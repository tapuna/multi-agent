"""Verify each environment-owned LLM profile independently."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0011"
down_revision = "0010"


def upgrade():
    op.create_table(
        "llm_readiness",
        sa.Column("profile_id", sa.String(50), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("config_hash", sa.String(64), nullable=False),
        sa.Column("latency_ms", sa.Integer()),
        sa.Column("tested_at", sa.DateTime(timezone=True)),
        sa.Column("result", JSONDocument(), nullable=False),
    )


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
