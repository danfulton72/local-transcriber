"""Store multiple confirmed voiceprint samples per speaker.

Revision ID: 20260923_04
Revises: 20260923_03
Create Date: 2026-09-23
"""
from typing import Sequence, Union
import uuid

import sqlalchemy as sa
from alembic import op


revision: str = "20260923_04"
down_revision: Union[str, Sequence[str], None] = "20260923_03"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _indexes(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {item["name"] for item in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "speaker_profile_samples" not in tables:
        op.create_table(
            "speaker_profile_samples",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("profile_id", sa.Uuid(), nullable=False),
            sa.Column("embedding", sa.JSON(), nullable=False),
            sa.Column("source_recording_id", sa.Uuid(), nullable=True),
            sa.Column("source_analysis_id", sa.Uuid(), nullable=True),
            sa.Column("source_detection_id", sa.Uuid(), nullable=True),
            sa.Column("speech_seconds", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["profile_id"], ["speaker_profiles.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["source_recording_id"], ["recordings.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["source_analysis_id"], ["speaker_analyses.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["source_detection_id"], ["speaker_detections.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )

    existing = _indexes("speaker_profile_samples")
    for name, column in (
        ("ix_speaker_profile_samples_profile_id", "profile_id"),
        ("ix_speaker_profile_samples_source_recording_id", "source_recording_id"),
        ("ix_speaker_profile_samples_source_analysis_id", "source_analysis_id"),
        ("ix_speaker_profile_samples_source_detection_id", "source_detection_id"),
        ("ix_speaker_profile_samples_created_at", "created_at"),
    ):
        if name not in existing:
            op.create_index(name, "speaker_profile_samples", [column], unique=False)

    # Existing installations stored one running-average embedding on each
    # speaker profile. Preserve it as the first bank sample so no learnt
    # voiceprint is lost during the upgrade.
    profiles = sa.Table("speaker_profiles", sa.MetaData(), autoload_with=bind)
    samples = sa.Table("speaker_profile_samples", sa.MetaData(), autoload_with=bind)

    existing_profile_ids = set(
        bind.execute(sa.select(samples.c.profile_id)).scalars().all()
    )
    rows = bind.execute(
        sa.select(
            profiles.c.id,
            profiles.c.embedding,
            profiles.c.source_recording_id,
            profiles.c.created_at,
        )
    ).mappings().all()

    inserts = []
    for row in rows:
        if row["id"] in existing_profile_ids or not row["embedding"]:
            continue
        inserts.append(
            {
                "id": uuid.uuid4(),
                "profile_id": row["id"],
                "embedding": row["embedding"],
                "source_recording_id": row["source_recording_id"],
                "source_analysis_id": None,
                "source_detection_id": None,
                "speech_seconds": None,
                "created_at": row["created_at"],
            }
        )
    if inserts:
        bind.execute(sa.insert(samples), inserts)

    # sample_count now represents the number of retained bank samples.
    for row in bind.execute(sa.select(profiles.c.id)).mappings():
        count = bind.execute(
            sa.select(sa.func.count())
            .select_from(samples)
            .where(samples.c.profile_id == row["id"])
        ).scalar_one()
        bind.execute(
            sa.update(profiles)
            .where(profiles.c.id == row["id"])
            .values(sample_count=max(1, int(count or 0)))
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "speaker_profile_samples" in inspector.get_table_names():
        op.drop_table("speaker_profile_samples")
