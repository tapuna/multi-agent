"""Agent conversations and evidence-bound context summaries."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0007"
down_revision = "0006"


def upgrade():
    op.create_table(
        "agent_conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id", sa.String(36), sa.ForeignKey("projects.id"), nullable=False
        ),
        sa.Column(
            "agent_id", sa.String(36), sa.ForeignKey("agents.id"), nullable=False
        ),
        sa.Column("provider_session_id", sa.String(250)),
        sa.Column("binding_hash", sa.String(64)),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("active_message_id", sa.String(36)),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_id", "agent_id"),
    )
    for key in ("project_id", "agent_id"):
        op.create_index(f"ix_agent_conversations_{key}", "agent_conversations", [key])
    op.create_table(
        "agent_messages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("agent_conversations.id"),
            nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("context_snapshot", JSONDocument(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("conversation_id", "sequence"),
    )
    op.create_index(
        "ix_agent_messages_conversation_id", "agent_messages", ["conversation_id"]
    )


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
