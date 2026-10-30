"""Firebird UNIQUE composites treat partially NULL keys as duplicates."""

from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade():
    if op.get_bind().dialect.name.startswith("firebird"):
        op.drop_constraint(
            "uq_agent_provider_session", "agent_sessions", type_="unique"
        )
        # All unbound sessions yield an entirely NULL key; bound identities remain unique.
        op.execute(
            "CREATE UNIQUE INDEX uq_agent_provider_bound ON agent_sessions COMPUTED BY (CASE WHEN provider_session_id IS NOT NULL THEN agent_id || ':' || provider_session_id ELSE NULL END)"
        )


def downgrade():
    raise RuntimeError(
        "Destructive downgrade disabled; restore a reviewed backup instead"
    )
