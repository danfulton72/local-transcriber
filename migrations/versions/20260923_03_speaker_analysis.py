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


def _indexes(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {item["name"] for item in inspector.get_indexes(table)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if "speaker_profiles" not in tables:
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
    if "ix_speaker_profiles_name" not in _indexes("speaker_profiles"):
        op.create_index("ix_speaker_profiles_name", "speaker_profiles", ["name"], unique=False)

    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "speaker_analyses" not in tables:
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
    existing = _indexes("speaker_analyses")
    if "ix_speaker_analyses_recording_id" not in existing:
        op.create_index("ix_speaker_analyses_recording_id", "speaker_analyses", ["recording_id"], unique=False)
    if "ix_speaker_analyses_status" not in existing:
        op.create_index("ix_speaker_analyses_status", "speaker_analyses", ["status"], unique=False)
    if "ix_speaker_analyses_created_at" not in existing:
        op.create_index("ix_speaker_analyses_created_at", "speaker_analyses", ["created_at"], unique=False)

    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "speaker_detections" not in tables:
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
    existing = _indexes("speaker_detections")
    if "ix_speaker_detections_analysis_id" not in existing:
        op.create_index("ix_speaker_detections_analysis_id", "speaker_detections", ["analysis_id"], unique=False)
    if "ix_speaker_detections_profile_id" not in existing:
        op.create_index("ix_speaker_detections_profile_id", "speaker_detections", ["profile_id"], unique=False)

    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "speaker_turns" not in tables:
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
    existing = _indexes("speaker_turns")
    if "ix_speaker_turns_analysis_id" not in existing:
        op.create_index("ix_speaker_turns_analysis_id", "speaker_turns", ["analysis_id"], unique=False)
    if "ix_speaker_turns_detection_id" not in existing:
        op.create_index("ix_speaker_turns_detection_id", "speaker_turns", ["detection_id"], unique=False)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in ("speaker_turns", "speaker_detections", "speaker_analyses", "speaker_profiles"):
        if table in tables:
            op.drop_table(table)
