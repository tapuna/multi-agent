from pathlib import Path
import os
import subprocess
import sys
from unittest.mock import patch
import pytest
from sqlalchemy import select
from control.database_config import database_url, ensure_database, make_engine
from control.models import Task, AuditEvent


def test_system_reports_firebird_and_protects_credentials(client):
    result = client.get("/api/system")
    assert result.status_code == 200
    assert result.json()["database"] == "firebird"
    assert result.json()["database_mode"] == "embedded"
    assert result.json()["database_version"][0] == 5
    assert result.json()["lock_timeout_seconds"] == 5
    client.headers.pop("X-Human-Key")
    assert client.get("/api/system").status_code == 401


def test_unicode_json_and_task_persist_after_new_engine_connection(client, task):
    description = ("ตรวจสอบข้อมูลภาษาไทย 🔧\n" * 500).strip()
    response = client.patch(
        f"/api/tasks/{task['id']}",
        json={"version": 1, "title": "งานภาษาไทย", "description": description},
    )
    assert response.status_code == 200
    engine = make_engine(client.test_engine.url.render_as_string(hide_password=False))
    try:
        with engine.connect() as connection:
            assert (
                connection.scalar(select(Task.description).where(Task.id == task["id"]))
                == description
            )
            payload = connection.scalar(
                select(AuditEvent.payload).where(
                    AuditEvent.task_id == task["id"],
                    AuditEvent.action == "task.updated",
                )
            )
            assert payload["after"]["description"] == description
            assert payload["version"] == 2
    finally:
        engine.dispose()


def test_existing_firebird_database_is_not_recreated(client, task):
    url = client.test_engine.url.render_as_string(hide_password=False)
    file = Path(client.test_engine.url.database)
    assert file.suffix == ".fdb" and file.is_file()
    assert ensure_database(url) == url
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["task"]["id"] == task["id"]
    assert detail["task"]["version"] == 1
    assert len(detail["events"]) == 1


@pytest.mark.parametrize("driver", ["mysql+pymysql", "mssql+pyodbc", "oracle+oracledb"])
def test_unsupported_database_urls_fail_before_any_connection_or_file_creation(
    tmp_path, monkeypatch, driver
):
    file = tmp_path / "unsupported-store"
    url = f"{driver}:///{file.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    with patch("control.database_config.create_engine") as create:
        for action in (
            database_url,
            lambda: ensure_database(url),
            lambda: make_engine(url),
        ):
            with pytest.raises(ValueError, match="Unsupported database driver"):
                action()
        create.assert_not_called()
    assert not file.exists()


def test_startup_rejects_unsupported_url_without_fallback(tmp_path):
    file = tmp_path / "must-not-be-created"
    environment = os.environ.copy()
    environment["DATABASE_URL"] = f"mysql+pymysql:///{file.as_posix()}"
    result = subprocess.run(
        [sys.executable, "-m", "control.bootstrap"],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert "Unsupported database driver" in result.stderr
    assert not file.exists()
