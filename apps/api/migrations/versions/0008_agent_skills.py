"""Agent-owned, version-pinned skill configuration."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0008"
down_revision = "0007"


def upgrade():
    if op.get_bind().dialect.name.startswith("firebird"):
        op.execute(
            "ALTER TABLE agents ADD skill_refs BLOB SUB_TYPE TEXT DEFAULT '[]' NOT NULL"
        )
        op.execute("ALTER TABLE agents ADD skills_version INTEGER DEFAULT 1 NOT NULL")
    else:
        op.add_column(
            "agents",
            sa.Column(
                "skill_refs", JSONDocument(), nullable=False, server_default="'[]'"
            ),
        )
        op.add_column(
            "agents",
            sa.Column(
                "skills_version", sa.Integer(), nullable=False, server_default="1"
            ),
        )


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
