"""Add admin acting-as user to sessions.

Revision ID: 20260924_10
Revises: 20260924_09
Create Date: 2026-09-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260924_10"
down_revision: Union[str, Sequence[str], None] = "20260924_09"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("user_sessions")}
    if "acting_as_user_id" not in columns:
        with op.batch_alter_table("user_sessions") as batch:
            batch.add_column(
                sa.Column("acting_as_user_id", sa.Uuid(), nullable=True)
            )
            batch.create_foreign_key(
                "fk_user_sessions_acting_as_user_id_users",
                "users",
                ["acting_as_user_id"],
                ["id"],
                ondelete="SET NULL",
            )
            batch.create_index(
                "ix_user_sessions_acting_as_user_id",
                ["acting_as_user_id"],
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("user_sessions")}
    if "acting_as_user_id" in columns:
        with op.batch_alter_table("user_sessions") as batch:
            batch.drop_index("ix_user_sessions_acting_as_user_id")
            batch.drop_constraint(
                "fk_user_sessions_acting_as_user_id_users",
                type_="foreignkey",
            )
            batch.drop_column("acting_as_user_id")
