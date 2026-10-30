import json
import pytest
from test_workflows import Provider
from test_agent_chat import ChatProvider
from control.runtime import ADAPTERS


@pytest.fixture
def skill_library(tmp_path, monkeypatch):
    import control.routes_knowledge as registry

    monkeypatch.setattr(registry, "ROOT", tmp_path)
    for name, version, text in [
        ("alpha", "1.0.0", "ALPHA_PRIVATE_INSTRUCTION"),
        ("alpha", "2.0.0", "ALPHA_NEW_INSTRUCTION"),
        ("beta", "1.0.0", "BETA_PRIVATE_INSTRUCTION"),
    ]:
        path = tmp_path / "skills" / name / version / "SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text(
            f"---\nname: {name}\nversion: {version}\ndescription: Test skill\n---\n{text}\n",
            encoding="utf-8",
        )
    return tmp_path


def agent(client, name):
    return client.post(
        "/api/agents",
        json={
            "name": name,
            "role": "Engineer",
            "runtime": "api",
            "model": "openai/test-model",
        },
    ).json()


def assign(client, agent, refs, version=1):
    response = client.put(
        f"/api/agents/{agent['id']}/skills",
        json={"version": version, "skill_refs": refs},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_agent_skill_selection_versioning_and_validation(
    client, project, skill_library
):
    first, second = agent(client, "One"), agent(client, "Two")
    url = f"/api/agents/{first['id']}/skills"
    assert client.get(url).json() == {"version": 1, "skill_refs": []}
    assert assign(client, first, ["alpha@1.0.0"])["version"] == 2
    assert client.get(f"/api/agents/{second['id']}/skills").json()["skill_refs"] == []
    assert client.put(url, json={"version": 1, "skill_refs": []}).status_code == 409
    for refs in [
        ["alpha@1.0.0", "alpha@2.0.0"],
        ["alpha@1.0.0", "alpha@1.0.0"],
        ["missing@1.0.0"],
    ]:
        assert (
            client.put(url, json={"version": 2, "skill_refs": refs}).status_code == 422
        )
    assert (
        client.put(
            url,
            json={"version": 2, "skill_refs": []},
            headers={"X-Human-Key": "", "X-API-Key": "test-agent"},
        ).status_code
        == 403
    )
    assert assign(client, first, [], 2)["skill_refs"] == []
    assert "agent.skills_configured" in {
        e["action"] for e in client.get("/api/audit").json()
    }


def test_workflow_skills_are_isolated_and_snapshotted(
    client, task, skill_library, monkeypatch
):
    first, second = agent(client, "Builder"), agent(client, "Reviewer")
    assign(client, first, ["alpha@1.0.0"])
    assign(client, second, ["beta@1.0.0"])
    provider = Provider()
    monkeypatch.setitem(ADAPTERS, "api", provider)
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    response = client.post(
        f"/api/tasks/{task['id']}/workflows",
        json={
            "version": 1,
            "steps": [
                {"key": "build", "kind": "implement", "agent_id": first["id"]},
                {
                    "key": "review",
                    "kind": "review",
                    "agent_id": second["id"],
                    "depends_on": ["build"],
                },
            ],
        },
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    assert len(provider.calls) == 2
    for key, request in provider.calls:
        context = json.loads(request.prompt.split("Engineering context:\n", 1)[1])
        expected = "alpha" if key == "build" else "beta"
        assert [s["name"] for s in context["skills"]] == [expected]
        assert "agent_skills" not in context and "skill" not in context
        assert (
            request.workspace / ".agents" / "skills" / expected / "SKILL.md"
        ).exists()
        other = "beta" if expected == "alpha" else "alpha"
        assert not (request.workspace / ".agents" / "skills" / other).exists()
    snapshot = client.get(f"/api/workflows/{run_id}/context").json()
    assert snapshot["agent_skills"][first["id"]][0]["version"] == "1.0.0"
    assign(client, first, ["alpha@2.0.0"], 2)
    assert client.get(f"/api/workflows/{run_id}/context").json() == snapshot
    sessions = client.get(f"/api/tasks/{task['id']}").json()["sessions"]
    assert all(len(s["context_snapshot"]["skills"]) == 1 for s in sessions)
    assert all("agent_skills" not in s["context_snapshot"] for s in sessions)


def test_chat_and_summary_only_receive_assigned_skills(
    client, project, skill_library, monkeypatch
):
    first, second = agent(client, "Chat One"), agent(client, "Chat Two")
    assign(client, first, ["alpha@1.0.0"])
    provider = ChatProvider()
    monkeypatch.setitem(ADAPTERS, "api", provider)
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    url = f"/api/projects/{project['id']}/agents/{first['id']}"
    assert client.get(url + "/knowledge").json()["inventory"]["skills_total"] == 1
    assert (
        client.get(
            f"/api/projects/{project['id']}/agents/{second['id']}/knowledge"
        ).json()["inventory"]["skills_total"]
        == 0
    )
    response = client.post(url + "/chat/messages", json={"kind": "context_summary"})
    assert response.status_code == 202, response.text
    assert "ALPHA_PRIVATE_INSTRUCTION" in provider.calls[-1].prompt
    assert "BETA_PRIVATE_INSTRUCTION" not in provider.calls[-1].prompt
    assert "ALPHA_NEW_INSTRUCTION" not in provider.calls[-1].prompt
    snapshot_url = url + f"/chat/messages/{response.json()['message_id']}/context"
    snapshot = client.get(snapshot_url).json()
    assign(client, first, ["alpha@2.0.0"], 2)
    assert (
        client.post(
            url + "/chat/messages", json={"content": "What changed?"}
        ).status_code
        == 202
    )
    assert provider.calls[-1].provider_session_id is None
    assert "ALPHA_NEW_INSTRUCTION" in provider.calls[-1].prompt
    assert client.get(snapshot_url).json() == snapshot


def test_workflow_level_skill_override_cannot_bypass_agent_configuration(
    client, task, skill_library
):
    first = agent(client, "Only")
    response = client.post(
        f"/api/tasks/{task['id']}/workflows",
        json={
            "version": 1,
            "steps": [{"key": "review", "kind": "review", "agent_id": first["id"]}],
            "skill_refs": ["beta@1.0.0"],
        },
    )
    assert response.status_code == 422, response.text
