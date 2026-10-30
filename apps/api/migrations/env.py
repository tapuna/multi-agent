from alembic import context
from sqlalchemy import pool, Table, Column, String, MetaData
from control.models import Base
from control.database_config import database_url, make_engine
import control.alembic_firebird  # noqa: F401 -- register external dialect DDL

config = context.config
config.set_main_option(
    "sqlalchemy.url",
    database_url().replace("%", "%%"),
)
if context.is_offline_mode():
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=Base.metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = make_engine(
        database_url(),
        poolclass=pool.NullPool,
    )
    with engine.connect() as connection:
        if connection.dialect.name.startswith("firebird"):
            # Firebird needs committed metadata before DML can address a new table.
            Table(
                "alembic_version",
                MetaData(),
                Column("version_num", String(32), primary_key=True),
            ).create(connection, checkfirst=True)
            connection.commit()
        context.configure(
            connection=connection,
            target_metadata=Base.metadata,
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()
