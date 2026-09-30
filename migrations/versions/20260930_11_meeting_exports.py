"""Add meeting notes / Open Notebook exports.

Revision ID: 20260930_11
Revises: 20260924_10
Create Date: 2026-09-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260930_11"
down_revision: Union[str, Sequence[str], None] = "20260924_10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "meeting_exports" in inspector.get_table_names():
        return
    op.create_table(
        "meeting_exports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "recording_id",
            sa.Uuid(),
            sa.ForeignKey("recordings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "analysis_id",
            sa.Uuid(),
            sa.ForeignKey("speaker_analyses.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="queued"),
        sa.Column("stage", sa.String(length=160), nullable=False, server_default=""),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("model", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("transcript_markdown", sa.Text(), nullable=True),
        sa.Column("notes_markdown", sa.Text(), nullable=True),
        sa.Column("export_requested", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("open_notebook_notebook_id", sa.String(length=200), nullable=True),
        sa.Column("open_notebook_source_id", sa.String(length=200), nullable=True),
        sa.Column("open_notebook_note_id", sa.String(length=200), nullable=True),
        sa.Column("processing_seconds", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "requested_by_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("notes_generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exported_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_meeting_exports_recording_id", "meeting_exports", ["recording_id"], unique=True)
    op.create_index("ix_meeting_exports_analysis_id", "meeting_exports", ["analysis_id"])
    op.create_index("ix_meeting_exports_status", "meeting_exports", ["status"])
    op.create_index("ix_meeting_exports_requested_by_user_id", "meeting_exports", ["requested_by_user_id"])
    op.create_index("ix_meeting_exports_created_at", "meeting_exports", ["created_at"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "meeting_exports" not in inspector.get_table_names():
        return
    op.drop_index("ix_meeting_exports_created_at", table_name="meeting_exports")
    op.drop_index("ix_meeting_exports_requested_by_user_id", table_name="meeting_exports")
    op.drop_index("ix_meeting_exports_status", table_name="meeting_exports")
    op.drop_index("ix_meeting_exports_analysis_id", table_name="meeting_exports")
    op.drop_index("ix_meeting_exports_recording_id", table_name="meeting_exports")
    op.drop_table("meeting_exports")
