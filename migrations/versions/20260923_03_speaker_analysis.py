"""Add parent-only speaker diarization and remembered voiceprints.

Revision ID: 20260923_03
Revises: 20260923_02
Create Date: 2026-09-23
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260923_03"
down_revision: Union[str, Sequence[str], None] = "20260923_02"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "speaker_profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("embedding", sa.JSON(), nullable=False),
        sa.Column("sample_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("source_recording_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["source_recording_id"], ["recordings.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_speaker_profiles_name", "speaker_profiles", ["name"], unique=False)

    op.create_table(
        "speaker_analyses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("recording_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("speaker_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processing_seconds", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["recording_id"], ["recordings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_speaker_analyses_recording_id", "speaker_analyses", ["recording_id"], unique=False)
    op.create_index("ix_speaker_analyses_status", "speaker_analyses", ["status"], unique=False)
    op.create_index("ix_speaker_analyses_created_at", "speaker_analyses", ["created_at"], unique=False)

    op.create_table(
        "speaker_detections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("analysis_id", sa.Uuid(), nullable=False),
        sa.Column("speaker_key", sa.String(length=80), nullable=False),
        sa.Column("person_index", sa.Integer(), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("embedding", sa.JSON(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=True),
        sa.Column("match_score", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["analysis_id"], ["speaker_analyses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["profile_id"], ["speaker_profiles.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_speaker_detections_analysis_id", "speaker_detections", ["analysis_id"], unique=False)
    op.create_index("ix_speaker_detections_profile_id", "speaker_detections", ["profile_id"], unique=False)

    op.create_table(
        "speaker_turns",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("analysis_id", sa.Uuid(), nullable=False),
        sa.Column("detection_id", sa.Uuid(), nullable=False),
        sa.Column("start_seconds", sa.Float(), nullable=False),
        sa.Column("end_seconds", sa.Float(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["analysis_id"], ["speaker_analyses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["detection_id"], ["speaker_detections.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_speaker_turns_analysis_id", "speaker_turns", ["analysis_id"], unique=False)
    op.create_index("ix_speaker_turns_detection_id", "speaker_turns", ["detection_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_speaker_turns_detection_id", table_name="speaker_turns")
    op.drop_index("ix_speaker_turns_analysis_id", table_name="speaker_turns")
    op.drop_table("speaker_turns")
    op.drop_index("ix_speaker_detections_profile_id", table_name="speaker_detections")
    op.drop_index("ix_speaker_detections_analysis_id", table_name="speaker_detections")
    op.drop_table("speaker_detections")
    op.drop_index("ix_speaker_analyses_created_at", table_name="speaker_analyses")
    op.drop_index("ix_speaker_analyses_status", table_name="speaker_analyses")
    op.drop_index("ix_speaker_analyses_recording_id", table_name="speaker_analyses")
    op.drop_table("speaker_analyses")
    op.drop_index("ix_speaker_profiles_name", table_name="speaker_profiles")
    op.drop_table("speaker_profiles")
