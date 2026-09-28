import shutil
from pathlib import Path
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import AppSetting, Recording, RecordingAudioSegment, TranscriptionChunk


RETENTION_KEY = "audio_retention"


async def get_retention_policy(db: AsyncSession) -> dict:
    setting = await db.get(AppSetting, RETENTION_KEY)
    if not setting:
        return {"audio_retention_days": 0, "delete_audio_after_transcription": False}
    value = setting.value or {}
    return {
        "audio_retention_days": int(value.get("audio_retention_days") or 0),
        "delete_audio_after_transcription": bool(value.get("delete_audio_after_transcription", False)),
    }


async def set_retention_policy(
    db: AsyncSession,
    *,
    audio_retention_days: int,
    delete_audio_after_transcription: bool,
) -> dict:
    policy = {
        "audio_retention_days": int(audio_retention_days),
        "delete_audio_after_transcription": bool(delete_audio_after_transcription),
    }
    setting = await db.get(AppSetting, RETENTION_KEY)
    if setting:
        setting.value = policy
    else:
        db.add(AppSetting(key=RETENTION_KEY, value=policy))
    await db.commit()
    return policy


async def remove_recording_audio(recording: Recording, db: AsyncSession) -> bool:
    root = settings.recordings_dir / str(recording.id)
    existed = root.exists()
    if existed:
        shutil.rmtree(root, ignore_errors=True)

    recording.audio_path = None
    recording.audio_mime_type = None
    recording.audio_size = None
    await db.execute(
        update(TranscriptionChunk)
        .where(TranscriptionChunk.recording_id == recording.id)
        .values(audio_path=None)
    )
    await db.execute(
        update(RecordingAudioSegment)
        .where(RecordingAudioSegment.recording_id == recording.id)
        .values(audio_path=None, audio_size=None)
    )
    return existed


async def apply_recording_retention(recording: Recording, db: AsyncSession) -> bool:
    policy = await get_retention_policy(db)
    if not policy["delete_audio_after_transcription"]:
        return False
    removed = await remove_recording_audio(recording, db)
    await db.commit()
    return removed


async def cleanup_expired_audio(db: AsyncSession) -> dict:
    policy = await get_retention_policy(db)
    immediate = policy["delete_audio_after_transcription"]
    days = policy["audio_retention_days"]

    if not immediate and days <= 0:
        return {"removed_recordings": 0, "policy": policy}

    query = select(Recording).where(Recording.status == "ready")
    if not immediate:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.where(Recording.finished_at.is_not(None), Recording.finished_at < cutoff)

    records = (await db.execute(query)).scalars().all()
    removed = 0
    for recording in records:
        root = settings.recordings_dir / str(recording.id)
        if recording.audio_path or root.exists():
            await remove_recording_audio(recording, db)
            removed += 1

    await db.commit()
    return {"removed_recordings": removed, "policy": policy}


async def _has_stored_audio_segments(recording_id, db: AsyncSession) -> bool:
    paths = (
        await db.execute(
            select(RecordingAudioSegment.audio_path).where(
                RecordingAudioSegment.recording_id == recording_id,
                RecordingAudioSegment.audio_path.is_not(None),
            )
        )
    ).scalars().all()
    return bool(paths) and all(Path(path).exists() for path in paths)


async def prune_live_chunk_audio(recording: Recording, db: AsyncSession) -> bool:
    """Delete near-live chunk WAVs once the full recording audio is stored.

    Chunk text/timing metadata is kept; only the duplicate audio goes. Chunks
    are left alone if the full audio is missing, since they are then the only
    copy of the voice recording.
    """
    if settings.keep_live_chunk_audio or recording.status != "ready":
        return False
    if not await _has_stored_audio_segments(recording.id, db):
        return False

    chunk_dir = settings.recordings_dir / str(recording.id) / "chunks"
    existed = chunk_dir.exists()
    if existed:
        shutil.rmtree(chunk_dir, ignore_errors=True)
    await db.execute(
        update(TranscriptionChunk)
        .where(
            TranscriptionChunk.recording_id == recording.id,
            TranscriptionChunk.audio_path.is_not(None),
        )
        .values(audio_path=None)
    )
    await db.commit()
    return existed


async def prune_finished_chunk_audio(db: AsyncSession) -> int:
    """One-off style sweep for recordings finished before chunk pruning existed."""
    if settings.keep_live_chunk_audio:
        return 0
    records = (
        await db.execute(
            select(Recording).where(
                Recording.status == "ready",
                exists().where(
                    TranscriptionChunk.recording_id == Recording.id,
                    TranscriptionChunk.audio_path.is_not(None),
                ),
            )
        )
    ).scalars().all()
    pruned = 0
    for recording in records:
        if await prune_live_chunk_audio(recording, db):
            pruned += 1
    return pruned
