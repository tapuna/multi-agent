"""Initial control-center schema and append-only audit guard."""

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from control.types import JSONDocument

revision = "0001"
down_revision = None


def upgrade():
    if op.get_bind().dialect.name not in {
        "postgresql",
        "firebird.firebird",
        "firebird",
    }:
        raise RuntimeError("Unsupported database dialect")
    pg = op.get_bind().dialect.name == "postgresql"
    if pg:
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("key", sa.String(10), unique=True, nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
    )
    op.create_table(
        "agents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("role", sa.String(100), nullable=False),
        sa.Column("runtime", sa.String(30), nullable=False),
        sa.Column("model", sa.String(150), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id", sa.String(36), sa.ForeignKey("projects.id"), nullable=False
        ),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("priority", sa.String(20), nullable=False),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("agents.id")),
        sa.Column("sprint", sa.String(80)),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_id", "number"),
        sa.CheckConstraint(
            "status IN ('backlog','todo','in_progress','review','done')",
            name="task_status",
        ),
        sa.CheckConstraint(
            "priority IN ('low','medium','high','urgent')", name="task_priority"
        ),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])
    op.create_index("ix_tasks_status", "tasks", ["status"])
    op.create_table(
        "dependencies",
        sa.Column(
            "task_id", sa.String(36), sa.ForeignKey("tasks.id"), primary_key=True
        ),
        sa.Column(
            "depends_on_id", sa.String(36), sa.ForeignKey("tasks.id"), primary_key=True
        ),
        sa.CheckConstraint("task_id != depends_on_id"),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id")),
        sa.Column("actor", sa.String(100), nullable=False),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("payload", JSONDocument(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_events_task_id", "audit_events", ["task_id"])
    op.create_table(
        "agent_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id"), nullable=False),
        sa.Column(
            "agent_id", sa.String(36), sa.ForeignKey("agents.id"), nullable=False
        ),
        sa.Column("provider_session_id", sa.String(250)),
        sa.Column("workspace_path", sa.Text(), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("context_snapshot", JSONDocument(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_agent_sessions_task_id", "agent_sessions", ["task_id"])
    op.create_table(
        "project_memories",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id", sa.String(36), sa.ForeignKey("projects.id"), nullable=False
        ),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(1536) if pg else JSONDocument()),
    )
    op.create_index(
        "ix_project_memories_project_id", "project_memories", ["project_id"]
    )
    op.create_table(
        "approvals",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id"), nullable=False),
        sa.Column("task_version", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("actor", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_approvals_task_id", "approvals", ["task_id"])
    if pg:
        op.execute(
            "CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END; $$"
        )
        op.execute(
            "CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation()"
        )
        op.execute(
            "CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation()"
        )
    elif op.get_bind().dialect.name.startswith("firebird"):
        op.execute("CREATE EXCEPTION audit_protected 'Audit records are append-only'")
        op.execute(
            "CREATE TRIGGER audit_immutable FOR audit_events ACTIVE BEFORE UPDATE OR DELETE POSITION 0 AS BEGIN EXCEPTION audit_protected; END"
        )


def downgrade():
    raise RuntimeError(
        "Destructive downgrade disabled; restore a reviewed backup instead"
    )
