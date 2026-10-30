import json
import sys
from types import SimpleNamespace
import pytest
from control.llm_profiles import profiles, resolve, signature
from control.gateway import LiteLLMGateway
from control.runtime import CLIAdapter, RuntimeRequest, ADAPTERS
from test_workflows import Provider
from test_agent_chat import ChatProvider


@pytest.fixture
def catalog(monkeypatch):
    items = [
        {
            "id": "main",
            "label": "Main connection",
            "runtime": "api",
            "model": "openai/model-one",
            "api_base": "https://one.example/v1",
            "api_key_env": "PROFILE_ONE_KEY",
        },
        {
            "id": "review",
            "label": "Review connection",
            "runtime": "api",
            "model": "openai/model-two",
            "api_base": "https://two.example/v1",
            "api_key_env": "PROFILE_TWO_KEY",
        },
        {"id": "code", "runtime": "codex", "model": "cli-model"},
    ]
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    monkeypatch.setenv("PROFILE_ONE_KEY", "private-key-one")
    monkeypatch.setenv("PROFILE_TWO_KEY", "private-key-two")
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    return items


def test_public_catalog_is_array_without_credentials(client, catalog, monkeypatch):
    data = client.get("/api/llm-profiles")
    assert data.status_code == 200, data.text
    assert len(data.json()) == 3
    assert data.json()[0]["reference"] == "profile:main"
    assert "private-key" not in data.text and "api_key_env" not in data.text
    monkeypatch.delenv("PROFILE_ONE_KEY")
    assert not client.get("/api/llm-profiles").json()[0]["credential_configured"]


def test_invalid_arrays_are_rejected_without_echoing_secrets(monkeypatch):
    for value in [
        "{bad",
        "{}",
        json.dumps([{"id": "x", "model": "x", "api_key": "private-inline-key"}]),
        json.dumps([{"id": "x", "model": "x"}] * 2),
        json.dumps(
            [
                {
                    "id": "x",
                    "model": "x",
                    "api_base": "https://user:password@example.com/v1",
                }
            ]
        ),
        json.dumps([{"id": "x", "model": "x", "api_key_env": "CONTROL_HUMAN_KEY"}]),
    ]:
        monkeypatch.setenv("LLM_PROFILES_JSON", value)
        with pytest.raises(ValueError) as error:
            profiles()
        assert "private-inline-key" not in str(error.value)
    monkeypatch.setenv("LLM_PROFILES_JSON", "[]")
    assert profiles() == []


def test_gateway_routes_each_profile_to_its_own_endpoint_and_key(catalog, monkeypatch):
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="answer", tool_calls=None)
                )
            ],
            usage=None,
            id="response-id",
        )

    monkeypatch.setitem(sys.modules, "litellm", SimpleNamespace(completion=completion))
    monkeypatch.setenv("LLM_API_BASE", "https://wrong-legacy.example/v1")
    monkeypatch.setenv("LLM_API_KEY", "wrong-legacy-key")
    monkeypatch.setenv("CONTROL_ALLOWED_MODELS", "openai/model-one,openai/model-two")
    for ref in ("main", "review"):
        assert (
            LiteLLMGateway().complete("profile:" + ref, "system", "hello").content
            == "answer"
        )
    assert [(c["model"], c["api_base"], c["api_key"]) for c in calls] == [
        ("openai/model-one", "https://one.example/v1", "private-key-one"),
        ("openai/model-two", "https://two.example/v1", "private-key-two"),
    ]
    catalog[0]["enabled"] = False
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(catalog))
    with pytest.raises(ValueError, match="disabled"):
        LiteLLMGateway().complete("profile:main", "system", "hello")
    assert len(calls) == 2


def test_cli_profile_resolution_runtime_validation_and_key_rotation(
    catalog, monkeypatch, tmp_path
):
    command = CLIAdapter("codex").command(
        RuntimeRequest("prompt", tmp_path, "profile:code")
    )
    assert "cli-model" in command and "profile:code" not in command
    with pytest.raises(ValueError, match="runtime"):
        resolve("profile:code", "api")
    before = signature("profile:main")
    monkeypatch.setenv("PROFILE_ONE_KEY", "rotated-key")
    assert signature("profile:main") != before
    monkeypatch.delenv("PROFILE_ONE_KEY")
    with pytest.raises(ValueError, match="Missing credential"):
        resolve("profile:main")


def test_workflow_snapshot_and_resume_reject_changed_profile(
    client, task, catalog, monkeypatch
):
    agent = client.post(
        "/api/agents",
        json={
            "name": "Profile agent",
            "role": "Engineer",
            "runtime": "api",
            "model": "profile:main",
        },
    )
    assert agent.status_code == 201, agent.text
    agent = agent.json()
    provider = Provider()
    provider.fail_once = "build"
    monkeypatch.setitem(ADAPTERS, "api", provider)
    response = client.post(
        f"/api/tasks/{task['id']}/workflows",
        json={
            "version": 1,
            "steps": [{"key": "build", "kind": "implement", "agent_id": agent["id"]}],
        },
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    detail = client.get(f"/api/workflows/{run_id}").json()
    assert detail["run"]["status"] == "failed"
    assert (
        detail["run"]["agents"]["build"]["llm_profile"]["model"] == "openai/model-one"
    )
    assert "private-key" not in str(detail)
    catalog[0]["model"] = "openai/new-model"
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(catalog))
    rejected = client.post(f"/api/workflows/{run_id}/resume")
    assert rejected.status_code == 409
    assert "LLM profile changed" in rejected.text
    assert len(provider.calls) == 1


def test_chat_profile_change_resets_provider_binding_and_preserves_snapshot(
    client, project, catalog, monkeypatch
):
    provider = ChatProvider()
    monkeypatch.setitem(ADAPTERS, "api", provider)
    agent = client.post(
        "/api/agents",
        json={
            "name": "Chat profile",
            "role": "Engineer",
            "runtime": "api",
            "model": "profile:main",
        },
    ).json()
    url = f"/api/projects/{project['id']}/agents/{agent['id']}/chat"
    response = client.post(url + "/messages", json={"content": "hello"})
    assert response.status_code == 202, response.text
    snap_url = url + f"/messages/{response.json()['message_id']}/context"
    snapshot = client.get(snap_url).json()
    assert snapshot["agent"]["llm_profile"]["profile_id"] == "main"
    catalog[0]["api_base"] = "https://new.example/v1"
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(catalog))
    assert (
        client.post(url + "/messages", json={"content": "continue"}).status_code == 202
    )
    assert provider.calls[-1].provider_session_id is None
    assert client.get(snap_url).json() == snapshot
