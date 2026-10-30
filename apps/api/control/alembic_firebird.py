"""Alembic integration for the external SQLAlchemy Firebird dialect."""

from alembic.ddl.impl import DefaultImpl


class FirebirdImpl(DefaultImpl):
    __dialect__ = "firebird.firebird"
    transactional_ddl = True

    def version_table_impl(
        self, *, version_table, version_table_schema, version_table_pk, **kw
    ):
        # Firebird identifier limit applies to constraint names, not just tables.
        return super().version_table_impl(
            version_table=version_table,
            version_table_schema=version_table_schema,
            version_table_pk=version_table_pk,
            **kw,
        )
