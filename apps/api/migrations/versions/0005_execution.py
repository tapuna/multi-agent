"""Executable workflows and native Firebird LangGraph persistence."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0005"
down_revision = "0004"


def upgrade():
    if op.get_bind().dialect.name.startswith("firebird"):
        op.execute("ALTER TABLE projects ADD repository_path BLOB SUB_TYPE TEXT")
    else:
        op.add_column("projects", sa.Column("repository_path", sa.Text()))
    op.create_table(
        "workflow_steps",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("workflow_runs.id"), nullable=False
        ),
        sa.Column("key", sa.String(40), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column(
            "agent_id", sa.String(36), sa.ForeignKey("agents.id"), nullable=False
        ),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("agent_sessions.id"),
            nullable=False,
        ),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("depends_on", JSONDocument(), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("runtime_state", JSONDocument(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("run_id", "key"),
    )
    op.create_index("ix_workflow_steps_run_id", "workflow_steps", ["run_id"])
    op.create_table(
        "graph_checkpoints",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "thread_id",
            sa.String(36),
            sa.ForeignKey("workflow_runs.id"),
            nullable=False,
        ),
        sa.Column("namespace", sa.String(200), nullable=False),
        sa.Column("checkpoint_id", sa.String(64), nullable=False),
        sa.Column("parent_id", sa.String(64)),
        sa.Column("data", JSONDocument(), nullable=False),
        sa.Column("metadata_data", JSONDocument(), nullable=False),
        sa.UniqueConstraint("thread_id", "namespace", "checkpoint_id"),
    )
    op.create_index(
        "ix_graph_checkpoints_thread_id", "graph_checkpoints", ["thread_id"]
    )
    op.create_table(
        "graph_writes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("identity_hash", sa.String(64), unique=True, nullable=False),
        sa.Column(
            "thread_id",
            sa.String(36),
            sa.ForeignKey("workflow_runs.id"),
            nullable=False,
        ),
        sa.Column("namespace", sa.String(200), nullable=False),
        sa.Column("checkpoint_id", sa.String(64), nullable=False),
        sa.Column("task_id", sa.String(100), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(200), nullable=False),
        sa.Column("data", JSONDocument(), nullable=False),
    )
    op.create_index("ix_graph_writes_thread_id", "graph_writes", ["thread_id"])


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
