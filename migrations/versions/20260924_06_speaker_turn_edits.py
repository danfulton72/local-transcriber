"""Add editable speaker turn text.

Revision ID: 20260924_06
Revises: 20260923_05
Create Date: 2026-09-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260924_06"
down_revision: Union[str, Sequence[str], None] = "20260923_05"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("speaker_turns")}
    with op.batch_alter_table("speaker_turns") as batch:
        if "edited_text" not in columns:
            batch.add_column(sa.Column("edited_text", sa.Text(), nullable=True))
        if "updated_at" not in columns:
            batch.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("speaker_turns")}
    with op.batch_alter_table("speaker_turns") as batch:
        if "updated_at" in columns:
            batch.drop_column("updated_at")
        if "edited_text" in columns:
            batch.drop_column("edited_text")
