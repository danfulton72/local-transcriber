import tempfile
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from .auth import (
    actor_user_id,
    current_user_id,
    ensure_default_user,
    is_acting_as,
    request_identity_from_request,
    reset_request_user_ids,
    require_admin,
    router as auth_router,
    set_request_user_ids,
)
from .config import settings
from .db import SessionLocal, get_db, init_db
from .models import (
    Recording,
    RecordingAudioSegment,
    SpeakerAnalysis,
    SpeakerDetection,
    SpeakerProfile,
    SpeakerRelabelSample,
    SpeakerTurn,
    TranscriptRevision,
    TranscriptionChunk,
    UsageEvent,
    User,
    utcnow,
)
from .schemas import (
    EventCreate,
    RecordingCreate,
    RecordingDraftUpdate,
    RecordingFinish,
    RecordingOut,
    RecordingUpdate,
    SpeakerIdentityUpdate,
    SpeakerTurnUpdate,
    SpeechRequest,
)
from .services.gateway import gateway
from .services.progress import correction_pairs, top_corrections, word_count
from .services.recording_audio import combine_wav_segments
from .services.storage import save_bytes
from .services.meeting_state import mark_meeting_notes_stale
from .services.titles import dated_title, renamed_title
from .services.whisper_guard import filter_transcript
from .services.transcript_merge import merge_transcripts
from .services.retention import cleanup_expired_audio, prune_finished_chunk_audio, prune_live_chunk_audio
from .admin import router as admin_router
from .speaker_admin import mark_interrupted_analyses, router as speaker_admin_router
from .meeting_notes_admin import mark_interrupted_exports, router as meeting_notes_router
from .reprocess_admin import mark_interrupted_reprocesses, router as reprocess_router

app = FastAPI(title="Local Transcriber", version="0.17.0")
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(speaker_admin_router)
app.include_router(meeting_notes_router)
app.include_router(reprocess_router)


@app.on_event("startup")
async def startup() -> None:
    settings.recordings_dir.mkdir(parents=True, exist_ok=True)
    await init_db()
    async with SessionLocal() as db:
        await ensure_default_user(db)
        await cleanup_expired_audio(db)
        await prune_finished_chunk_audio(db)
    await mark_interrupted_exports()
    await mark_interrupted_analyses()
    await mark_interrupted_reprocesses()


@app.middleware("http")
async def revalidate_app_shell(request, call_next):
    # StaticFiles sends an ETag but no Cache-Control, which lets browsers keep
    # app.js/styles.css heuristically for hours after a deploy. "no-cache"
    # makes them revalidate every load; unchanged files come back as a 304.
    response = await call_next(request)
    path = request.url.path
    if (
        request.method == "GET"
        and not path.startswith("/api/")
        and "cache-control" not in response.headers
    ):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def authenticated_api(request, call_next):
    path = request.url.path
    if path.startswith("/api/") and not path.startswith("/api/auth/"):
        async with SessionLocal() as db:
            identity = await request_identity_from_request(request, db)
        if not identity:
            return JSONResponse({"detail": "Login required"}, status_code=401)
        actor, effective, _session = identity
        tokens = set_request_user_ids(actor.id, effective.id)
        try:
            return await call_next(request)
        finally:
            reset_request_user_ids(tokens)
    return await call_next(request)


def make_title(transcript: str) -> str:
    clean = " ".join((transcript or "").split())
    if not clean:
        return "New recording"
    parts = clean.split()
    title = " ".join(parts[:9])
    if len(parts) > 9:
        title += "…"
    return title[:240]


def merge_overlapping_text(existing: str, incoming: str) -> str:
    """Append a chunk, removing words it repeats from the end of the existing text."""
    existing = " ".join((existing or "").split()).strip()
    incoming = " ".join((incoming or "").split()).strip()
    if not incoming:
        return existing
    if not existing:
        return incoming
    return merge_transcripts(existing, incoming)


def recording_out(recording: Recording) -> RecordingOut:
    saved_transcript = recording.transcript
    transcript = (
        recording.draft_text
        if recording.status in {"recording", "processing"} and recording.draft_text
        else saved_transcript
    )
    transcript = transcript or ""
    return RecordingOut(
        id=recording.id,
        created_at=recording.created_at,
        finished_at=recording.finished_at,
        last_activity_at=recording.last_activity_at,
        duration_seconds=recording.duration_seconds,
        language=recording.language,
        title=recording.title,
        status=recording.status,
        transcript_original=recording.transcript_original or "",
        transcript_edited=recording.transcript_edited,
        transcript=transcript,
        is_favourite=recording.is_favourite,
        has_audio=bool(recording.audio_path),
        word_count=word_count(transcript),
        draft_text=recording.draft_text,
    )


