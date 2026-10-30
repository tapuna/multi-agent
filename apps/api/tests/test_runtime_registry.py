import pytest
from sqlalchemy.orm import sessionmaker
from control import runtime_registry
from control.runtime import ADAPTERS
from control.runtime_registry import RuntimeEngine
from test_agent_diagnostics import Probe


@pytest.fixture
def real_registry(client, monkeypatch):
    monkeypatch.setattr(
        runtime_registry, "availability", client.runtime_availability_original
    )
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    probe = Probe()
    monkeypatch.setitem(ADAPTERS, "api", probe)
    return probe


def setup_api(client):
    response = client.put(
        "/api/runtime-adapters/api",
        json={"version": 0, "enabled": True, "probe_model": "openai/test-model"},
    )
    assert response.status_code == 200, response.text
    assert not response.json()["available"]
    assert client.post("/api/runtime-adapters/api/verify").status_code == 202
    return next(
        r for r in client.get("/api/runtime-adapters").json() if r["runtime"] == "api"
    )


def body():
    return {
        "name": "Worker",
        "role": "Engineer",
        "runtime": "api",
        "model": "openai/test-model",
    }


def test_setup_must_precede_registration_and_disable_blocks_use(
    client, project, task, real_registry
):
    assert client.post("/api/agents", json=body()).status_code == 409
    assert setup_api(client)["available"]
    agent = client.post("/api/agents", json=body())
    assert agent.status_code == 201, agent.text
    agent = agent.json()
    response = client.put(
        "/api/runtime-adapters/api",
        json={"version": 1, "enabled": False, "probe_model": "openai/test-model"},
    )
    assert response.status_code == 200 and not response.json()["available"]
    assert "disabled" in response.json()["reason"].lower()
    assert client.get("/api/agents").json()[0]["runtime_available"] is False
    assert client.post("/api/agents", json=body()).status_code == 409
    assert (
        client.post(
            f"/api/tasks/{task['id']}/sessions", json={"agent_id": agent["id"]}
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/tasks/{task['id']}/workflows",
            json={
                "version": 1,
                "steps": [{"key": "review", "kind": "review", "agent_id": agent["id"]}],
            },
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/projects/{project['id']}/agents/{agent['id']}/chat/messages",
            json={"content": "hello"},
        ).status_code
        == 409
    )
    actions = {e["action"] for e in client.get("/api/audit").json()}
    assert {"runtime.configured", "runtime.verified"}.issubset(actions)


def test_changed_provider_configuration_invalidates_availability(
    client, real_registry, monkeypatch
):
    assert setup_api(client)["available"]
    monkeypatch.setenv("TOKENIZERS_PARALLELISM", "false")
    monkeypatch.setenv("TIKTOKEN_CACHE_DIR", "sdk-cache-directory")
    assert next(
        r for r in client.get("/api/runtime-adapters").json() if r["runtime"] == "api"
    )["available"]
    monkeypatch.setenv("LLM_API_KEY", "updated-provider-key")
    current = next(
        r for r in client.get("/api/runtime-adapters").json() if r["runtime"] == "api"
    )
    assert not current["available"]
    assert client.post("/api/agents", json=body()).status_code == 409
    assert client.post("/api/runtime-adapters/api/verify").status_code == 202
    assert client.post("/api/agents", json=body()).status_code == 201


def test_failed_verification_missing_cli_and_authority(
    client, real_registry, monkeypatch
):
    real_registry.output = "not a verification token"
    assert not setup_api(client)["available"]
    assert client.post("/api/agents", json=body()).status_code == 409
    assert (
        client.put(
            "/api/runtime-adapters/api",
            headers={"X-Human-Key": "", "X-API-Key": "test-agent"},
            json={"version": 1, "enabled": False},
        ).status_code
        == 403
    )
    assert (
        client.put(
            "/api/runtime-adapters/api", json={"version": 0, "enabled": False}
        ).status_code
        == 409
    )
    monkeypatch.setattr(runtime_registry, "executable", lambda _: None)
    assert (
        client.put(
            "/api/runtime-adapters/codex",
            json={"version": 0, "enabled": True, "probe_model": "some-model"},
        ).status_code
        == 200
    )
    assert client.post("/api/runtime-adapters/codex/verify").status_code == 409


def test_restart_does_not_replay_and_disabling_cannot_be_overwritten(
    client, real_registry, monkeypatch
):
    assert setup_api(client)["available"]
    original = RuntimeEngine.run
    monkeypatch.setattr(RuntimeEngine, "run", lambda *_: None)
    assert client.post("/api/runtime-adapters/api/verify").status_code == 202
    assert client.post("/api/runtime-adapters/api/verify").status_code == 409
    RuntimeEngine(
        sessionmaker(bind=client.test_engine, expire_on_commit=False)
    ).recover()
    current = next(
        r for r in client.get("/api/runtime-adapters").json() if r["runtime"] == "api"
    )
    assert current["status"] == "interrupted" and not current["available"]
    assert client.post("/api/runtime-adapters/api/verify").status_code == 202
    assert (
        client.put(
            "/api/runtime-adapters/api", json={"version": 1, "enabled": False}
        ).status_code
        == 200
    )
    original(
        RuntimeEngine(sessionmaker(bind=client.test_engine, expire_on_commit=False)),
        "api",
        1,
        "old-fingerprint",
    )
    current = next(
        r for r in client.get("/api/runtime-adapters").json() if r["runtime"] == "api"
    )
    assert not current["enabled"] and not current["available"]
    assert len(real_registry.calls) == 1
