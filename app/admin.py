import json
import secrets
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from .auth import current_user_id, hash_password, normalize_username
from .config import settings
from .db import get_db
from .models import (
    AppSetting,
    Recording,
    RecordingAudioSegment,
    SpeakerAnalysis,
    SpeakerDetection,
    SpeakerProfile,
    SpeakerProfileSample,
    SpeakerTurn,
    TranscriptRevision,
    TranscriptionChunk,
    UsageEvent,
    User,
    UserSession,
)
from .services.gateway import gateway
from .services.progress import word_count
from .services.retention import cleanup_expired_audio, get_retention_policy, set_retention_policy


router = APIRouter(prefix="/api/admin", tags=["admin"])


def require_parent_pin(x_parent_pin: str | None) -> None:
    expected = settings.parent_pin.strip()
    if not expected:
        return
    supplied = (x_parent_pin or "").strip()
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Parent PIN required")


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=80)
    display_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=200)


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    password: str | None = Field(default=None, min_length=8, max_length=200)
    is_active: bool | None = None


class RetentionUpdate(BaseModel):
    audio_retention_days: int = Field(default=0, ge=0, le=3650)
    delete_audio_after_transcription: bool = False


def _recording_dict(recording: Recording) -> dict:
    transcript = recording.transcript
    return {
        "id": str(recording.id),
        "user_id": str(recording.user_id) if recording.user_id else None,
        "created_at": recording.created_at.isoformat(),
        "finished_at": recording.finished_at.isoformat() if recording.finished_at else None,
        "deleted_at": recording.deleted_at.isoformat() if recording.deleted_at else None,
        "last_activity_at": recording.last_activity_at.isoformat() if recording.last_activity_at else None,
        "duration_seconds": recording.duration_seconds,
        "language": recording.language,
        "title": recording.title,
        "status": recording.status,
        "transcript_original": recording.transcript_original or "",
        "transcript_edited": recording.transcript_edited,
        "draft_text": recording.draft_text,
        "transcript": transcript,
        "is_favourite": recording.is_favourite,
        "has_audio": bool(recording.audio_path),
        "audio_mime_type": recording.audio_mime_type,
        "audio_size": recording.audio_size,
        "word_count": word_count(transcript),
    }


async def _set_setting(db: AsyncSession, key: str, value: dict) -> None:
    setting = await db.get(AppSetting, key)
    if setting:
        setting.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def _serialize_row(row, fields: list[str]) -> dict:
    result = {}
    for field in fields:
        value = getattr(row, field)
        if isinstance(value, (datetime, uuid.UUID)):
            value = str(value)
        result[field] = value
    return result


@router.get("/status")
async def admin_status(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)

    database_ok = True
    try:
        await db.execute(text("select 1"))
    except Exception:
        database_ok = False

    gateway_ok = True
    gateway_version = None
    try:
        gateway_info = await gateway.health()
        gateway_version = gateway_info.get("version")
    except (httpx.HTTPError, OSError):
        gateway_ok = False

    recordings_count = await db.scalar(
        select(func.count()).select_from(Recording).where(
            Recording.user_id == current_user_id(),
            Recording.deleted_at.is_(None),
        )
    )
    deleted_count = await db.scalar(
        select(func.count()).select_from(Recording).where(
            Recording.user_id == current_user_id(),
            Recording.deleted_at.is_not(None),
        )
    )

    audio_files = 0
    audio_bytes = 0
    if settings.recordings_dir.exists():
        for path in settings.recordings_dir.rglob("*"):
            if path.is_file():
                audio_files += 1
                try:
                    audio_bytes += path.stat().st_size
                except OSError:
                    pass

    backup_setting = await db.get(AppSetting, "last_backup")
    last_backup_at = (backup_setting.value or {}).get("created_at") if backup_setting else None

    return {
        "database": database_ok,
        "speech_gateway": gateway_ok,
        "speech_gateway_version": gateway_version,
        "recordings": int(recordings_count or 0),
        "recycle_bin": int(deleted_count or 0),
        "audio_files": audio_files,
        "audio_bytes": audio_bytes,
        "last_backup_at": last_backup_at,
        "retention": await get_retention_policy(db),
    }


