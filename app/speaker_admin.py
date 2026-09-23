import math
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .admin import require_parent_pin
from .config import settings
from .db import SessionLocal, get_db
from .models import (
    Recording,
    SpeakerAnalysis,
    SpeakerDetection,
    SpeakerProfile,
    SpeakerTurn,
)
from .services.progress import word_count
from .services.recording_audio import build_combined_wav
from .services.speaker_service import speaker_service


router = APIRouter(prefix="/api/admin/speakers", tags=["speaker-analysis"])


class AnalysisRequest(BaseModel):
    num_speakers: int | None = Field(default=None, ge=1, le=10)


class DetectionLabelUpdate(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)


class RememberSpeakerRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class RenameProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return -1.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        return -1.0
    return dot / (left_norm * right_norm)


def normalise_embedding(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in values))
    if not norm:
        return [float(value) for value in values]
    return [float(value / norm) for value in values]


def blend_embeddings(old: list[float], new: list[float], sample_count: int) -> list[float]:
    if len(old) != len(new) or not old:
        return normalise_embedding(new)
    count = max(1, int(sample_count))
    combined = [
        (float(a) * count + float(b)) / (count + 1)
        for a, b in zip(old, new)
    ]
    return normalise_embedding(combined)


def best_profile(
    embedding: list[float],
    profiles: list[SpeakerProfile],
) -> tuple[SpeakerProfile | None, float | None]:
    best = None
    best_score = -1.0
    for profile in profiles:
        score = cosine_similarity(embedding, profile.embedding or [])
        if score > best_score:
            best = profile
            best_score = score
    if best is None or best_score < settings.speaker_match_threshold:
        return None, None
    return best, best_score


async def _analysis_payload(analysis: SpeakerAnalysis, db: AsyncSession) -> dict:
    recording = await db.get(Recording, analysis.recording_id)
    detections = (
        await db.execute(
            select(SpeakerDetection)
            .where(SpeakerDetection.analysis_id == analysis.id)
            .order_by(SpeakerDetection.person_index.asc())
        )
    ).scalars().all()
    turns = (
        await db.execute(
            select(SpeakerTurn)
            .where(SpeakerTurn.analysis_id == analysis.id)
            .order_by(SpeakerTurn.start_seconds.asc())
        )
    ).scalars().all()
    by_id = {item.id: item for item in detections}

    return {
        "id": str(analysis.id),
        "recording_id": str(analysis.recording_id),
        "recording_title": recording.title if recording else None,
        "status": analysis.status,
        "model": analysis.model,
        "speaker_count": analysis.speaker_count,
        "processing_seconds": round(analysis.processing_seconds or 0, 2),
        "error": analysis.error,
        "created_at": analysis.created_at.isoformat(),
        "completed_at": analysis.completed_at.isoformat() if analysis.completed_at else None,
        "detections": [
            {
                "id": str(item.id),
                "speaker_key": item.speaker_key,
                "person_index": item.person_index,
                "display_name": item.display_name,
                "profile_id": str(item.profile_id) if item.profile_id else None,
                "match_score": round(item.match_score, 3) if item.match_score is not None else None,
            }
            for item in detections
        ],
        "turns": [
            {
                "id": str(turn.id),
                "speaker_key": by_id[turn.detection_id].speaker_key if turn.detection_id in by_id else "",
                "display_name": by_id[turn.detection_id].display_name if turn.detection_id in by_id else "Speaker",
                "start_seconds": round(turn.start_seconds, 2),
                "end_seconds": round(turn.end_seconds, 2),
                "text": turn.text,
            }
            for turn in turns
        ],
    }


