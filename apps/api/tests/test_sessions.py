from pathlib import Path
from control.runtime import CLIAdapter, RuntimeRequest


def test_workspace_isolation_context_and_resume(client, task):
    agent = client.post(
        "/api/agents",
        json={
            "name": "Engineer",
            "role": "Backend",
            "runtime": "codex",
            "model": "configured-model",
        },
    ).json()
    sessions = [
        client.post(
            f"/api/tasks/{task['id']}/sessions", json={"agent_id": agent["id"]}
        ).json()
        for _ in range(2)
    ]
    assert sessions[0]["workspace_path"] != sessions[1]["workspace_path"]
    assert all(Path(s["workspace_path"]).is_dir() for s in sessions)
    assert sessions[0]["context_snapshot"]["precedence"][0] == "company"
    assert sessions[0]["context_snapshot"]["policy_sha256"]
    session_id = sessions[0]["id"]
    assert client.get(f"/api/sessions/{session_id}/resume").status_code == 409
    assert (
        client.patch(
            f"/api/sessions/{session_id}", json={"provider_session_id": "provider-123"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/sessions/{session_id}", json={"provider_session_id": "different"}
        ).status_code
        == 409
    )
    assert (
        client.patch(
            f"/api/sessions/{sessions[1]['id']}",
            json={"provider_session_id": "provider-123"},
        ).status_code
        == 409
    )
    resumed = client.get(f"/api/sessions/{session_id}/resume").json()
    assert "provider-123" in resumed["command"]
    assert resumed["execution_enabled"] is False
    assert resumed["workspace"] == sessions[0]["workspace_path"]


def test_resume_adapter_contracts():
    request = RuntimeRequest(
        "implement task", Path("."), "configured-model", "provider-id"
    )
    for provider in ("codex", "claude", "gemini"):
        command = CLIAdapter(provider).command(request)
        assert "provider-id" in command
        assert "implement task" in command


def test_shared_project_memory(client, project):
    assert (
        client.post(
            f"/api/projects/{project['id']}/memory", json={"content": "Use PostgreSQL"}
        ).status_code
        == 201
    )
    assert (
        client.get(f"/api/projects/{project['id']}/memory").json()[0]["content"]
        == "Use PostgreSQL"
    )
