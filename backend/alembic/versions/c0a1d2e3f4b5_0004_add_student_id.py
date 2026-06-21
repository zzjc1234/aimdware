"""0004 add student_id to users

Roster 学号. Nullable and not unique — rosters may carry blanks and we don't
want a stray duplicate to fail a batch import. jaccount stays the identity.

Revision ID: c0a1d2e3f4b5
Revises: b984da6ac5c5
Create Date: 2026-06-21 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel  # noqa: F401  (kept for autogen-friendly imports)


revision: str = "c0a1d2e3f4b5"
down_revision: Union[str, Sequence[str], None] = "b984da6ac5c5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("student_id", sqlmodel.sql.sqltypes.AutoString(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("student_id")
