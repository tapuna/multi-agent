"""Real HTTP/LiteLLM transport against a local contract server; no cloud inference."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


def test_litellm_http_to_workflow_artifacts_and_review_gate(client, task, monkeypatch):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            context = json.loads(
                request["messages"][-1]["content"].split("Engineering context:\n", 1)[1]
            )
            kind = context["step"]["kind"]
            output = {
                "summary": "Local HTTP provider contract response",
                "files": [{"path": "generated.py", "content": 'print("generated")\n'}]
                if kind == "implement"
                else [],
            }
            response = {
                "id": "chatcmpl-local-contract",
                "object": "chat.completion",
                "created": 1,
                "model": "unit-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": json.dumps(output)},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
            data = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("LLM_API_BASE", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setenv("LLM_API_KEY", "local-contract-only")
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    monkeypatch.delenv("ARTIFACT_S3_BUCKET", raising=False)
    monkeypatch.delenv("CONTROL_ALLOWED_MODELS", raising=False)
    monkeypatch.setenv("AGENT_EXECUTION_ENABLED", "1")
    try:
        agent = client.post(
            "/api/agents",
            json={
                "name": "HTTP Agent",
                "role": "Engineering",
                "runtime": "api",
                "model": "openai/unit-model",
            },
        ).json()
        response = client.post(
            f"/api/tasks/{task['id']}/workflows",
            json={
                "version": 1,
                "steps": [
                    {"key": "implement", "kind": "implement", "agent_id": agent["id"]},
                    {
                        "key": "review",
                        "kind": "review",
                        "agent_id": agent["id"],
                        "depends_on": ["implement"],
                    },
                ],
            },
        )
        assert response.status_code == 202, response.text
        detail = client.get("/api/workflows/" + response.json()["id"]).json()
        assert detail["run"]["status"] == "awaiting_approval", detail["run"].get(
            "error"
        )
        assert len(requests) == 2
        assert all(
            "MANDATORY COMPANY POLICY" in r["messages"][-1]["content"] for r in requests
        )
        assert (
            detail["artifacts"][0]["provider_response_id"] == "chatcmpl-local-contract"
        )
        assert all(s["provider_session_id"] is None for s in detail["steps"])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
