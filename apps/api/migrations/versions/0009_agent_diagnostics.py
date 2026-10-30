"""Audited actual-provider readiness checks."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0009"
down_revision = "0008"


def upgrade():
    op.create_table(
        "agent_diagnostics",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "agent_id", sa.String(36), sa.ForeignKey("agents.id"), nullable=False
        ),
        sa.Column("active_agent_id", sa.String(36), unique=True),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("config_hash", sa.String(64), nullable=False),
        sa.Column("config_snapshot", JSONDocument(), nullable=False),
        sa.Column("result", JSONDocument(), nullable=False),
        sa.Column("latency_ms", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_agent_diagnostics_agent_id", "agent_diagnostics", ["agent_id"])


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
