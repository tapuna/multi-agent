import io
import json
import threading
import zipfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import update
from control.models import WorkflowRun
from control.runtime import ADAPTERS, RuntimeResult
from control.workflows import WorkflowEngine
from control.workspaces import git


class Provider:
    def __init__(self):
        self.calls = []
        self.fail_once = None
        self.failed = False
        self.parallel = None
        self.block = None

    def run(self, request, on_event, check_cancel):
        context = json.loads(request.prompt.split("Engineering context:\n", 1)[1])
        key = context["step"]["key"]
        kind = context["step"]["kind"]
        self.calls.append((key, request))
        sid = request.provider_session_id or "test-session-" + key
        on_event("session.provider_bound", {"provider_session_id": sid})
        if self.block:
            self.block.set()
            while True:
                check_cancel()
                threading.Event().wait(0.02)
        if self.fail_once == key and not self.failed:
            self.failed = True
            raise RuntimeError("Simulated provider disconnect")
        if self.parallel and kind == "implement":
            self.parallel.wait(timeout=5)
        output = {
            "summary": f"{key} finished",
            "files": [{"path": key + ".py", "content": f"print('{key}')\n"}]
            if kind == "implement"
            else [],
        }
        return RuntimeResult(
            json.dumps(output), sid, "test-response-" + key, {"total_tokens": 10}
        )


@pytest.fixture
def provider(monkeypatch):
    runtime = Provider()
    monkeypatch.setitem(ADAPTERS, "api", runtime)
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    return runtime


def steps(client):
    agent = client.post(
        "/api/agents",
        json={
            "name": "Engineer",
            "role": "Engineering",
            "runtime": "api",
            "model": "openai/test-configured-model",
        },
    ).json()
    return [
        {"key": key, "kind": kind, "agent_id": agent["id"], "depends_on": dependencies}
        for key, kind, dependencies in [
            ("plan", "plan", []),
            ("implement", "implement", ["plan"]),
            ("review", "review", ["implement"]),
        ]
    ]


def start(client, task, selected):
    response = client.post(
        f"/api/tasks/{task['id']}/workflows",
        json={"version": task["version"], "steps": selected},
    )
    assert response.status_code == 202, response.text
    return client.get("/api/workflows/" + response.json()["id"]).json()


def test_real_graph_persists_artifacts_checkpoints_and_human_gate(
    client, task, provider
):
    result = start(client, task, steps(client))
    run = result["run"]
    assert run["status"] == "awaiting_approval", run.get("error")
    assert [key for key, _ in provider.calls] == ["plan", "implement", "review"]
    assert all(s["state"] == "completed" for s in result["steps"])
    assert result["checkpoints"] and len(result["artifacts"]) == 3
    assert {
        "agent.queued",
        "agent.started",
        "agent.completed",
        "tool.workspace_write",
        "handoff.ready",
        "workflow.awaiting_approval",
    }.issubset({e["kind"] for e in result["events"]})
    assert (
        (Path(run["workspace_path"]) / "source" / "implement.py")
        .read_text()
        .startswith("print")
    )
    assert (
        client.patch(
            f"/api/tasks/{task['id']}",
            json={"version": run["task_version"], "title": "racing edit"},
        ).status_code
        == 409
    )
    archive = client.get(f"/api/workflows/{run['id']}/export")
    assert archive.headers["content-type"] == "application/zip"
    assert (
        "implement/implement.py"
        in zipfile.ZipFile(io.BytesIO(archive.content)).namelist()
    )
    decision = client.post(
        f"/api/workflows/{run['id']}/decision",
        json={"approved": True, "digest": run["result_digest"]},
    )
    assert decision.status_code == 202, decision.text
    final = client.get(f"/api/workflows/{run['id']}").json()
    assert final["run"]["status"] == "completed", final["run"].get("error")
    assert len(provider.calls) == 3
    assert client.get(f"/api/tasks/{task['id']}").json()["task"]["status"] == "done"


def test_failed_step_resumes_same_provider_session_without_rerunning_completed_steps(
    client, task, provider
):
    provider.fail_once = "implement"
    first = start(client, task, steps(client))
    run_id = first["run"]["id"]
    assert first["run"]["status"] == "failed"
    assert len(first["artifacts"]) == 1
    response = client.post(f"/api/workflows/{run_id}/resume")
    assert response.status_code == 202, response.text
    result = client.get(f"/api/workflows/{run_id}").json()
    assert result["run"]["status"] == "awaiting_approval", result["run"].get("error")
    assert [key for key, _ in provider.calls] == [
        "plan",
        "implement",
        "implement",
        "review",
    ]
    attempts = [request for key, request in provider.calls if key == "implement"]
    assert attempts[1].provider_session_id == "test-session-implement"
    assert attempts[0].workspace == attempts[1].workspace


def test_parallel_steps_join_before_review(client, task, provider):
    selected = steps(client)
    agent = selected[0]["agent_id"]
    selected = [
        {"key": "frontend", "kind": "implement", "agent_id": agent, "depends_on": []},
        {"key": "backend", "kind": "implement", "agent_id": agent, "depends_on": []},
        {
            "key": "review",
            "kind": "review",
            "agent_id": agent,
            "depends_on": ["frontend", "backend"],
        },
    ]
    provider.parallel = threading.Barrier(2)
    result = start(client, task, selected)
    assert result["run"]["status"] == "awaiting_approval", result["run"].get("error")
    assert {key for key, _ in provider.calls[:2]} == {"frontend", "backend"}
    assert provider.calls[-1][0] == "review"


