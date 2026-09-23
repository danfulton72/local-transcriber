"""Persist recovery reminder acknowledgement.

Revision ID: 20260923_02
Revises: 20260921_01
Create Date: 2026-09-23
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260923_02"
down_revision: Union[str, Sequence[str], None] = "20260921_01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("recordings")}
    if "recovery_dismissed_at" not in columns:
        op.add_column(
            "recordings",
            sa.Column("recovery_dismissed_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("recordings")}
    if "recovery_dismissed_at" in columns:
        with op.batch_alter_table("recordings") as batch:
            batch.drop_column("recovery_dismissed_at")
