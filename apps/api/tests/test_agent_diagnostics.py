import re
import pytest
from sqlalchemy.orm import sessionmaker
from control.runtime import ADAPTERS, RuntimeResult
from control.agent_diagnostics import DiagnosticEngine


class Probe:
    def __init__(self):
        self.calls = []
        self.output = None
        self.error = None

    def run(self, request, event, check):
        self.calls.append(request)
        check()
        if self.error:
            raise self.error
        return RuntimeResult(
            self.output
            if self.output is not None
            else re.search(r"RELAY_OK_[a-f0-9]+", request.prompt).group(),
            usage={"total_tokens": 4},
        )


@pytest.fixture
def setup_probe(client, monkeypatch):
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    agent = client.post(
        "/api/agents",
        json={
            "name": "Probe Agent",
            "role": "Engineer",
            "runtime": "api",
            "model": "openai/test-model",
        },
    ).json()
    probe = Probe()
    monkeypatch.setitem(ADAPTERS, "api", probe)
    return agent, probe


def latest(client, agent):
    return next(
        r
        for r in client.get("/api/agent-diagnostics").json()
        if r["agent"]["id"] == agent["id"]
    )


def test_actual_probe_verifies_fresh_response_and_detects_stale_config(
    client, setup_probe
):
    agent, probe = setup_probe
    url = f"/api/agents/{agent['id']}/diagnostics"
    assert latest(client, agent)["latest"] is None and not probe.calls
    for _ in range(2):
        response = client.post(url)
        assert response.status_code == 202, response.text
        result = latest(client, agent)["latest"]
        assert result["status"] == "passed" and result["result"]["response_verified"]
        assert result["latency_ms"] >= 0 and not result["stale"]
    assert probe.calls[0].prompt != probe.calls[1].prompt
    assert probe.calls[0].workspace != probe.calls[1].workspace
    assert all(
        r.provider_session_id is None
        and r.purpose == "diagnostic"
        and r.timeout_seconds == 30
        for r in probe.calls
    )
    assert "project" not in list(probe.calls[0].workspace.iterdir())
    updated = {k: agent[k] for k in ("name", "role", "runtime", "model")}
    updated["model"] = "openai/another-model"
    assert client.patch(f"/api/agents/{agent['id']}", json=updated).status_code == 200
    assert latest(client, agent)["latest"]["stale"]
    assert "agent.diagnostic.passed" in {
        e["action"] for e in client.get("/api/audit").json()
    }


def test_preflight_blocked_never_claims_provider_success(
    client, setup_probe, monkeypatch
):
    agent, probe = setup_probe
    monkeypatch.setenv("CONTROL_ALLOWED_MODELS", "openai/not-allowed")
    response = client.post(f"/api/agents/{agent['id']}/diagnostics")
    assert response.status_code == 202
    result = latest(client, agent)
    assert (
        result["latest"]["status"] == "blocked"
        and not result["latest"]["result"]["response_verified"]
    )
    assert not probe.calls
    assert any(not c["ok"] for c in result["checks"])


def test_wrong_response_and_provider_errors_are_not_passes(
    client, setup_probe, monkeypatch
):
    agent, probe = setup_probe
    probe.output = "Unrelated answer"
    url = f"/api/agents/{agent['id']}/diagnostics"
    assert client.post(url).status_code == 202
    assert latest(client, agent)["latest"]["status"] == "failed"
    monkeypatch.setenv("OPENAI_API_KEY", "private-provider-test-key")
    probe.error = RuntimeError("Login failed: private-provider-test-key")
    assert client.post(url).status_code == 202
    result = latest(client, agent)
    assert result["latest"]["status"] == "failed"
    assert "private-provider-test-key" not in str(result)
    assert "[REDACTED]" in result["latest"]["result"]["message"]


def test_diagnostic_requires_human_and_recovers_without_paid_replay(
    client, setup_probe, monkeypatch
):
    agent, probe = setup_probe
    url = f"/api/agents/{agent['id']}/diagnostics"
    assert (
        client.post(
            url, headers={"X-Human-Key": "", "X-API-Key": "test-agent"}
        ).status_code
        == 403
    )
    monkeypatch.setattr(DiagnosticEngine, "run", lambda *_: None)
    assert client.post(url).status_code == 202
    assert client.post(url).status_code == 409
    DiagnosticEngine(
        sessionmaker(bind=client.test_engine, expire_on_commit=False)
    ).recover()
    assert latest(client, agent)["latest"]["status"] == "interrupted"
    assert not probe.calls