async def process_analysis(analysis_id: uuid.UUID, num_speakers: int | None) -> None:
    started = time.perf_counter()
    temp_path = None
    delete_temp = False

    async with SessionLocal() as db:
        analysis = await db.get(SpeakerAnalysis, analysis_id)
        if not analysis:
            return
        recording = await db.get(Recording, analysis.recording_id)
        if not recording:
            analysis.status = "error"
            analysis.error = "Recording no longer exists."
            await db.commit()
            return

        analysis.status = "processing"
        await db.commit()

        try:
            temp_path, delete_temp, _, _ = await build_combined_wav(recording, db)
            result = await speaker_service.analyze(
                temp_path,
                language=recording.language,
                num_speakers=num_speakers,
            )

            await db.execute(delete(SpeakerTurn).where(SpeakerTurn.analysis_id == analysis.id))
            await db.execute(delete(SpeakerDetection).where(SpeakerDetection.analysis_id == analysis.id))

            profiles = (await db.execute(select(SpeakerProfile))).scalars().all()
            turns = result.get("turns", [])
            first_seen: dict[str, int] = {}
            for turn in turns:
                key = str(turn.get("speaker_key", ""))
                if key and key not in first_seen:
                    first_seen[key] = len(first_seen) + 1

            detections: dict[str, SpeakerDetection] = {}
            for raw in result.get("speakers", []):
                key = str(raw.get("speaker_key", ""))
                if not key:
                    continue
                embedding = normalise_embedding([float(value) for value in raw.get("embedding", [])])
                profile, score = best_profile(embedding, profiles)
                person_index = first_seen.get(key, len(first_seen) + len(detections) + 1)
                display_name = profile.name if profile else f"Person {person_index}"
                detection = SpeakerDetection(
                    analysis_id=analysis.id,
                    speaker_key=key,
                    person_index=person_index,
                    display_name=display_name,
                    embedding=embedding,
                    profile_id=profile.id if profile else None,
                    match_score=score,
                )
                db.add(detection)
                await db.flush()
                detections[key] = detection

            for raw in turns:
                key = str(raw.get("speaker_key", ""))
                detection = detections.get(key)
                if not detection:
                    continue
                db.add(
                    SpeakerTurn(
                        analysis_id=analysis.id,
                        detection_id=detection.id,
                        start_seconds=float(raw.get("start_seconds", 0)),
                        end_seconds=float(raw.get("end_seconds", 0)),
                        text=str(raw.get("text", "")).strip(),
                    )
                )

            analysis.status = "completed"
            analysis.model = str(result.get("model", "pyannote"))
            analysis.speaker_count = len(detections)
            analysis.processing_seconds = time.perf_counter() - started
            analysis.completed_at = datetime.now(timezone.utc)
            analysis.error = None
            await db.commit()
        except Exception as exc:
            analysis.status = "error"
            analysis.error = str(exc)[:2000]
            analysis.processing_seconds = time.perf_counter() - started
            analysis.completed_at = datetime.now(timezone.utc)
            await db.commit()
        finally:
            if delete_temp and temp_path is not None:
                temp_path.unlink(missing_ok=True)


