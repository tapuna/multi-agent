import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from sqlalchemy import update
from sqlalchemy.orm import sessionmaker
from control import runtime_registry
from control.models import Agent
from control.profile_readiness import ProfileEngine
from control.runtime import ADAPTERS, APIAdapter
from test_agent_diagnostics import Probe


@pytest.fixture
def profile_setup(client, monkeypatch):
    monkeypatch.setattr(
        runtime_registry, "availability", client.runtime_availability_original
    )
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    items = [
        {
            "id": "a",
            "label": "Model A",
            "runtime": "api",
            "model": "openai/model-a",
            "api_key_env": "PROFILE_AUTH_A",
        },
        {
            "id": "b",
            "label": "Model B",
            "runtime": "api",
            "model": "openai/model-b",
            "api_key_env": "PROFILE_AUTH_B",
        },
    ]
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    monkeypatch.setenv("PROFILE_AUTH_A", "profile-a-secret")
    monkeypatch.setenv("PROFILE_AUTH_B", "profile-b-secret")
    probe = Probe()
    monkeypatch.setitem(ADAPTERS, "api", probe)
    return items, probe


def catalog(client):
    return {p["id"]: p for p in client.get("/api/llm-profiles").json()}


def agent_body(profile):
    return {
        "name": "Agent " + profile,
        "role": "Engineer",
        "runtime": "api",
        "model": "profile:" + profile,
    }


def test_each_profile_must_pass_before_agent_configuration(client, profile_setup):
    _, probe = profile_setup
    assert (
        not catalog(client)["a"]["available"] and not catalog(client)["b"]["available"]
    )
    assert client.post("/api/agents", json=agent_body("a")).status_code == 409
    assert client.post("/api/llm-profiles/a/verify").status_code == 202
    result = catalog(client)
    assert result["a"]["available"] and not result["b"]["available"]
    assert result["a"]["latency_ms"] >= 0 and result["a"]["tested_at"]
    first = client.post("/api/agents", json=agent_body("a"))
    assert first.status_code == 201, first.text
    assert client.post("/api/agents", json=agent_body("b")).status_code == 409
    assert (
        client.patch(
            "/api/agents/" + first.json()["id"], json=agent_body("b")
        ).status_code
        == 409
    )
    raw = agent_body("a")
    raw["model"] = "openai/model-b"
    assert client.post("/api/agents", json=raw).status_code == 409
    assert len(probe.calls) == 1 and probe.calls[0].model == "profile:a"


def test_existing_agents_cannot_execute_unverified_profile(
    client, project, task, profile_setup
):
    client.post("/api/llm-profiles/a/verify")
    agent = client.post("/api/agents", json=agent_body("a")).json()
    with client.test_engine.begin() as connection:
        connection.execute(
            update(Agent).where(Agent.id == agent["id"]).values(model="profile:b")
        )
    assert not client.get("/api/agents").json()[0]["runtime_available"]
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


def test_changes_disable_and_removal_invalidate_only_affected_profile(
    client, profile_setup, monkeypatch
):
    items, _ = profile_setup
    for profile in ("a", "b"):
        assert client.post(f"/api/llm-profiles/{profile}/verify").status_code == 202
    monkeypatch.setenv("PROFILE_AUTH_A", "rotated-profile-a-key")
    result = catalog(client)
    assert result["a"]["status"] == "stale" and not result["a"]["available"]
    assert result["b"]["available"]
    items[0]["enabled"] = False
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    assert catalog(client)["a"]["status"] == "disabled"
    assert client.post("/api/llm-profiles/a/verify").status_code == 409
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items[1:]))
    assert client.post("/api/agents", json=agent_body("a")).status_code == 409
    assert client.post("/api/llm-profiles/a/verify").status_code == 404


def test_failed_tests_authorization_and_secret_redaction(client, profile_setup):
    _, probe = profile_setup
    assert (
        client.post(
            "/api/llm-profiles/a/verify",
            headers={"X-Human-Key": "", "X-API-Key": "test-agent"},
        ).status_code
        == 403
    )
    probe.output = "Wrong reply"
    assert client.post("/api/llm-profiles/a/verify").status_code == 202
    assert not catalog(client)["a"]["available"]
    probe.error = RuntimeError("Authentication failed: profile-a-secret")
    client.post("/api/llm-profiles/a/verify")
    result = catalog(client)
    assert result["a"]["status"] == "failed" and "[REDACTED]" in result["a"]["reason"]
    assert "profile-a-secret" not in str(result)


def test_reenable_after_disabled_restart_requires_new_test(
    client, profile_setup, monkeypatch
):
    items, _ = profile_setup
    assert client.post("/api/llm-profiles/a/verify").status_code == 202
    engine = ProfileEngine(
        sessionmaker(bind=client.test_engine, expire_on_commit=False)
    )
    items[0]["enabled"] = False
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    engine.recover()
    items[0]["enabled"] = True
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    engine.recover()
    assert not catalog(client)["a"]["available"]
    assert client.post("/api/llm-profiles/a/verify").status_code == 202
    assert catalog(client)["a"]["available"]


def test_restart_and_disabled_during_test_cannot_publish_ready(
    client, profile_setup, monkeypatch
):
    items, probe = profile_setup
    original = ProfileEngine.run
    monkeypatch.setattr(ProfileEngine, "run", lambda *_: None)
    assert client.post("/api/llm-profiles/a/verify").status_code == 202
    assert client.post("/api/llm-profiles/a/verify").status_code == 409
    engine = ProfileEngine(
        sessionmaker(bind=client.test_engine, expire_on_commit=False)
    )
    engine.recover()
    assert catalog(client)["a"]["status"] == "interrupted" and not probe.calls
    assert client.post("/api/llm-profiles/a/verify").status_code == 202
    items[0]["enabled"] = False
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    original(engine, "a", 2, "old-hash")
    assert not catalog(client)["a"]["available"] and not probe.calls


def test_real_http_transport_verifies_selected_profile_only(
    client, profile_setup, monkeypatch
):
    items, _ = profile_setup
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(
                {"model": body["model"], "auth": self.headers.get("Authorization")}
            )
            token = re.search(
                r"RELAY_OK_[a-f0-9]+", body["messages"][-1]["content"]
            ).group()
            result = {
                "id": "local-contract",
                "object": "chat.completion",
                "created": 1,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": token},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    items[0]["api_base"] = f"http://127.0.0.1:{server.server_port}/v1"
    monkeypatch.setenv("LLM_PROFILES_JSON", json.dumps(items))
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    monkeypatch.setitem(ADAPTERS, "api", APIAdapter())
    try:
        response = client.post("/api/llm-profiles/a/verify")
        assert response.status_code == 202, response.text
        result = catalog(client)
        assert result["a"]["available"] and not result["b"]["available"]
        assert calls == [
            {
                "model": "openai/model-a".removeprefix("openai/"),
                "auth": "Bearer profile-a-secret",
            }
        ]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
