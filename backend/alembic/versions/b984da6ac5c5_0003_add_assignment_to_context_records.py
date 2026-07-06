"""0003 add assignment to context_records

Free-form course-scoped label (homework slug / lab number / exam name).
The router config from this point on requires `assignment` alongside
`course`, so every new ContextRecord carries one.

For existing rows on an upgraded database: backfill to empty string so
the NOT NULL constraint holds.

Revision ID: b984da6ac5c5
Revises: 1cc659f78871
Create Date: 2026-05-14 14:32:39.058999
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel  # noqa: F401  (kept for autogen-friendly imports)


revision: str = 'b984da6ac5c5'
down_revision: Union[str, Sequence[str], None] = '1cc659f78871'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('context_records', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                'assignment',
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=False,
                server_default='',
            )
        )
        batch_op.create_index(
            batch_op.f('ix_context_records_assignment'),
            ['assignment'],
            unique=False,
        )
    # NOTE: autogen wants to drop ux_student_tokens_active_per_user
    # here because SQLModel.metadata doesn't know about partial indexes.
    # The index is correct and kept; do NOT drop it.


def downgrade() -> None:
    with op.batch_alter_table('context_records', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_context_records_assignment'))
        batch_op.drop_column('assignment')
