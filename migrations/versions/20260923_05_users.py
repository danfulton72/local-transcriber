"""Add application users, sessions, and recording ownership.

Revision ID: 20260923_05
Revises: 20260923_04
Create Date: 2026-09-23
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260923_05"
down_revision: Union[str, Sequence[str], None] = "20260923_04"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _indexes(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {item["name"] for item in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "users" not in tables:
        op.create_table(
            "users",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("username", sa.String(length=80), nullable=False),
            sa.Column("display_name", sa.String(length=120), nullable=False),
            sa.Column("password_hash", sa.Text(), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("username", name="uq_users_username"),
        )
    existing = _indexes("users")
    if "ix_users_username" not in existing:
        op.create_index("ix_users_username", "users", ["username"], unique=True)
    if "ix_users_is_active" not in existing:
        op.create_index("ix_users_is_active", "users", ["is_active"], unique=False)

    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "user_sessions" not in tables:
        op.create_table(
            "user_sessions",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False),
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("token_hash", name="uq_user_sessions_token_hash"),
        )
    existing = _indexes("user_sessions")
    for name, column, unique in (
        ("ix_user_sessions_user_id", "user_id", False),
        ("ix_user_sessions_token_hash", "token_hash", True),
        ("ix_user_sessions_created_at", "created_at", False),
        ("ix_user_sessions_expires_at", "expires_at", False),
    ):
        if name not in existing:
            op.create_index(name, "user_sessions", [column], unique=unique)

    inspector = sa.inspect(bind)
    recording_columns = {column["name"] for column in inspector.get_columns("recordings")}
    if "user_id" not in recording_columns:
        with op.batch_alter_table("recordings") as batch:
            batch.add_column(sa.Column("user_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_recordings_user_id_users",
                "users",
                ["user_id"],
                ["id"],
                ondelete="CASCADE",
            )

    if "ix_recordings_user_id" not in _indexes("recordings"):
        op.create_index("ix_recordings_user_id", "recordings", ["user_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "recordings" in tables:
        columns = {column["name"] for column in inspector.get_columns("recordings")}
        if "user_id" in columns:
            with op.batch_alter_table("recordings") as batch:
                batch.drop_column("user_id")

    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "user_sessions" in tables:
        op.drop_table("user_sessions")
    if "users" in tables:
        op.drop_table("users")
