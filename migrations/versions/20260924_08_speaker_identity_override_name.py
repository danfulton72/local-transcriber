"""Add free-form speaker identity override name.

Revision ID: 20260924_08
Revises: 20260924_07
Create Date: 2026-09-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260924_08"
down_revision: Union[str, Sequence[str], None] = "20260924_07"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("speaker_turns")}
    if "identity_override_name" not in columns:
        with op.batch_alter_table("speaker_turns") as batch:
            batch.add_column(sa.Column("identity_override_name", sa.String(length=120), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("speaker_turns")}
    if "identity_override_name" in columns:
        with op.batch_alter_table("speaker_turns") as batch:
            batch.drop_column("identity_override_name")
