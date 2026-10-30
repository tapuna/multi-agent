"""Database bootstrap/configuration; Firebird Embedded needs no system service."""

import os
from importlib.metadata import entry_points
from pathlib import Path
from threading import Lock
from sqlalchemy import create_engine, event
from sqlalchemy.engine import URL, make_url

ROOT = next(
    (
        p
        for p in Path(__file__).resolve().parents
        if (p / "contexts" / "company").is_dir()
    ),
    Path(__file__).resolve().parents[1],
)
from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=False)
DATA_ROOT = Path(os.getenv("CONTROL_DATA_DIR", str(ROOT / ".data"))).resolve()
_lock = Lock()
_loaded = False
SUPPORTED_DRIVERS = frozenset({"firebird+firebird", "postgresql+psycopg"})


def validate_database_url(url):
    parsed = make_url(url)
    if parsed.drivername not in SUPPORTED_DRIVERS:
        raise ValueError(
            "Unsupported database driver. Use firebird+firebird (default) or postgresql+psycopg."
        )
    return parsed


def database_url():
    url = os.getenv("DATABASE_URL") or URL.create(
        "firebird+firebird",
        username="SYSDBA",
        database=str(DATA_ROOT / "control.fdb"),
        query={"charset": "UTF8"},
    ).render_as_string(hide_password=False)
    validate_database_url(url)
    return url


def configure_driver(url):
    global _loaded
    parsed = validate_database_url(url)
    if not parsed.drivername.startswith("firebird") or parsed.host:
        return
    with _lock:
        if not _loaded:
            from firebird.driver import load_api

            lock_root = Path(
                os.getenv("FIREBIRD_LOCK", str(DATA_ROOT / "firebird-lock"))
            ).resolve()
            lock_root.mkdir(parents=True, exist_ok=True)
            # Shared by every process in this application; no ProgramData/admin install.
            os.environ["FIREBIRD_LOCK"] = str(lock_root)
            provider = next(
                ep
                for ep in entry_points(group="firebird.runtime.providers")
                if ep.name == "firebird"
            ).load()()
            load_api(provider)
            _loaded = True


def ensure_database(url=None):
    """Create a new embedded file only; never replace or reinitialize a database."""
    url = url or database_url()
    parsed = validate_database_url(url)
    configure_driver(url)
    if parsed.drivername.startswith("firebird") and not parsed.host:
        from firebird.driver import create_database

        path = Path(parsed.database).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with create_database(
                str(path), user=parsed.username or "SYSDBA", charset="UTF8"
            ):
                pass
    return url


def firebird_lock_timeout_seconds():
    try:
        seconds = int(os.getenv("FIREBIRD_LOCK_TIMEOUT_SECONDS", "5"))
    except ValueError as exc:
        raise ValueError(
            "FIREBIRD_LOCK_TIMEOUT_SECONDS must be an integer from 1 to 10"
        ) from exc
    # Leave room inside the frontend proxy's 15-second request budget.
    if not 1 <= seconds <= 10:
        raise ValueError(
            "FIREBIRD_LOCK_TIMEOUT_SECONDS must be an integer from 1 to 10"
        )
    return seconds


def make_engine(url, **kwargs):
    configure_driver(url)
    seconds = firebird_lock_timeout_seconds() if url.startswith("firebird") else None
    engine = create_engine(url, pool_pre_ping=True, **kwargs)
    if seconds is not None:
        from firebird.driver import tpb, Isolation

        params = tpb(Isolation.READ_COMMITTED_RECORD_VERSION, lock_timeout=seconds)

        @event.listens_for(engine, "checkout")
        def configure_transaction(connection, _record, _proxy):
            # Pre-ping can open a driver transaction. Checkout has no user work yet.
            if connection.is_active():
                connection.rollback()
            connection.default_tpb = params
            connection.main_transaction.default_tpb = params

    return engine
