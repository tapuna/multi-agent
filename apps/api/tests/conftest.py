from pathlib import Path
import pytest
from alembic.config import Config
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy.engine import URL
from sqlalchemy.orm import sessionmaker
from control.main import app
from control.db import get_db
from control.database_config import ensure_database, make_engine


@pytest.fixture
def client(tmp_path, monkeypatch):
    url = URL.create(
        "firebird+firebird",
        username="SYSDBA",
        database=str(tmp_path / "test.fdb"),
        query={"charset": "UTF8"},
    ).render_as_string(hide_password=False)
    monkeypatch.setenv("DATABASE_URL", url)
    ensure_database(url)
    monkeypatch.setenv("CONTROL_API_KEY", "test-agent")
    monkeypatch.setenv("CONTROL_HUMAN_KEY", "test-human")
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.delenv("ARTIFACT_S3_BUCKET", raising=False)
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "migrations")
    )
    command.upgrade(config, "head")
    engine = make_engine(url)

    factory = sessionmaker(bind=engine, expire_on_commit=False)
    # Provider-specific tests use stub adapters; runtime lifecycle is exercised separately.
    import control.runtime_registry as runtime_registry

    original_availability = runtime_registry.availability
    monkeypatch.setattr(
        runtime_registry,
        "availability",
        lambda db, runtime, model=None: {
            "runtime": runtime,
            "available": True,
            "installed": True,
            "enabled": True,
            "version": 1,
            "probe_model": "test-model",
            "status": "available",
            "reason": "Verified test fixture",
            "result": {},
        },
    )

    def override():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = override
    with TestClient(app, headers={"X-Human-Key": "test-human"}) as c:
        c.test_engine = engine
        c.runtime_availability_original = original_availability
        yield c
    app.dependency_overrides.clear()
    engine.dispose()


@pytest.fixture
def project(client):
    result = client.post("/api/projects", json={"name": "Platform", "key": "PLAT"})
    assert result.status_code == 201
    return result.json()


@pytest.fixture
def task(client, project):
    return client.post(
        "/api/tasks", json={"project_id": project["id"], "title": "Ship a feature"}
    ).json()
