"""Add speaker identity corrections and relabel review queue.

Revision ID: 20260924_07
Revises: 20260924_06
Create Date: 2026-09-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260924_07"
down_revision: Union[str, Sequence[str], None] = "20260924_06"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("speaker_turns")}
    with op.batch_alter_table("speaker_turns") as batch:
        if "identity_override_profile_id" not in columns:
            batch.add_column(sa.Column("identity_override_profile_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_speaker_turns_override_profile",
                "speaker_profiles",
                ["identity_override_profile_id"],
                ["id"],
                ondelete="SET NULL",
            )
            batch.create_index("ix_speaker_turns_identity_override_profile_id", ["identity_override_profile_id"])
        if "identity_override_detection_id" not in columns:
            batch.add_column(sa.Column("identity_override_detection_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_speaker_turns_override_detection",
                "speaker_detections",
                ["identity_override_detection_id"],
                ["id"],
                ondelete="SET NULL",
            )
            batch.create_index("ix_speaker_turns_identity_override_detection_id", ["identity_override_detection_id"])
        if "identity_override_unknown" not in columns:
            batch.add_column(sa.Column("identity_override_unknown", sa.Boolean(), nullable=False, server_default=sa.false()))
        if "identity_corrected_by_user_id" not in columns:
            batch.add_column(sa.Column("identity_corrected_by_user_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_speaker_turns_identity_corrected_user",
                "users",
                ["identity_corrected_by_user_id"],
                ["id"],
                ondelete="SET NULL",
            )
            batch.create_index("ix_speaker_turns_identity_corrected_by_user_id", ["identity_corrected_by_user_id"])
        if "identity_corrected_at" not in columns:
            batch.add_column(sa.Column("identity_corrected_at", sa.DateTime(timezone=True), nullable=True))

    inspector = sa.inspect(op.get_bind())
    if "speaker_relabel_samples" not in inspector.get_table_names():
        op.create_table(
            "speaker_relabel_samples",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("recording_id", sa.Uuid(), sa.ForeignKey("recordings.id", ondelete="CASCADE"), nullable=False),
            sa.Column("analysis_id", sa.Uuid(), sa.ForeignKey("speaker_analyses.id", ondelete="CASCADE"), nullable=False),
            sa.Column("turn_id", sa.Uuid(), sa.ForeignKey("speaker_turns.id", ondelete="CASCADE"), nullable=False, unique=True),
            sa.Column("original_profile_id", sa.Uuid(), sa.ForeignKey("speaker_profiles.id", ondelete="SET NULL"), nullable=True),
            sa.Column("corrected_profile_id", sa.Uuid(), sa.ForeignKey("speaker_profiles.id", ondelete="SET NULL"), nullable=True),
            sa.Column("original_display_name", sa.String(length=120), nullable=False),
            sa.Column("corrected_display_name", sa.String(length=120), nullable=False),
            sa.Column("status", sa.String(length=24), nullable=False, server_default="pending"),
            sa.Column("corrected_by_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_speaker_relabel_samples_recording_id", "speaker_relabel_samples", ["recording_id"])
        op.create_index("ix_speaker_relabel_samples_analysis_id", "speaker_relabel_samples", ["analysis_id"])
        op.create_index("ix_speaker_relabel_samples_turn_id", "speaker_relabel_samples", ["turn_id"], unique=True)
        op.create_index("ix_speaker_relabel_samples_original_profile_id", "speaker_relabel_samples", ["original_profile_id"])
        op.create_index("ix_speaker_relabel_samples_corrected_profile_id", "speaker_relabel_samples", ["corrected_profile_id"])
        op.create_index("ix_speaker_relabel_samples_status", "speaker_relabel_samples", ["status"])
        op.create_index("ix_speaker_relabel_samples_corrected_by_user_id", "speaker_relabel_samples", ["corrected_by_user_id"])
        op.create_index("ix_speaker_relabel_samples_created_at", "speaker_relabel_samples", ["created_at"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "speaker_relabel_samples" in inspector.get_table_names():
        op.drop_table("speaker_relabel_samples")

    columns = {column["name"] for column in inspector.get_columns("speaker_turns")}
    with op.batch_alter_table("speaker_turns") as batch:
        if "identity_corrected_at" in columns:
            batch.drop_column("identity_corrected_at")
        if "identity_corrected_by_user_id" in columns:
            batch.drop_column("identity_corrected_by_user_id")
        if "identity_override_unknown" in columns:
            batch.drop_column("identity_override_unknown")
        if "identity_override_detection_id" in columns:
            batch.drop_column("identity_override_detection_id")
        if "identity_override_profile_id" in columns:
            batch.drop_column("identity_override_profile_id")