@router.get("/status")
async def speaker_status(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    profiles = await db.scalar(select(func.count()).select_from(SpeakerProfile))
    try:
        service = await speaker_service.health()
        reachable = True
    except (httpx.HTTPError, OSError):
        service = {"status": "unavailable"}
        reachable = False
    return {
        "reachable": reachable,
        "service": service,
        "remembered_speakers": int(profiles or 0),
        "match_threshold": settings.speaker_match_threshold,
    }


@router.get("/recordings")
async def speaker_recordings(
    limit: int = Query(default=50, ge=1, le=200),
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    require_parent_pin(x_parent_pin)
    rows = (
        await db.execute(
            select(Recording)
            .where(
                Recording.deleted_at.is_(None),
                Recording.status == "ready",
                Recording.audio_path.is_not(None),
            )
            .order_by(Recording.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": str(row.id),
            "title": row.title or "Recording",
            "created_at": row.created_at.isoformat(),
            "duration_seconds": row.duration_seconds,
            "words": word_count(row.transcript),
        }
        for row in rows
    ]


@router.post("/analyze/{recording_id}", status_code=202)
async def start_speaker_analysis(
    recording_id: uuid.UUID,
    payload: AnalysisRequest,
    background_tasks: BackgroundTasks,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    recording = await db.get(Recording, recording_id)
    if not recording or recording.deleted_at is not None or recording.status != "ready":
        raise HTTPException(status_code=404, detail="Saved recording not found")
    if not recording.audio_path:
        raise HTTPException(status_code=400, detail="This recording has no retained voice audio.")

    analysis = SpeakerAnalysis(recording_id=recording.id, status="queued")
    db.add(analysis)
    await db.commit()
    await db.refresh(analysis)
    background_tasks.add_task(process_analysis, analysis.id, payload.num_speakers)
    return {"id": str(analysis.id), "status": analysis.status}


@router.get("/analyses/{analysis_id}")
async def get_speaker_analysis(
    analysis_id: uuid.UUID,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    analysis = await db.get(SpeakerAnalysis, analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Speaker analysis not found")
    return await _analysis_payload(analysis, db)


@router.patch("/analyses/{analysis_id}/detections/{speaker_key}")
async def label_detection(
    analysis_id: uuid.UUID,
    speaker_key: str,
    payload: DetectionLabelUpdate,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    detection = (
        await db.execute(
            select(SpeakerDetection).where(
                SpeakerDetection.analysis_id == analysis_id,
                SpeakerDetection.speaker_key == speaker_key,
            )
        )
    ).scalar_one_or_none()
    if not detection:
        raise HTTPException(status_code=404, detail="Detected speaker not found")

    name = payload.display_name.strip()
    detection.display_name = name
    if detection.profile_id:
        profile = await db.get(SpeakerProfile, detection.profile_id)
        if not profile or profile.name.casefold() != name.casefold():
            detection.profile_id = None
            detection.match_score = None
    await db.commit()
    return {"speaker_key": detection.speaker_key, "display_name": detection.display_name}


@router.post("/analyses/{analysis_id}/detections/{speaker_key}/remember")
async def remember_speaker(
    analysis_id: uuid.UUID,
    speaker_key: str,
    payload: RememberSpeakerRequest,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    detection = (
        await db.execute(
            select(SpeakerDetection).where(
                SpeakerDetection.analysis_id == analysis_id,
                SpeakerDetection.speaker_key == speaker_key,
            )
        )
    ).scalar_one_or_none()
    if not detection:
        raise HTTPException(status_code=404, detail="Detected speaker not found")

    analysis = await db.get(SpeakerAnalysis, analysis_id)
    name = payload.name.strip()
    profile = (
        await db.execute(
            select(SpeakerProfile).where(func.lower(SpeakerProfile.name) == name.lower())
        )
    ).scalar_one_or_none()

    if profile:
        profile.embedding = blend_embeddings(
            profile.embedding or [],
            detection.embedding or [],
            profile.sample_count,
        )
        profile.sample_count += 1
        profile.updated_at = datetime.now(timezone.utc)
    else:
        profile = SpeakerProfile(
            name=name,
            embedding=normalise_embedding(detection.embedding or []),
            sample_count=1,
            source_recording_id=analysis.recording_id if analysis else None,
        )
        db.add(profile)
        await db.flush()

    detection.profile_id = profile.id
    detection.display_name = profile.name
    detection.match_score = 1.0
    await db.commit()
    return {"id": str(profile.id), "name": profile.name, "sample_count": profile.sample_count}


@router.get("/profiles")
async def list_speaker_profiles(
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    require_parent_pin(x_parent_pin)
    rows = (await db.execute(select(SpeakerProfile).order_by(SpeakerProfile.name.asc()))).scalars().all()
    return [
        {
            "id": str(row.id),
            "name": row.name,
            "sample_count": row.sample_count,
            "created_at": row.created_at.isoformat(),
            "updated_at": row.updated_at.isoformat(),
        }
        for row in rows
    ]


@router.patch("/profiles/{profile_id}")
async def rename_speaker_profile(
    profile_id: uuid.UUID,
    payload: RenameProfileRequest,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    require_parent_pin(x_parent_pin)
    profile = await db.get(SpeakerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Remembered speaker not found")
    profile.name = payload.name.strip()
    profile.updated_at = datetime.now(timezone.utc)
    detections = (
        await db.execute(select(SpeakerDetection).where(SpeakerDetection.profile_id == profile.id))
    ).scalars().all()
    for detection in detections:
        detection.display_name = profile.name
    await db.commit()
    return {"id": str(profile.id), "name": profile.name}


@router.delete("/profiles/{profile_id}", status_code=204)
async def forget_speaker_profile(
    profile_id: uuid.UUID,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> None:
    require_parent_pin(x_parent_pin)
    profile = await db.get(SpeakerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Remembered speaker not found")
    detections = (
        await db.execute(select(SpeakerDetection).where(SpeakerDetection.profile_id == profile.id))
    ).scalars().all()
    for detection in detections:
        detection.profile_id = None
        detection.match_score = None
    await db.delete(profile)
    await db.commit()
