"""Project workflow templates and inheritable task selection."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0006"
down_revision = "0005"


def upgrade():
    op.create_table(
        "workflow_templates",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id", sa.String(36), sa.ForeignKey("projects.id"), nullable=False
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("steps", JSONDocument(), nullable=False),
    )
    op.create_index(
        "ix_workflow_templates_project_id", "workflow_templates", ["project_id"]
    )
    if op.get_bind().dialect.name.startswith("firebird"):
        op.execute("ALTER TABLE projects ADD default_workflow_id VARCHAR(36)")
        op.execute(
            "ALTER TABLE projects ADD workflow_config_version INTEGER DEFAULT 1 NOT NULL"
        )
        op.execute("ALTER TABLE tasks ADD workflow_template_id VARCHAR(36)")
    else:
        op.add_column("projects", sa.Column("default_workflow_id", sa.String(36)))
        op.add_column(
            "projects",
            sa.Column(
                "workflow_config_version",
                sa.Integer(),
                server_default="1",
                nullable=False,
            ),
        )
        op.add_column("tasks", sa.Column("workflow_template_id", sa.String(36)))


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
