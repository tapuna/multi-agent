from time import monotonic
import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import sessionmaker
from control.database_config import make_engine, firebird_lock_timeout_seconds
from control.db import get_db
from control.models import Task


def test_lock_timeout_default(monkeypatch):
    monkeypatch.delenv("FIREBIRD_LOCK_TIMEOUT_SECONDS", raising=False)
    assert firebird_lock_timeout_seconds() == 5


@pytest.mark.parametrize("value", ["0", "-1", "11", "invalid"])
def test_reject_invalid_lock_timeouts(monkeypatch, value):
    monkeypatch.setenv("FIREBIRD_LOCK_TIMEOUT_SECONDS", value)
    with pytest.raises(ValueError, match="integer from 1 to 10"):
        firebird_lock_timeout_seconds()


def test_native_timeout_applies_after_commit_and_pool_reuse(client, task):
    for _ in range(2):
        with client.test_engine.connect() as connection:
            for _ in range(2):
                connection.execute(select(Task.id))
                raw = connection.connection.driver_connection
                assert raw.main_transaction.info.lock_timeout == 5
                connection.commit()


def test_contended_update_times_out_without_audit_or_partial_write(
    client, task, monkeypatch
):
    monkeypatch.setenv("FIREBIRD_LOCK_TIMEOUT_SECONDS", "1")
    contender = make_engine(
        client.test_engine.url.render_as_string(hide_password=False)
    )
    factory = sessionmaker(bind=contender, expire_on_commit=False)
    previous = client.app.dependency_overrides[get_db]

    def override():
        with factory() as db:
            yield db

    client.app.dependency_overrides[get_db] = override
    try:
        before = client.get(f"/api/tasks/{task['id']}").json()
        with client.test_engine.connect() as blocker:
            blocker.execute(
                update(Task)
                .where(Task.id == task["id"])
                .values(title="uncommitted competing edit")
            )
            started = monotonic()
            response = client.patch(
                f"/api/tasks/{task['id']}",
                json={"version": 1, "title": "must not be written"},
            )
            elapsed = monotonic() - started
            assert response.status_code == 409, response.text
            assert response.json()["code"] == "database_busy"
            assert response.headers["retry-after"] == "1"
            assert 0.5 <= elapsed < 6
            blocker.rollback()
        after = client.get(f"/api/tasks/{task['id']}").json()
        assert after["task"]["title"] == task["title"]
        assert after["task"]["version"] == 1
        assert len(after["events"]) == len(before["events"])
        # Failed request is closed/rolled back; a subsequent save can use the pool.
        assert (
            client.patch(
                f"/api/tasks/{task['id']}",
                json={"version": 1, "title": "saved after release"},
            ).status_code
            == 200
        )
    finally:
        client.app.dependency_overrides[get_db] = previous
        contender.dispose()
