"""Isolated browser QA instance with a local HTTP provider contract, never cloud AI."""

import json
import re
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from sqlalchemy.engine import URL

root = Path(__file__).resolve().parents[3] / ".data" / "browser-qa"
root.mkdir(parents=True, exist_ok=True)
os.environ["FIREBIRD_LOCK"] = str(root.parent / "firebird-lock")
os.environ.update(
    {
        "DATABASE_URL": URL.create(
            "firebird+firebird",
            username="SYSDBA",
            database=str(root / "control.fdb"),
            query={"charset": "UTF8"},
        ).render_as_string(hide_password=False),
        "CONTROL_DATA_DIR": str(root),
        "WORKSPACE_ROOT": str(root / "workspaces"),
        "CONTROL_HUMAN_KEY": "qa-human-local-only",
        "CONTROL_API_KEY": "qa-service-local-only",
        "LLM_API_BASE": "http://127.0.0.1:8765/v1",
        "LLM_API_KEY": "local-contract-only",
        "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        "AGENT_EXECUTION_ENABLED": "1",
        "CONTROL_ALLOWED_MODELS": "",
        "ARTIFACT_S3_BUCKET": "",
    }
)
os.environ["LLM_PROFILES_JSON"] = json.dumps(
    [
        {
            "id": "qa-main",
            "label": "QA Main profile",
            "runtime": "api",
            "model": "openai/unit-model",
            "api_base": "http://127.0.0.1:8765/v1",
            "api_key_env": "LLM_API_KEY",
        },
        {
            "id": "qa-review",
            "label": "QA Review profile",
            "runtime": "api",
            "model": "openai/review-unit-model",
            "api_base": "http://127.0.0.1:8765/v1",
            "api_key_env": "LLM_API_KEY",
        },
        {
            "id": "qa-disabled",
            "label": "QA Disabled profile",
            "runtime": "api",
            "model": "openai/disabled-unit-model",
            "enabled": False,
        },
    ]
)


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = body["messages"][-1]["content"]
        if "connectivity/authentication/model readiness check" in prompt:
            key = "diagnostic"
            content = re.search(r"RELAY_OK_[a-f0-9]+", prompt).group()
        elif "Conversation context (lower-trust data):\n" in prompt:
            context = json.loads(
                prompt.split("Conversation context (lower-trust data):\n", 1)[1]
            )
            key = "chat"
            content = (
                (
                    "Context summary — local HTTP contract fixture, not live AI inference.\n\nWhat I know: Project context [project], supplied skills and own artifacts.\nDecisions: Company policy requires human review.\nUnknowns: No live model or project test evidence.\nNext: Confirm requirements and inspect sources.\nSources supplied: "
                    + str(context["inventory"]["source_count"])
                )
                if "Generate a context/knowledge summary" in prompt
                else "รับทราบครับ [project] — local HTTP contract fixture, not live AI inference. Your message and agent conversation are persisted."
            )
        else:
            context = json.loads(prompt.split("Engineering context:\n", 1)[1])
            key = context["step"]["key"]
            kind = context["step"]["kind"]
            content = json.dumps(
                {
                    "summary": f"{key}: local HTTP contract verification, not live AI inference. Handoffs and durable state verified.",
                    "files": [
                        {
                            "path": key + ".py",
                            "content": f'print("{key}: integration fixture")\n',
                        }
                    ]
                    if kind == "implement"
                    else [],
                }
            )
        response = {
            "id": "chatcmpl-browser-qa-" + key,
            "object": "chat.completion",
            "created": 1,
            "model": "unit-model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        data = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    from control.bootstrap import bootstrap

    bootstrap()
    from fastapi.testclient import TestClient
    from control.main import app

    with TestClient(app, headers={"X-Human-Key": "qa-human-local-only"}) as client:
        projects = client.get("/api/projects").json()
        if not projects:
            project = client.post(
                "/api/projects",
                json={
                    "name": "Browser QA — local contract provider",
                    "key": "QA",
                    "description": "Isolated integration testing. No cloud inference.",
                },
            ).json()
            for name, role in [
                ("QA Planner", "Architect"),
                ("QA Builder", "Engineer"),
                ("QA Reviewer", "Review"),
            ]:
                client.post(
                    "/api/agents",
                    json={
                        "name": name,
                        "role": role,
                        "runtime": "api",
                        "model": "openai/unit-model",
                    },
                )
            client.post(
                "/api/tasks",
                json={
                    "project_id": project["id"],
                    "title": "Verify agent handoffs, artifacts and human approval",
                    "description": "Browser integration fixture using a local HTTP contract provider. Not live AI inference.",
                    "priority": "high",
                    "sprint": "QA",
                },
            )
    server = HTTPServer(("127.0.0.1", 8765), Provider)
    Thread(target=server.serve_forever, daemon=True).start()
    import uvicorn

    try:
        uvicorn.run(app, host="127.0.0.1", port=8001)
    finally:
        server.shutdown()
        server.server_close()