@router.get("/users")
async def list_users(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    require_parent_pin(x_parent_pin)
    users = (await db.execute(select(User).order_by(User.username.asc()))).scalars().all()
    counts = dict(
        (
            await db.execute(
                select(Recording.user_id, func.count(Recording.id))
                .where(Recording.deleted_at.is_(None))
                .group_by(Recording.user_id)
            )
        ).all()
    )
    return [
        {
            "id": str(user.id),
            "username": user.username,
            "display_name": user.display_name,
            "is_active": user.is_active,
            "recordings": int(counts.get(user.id, 0)),
            "is_current": user.id == current_user_id(),
            "created_at": user.created_at.isoformat(),
        }
        for user in users
    ]


@router.post("/users", status_code=201)
async def create_user(
    payload: UserCreate,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    try:
        username = normalize_username(payload.username)
        password_hash = hash_password(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    existing = (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="That username already exists.")

    user = User(
        username=username,
        display_name=payload.display_name.strip(),
        password_hash=password_hash,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {
        "id": str(user.id),
        "username": user.username,
        "display_name": user.display_name,
        "is_active": user.is_active,
        "recordings": 0,
        "is_current": False,
    }


@router.patch("/users/{user_id}")
async def update_user(
    user_id: uuid.UUID,
    payload: UserUpdate,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.is_active is False and user.id == current_user_id():
        raise HTTPException(status_code=400, detail="You cannot deactivate the account you are currently using.")

    invalidate_sessions = False
    if payload.display_name is not None:
        user.display_name = payload.display_name.strip()
    if payload.password is not None:
        try:
            user.password_hash = hash_password(payload.password)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        invalidate_sessions = True
    if payload.is_active is not None:
        user.is_active = payload.is_active
        invalidate_sessions = True

    user.updated_at = datetime.now(timezone.utc)
    if invalidate_sessions:
        await db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    await db.commit()

    recordings = await db.scalar(
        select(func.count()).select_from(Recording).where(
            Recording.user_id == user.id,
            Recording.deleted_at.is_(None),
        )
    )
    return {
        "id": str(user.id),
        "username": user.username,
        "display_name": user.display_name,
        "is_active": user.is_active,
        "recordings": int(recordings or 0),
        "is_current": user.id == current_user_id(),
    }


@router.get("/retention")
async def get_retention(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    return await get_retention_policy(db)


@router.patch("/retention")
async def update_retention(
    payload: RetentionUpdate,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    if payload.delete_audio_after_transcription and payload.audio_retention_days:
        raise HTTPException(
            status_code=400,
            detail="Choose either immediate audio deletion or an age-based retention period, not both.",
        )
    return await set_retention_policy(
        db,
        audio_retention_days=payload.audio_retention_days,
        delete_audio_after_transcription=payload.delete_audio_after_transcription,
    )


@router.post("/retention/apply")
async def apply_retention(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    return await cleanup_expired_audio(db)


@router.get("/recycle-bin")
async def recycle_bin(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    require_parent_pin(x_parent_pin)
    records = (
        await db.execute(
            select(Recording)
            .where(
                Recording.user_id == current_user_id(),
                Recording.deleted_at.is_not(None),
            )
            .order_by(Recording.deleted_at.desc())
        )
    ).scalars().all()
    return [_recording_dict(recording) for recording in records]


@router.post("/recycle-bin/{recording_id}/restore")
async def restore_from_bin(
    recording_id: uuid.UUID,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    recording = (
        await db.execute(
            select(Recording).where(
                Recording.id == recording_id,
                Recording.user_id == current_user_id(),
                Recording.deleted_at.is_not(None),
            )
        )
    ).scalar_one_or_none()
    if not recording:
        raise HTTPException(status_code=404, detail="Deleted recording not found")
    recording.deleted_at = None
    await db.commit()
    await db.refresh(recording)
    return _recording_dict(recording)


@router.delete("/recycle-bin/{recording_id}", status_code=204)
async def permanently_delete(
    recording_id: uuid.UUID,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> None:
    require_parent_pin(x_parent_pin)
    recording = (
        await db.execute(
            select(Recording).where(
                Recording.id == recording_id,
                Recording.deleted_at.is_not(None),
            )
        )
    ).scalar_one_or_none()
    if not recording:
        raise HTTPException(status_code=404, detail="Deleted recording not found")

    recording_dir = settings.recordings_dir / str(recording.id)
    if recording_dir.exists():
        shutil.rmtree(recording_dir, ignore_errors=True)

    await db.execute(delete(UsageEvent).where(UsageEvent.recording_id == recording.id))
    await db.execute(delete(TranscriptRevision).where(TranscriptRevision.recording_id == recording.id))
    await db.execute(delete(TranscriptionChunk).where(TranscriptionChunk.recording_id == recording.id))
    await db.execute(delete(RecordingAudioSegment).where(RecordingAudioSegment.recording_id == recording.id))
    await db.execute(delete(Recording).where(Recording.id == recording.id))
    await db.commit()


@router.get("/backup")
async def download_backup(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    require_parent_pin(x_parent_pin)

    users = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
    recordings = (await db.execute(select(Recording).order_by(Recording.created_at))).scalars().all()
    chunks = (await db.execute(select(TranscriptionChunk).order_by(TranscriptionChunk.created_at))).scalars().all()
    audio_segments = (await db.execute(select(RecordingAudioSegment).order_by(RecordingAudioSegment.created_at))).scalars().all()
    revisions = (await db.execute(select(TranscriptRevision).order_by(TranscriptRevision.created_at))).scalars().all()
    events = (await db.execute(select(UsageEvent).order_by(UsageEvent.created_at))).scalars().all()
    speaker_profiles = (await db.execute(select(SpeakerProfile).order_by(SpeakerProfile.created_at))).scalars().all()
    speaker_profile_samples = (
        await db.execute(select(SpeakerProfileSample).order_by(SpeakerProfileSample.created_at))
    ).scalars().all()
    speaker_analyses = (await db.execute(select(SpeakerAnalysis).order_by(SpeakerAnalysis.created_at))).scalars().all()
    speaker_detections = (
        await db.execute(
            select(SpeakerDetection).order_by(
                SpeakerDetection.analysis_id,
                SpeakerDetection.person_index,
            )
        )
    ).scalars().all()
    speaker_turns = (
        await db.execute(
            select(SpeakerTurn).order_by(
                SpeakerTurn.analysis_id,
                SpeakerTurn.start_seconds,
            )
        )
    ).scalars().all()
    app_settings = (await db.execute(select(AppSetting).order_by(AppSetting.key))).scalars().all()

    exported_at = datetime.now(timezone.utc)
    manifest = {
        "format": "local-transcriber-backup-v4",
        "exported_at": exported_at.isoformat(),
        "users": [
            _serialize_row(row, ["id", "username", "display_name", "is_active", "created_at", "updated_at"])
            for row in users
        ],
        "recordings": [_recording_dict(row) for row in recordings],
        "chunks": [
            _serialize_row(row, [
                "id", "recording_id", "chunk_number", "started_at_ms", "ended_at_ms",
                "text", "processing_seconds", "created_at",
            ])
            for row in chunks
        ],
        "audio_segments": [
            _serialize_row(row, [
                "id", "recording_id", "created_at", "duration_seconds",
                "audio_mime_type", "audio_size",
            ])
            for row in audio_segments
        ],
        "revisions": [
            _serialize_row(row, ["id", "recording_id", "previous_text", "new_text", "created_at"])
            for row in revisions
        ],
        "events": [
            _serialize_row(row, ["id", "recording_id", "event_type", "event_data", "created_at"])
            for row in events
        ],
        "speaker_profiles": [
            _serialize_row(row, [
                "id", "name", "embedding", "sample_count", "source_recording_id",
                "created_at", "updated_at",
            ])
            for row in speaker_profiles
        ],
        "speaker_profile_samples": [
            _serialize_row(row, [
                "id", "profile_id", "embedding", "source_recording_id",
                "source_analysis_id", "source_detection_id", "speech_seconds", "created_at",
            ])
            for row in speaker_profile_samples
        ],
        "speaker_analyses": [
            _serialize_row(row, [
                "id", "recording_id", "status", "model", "speaker_count",
                "processing_seconds", "error", "created_at", "completed_at",
            ])
            for row in speaker_analyses
        ],
        "speaker_detections": [
            _serialize_row(row, [
                "id", "analysis_id", "speaker_key", "person_index",
                "display_name", "embedding", "profile_id", "match_score",
            ])
            for row in speaker_detections
        ],
        "speaker_turns": [
            _serialize_row(row, [
                "id", "analysis_id", "detection_id", "start_seconds",
                "end_seconds", "text", "edited_text", "updated_at",
            ])
            for row in speaker_turns
        ],
        "settings": {row.key: row.value for row in app_settings},
    }

    temp = tempfile.NamedTemporaryFile(prefix="local-transcriber-", suffix=".zip", delete=False)
    temp_path = Path(temp.name)
    temp.close()

    with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("backup.json", json.dumps(manifest, indent=2, ensure_ascii=False, default=str))
        if settings.recordings_dir.exists():
            for path in settings.recordings_dir.rglob("*"):
                if path.is_file():
                    relative = path.relative_to(settings.recordings_dir)
                    archive.write(path, f"recordings/{relative.as_posix()}")

    await _set_setting(db, "last_backup", {"created_at": exported_at.isoformat()})
    await db.commit()

    filename = f"local-transcriber-backup-{exported_at.strftime('%Y%m%d-%H%M%S')}.zip"
    return FileResponse(
        temp_path,
        filename=filename,
        media_type="application/zip",
        background=BackgroundTask(lambda: temp_path.unlink(missing_ok=True)),
    )
