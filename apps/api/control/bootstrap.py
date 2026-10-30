"""Create a missing embedded database and apply migrations; never overwrite data."""

from pathlib import Path
from alembic import command
from alembic.config import Config
from .database_config import ensure_database


def bootstrap():
    ensure_database()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    command.upgrade(config, "head")
    print("Database ready; existing records preserved.")


if __name__ == "__main__":
    bootstrap()
