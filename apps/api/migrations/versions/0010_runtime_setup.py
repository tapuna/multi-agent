"""Explicit runtime setup, enablement and verified availability."""

from alembic import op
import sqlalchemy as sa
from control.types import JSONDocument

revision = "0010"
down_revision = "0009"


def upgrade():
    op.create_table(
        "runtime_configurations",
        sa.Column("runtime", sa.String(30), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("probe_model", sa.String(150), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("verified_hash", sa.String(64)),
        sa.Column("result", JSONDocument(), nullable=False),
    )


def downgrade():
    raise RuntimeError("Destructive downgrade disabled")
