"""Baseline the existing app schema and add writing-session recovery fields.

Revision ID: 20260921_01
Revises:
Create Date: 2026-09-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.db import Base
from app import models  # noqa: F401


revision: str = "20260921_01"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    Base.metadata.create_all(bind=bind)

    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("recordings")}

    if "draft_text" not in columns:
        op.add_column("recordings", sa.Column("draft_text", sa.Text(), nullable=True))

    if "last_activity_at" not in columns:
        op.add_column(
            "recordings",
            sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.execute(
            sa.text(
                "UPDATE recordings SET last_activity_at = "
                "COALESCE(finished_at, created_at) WHERE last_activity_at IS NULL"
            )
        )

    inspector = sa.inspect(bind)
    index_names = {index["name"] for index in inspector.get_indexes("recordings")}
    if "ix_recordings_last_activity_at" not in index_names:
        op.create_index(
            "ix_recordings_last_activity_at",
            "recordings",
            ["last_activity_at"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "recording_audio_segments" in inspector.get_table_names():
        op.drop_table("recording_audio_segments")

    columns = {column["name"] for column in inspector.get_columns("recordings")}
    indexes = {index["name"] for index in inspector.get_indexes("recordings")}

    if "ix_recordings_last_activity_at" in indexes:
        op.drop_index("ix_recordings_last_activity_at", table_name="recordings")

    with op.batch_alter_table("recordings") as batch:
        if "last_activity_at" in columns:
            batch.drop_column("last_activity_at")
        if "draft_text" in columns:
            batch.drop_column("draft_text")
