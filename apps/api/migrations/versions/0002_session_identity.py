"""Prevent provider sessions from leaking between task sessions for an agent."""

from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    op.create_unique_constraint(
        "uq_agent_provider_session",
        "agent_sessions",
        ["agent_id", "provider_session_id"],
    )


def downgrade():
    raise RuntimeError(
        "Destructive downgrade disabled; restore a reviewed backup instead"
    )
