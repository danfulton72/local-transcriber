"""Add transcription reprocessing jobs and meeting-note staleness.

Revision ID: 20261004_13
Revises: 20260930_12
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261004_13"
down_revision: Union[str, Sequence[str], None] = "20260930_12"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if "transcription_runs" not in tables:
        op.create_table(
            "transcription_runs",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("recording_id", sa.Uuid(), nullable=False),
            sa.Column("analysis_id", sa.Uuid(), nullable=True),
            sa.Column("mode", sa.String(length=24), nullable=False),
            sa.Column("status", sa.String(length=24), nullable=False),
            sa.Column("model", sa.String(length=200), nullable=False),
            sa.Column("transcript_candidate", sa.Text(), nullable=True),
            sa.Column("result_data", sa.JSON(), nullable=False),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("processing_seconds", sa.Float(), nullable=False),
            sa.Column("requested_by_user_id", sa.Uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("discarded_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["analysis_id"], ["speaker_analyses.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["recording_id"], ["recordings.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_transcription_runs_recording_id", "transcription_runs", ["recording_id"])
        op.create_index("ix_transcription_runs_analysis_id", "transcription_runs", ["analysis_id"])
        op.create_index("ix_transcription_runs_status", "transcription_runs", ["status"])
        op.create_index("ix_transcription_runs_created_at", "transcription_runs", ["created_at"])

    export_columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("meeting_exports")
    }
    if "notes_stale" not in export_columns:
        with op.batch_alter_table("meeting_exports") as batch:
            batch.add_column(
                sa.Column("notes_stale", sa.Boolean(), nullable=False, server_default=sa.false())
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "meeting_exports" in inspector.get_table_names():
        export_columns = {
            column["name"]
            for column in sa.inspect(op.get_bind()).get_columns("meeting_exports")
        }
        if "notes_stale" in export_columns:
            with op.batch_alter_table("meeting_exports") as batch:
                batch.drop_column("notes_stale")

    if "transcription_runs" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_index("ix_transcription_runs_created_at", table_name="transcription_runs")
        op.drop_index("ix_transcription_runs_status", table_name="transcription_runs")
        op.drop_index("ix_transcription_runs_analysis_id", table_name="transcription_runs")
        op.drop_index("ix_transcription_runs_recording_id", table_name="transcription_runs")
        op.drop_table("transcription_runs")