async def find_recording(recording_id: uuid.UUID, db: AsyncSession, include_deleted: bool = False) -> Recording:
    query = select(Recording).where(
        Recording.id == recording_id,
        Recording.user_id == current_user_id(),
    )
    if not include_deleted:
        query = query.where(Recording.deleted_at.is_(None))
    recording = (await db.execute(query)).scalar_one_or_none()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return recording


def ensure_capture_allowed() -> None:
    if is_acting_as():
        raise HTTPException(
            status_code=403,
            detail="Return to your own account before creating or continuing a recording.",
        )


def admin_audit_event(recording_id: uuid.UUID, action: str, details: dict | None = None) -> UsageEvent | None:
    if not is_acting_as():
        return None
    return UsageEvent(
        recording_id=recording_id,
        event_type="admin_act_as_edit",
        event_data={
            "actor_user_id": str(actor_user_id()),
            "effective_user_id": str(current_user_id()),
            "action": action,
            **(details or {}),
        },
    )


async def store_audio_segment(
    recording: Recording,
    data: bytes,
    filename: str,
    content_type: str,
    db: AsyncSession,
    duration_seconds: float | None = None,
) -> RecordingAudioSegment:
    suffix = Path(filename or "recording.wav").suffix or ".wav"
    segment = RecordingAudioSegment(
        recording_id=recording.id,
        duration_seconds=duration_seconds,
        audio_mime_type=content_type or "audio/wav",
        audio_size=len(data),
    )
    db.add(segment)
    await db.flush()
    relative = f"segments/{segment.id}{suffix}"
    path = save_bytes(recording.id, relative, data)
    segment.audio_path = str(path)

    # Keep these fields populated for backward compatibility and the existing
    # has_audio flag. They point at the newest capture.
    recording.audio_path = str(path)
    recording.audio_mime_type = content_type or "audio/wav"
    recording.audio_size = len(data)
    recording.last_activity_at = utcnow()
    return segment


@app.get("/healthz")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    database_ok = True
    gateway_ok = True
    gateway_version = None
    try:
        await db.execute(text("select 1"))
    except Exception:
        database_ok = False
    try:
        info = await gateway.health()
        gateway_version = info.get("version")
    except Exception:
        gateway_ok = False
    return {
        "status": "ok" if database_ok and gateway_ok else "degraded",
        "database": database_ok,
        "speech_gateway": gateway_ok,
        "speech_gateway_version": gateway_version,
    }


@app.get("/api/voices")
async def voices() -> dict:
    try:
        return await gateway.voices()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Speech gateway unavailable: {exc}") from exc


@app.get("/api/speaker-profiles")
async def speaker_profile_names(db: AsyncSession = Depends(get_db)) -> list[dict]:
    profiles = (
        await db.execute(
            select(SpeakerProfile).order_by(func.lower(SpeakerProfile.name), SpeakerProfile.id)
        )
    ).scalars().all()
    return [{"id": str(profile.id), "name": profile.name} for profile in profiles]


