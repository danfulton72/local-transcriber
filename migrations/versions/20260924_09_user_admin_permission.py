"""Add admin permission to users.

Revision ID: 20260924_09
Revises: 20260924_08
Create Date: 2026-09-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260924_09"
down_revision: Union[str, Sequence[str], None] = "20260924_08"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "is_admin" not in columns:
        with op.batch_alter_table("users") as batch:
            batch.add_column(
                sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false())
            )
            batch.create_index("ix_users_is_admin", ["is_admin"])

    # The oldest existing account is the original/default account and becomes
    # the initial administrator. Fresh installs are handled by ensure_default_user.
    op.execute(
        sa.text(
            """
            UPDATE users
            SET is_admin = TRUE
            WHERE id = (
                SELECT id
                FROM users
                ORDER BY created_at ASC, id ASC
                LIMIT 1
            )
            """
        )
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "is_admin" in columns:
        with op.batch_alter_table("users") as batch:
            batch.drop_index("ix_users_is_admin")
            batch.drop_column("is_admin")
