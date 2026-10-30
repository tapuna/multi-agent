"""Run only against a disposable, migrated database (CI)."""

from uuid import uuid4
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DatabaseError
from control.main import app
from control.db import engine
import os

with TestClient(
    app, headers={"X-Human-Key": os.environ["CONTROL_HUMAN_KEY"]}
) as client:
    assert client.get("/health").status_code == 200
    p = client.post(
        "/api/projects",
        json={"name": "CI integration", "key": "CI" + uuid4().hex[:6].upper()},
    )
    assert p.status_code == 201, p.text
    t = client.post(
        "/api/tasks",
        json={"project_id": p.json()["id"], "title": "PostgreSQL persistence"},
    )
    assert t.status_code == 201, t.text
    assert (
        client.patch(
            "/api/tasks/" + t.json()["id"], json={"version": 1, "status": "todo"}
        ).status_code
        == 200
    )
    assert client.get("/api/tasks/" + t.json()["id"]).json()["events"]
with engine.connect() as connection:
    assert (
        connection.scalar(
            text("SELECT extname FROM pg_extension WHERE extname='vector'")
        )
        == "vector"
    )
    try:
        connection.execute(text("DELETE FROM audit_events"))
    except DatabaseError:
        connection.rollback()
    else:
        raise AssertionError("Audit mutation was not rejected")
print("PostgreSQL + pgvector smoke passed")