@app.post("/api/recordings", response_model=RecordingOut)
async def create_recording(payload: RecordingCreate, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    ensure_capture_allowed()
    recording = Recording(
        user_id=current_user_id(),
        language=payload.language or None,
        title=dated_title(payload.title, utcnow()),
        status="recording",
        last_activity_at=utcnow(),
    )
    db.add(recording)
    await db.commit()
    await db.refresh(recording)
    return recording_out(recording)


@app.get("/api/recordings", response_model=list[RecordingOut])
async def list_recordings(
    q: str | None = Query(default=None, max_length=200),
    favourite: bool | None = None,
    deleted: bool = False,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> list[RecordingOut]:
    if deleted:
        user = await db.get(User, actor_user_id())
        if not user or not user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
    query = select(Recording).where(Recording.user_id == current_user_id())
    query = query.where(Recording.deleted_at.is_not(None) if deleted else Recording.deleted_at.is_(None))
    if not deleted:
        query = query.where(Recording.status == "ready")
    if favourite is not None:
        query = query.where(Recording.is_favourite == favourite)
    if q:
        pattern = f"%{q.strip()}%"
        query = query.where(
            or_(
                Recording.title.ilike(pattern),
                Recording.transcript_original.ilike(pattern),
                Recording.transcript_edited.ilike(pattern),
            )
        )
    query = query.order_by(Recording.created_at.desc()).offset(offset).limit(limit)
    records = (await db.execute(query)).scalars().all()
    return [recording_out(record) for record in records]


@app.get("/api/recoverable", response_model=RecordingOut | None)
async def recoverable_recording(db: AsyncSession = Depends(get_db)) -> RecordingOut | None:
    if is_acting_as():
        return None
    recording = (
        await db.execute(
            select(Recording)
            .where(
                Recording.user_id == current_user_id(),
                Recording.deleted_at.is_(None),
                Recording.status.in_(["recording", "processing"]),
                or_(
                    Recording.recovery_dismissed_at.is_(None),
                    Recording.last_activity_at > Recording.recovery_dismissed_at,
                ),
            )
            .order_by(Recording.last_activity_at.desc(), Recording.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not recording:
        return None

    if not recording.draft_text:
        chunks = (
            await db.execute(
                select(TranscriptionChunk)
                .where(TranscriptionChunk.recording_id == recording.id)
                .order_by(TranscriptionChunk.chunk_number.asc(), TranscriptionChunk.created_at.asc())
            )
        ).scalars().all()
        recovered = ""
        for chunk in chunks:
            recovered = merge_overlapping_text(recovered, chunk.text)
        if recovered:
            recording.draft_text = recovered
            recording.last_activity_at = utcnow()
            await db.commit()
            await db.refresh(recording)

    return recording_out(recording)


@app.post("/api/recordings/{recording_id}/recovery-acknowledged", status_code=204)
async def acknowledge_recording_recovery(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    recording = await find_recording(recording_id, db)
    if recording.status in {"recording", "processing"}:
        recording.recovery_dismissed_at = utcnow()
        await db.commit()
    return Response(status_code=204)


@app.patch("/api/recordings/{recording_id}/draft", response_model=RecordingOut)
async def save_recording_draft(
    recording_id: uuid.UUID,
    payload: RecordingDraftUpdate,
    db: AsyncSession = Depends(get_db),
) -> RecordingOut:
    recording = await find_recording(recording_id, db)
    if payload.active_capture:
        ensure_capture_allowed()
    recording.draft_text = payload.text.strip() or None
    if payload.active_capture:
        recording.status = "recording"
    recording.last_activity_at = utcnow()
    await db.commit()
    await db.refresh(recording)
    return recording_out(recording)


@app.post("/api/recordings/{recording_id}/abandon", response_model=RecordingOut)
async def abandon_recording(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    recording = await find_recording(recording_id, db)
    if recording.status in {"recording", "processing"}:
        recording.status = "abandoned"
        recording.draft_text = None
        recording.last_activity_at = utcnow()
        await db.commit()
        await db.refresh(recording)
    return recording_out(recording)


@app.get("/api/recordings/{recording_id}", response_model=RecordingOut)
async def get_recording(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    return recording_out(await find_recording(recording_id, db))


async def latest_completed_speaker_analysis(
    recording_id: uuid.UUID,
    db: AsyncSession,
) -> SpeakerAnalysis | None:
    return (
        await db.execute(
            select(SpeakerAnalysis)
            .where(
                SpeakerAnalysis.recording_id == recording_id,
                SpeakerAnalysis.status == "completed",
            )
            .order_by(
                SpeakerAnalysis.completed_at.desc(),
                SpeakerAnalysis.created_at.desc(),
            )
            .limit(1)
        )
    ).scalar_one_or_none()


@app.get("/api/recordings/{recording_id}/speaker-turns")
async def recording_speaker_turns(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await find_recording(recording_id, db)
    analysis = await latest_completed_speaker_analysis(recording.id, db)
    if not analysis:
        return {"analysis_id": None, "speaker_count": 0, "turns": []}

    detections = (
        await db.execute(
            select(SpeakerDetection).where(SpeakerDetection.analysis_id == analysis.id)
        )
    ).scalars().all()
    by_id = {item.id: item for item in detections}
    profiles = (await db.execute(select(SpeakerProfile))).scalars().all()
    profiles_by_id = {item.id: item for item in profiles}
    turns = (
        await db.execute(
            select(SpeakerTurn)
            .where(SpeakerTurn.analysis_id == analysis.id)
            .order_by(SpeakerTurn.start_seconds.asc(), SpeakerTurn.id.asc())
        )
    ).scalars().all()

    return {
        "analysis_id": str(analysis.id),
        "speaker_count": analysis.speaker_count or len(detections),
        "turns": [
            {
                "id": str(turn.id),
                "display_name": (
                    "Unknown"
                    if turn.identity_override_unknown
                    else turn.identity_override_name
                    if turn.identity_override_name
                    else profiles_by_id[turn.identity_override_profile_id].name
                    if turn.identity_override_profile_id in profiles_by_id
                    else by_id[turn.identity_override_detection_id].display_name
                    if turn.identity_override_detection_id in by_id
                    else by_id[turn.detection_id].display_name
                    if turn.detection_id in by_id
                    else "Speaker"
                ),
                "detected_display_name": (
                    by_id[turn.detection_id].display_name
                    if turn.detection_id in by_id
                    else "Speaker"
                ),
                "identity_corrected": bool(
                    turn.identity_override_unknown
                    or turn.identity_override_name
                    or turn.identity_override_profile_id
                    or turn.identity_override_detection_id
                ),
                "start_seconds": round(turn.start_seconds, 2),
                "end_seconds": round(turn.end_seconds, 2),
                "text": turn.edited_text if turn.edited_text is not None else turn.text,
                "original_text": turn.text,
                "edited": turn.edited_text is not None,
                "updated_at": turn.updated_at.isoformat() if turn.updated_at else None,
            }
            for turn in turns
            if (turn.edited_text if turn.edited_text is not None else turn.text)
        ],
    }


@app.patch("/api/recordings/{recording_id}/speaker-turns/{turn_id}/identity")
async def update_recording_speaker_identity(
    recording_id: uuid.UUID,
    turn_id: uuid.UUID,
    payload: SpeakerIdentityUpdate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await find_recording(recording_id, db)
    analysis = await latest_completed_speaker_analysis(recording.id, db)
    if not analysis:
        raise HTTPException(status_code=404, detail="No completed speaker analysis is available for this recording.")

    turn = await db.get(SpeakerTurn, turn_id)
    if not turn or turn.analysis_id != analysis.id:
        raise HTTPException(status_code=404, detail="Speaker turn not found")

    clean_name = (payload.name or "").strip()
    selected = sum(
        bool(value)
        for value in (
            clean_name,
            payload.target_profile_id,
            payload.unknown,
            payload.clear,
        )
    )
    if selected != 1 or payload.target_detection_id:
        raise HTTPException(
            status_code=400,
            detail="Choose a remembered speaker, a new speaker name, Unknown, or reset to the detected identity.",
        )

    source_detection = await db.get(SpeakerDetection, turn.detection_id)
    if not source_detection:
        raise HTTPException(status_code=409, detail="The original detected speaker is no longer available.")

    turns = [turn]
    if payload.scope == "detection":
        turns = (
            await db.execute(
                select(SpeakerTurn).where(
                    SpeakerTurn.analysis_id == analysis.id,
                    SpeakerTurn.detection_id == turn.detection_id,
                )
            )
        ).scalars().all()

    target_profile = None
    if payload.target_profile_id:
        target_profile = await db.get(SpeakerProfile, payload.target_profile_id)
        if not target_profile:
            raise HTTPException(status_code=404, detail="Remembered speaker not found.")
        clean_name = target_profile.name
    elif clean_name:
        target_profile = (
            await db.execute(
                select(SpeakerProfile).where(
                    func.lower(SpeakerProfile.name) == clean_name.casefold()
                )
            )
        ).scalar_one_or_none()

    now = utcnow()
    user_id = actor_user_id()
    for item in turns:
        item_detection = await db.get(SpeakerDetection, item.detection_id)
        if not item_detection:
            continue

        existing = (
            await db.execute(
                select(SpeakerRelabelSample).where(SpeakerRelabelSample.turn_id == item.id)
            )
        ).scalar_one_or_none()

        reset_to_detected = payload.clear or (
            target_profile is not None
            and item_detection.profile_id == target_profile.id
        ) or (
            clean_name and clean_name.casefold() == item_detection.display_name.casefold()
        )
        if reset_to_detected:
            item.identity_override_profile_id = None
            item.identity_override_detection_id = None
            item.identity_override_unknown = False
            item.identity_override_name = None
            item.identity_corrected_by_user_id = None
            item.identity_corrected_at = None
            if existing:
                await db.delete(existing)
            continue

        corrected_name = "Unknown" if payload.unknown else clean_name
        item.identity_override_profile_id = target_profile.id if target_profile else None
        item.identity_override_detection_id = None
        item.identity_override_unknown = bool(payload.unknown)
        item.identity_override_name = None if target_profile or payload.unknown else corrected_name
        item.identity_corrected_by_user_id = user_id
        item.identity_corrected_at = now

        if existing is None:
            db.add(
                SpeakerRelabelSample(
                    recording_id=recording.id,
                    analysis_id=analysis.id,
                    turn_id=item.id,
                    original_profile_id=item_detection.profile_id,
                    corrected_profile_id=target_profile.id if target_profile else None,
                    original_display_name=item_detection.display_name,
                    corrected_display_name=corrected_name,
                    status="pending",
                    corrected_by_user_id=user_id,
                    created_at=now,
                )
            )
        else:
            existing.corrected_profile_id = target_profile.id if target_profile else None
            existing.corrected_display_name = corrected_name
            existing.corrected_by_user_id = user_id
            existing.status = "pending"
            existing.reviewed_at = None

    await mark_meeting_notes_stale(recording.id, db)
    await db.commit()
    return await recording_speaker_turns(recording_id, db)


@app.patch("/api/recordings/{recording_id}/speaker-turns/{turn_id}")
async def update_recording_speaker_turn(
    recording_id: uuid.UUID,
    turn_id: uuid.UUID,
    payload: SpeakerTurnUpdate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await find_recording(recording_id, db)
    analysis = await latest_completed_speaker_analysis(recording.id, db)
    if not analysis:
        raise HTTPException(status_code=404, detail="No completed speaker analysis is available for this recording.")

    turn = await db.get(SpeakerTurn, turn_id)
    if not turn or turn.analysis_id != analysis.id:
        raise HTTPException(status_code=404, detail="Speaker turn not found")

    new_turn_text = payload.text.strip()
    current_turn_text = turn.edited_text if turn.edited_text is not None else turn.text
    if new_turn_text != current_turn_text:
        turn.edited_text = new_turn_text
        turn.updated_at = utcnow()

        turns = (
            await db.execute(
                select(SpeakerTurn)
                .where(SpeakerTurn.analysis_id == analysis.id)
                .order_by(SpeakerTurn.start_seconds.asc(), SpeakerTurn.id.asc())
            )
        ).scalars().all()
        rebuilt = " ".join(
            (item.edited_text if item.edited_text is not None else item.text).strip()
            for item in turns
            if (item.edited_text if item.edited_text is not None else item.text).strip()
        ).strip()
        previous = recording.transcript
        if rebuilt != previous:
            db.add(
                TranscriptRevision(
                    recording_id=recording.id,
                    previous_text=previous,
                    new_text=rebuilt,
                )
            )
            db.add(
                UsageEvent(
                    recording_id=recording.id,
                    event_type="edit",
                    event_data={
                        "source": "speaker_turn",
                        "turn_id": str(turn.id),
                        **(
                            {
                                "admin_actor_user_id": str(actor_user_id()),
                                "effective_user_id": str(current_user_id()),
                            }
                            if is_acting_as()
                            else {}
                        ),
                    },
                )
            )
            recording.transcript_edited = rebuilt
            recording.draft_text = None
            recording.last_activity_at = utcnow()
            if not recording.title or recording.title == "New recording":
                recording.title = dated_title(make_title(rebuilt), recording.created_at)
            await mark_meeting_notes_stale(recording.id, db)

        await db.commit()
        await db.refresh(turn)
        await db.refresh(recording)

    return {
        "id": str(turn.id),
        "text": turn.edited_text if turn.edited_text is not None else turn.text,
        "original_text": turn.text,
        "edited": turn.edited_text is not None,
        "updated_at": turn.updated_at.isoformat() if turn.updated_at else None,
        "transcript": recording.transcript,
        "word_count": word_count(recording.transcript),
    }


@app.patch("/api/recordings/{recording_id}", response_model=RecordingOut)
async def update_recording(recording_id: uuid.UUID, payload: RecordingUpdate, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    recording = await find_recording(recording_id, db)
    title_changed = False
    if payload.title is not None:
        previous_title = recording.title
        if payload.title.strip():
            recording.title = renamed_title(payload.title, recording.title)
        else:
            recording.title = dated_title(make_title(recording.transcript), recording.created_at)
        title_changed = recording.title != previous_title
    if payload.is_favourite is not None:
        recording.is_favourite = payload.is_favourite
    if payload.transcript_edited is not None:
        new_text = payload.transcript_edited.strip()
        previous = recording.transcript
        if new_text != previous:
            db.add(TranscriptRevision(recording_id=recording.id, previous_text=previous, new_text=new_text))
            db.add(UsageEvent(recording_id=recording.id, event_type="edit", event_data={}))
            recording.transcript_edited = new_text
            recording.draft_text = None
            recording.last_activity_at = utcnow()
            if not recording.title or recording.title == "New recording":
                recording.title = dated_title(make_title(new_text), recording.created_at)
            await mark_meeting_notes_stale(recording.id, db, source="recording")
    if title_changed:
        await mark_meeting_notes_stale(recording.id, db)
    audit = admin_audit_event(
        recording.id,
        "recording_update",
        {
            "title_changed": payload.title is not None,
            "transcript_changed": payload.transcript_edited is not None,
            "favourite_changed": payload.is_favourite is not None,
        },
    )
    if audit:
        db.add(audit)
    await db.commit()
    await db.refresh(recording)
    return recording_out(recording)


@app.delete("/api/recordings/{recording_id}", status_code=204)
async def delete_recording(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Response:
    if is_acting_as():
        raise HTTPException(
            status_code=403,
            detail="Return to your own account before moving recordings to the bin.",
        )
    recording = await find_recording(recording_id, db)
    recording.deleted_at = utcnow()
    await db.commit()
    return Response(status_code=204)


@app.post("/api/recordings/{recording_id}/restore", response_model=RecordingOut)
async def restore_recording(
    recording_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> RecordingOut:
    recording = await find_recording(recording_id, db, include_deleted=True)
    recording.deleted_at = None
    await db.commit()
    await db.refresh(recording)
    return recording_out(recording)


@app.post("/api/recordings/{recording_id}/chunks")
async def transcribe_chunk(
    recording_id: uuid.UUID,
    file: UploadFile = File(...),
    chunk_number: int = Form(...),
    started_at_ms: int | None = Form(default=None),
    ended_at_ms: int | None = Form(default=None),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
    task: str = Form(default="transcriptions"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    ensure_capture_allowed()
    recording = await find_recording(recording_id, db)
    data = await file.read()
    relative = f"chunks/{chunk_number:05d}.wav"
    path = save_bytes(recording.id, relative, data)
    started = time.perf_counter()
    try:
        transcript = await gateway.transcribe(
            data,
            file.filename or relative,
            file.content_type or "audio/wav",
            language=language or recording.language,
            prompt=prompt,
            task=task,
        )
    except httpx.HTTPError as exc:
        recording.status = "error"
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}") from exc
    # Whisper invents sign-offs ("Thank you.") for silent audio such as pauses.
    transcript = filter_transcript(transcript, data, context=f"chunk {chunk_number}")
    processing = time.perf_counter() - started
    db.add(
        TranscriptionChunk(
            recording_id=recording.id,
            chunk_number=chunk_number,
            started_at_ms=started_at_ms,
            ended_at_ms=ended_at_ms,
            text=transcript,
            audio_path=str(path),
            processing_seconds=processing,
        )
    )
    recording.processing_seconds += processing
    recording.status = "recording"
    recording.last_activity_at = utcnow()
    await db.commit()
    return {"text": transcript, "processing_seconds": processing}


@app.post("/api/recordings/{recording_id}/audio")
async def upload_audio(
    recording_id: uuid.UUID,
    file: UploadFile = File(...),
    duration_seconds: float | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    ensure_capture_allowed()
    recording = await find_recording(recording_id, db)
    data = await file.read()
    segment = await store_audio_segment(
        recording,
        data,
        file.filename or "recording.wav",
        file.content_type or "audio/wav",
        db,
        duration_seconds=duration_seconds,
    )
    await db.commit()
    return {
        "stored": True,
        "bytes": len(data),
        "segment_id": str(segment.id),
        "duration_seconds": duration_seconds,
    }


@app.post("/api/recordings/{recording_id}/transcribe", response_model=RecordingOut)
async def transcribe_recording(
    recording_id: uuid.UUID,
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
    task: str = Form(default="transcriptions"),
    duration_seconds: float | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> RecordingOut:
    ensure_capture_allowed()
    recording = await find_recording(recording_id, db)
    data = await file.read()
    await store_audio_segment(
        recording,
        data,
        file.filename or "recording.wav",
        file.content_type or "audio/wav",
        db,
        duration_seconds=duration_seconds,
    )
    recording.status = "processing"
    recording.draft_text = None
    await db.commit()
    started = time.perf_counter()
    try:
        transcript = await gateway.transcribe(
            data,
            file.filename or "recording.wav",
            file.content_type or "audio/wav",
            language=language or recording.language,
            prompt=prompt,
            task=task,
        )
    except httpx.HTTPError as exc:
        recording.status = "error"
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}") from exc
    transcript = filter_transcript(transcript, data, context="uploaded recording")
    recording.processing_seconds += time.perf_counter() - started
    recording.transcript_original = transcript
    recording.duration_seconds = duration_seconds
    recording.finished_at = utcnow()
    recording.status = "ready"
    recording.draft_text = None
    recording.last_activity_at = utcnow()
    recording.title = recording.title or dated_title(make_title(transcript), recording.created_at)
    await mark_meeting_notes_stale(recording.id, db, source="recording")
    await db.commit()
    await cleanup_expired_audio(db)
    await db.refresh(recording)
    return recording_out(recording)


@app.post("/api/recordings/{recording_id}/finish", response_model=RecordingOut)
async def finish_recording(recording_id: uuid.UUID, payload: RecordingFinish, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    ensure_capture_allowed()
    recording = await find_recording(recording_id, db)
    new_text = payload.transcript.strip()

    if payload.append:
        recording.transcript_original = merge_overlapping_text(recording.transcript_original or "", new_text)
        if recording.transcript_edited is not None:
            recording.transcript_edited = merge_overlapping_text(recording.transcript_edited, new_text)
        if payload.duration_seconds is not None:
            recording.duration_seconds = (recording.duration_seconds or 0) + payload.duration_seconds
    else:
        recording.transcript_original = new_text
        recording.duration_seconds = payload.duration_seconds

    recording.processing_seconds = max(recording.processing_seconds, payload.processing_seconds)
    recording.finished_at = utcnow()
    recording.status = "ready"
    recording.draft_text = None
    recording.last_activity_at = utcnow()
    recording.title = recording.title or dated_title(make_title(recording.transcript), recording.created_at)
    await mark_meeting_notes_stale(recording.id, db)
    await db.commit()
    await prune_live_chunk_audio(recording, db)
    await cleanup_expired_audio(db)
    await db.refresh(recording)
    return recording_out(recording)


@app.get("/api/recordings/{recording_id}/audio")
async def recording_audio(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> FileResponse:
    recording = await find_recording(recording_id, db)
    if not recording.audio_path or not Path(recording.audio_path).exists():
        raise HTTPException(status_code=404, detail="Audio not available")
    return FileResponse(recording.audio_path, media_type=recording.audio_mime_type or "audio/wav", filename=f"{recording.id}.wav")


@app.get("/api/recordings/{recording_id}/audio-segments")
async def recording_audio_segments(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    recording = await find_recording(recording_id, db)
    segments = (
        await db.execute(
            select(RecordingAudioSegment)
            .where(
                RecordingAudioSegment.recording_id == recording.id,
                RecordingAudioSegment.audio_path.is_not(None),
            )
            .order_by(RecordingAudioSegment.created_at.asc())
        )
    ).scalars().all()

    if not segments and recording.audio_path and Path(recording.audio_path).exists():
        return {
            "complete": True,
            "segment_count": 1,
            "available_count": 1,
            "missing_segment_ids": [],
            "duration_seconds": recording.duration_seconds,
            "segments": [
                {
                    "id": "legacy",
                    "url": f"/api/recordings/{recording.id}/audio",
                    "duration_seconds": recording.duration_seconds,
                }
            ],
        }

    missing = [
        str(segment.id)
        for segment in segments
        if not segment.audio_path or not Path(segment.audio_path).exists()
    ]
    available = [
        segment
        for segment in segments
        if segment.audio_path and Path(segment.audio_path).exists()
    ]
    segment_duration = sum(
        segment.duration_seconds or 0
        for segment in segments
    )
    return {
        "complete": not missing,
        "segment_count": len(segments),
        "available_count": len(available),
        "missing_segment_ids": missing,
        "duration_seconds": segment_duration or recording.duration_seconds,
        "segments": [
            {
                "id": str(segment.id),
                "url": f"/api/recordings/{recording.id}/audio-segments/{segment.id}",
                "duration_seconds": segment.duration_seconds,
            }
            for segment in available
        ],
    }


@app.get("/api/recordings/{recording_id}/audio-combined")
async def recording_audio_combined(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    recording = await find_recording(recording_id, db)
    segments = (
        await db.execute(
            select(RecordingAudioSegment)
            .where(RecordingAudioSegment.recording_id == recording.id)
            .order_by(
                RecordingAudioSegment.created_at.asc(),
                RecordingAudioSegment.id.asc(),
            )
        )
    ).scalars().all()

    # Recordings created before audio segments existed have one legacy file.
    if not segments:
        if recording.audio_path and Path(recording.audio_path).exists():
            return FileResponse(
                recording.audio_path,
                media_type=recording.audio_mime_type or "audio/wav",
                filename=f"{recording.id}.wav",
                headers={"X-Audio-Segments": "1"},
            )
        raise HTTPException(status_code=404, detail="Audio not available")

    missing = [
        str(segment.id)
        for segment in segments
        if not segment.audio_path or not Path(segment.audio_path).exists()
    ]
    if missing:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This voice recording is incomplete because one or more audio segments are missing.",
                "missing_segment_ids": missing,
                "segment_count": len(segments),
            },
        )

    temp = tempfile.NamedTemporaryFile(
        prefix=f"local-transcriber-{recording.id}-",
        suffix=".wav",
        delete=False,
    )
    temp_path = Path(temp.name)
    temp.close()

    try:
        total_frames, sample_rate = combine_wav_segments(
            [Path(segment.audio_path) for segment in segments],
            temp_path,
        )
    except ValueError as exc:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    return FileResponse(
        temp_path,
        media_type="audio/wav",
        filename=f"{recording.id}-complete.wav",
        headers={
            "X-Audio-Segments": str(len(segments)),
            "X-Audio-Frames": str(total_frames),
            "X-Audio-Duration": f"{total_frames / sample_rate:.3f}",
        },
        background=BackgroundTask(lambda: temp_path.unlink(missing_ok=True)),
    )


@app.get("/api/recordings/{recording_id}/audio-segments/{segment_id}")
async def recording_audio_segment(
    recording_id: uuid.UUID,
    segment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    await find_recording(recording_id, db)
    segment = (
        await db.execute(
            select(RecordingAudioSegment).where(
                RecordingAudioSegment.id == segment_id,
                RecordingAudioSegment.recording_id == recording_id,
            )
        )
    ).scalar_one_or_none()
    if not segment or not segment.audio_path or not Path(segment.audio_path).exists():
        raise HTTPException(status_code=404, detail="Audio segment not available")
    return FileResponse(
        segment.audio_path,
        media_type=segment.audio_mime_type or "audio/wav",
        filename=f"{segment.id}.wav",
    )


@app.post("/api/speech")
async def speech(payload: SpeechRequest, db: AsyncSession = Depends(get_db)) -> Response:
    voice = payload.voice or settings.default_voice
    try:
        data, content_type = await gateway.speak(payload.input, voice, payload.speed)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Text-to-speech failed: {exc}") from exc
    if payload.recording_id:
        recording = await find_recording(payload.recording_id, db)
        db.add(UsageEvent(recording_id=recording.id, event_type="read_aloud", event_data={"chars": len(payload.input)}))
        await db.commit()
    return Response(content=data, media_type=content_type)


@app.post("/api/events", status_code=204)
async def create_event(payload: EventCreate, db: AsyncSession = Depends(get_db)) -> Response:
    allowed = {"copy", "share", "download", "read_aloud"}
    if payload.event_type not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported event type")
    if payload.recording_id:
        await find_recording(payload.recording_id, db)
    db.add(UsageEvent(recording_id=payload.recording_id, event_type=payload.event_type, event_data=payload.event_data))
    await db.commit()
    return Response(status_code=204)


@app.get("/api/progress")
async def progress(
    days: int = Query(default=30, ge=7, le=365),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    records = (
        await db.execute(
            select(Recording)
            .where(
                Recording.user_id == current_user_id(),
                Recording.deleted_at.is_(None),
                Recording.created_at >= since,
                Recording.status == "ready",
            )
            .order_by(Recording.created_at.asc())
        )
    ).scalars().all()
    events = (
        await db.execute(
            select(UsageEvent)
            .join(Recording, UsageEvent.recording_id == Recording.id)
            .where(
                Recording.user_id == current_user_id(),
                UsageEvent.created_at >= since,
            )
        )
    ).scalars().all()

    total_seconds = sum(record.duration_seconds or 0 for record in records)
    total_words = sum(word_count(record.transcript) for record in records)
    edited = [
        record
        for record in records
        if record.transcript_edited is not None and record.transcript_edited != record.transcript_original
    ]
    correction_list: list[tuple[str, str]] = []
    for record in edited:
        correction_list.extend(correction_pairs(record.transcript_original, record.transcript_edited or ""))

    longest = max(records, key=lambda item: word_count(item.transcript), default=None)
    daily_map: dict[str, dict] = defaultdict(lambda: {"sessions": 0, "words": 0, "minutes": 0.0})
    for record in records:
        key = record.created_at.date().isoformat()
        daily_map[key]["sessions"] += 1
        daily_map[key]["words"] += word_count(record.transcript)
        daily_map[key]["minutes"] += (record.duration_seconds or 0) / 60

    return {
        "days": days,
        "sessions": len(records),
        "minutes_spoken": round(total_seconds / 60, 1),
        "words_dictated": total_words,
        "average_session_minutes": round(total_seconds / len(records) / 60, 1) if records else 0,
        "edited_sessions": len(edited),
        "read_aloud_uses": sum(1 for event in events if event.event_type == "read_aloud"),
        "copy_uses": sum(1 for event in events if event.event_type == "copy"),
        "top_corrections": top_corrections(correction_list),
        "longest_piece": None if not longest else {
            "id": str(longest.id),
            "title": longest.title,
            "words": word_count(longest.transcript),
        },
        "daily": [
            {"date": key, **value, "minutes": round(value["minutes"], 1)}
            for key, value in sorted(daily_map.items())
        ],
    }


static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
