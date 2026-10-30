import pytest
import threading
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy.orm import sessionmaker
from control.runtime import ADAPTERS, RuntimeResult
from control.agent_chat import ChatEngine


class ChatProvider:
    def __init__(self):
        self.calls = []
        self.fail = False

    def run(self, request, event, check):
        self.calls.append(request)
        check()
        sid = request.provider_session_id or "test-chat-provider-session"
        event("session.provider_bound", {"provider_session_id": sid})
        if self.fail:
            raise RuntimeError("Test provider disconnected")
        return RuntimeResult(
            "สิ่งที่รู้: ข้อมูลโปรเจกต์ [project]\nสิ่งที่ยังไม่รู้: ยังไม่มีหลักฐานทดสอบจริง"
            if request.purpose == "context_summary"
            else "รับทราบข้อมูลโปรเจกต์ [project]",
            sid,
        )


@pytest.fixture
def chat_agent(client, monkeypatch):
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    agent = client.post(
        "/api/agents",
        json={
            "name": "Chat Builder",
            "role": "Engineer",
            "runtime": "api",
            "model": "openai/test-model",
        },
    ).json()
    provider = ChatProvider()
    monkeypatch.setitem(ADAPTERS, "api", provider)
    return agent, provider


def base(project, agent):
    return f"/api/projects/{project['id']}/agents/{agent['id']}"


def test_persistent_conversation_summary_and_source_snapshot(
    client, project, chat_agent
):
    agent, provider = chat_agent
    url = base(project, agent)
    client.post(
        f"/api/projects/{project['id']}/memory",
        json={"content": "Approved design: use Firebird Embedded"},
    )
    assert client.get(url + "/chat").json()["conversation"] is None
    first = client.post(url + "/chat/messages", json={"content": "เราจะใช้ Firebird นะ"})
    assert first.status_code == 202, first.text
    state = client.get(url + "/chat").json()
    assert state["conversation"]["status"] == "idle"
    assert state["conversation"]["provider_session_id"] == "test-chat-provider-session"
    assert [m["role"] for m in state["messages"]] == ["user", "assistant"]
    summary = client.post(url + "/chat/messages", json={"kind": "context_summary"})
    assert summary.status_code == 202, summary.text
    state = client.get(url + "/chat").json()
    response = state["messages"][-1]
    assert (
        response["kind"] == "context_summary"
        and response["inventory"]["memory_total"] == 1
    )
    assert provider.calls[0].provider_session_id is None
    assert provider.calls[1].provider_session_id == "test-chat-provider-session"
    assert provider.calls[1].purpose == "context_summary"
    assert provider.calls[0].workspace != provider.calls[1].workspace
    assert "Firebird Embedded" in provider.calls[1].prompt
    snapshot_url = url + f"/chat/messages/{summary.json()['message_id']}/context"
    snapshot = client.get(snapshot_url).json()
    assert snapshot["knowledge"]["company_policy"]
    assert len(snapshot["history"]) == 2
    client.post(
        f"/api/projects/{project['id']}/memory",
        json={"content": "New fact after summary"},
    )
    assert client.get(snapshot_url).json() == snapshot
    assert client.get(url + "/knowledge").json()["inventory"]["memory_total"] == 2
    actions = {e["action"] for e in client.get("/api/audit").json()}
    assert {
        "agent.chat.requested",
        "agent.chat.responded",
        "agent.context_summary.requested",
        "agent.context_summary.generated",
    }.issubset(actions)


def test_agent_and_project_scope_are_isolated(client, project, chat_agent):
    agent, _ = chat_agent
    other_project = client.post(
        "/api/projects", json={"name": "Private other project", "key": "OTHER"}
    ).json()
    other_agent = client.post(
        "/api/agents",
        json={
            "name": "Other",
            "role": "Reviewer",
            "runtime": "api",
            "model": "openai/test-model",
        },
    ).json()
    url = base(project, agent)
    request = client.post(
        url + "/chat/messages", json={"content": "Project specific message"}
    ).json()
    for other in (base(other_project, agent), base(project, other_agent)):
        assert client.get(other + "/chat").json()["messages"] == []
        assert (
            client.get(
                other + f"/chat/messages/{request['message_id']}/context"
            ).status_code
            == 404
        )
    client.post(
        f"/api/projects/{other_project['id']}/memory",
        json={"content": "OTHER PROJECT SECRET FACT"},
    )
    current = client.get(url + "/knowledge").json()
    assert current["inventory"]["memory_total"] == 0


def test_config_and_policy_changes_start_fresh_provider_session(
    client, project, chat_agent, monkeypatch
):
    agent, provider = chat_agent
    url = base(project, agent)
    client.post(url + "/chat/messages", json={"content": "hello"})
    assert (
        client.patch(
            f"/api/agents/{agent['id']}",
            json={
                "name": agent["name"],
                "role": agent["role"],
                "runtime": "api",
                "model": "openai/new-model",
            },
        ).status_code
        == 200
    )
    client.post(url + "/chat/messages", json={"content": "next"})
    assert (
        provider.calls[-1].provider_session_id is None
        and provider.calls[-1].model == "openai/new-model"
    )
    import control.agent_chat as module

    original = module.snapshot
    monkeypatch.setattr(
        module,
        "snapshot",
        lambda *args: {
            **original(*args),
            "company_policy": "Updated mandatory policy",
            "policy_sha256": "changed",
        },
    )
    client.post(url + "/chat/messages", json={"kind": "context_summary"})
    assert provider.calls[-1].provider_session_id is None
    assert "Updated mandatory policy" in provider.calls[-1].prompt


