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
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from .config import settings
from .db import get_db
from .models import AppSetting, Recording, TranscriptRevision, TranscriptionChunk, UsageEvent
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


class RetentionUpdate(BaseModel):
    audio_retention_days: int = Field(default=0, ge=0, le=3650)
    delete_audio_after_transcription: bool = False


def _recording_dict(recording: Recording) -> dict:
    transcript = recording.transcript
    return {
        "id": str(recording.id),
        "created_at": recording.created_at.isoformat(),
        "finished_at": recording.finished_at.isoformat() if recording.finished_at else None,
        "deleted_at": recording.deleted_at.isoformat() if recording.deleted_at else None,
        "duration_seconds": recording.duration_seconds,
        "language": recording.language,
        "title": recording.title,
        "status": recording.status,
        "transcript_original": recording.transcript_original or "",
        "transcript_edited": recording.transcript_edited,
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


@app_placeholder
