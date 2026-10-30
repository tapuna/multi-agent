import pytest
from sqlalchemy import text
from sqlalchemy.exc import DatabaseError


def patch(client, task, **changes):
    return client.patch(
        f"/api/tasks/{task['id']}", json={"version": task["version"], **changes}
    )


def test_persistence_and_atomic_audit(client, project, task):
    tasks = client.get("/api/tasks", params={"project_id": project["id"]}).json()
    assert tasks[0]["title"] == "Ship a feature"
    updated = patch(client, task, title="Implemented feature").json()
    assert updated["version"] == 2
    detail = client.get(f"/api/tasks/{task['id']}").json()
    event = next(e for e in detail["events"] if e["action"] == "task.updated")
    assert event["payload"]["before"]["title"] == "Ship a feature"
    assert event["payload"]["after"]["title"] == "Implemented feature"


def test_stale_write_and_invalid_transition_leave_no_event(client, task):
    assert patch(client, task, status="done").status_code == 409
    assert patch(client, task, status="todo").status_code == 200
    assert patch(client, task, title="stale").status_code == 409
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert len(detail["events"]) == 2


def test_dependencies_cycle_and_blocking(client, project, task):
    other = client.post(
        "/api/tasks", json={"project_id": project["id"], "title": "Dependency"}
    ).json()
    assert (
        client.post(
            f"/api/tasks/{task['id']}/dependencies", json={"depends_on_id": other["id"]}
        ).status_code
        == 201
    )
    assert (
        client.post(
            f"/api/tasks/{other['id']}/dependencies", json={"depends_on_id": task["id"]}
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/tasks/{other['id']}/dependencies",
            json={"depends_on_id": other["id"]},
        ).status_code
        == 409
    )
    current = client.get(f"/api/tasks/{task['id']}").json()["task"]
    current = patch(client, current, status="todo").json()
    assert patch(client, current, status="in_progress").status_code == 409


def test_agent_cannot_approve_or_complete(client, task):
    current = task
    for status in ("todo", "in_progress", "review"):
        response = patch(client, current, status=status)
        assert response.status_code == 200
        current = response.json()
    client.headers.pop("X-Human-Key")
    client.headers["X-API-Key"] = "test-agent"
    assert patch(client, current, status="done").status_code == 403
    assert (
        client.post(
            f"/api/tasks/{task['id']}/approvals",
            json={"kind": "merge", "version": current["version"]},
        ).status_code
        == 403
    )
    client.headers["X-Human-Key"] = "test-human"
    response = patch(client, current, status="done")
    assert response.status_code == 200
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["approvals"][0]["kind"] == "complete"


def test_audit_append_only_at_database(client, task):
    with client.test_engine.connect() as connection:
        for sql in (
            "UPDATE audit_events SET actor='forged'",
            "DELETE FROM audit_events",
        ):
            with pytest.raises(DatabaseError):
                connection.execute(text(sql))
            connection.rollback()


def test_auth_validation_and_unknown_records(client, task):
    client.headers.pop("X-Human-Key")
    assert client.get("/api/projects").status_code == 401
    client.headers["X-Human-Key"] = "test-human"
    assert client.get("/api/tasks/missing").status_code == 404
    assert patch(client, task, title=None).status_code == 422
    assert patch(client, task, title=" ").status_code == 422
    assert patch(client, task, status="invalid").status_code == 422
    assert patch(client, task, assignee_id="missing").status_code == 404


def test_approval_scoped_to_version(client, task):
    assert (
        client.post(
            f"/api/tasks/{task['id']}/approvals", json={"kind": "merge", "version": 1}
        ).status_code
        == 201
    )
    current = patch(client, task, title="new revision").json()
    assert current["version"] == 2
    assert (
        client.post(
            f"/api/tasks/{task['id']}/approvals", json={"kind": "deploy", "version": 1}
        ).status_code
        == 409
    )


def test_cross_project_dependency(client, task):
    p = client.post("/api/projects", json={"name": "Other", "key": "OT"}).json()
    other = client.post(
        "/api/tasks", json={"project_id": p["id"], "title": "Other task"}
    ).json()
    assert (
        client.post(
            f"/api/tasks/{task['id']}/dependencies", json={"depends_on_id": other["id"]}
        ).status_code
        == 422
    )


def test_duplicate_project_has_clean_conflict_response(client, project):
    response = client.post(
        "/api/projects", json={"name": "Duplicate", "key": project["key"]}
    )
    assert response.status_code == 409
    assert len(client.get("/api/projects").json()) == 1
