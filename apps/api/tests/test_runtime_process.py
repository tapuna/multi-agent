import json
import sys
import time
import pytest
from control.runtime import CLIAdapter, RuntimeRequest


def test_cli_stream_parser_persists_session_and_filters_credentials(
    tmp_path, monkeypatch
):
    script = tmp_path / "provider.py"
    script.write_text("""import json,os,sys
prompt=sys.stdin.read()
print(os.environ.get('OPENAI_API_KEY',''),file=sys.stderr,flush=True)
print(json.dumps({'type':'thread.started','thread_id':'provider-session-real-format'}),flush=True)
answer={'summary':'answer','files':[]}
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(answer)}}),flush=True)
with open('environment-result.json','w') as file: json.dump({'control_present':'CONTROL_HUMAN_KEY' in os.environ,'aws_present':'AWS_SECRET_ACCESS_KEY' in os.environ,'provider_present':'OPENAI_API_KEY' in os.environ},file)
""")
    monkeypatch.setenv("CONTROL_HUMAN_KEY", "private-human-authority")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "private-storage-key")
    monkeypatch.setenv("OPENAI_API_KEY", "private-provider-key")
    monkeypatch.setattr("control.runtime.executable", lambda _: sys.executable)
    adapter = CLIAdapter("codex")
    monkeypatch.setattr(
        adapter, "command", lambda request: [sys.executable, str(script)]
    )
    events = []
    result = adapter.run(
        RuntimeRequest("Prompt", tmp_path, "configured-model"),
        lambda kind, data: events.append((kind, data)),
        lambda: None,
    )
    assert result.provider_session_id == "provider-session-real-format"
    assert json.loads(result.content)["summary"] == "answer"
    assert json.loads((tmp_path / "environment-result.json").read_text()) == {
        "control_present": False,
        "aws_present": False,
        "provider_present": True,
    }
    assert "private-provider-key" not in json.dumps(events)


def test_cli_deadline_applies_when_provider_never_reads_large_stdin(
    tmp_path, monkeypatch
):
    script = tmp_path / "blocked_provider.py"
    script.write_text("import time\ntime.sleep(60)\n")
    monkeypatch.setenv("AGENT_RUNTIME_TIMEOUT_SECONDS", "1")
    monkeypatch.setattr("control.runtime.executable", lambda _: sys.executable)
    adapter = CLIAdapter("codex")
    monkeypatch.setattr(
        adapter, "command", lambda request: [sys.executable, str(script)]
    )
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="deadline"):
        adapter.run(
            RuntimeRequest("x" * 1000000, tmp_path, "configured-model"),
            lambda *_: None,
            lambda: None,
        )
    assert time.monotonic() - started < 10
