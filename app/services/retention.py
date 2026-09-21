import shutil
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import AppSetting, Recording, TranscriptionChunk


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
