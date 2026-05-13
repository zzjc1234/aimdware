"""0002 unique session turn

Adds UNIQUE(session_id, turn_count) on context_records so two routers
racing on the same session can never silently collide on a tiebreaker
when /admin/session/<id>/payload picks the "latest" turn.

Revision ID: 1cc659f78871
Revises: ad7b66d6bff9
Create Date: 2026-05-13 08:07:21.015170
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa  # noqa: F401  (kept for autogen-friendly imports)
import sqlmodel  # noqa: F401


revision: str = '1cc659f78871'
down_revision: Union[str, Sequence[str], None] = 'ad7b66d6bff9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('context_records', schema=None) as batch_op:
        batch_op.create_unique_constraint(
            'ux_context_records_session_turn',
            ['session_id', 'turn_count'],
        )
    # NOTE: autogen wants to drop the ux_student_tokens_active_per_user
    # partial index here because SQLModel.metadata doesn't know about it
    # (partial-where isn't expressible in the declarative model). The
    # index is correct and needed for "one active token per user", so we
    # intentionally do NOT drop it.


def downgrade() -> None:
    with op.batch_alter_table('context_records', schema=None) as batch_op:
        batch_op.drop_constraint(
            'ux_context_records_session_turn', type_='unique'
        )
