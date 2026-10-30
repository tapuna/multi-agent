"""Durable local workflow metadata, event stream, immutable artifacts."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0003"
down_revision = "0002"


def upgrade():
    op.create_table(
        "workflow_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id"), nullable=False),
        sa.Column(
            "active_task_id", sa.String(36), sa.ForeignKey("tasks.id"), unique=True
        ),
        sa.Column("task_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("agents", JSONDocument(), nullable=False),
        sa.Column("context_snapshot", JSONDocument(), nullable=False),
        sa.Column("workspace_path", sa.Text(), nullable=False),
        sa.Column("decision", JSONDocument()),
        sa.Column("result_digest", sa.String(64)),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_workflow_runs_task_id", "workflow_runs", ["task_id"])
    op.create_index("ix_workflow_runs_status", "workflow_runs", ["status"])
    op.create_table(
        "run_events",
        sa.Column("sequence", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("workflow_runs.id"), nullable=False
        ),
        sa.Column("kind", sa.String(80), nullable=False),
        sa.Column("stage", sa.String(30)),
        sa.Column("payload", JSONDocument(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_run_events_run_id", "run_events", ["run_id"])
    op.create_table(
        "run_artifacts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("workflow_runs.id"), nullable=False
        ),
        sa.Column("stage", sa.String(30), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("provider_response_id", sa.String(250)),
        sa.Column("usage", JSONDocument(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_id", "stage"),
    )
    op.create_index("ix_run_artifacts_run_id", "run_artifacts", ["run_id"])
    if op.get_bind().dialect.name == "postgresql":
        for table in ("run_events", "run_artifacts"):
            op.execute(
                f"CREATE TRIGGER {table}_immutable BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation()"
            )
            op.execute(
                f"CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation()"
            )
    elif op.get_bind().dialect.name.startswith("firebird"):
        for table in ("run_events", "run_artifacts"):
            op.execute(
                f"CREATE TRIGGER {table}_immutable FOR {table} ACTIVE BEFORE UPDATE OR DELETE POSITION 0 AS BEGIN EXCEPTION audit_protected; END"
            )


def downgrade():
    raise RuntimeError(
        "Destructive downgrade disabled; restore a reviewed backup instead"
    )