def test_busy_cancel_and_startup_recovery_do_not_replay(
    client, project, chat_agent, monkeypatch
):
    agent, provider = chat_agent
    url = base(project, agent)
    monkeypatch.setattr(ChatEngine, "run", lambda *_: None)
    assert (
        client.post(url + "/chat/messages", json={"content": "queued"}).status_code
        == 202
    )
    assert (
        client.post(url + "/chat/messages", json={"content": "duplicate"}).status_code
        == 409
    )
    assert client.post(url + "/chat/cancel").status_code == 200
    state = client.get(url + "/chat").json()
    assert state["messages"][0]["state"] == "cancelled"
    assert (
        client.post(url + "/chat/messages", json={"content": "another"}).status_code
        == 202
    )
    factory = sessionmaker(bind=client.test_engine, expire_on_commit=False)
    ChatEngine(factory).recover()
    state = client.get(url + "/chat").json()
    assert state["conversation"]["status"] == "interrupted"
    assert state["messages"][-1]["state"] == "interrupted" and not provider.calls


def test_provider_error_is_persisted_and_authority_enforced(
    client, project, chat_agent, monkeypatch
):
    agent, provider = chat_agent
    url = base(project, agent)
    assert client.post(url + "/chat/messages", json={"content": ""}).status_code == 422
    assert (
        client.post(
            url + "/chat/messages",
            json={"content": "no"},
            headers={"X-Human-Key": "", "X-API-Key": "test-agent"},
        ).status_code
        == 403
    )
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "0")
    assert (
        client.post(
            url + "/chat/messages", json={"kind": "context_summary"}
        ).status_code
        == 409
    )
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    provider.fail = True
    assert (
        client.post(url + "/chat/messages", json={"content": "error"}).status_code
        == 202
    )
    state = client.get(url + "/chat").json()
    assert (
        state["conversation"]["status"] == "failed"
        and state["messages"][0]["state"] == "failed"
    )
    assert "disconnected" in state["conversation"]["error"]
    assert len(state["messages"]) == 1


def test_knowledge_inventory_reports_budget_limits(client, project, chat_agent):
    agent, _ = chat_agent
    for i in range(12):
        response = client.post(
            f"/api/projects/{project['id']}/memory",
            json={"content": str(i) + "ก" * 5000},
        )
        assert response.status_code == 201, response.text
    result = client.get(base(project, agent) + "/knowledge").json()
    assert result["inventory"]["truncated"]
    assert result["inventory"]["memory_included"] < result["inventory"]["memory_total"]
    assert sum(s["included_bytes"] for s in result["sources"]) <= 96000


def test_cancel_discards_late_provider_reply(client, project, chat_agent, monkeypatch):
    agent, _ = chat_agent
    started, release = threading.Event(), threading.Event()

    class LateProvider:
        def run(self, *_):
            started.set()
            assert release.wait(timeout=10)
            return RuntimeResult("Late response must not be committed")

    monkeypatch.setitem(ADAPTERS, "api", LateProvider())
    url = base(project, agent)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(
            client.post, url + "/chat/messages", json={"content": "wait"}
        )
        assert started.wait(timeout=10)
        try:
            assert client.post(url + "/chat/cancel").status_code == 200
        finally:
            release.set()
        assert pending.result(timeout=10).status_code == 202
    state = client.get(url + "/chat").json()
    assert len(state["messages"]) == 1
    assert state["messages"][0]["state"] == "cancelled"


def test_only_this_agents_project_work_is_available(
    client, project, task, chat_agent, monkeypatch
):
    from test_workflows import Provider, steps

    agent, _ = chat_agent
    specs = steps(client)
    for spec in specs:
        spec["agent_id"] = agent["id"]
    monkeypatch.setitem(ADAPTERS, "api", Provider())
    result = client.post(
        f"/api/tasks/{task['id']}/workflows", json={"version": 1, "steps": specs}
    )
    assert result.status_code == 202, result.text
    context = client.get(base(project, agent) + "/knowledge").json()
    assert context["inventory"]["agent_artifacts_total"] == 3
    artifacts = [s for s in context["sources"] if s["id"].startswith("artifact:")]
    assert len(artifacts) == 3 and all(not s["human_reviewed"] for s in artifacts)
    other = client.get("/api/agents").json()[-1]
    if other["id"] == agent["id"]:
        other = client.get("/api/agents").json()[0]
    assert (
        client.get(base(project, other) + "/knowledge").json()["inventory"][
            "agent_artifacts_total"
        ]
        == 0
    )