def test_cycles_and_service_start_are_rejected(client, task, provider):
    selected = steps(client)
    selected[0]["depends_on"] = ["review"]
    response = client.post(
        f"/api/tasks/{task['id']}/workflows", json={"version": 1, "steps": selected}
    )
    assert response.status_code == 422
    assert not provider.calls
    selected[0]["depends_on"] = []
    client.headers.pop("X-Human-Key")
    client.headers["X-API-Key"] = "test-agent"
    assert (
        client.post(
            f"/api/tasks/{task['id']}/workflows", json={"version": 1, "steps": selected}
        ).status_code
        == 403
    )


def test_workspace_tampering_invalidates_review_and_human_can_reject(
    client, task, provider
):
    result = start(client, task, steps(client))
    run = result["run"]
    path = Path(run["workspace_path"]) / "source" / "implement.py"
    original = path.read_text()
    path.write_text("tampered")
    assert (
        client.post(
            f"/api/workflows/{run['id']}/decision",
            json={"approved": True, "digest": run["result_digest"]},
        ).status_code
        == 409
    )
    path.write_text(original)
    client.headers.pop("X-Human-Key")
    client.headers["X-API-Key"] = "test-agent"
    assert (
        client.post(
            f"/api/workflows/{run['id']}/decision",
            json={"approved": True, "digest": run["result_digest"]},
        ).status_code
        == 403
    )
    client.headers["X-Human-Key"] = "test-human"
    assert (
        client.post(
            f"/api/workflows/{run['id']}/decision",
            json={"approved": False, "digest": run["result_digest"]},
        ).status_code
        == 202
    )
    assert (
        client.get(f"/api/workflows/{run['id']}").json()["run"]["status"] == "rejected"
    )


def test_recovery_restores_saved_human_gate_without_provider_calls(
    client, task, provider
):
    result = start(client, task, steps(client))
    run_id = result["run"]["id"]
    with client.test_engine.begin() as db:
        db.execute(
            update(WorkflowRun).where(WorkflowRun.id == run_id).values(status="running")
        )
    WorkflowEngine(client.test_engine).recover()
    assert (
        client.get(f"/api/workflows/{run_id}").json()["run"]["status"] == "interrupted"
    )
    assert client.post(f"/api/workflows/{run_id}/resume").status_code == 202
    assert (
        client.get(f"/api/workflows/{run_id}").json()["run"]["status"]
        == "awaiting_approval"
    )
    assert len(provider.calls) == 3


def test_running_workflow_can_be_cancelled_without_artifact_completion(
    client, task, provider
):
    selected = steps(client)
    provider.block = threading.Event()
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(
            client.post,
            f"/api/tasks/{task['id']}/workflows",
            json={"version": 1, "steps": selected},
        )
        assert provider.block.wait(timeout=5)
        run = client.get("/api/workflows").json()[0]
        assert client.post(f"/api/workflows/{run['id']}/cancel").status_code == 200
        assert pending.result(timeout=5).status_code == 202
    result = client.get(f"/api/workflows/{run['id']}").json()
    assert result["run"]["status"] == "cancelled" and not result["artifacts"]
    assert client.get(f"/api/tasks/{task['id']}").json()["task"]["status"] == "todo"


def test_human_merge_requires_review_and_preserves_unrelated_work(
    client, task, provider, tmp_path
):
    repo = tmp_path / "repository"
    repo.mkdir()
    git(["init", str(repo)])
    (repo / "original.py").write_text("original")
    git(["-C", str(repo), "add", "original.py"])
    git(
        [
            "-C",
            str(repo),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "initial",
        ]
    )
    base = git(["-C", str(repo), "rev-parse", "HEAD"])
    assert (
        client.patch(
            f"/api/projects/{task['project_id']}/repository",
            json={"repository_path": str(repo)},
        ).status_code
        == 200
    )
    result = start(client, task, steps(client))
    run = result["run"]
    assert not (repo / "implement.py").exists()
    assert (
        client.post(
            f"/api/workflows/{run['id']}/merge",
            json={"digest": run["result_digest"], "expected_revision": base},
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/workflows/{run['id']}/decision",
            json={"approved": True, "digest": run["result_digest"]},
        ).status_code
        == 202
    )
    (repo / "local-user-file.txt").write_text("keep this work")
    assert (
        client.post(
            f"/api/workflows/{run['id']}/merge",
            json={"digest": run["result_digest"], "expected_revision": base},
        ).status_code
        == 409
    )
    assert (repo / "local-user-file.txt").read_text() == "keep this work"
    # Move this test-only file aside; no user work is removed by the merge endpoint.
    (repo / "local-user-file.txt").rename(tmp_path / "preserved-local-user-file.txt")
    client.headers.pop("X-Human-Key")
    client.headers["X-API-Key"] = "test-agent"
    assert (
        client.post(
            f"/api/workflows/{run['id']}/merge",
            json={"digest": run["result_digest"], "expected_revision": base},
        ).status_code
        == 403
    )
    client.headers["X-Human-Key"] = "test-human"
    merged = client.post(
        f"/api/workflows/{run['id']}/merge",
        json={"digest": run["result_digest"], "expected_revision": base},
    )
    assert merged.status_code == 200, merged.text
    assert (repo / "original.py").read_text() == "original" and (
        repo / "implement.py"
    ).is_file()
    assert git(["-C", str(repo), "rev-parse", "HEAD"]) == merged.json()["commit"]
    assert (
        client.post(
            f"/api/workflows/{run['id']}/merge",
            json={"digest": run["result_digest"], "expected_revision": base},
        ).json()
        == merged.json()
    )
