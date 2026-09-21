import secrets
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import SessionLocal, get_db, init_db
from .models import Recording, TranscriptRevision, TranscriptionChunk, UsageEvent, utcnow
from .schemas import EventCreate, RecordingCreate, RecordingFinish, RecordingOut, RecordingUpdate, SpeechRequest
from .services.gateway import gateway
from .services.progress import correction_pairs, top_corrections, word_count
from .services.storage import save_bytes
from .services.retention import apply_recording_retention, cleanup_expired_audio
from .admin import router as admin_router

app = FastAPI(title="Local Transcriber", version="0.2.0")
app.include_router(admin_router)


@app.on_event("startup")
async def startup() -> None:
    settings.recordings_dir.mkdir(parents=True, exist_ok=True)
    await init_db()
    async with SessionLocal() as db:
        await cleanup_expired_audio(db)


def make_title(transcript: str) -> str:
    clean = " ".join((transcript or "").split())
    if not clean:
        return "New recording"
    parts = clean.split()
    title = " ".join(parts[:9])
    if len(parts) > 9:
        title += "…"
    return title[:240]


def recording_out(recording: Recording) -> RecordingOut:
    transcript = recording.transcript
    return RecordingOut(
        id=recording.id,
        created_at=recording.created_at,
        finished_at=recording.finished_at,
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
    )


async def find_recording(recording_id: uuid.UUID, db: AsyncSession, include_deleted: bool = False) -> Recording:
    query = select(Recording).where(Recording.id == recording_id)
    if not include_deleted:
        query = query.where(Recording.deleted_at.is_(None))
    recording = (await db.execute(query)).scalar_one_or_none()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return recording


def check_parent_pin(x_parent_pin: str | None) -> None:
    expected = settings.parent_pin.strip()
    if not expected:
        return
    supplied = (x_parent_pin or "").strip()
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Parent PIN required")


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


@app.post("/api/recordings", response_model=RecordingOut)
async def create_recording(payload: RecordingCreate, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    recording = Recording(language=payload.language or None, title=payload.title, status="recording")
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
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[RecordingOut]:
    if deleted:
        check_parent_pin(x_parent_pin)
    query = select(Recording)
    query = query.where(Recording.deleted_at.is_not(None) if deleted else Recording.deleted_at.is_(None))
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


@app.get("/api/recordings/{recording_id}", response_model=RecordingOut)
async def get_recording(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    return recording_out(await find_recording(recording_id, db))


@app.patch("/api/recordings/{recording_id}", response_model=RecordingOut)
async def update_recording(recording_id: uuid.UUID, payload: RecordingUpdate, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    recording = await find_recording(recording_id, db)
    if payload.title is not None:
        recording.title = payload.title.strip()[:240] or make_title(recording.transcript)
    if payload.is_favourite is not None:
        recording.is_favourite = payload.is_favourite
    if payload.transcript_edited is not None:
        new_text = payload.transcript_edited.strip()
        previous = recording.transcript
        if new_text != previous:
            db.add(TranscriptRevision(recording_id=recording.id, previous_text=previous, new_text=new_text))
            db.add(UsageEvent(recording_id=recording.id, event_type="edit", event_data={}))
            recording.transcript_edited = new_text
            if not recording.title or recording.title == "New recording":
                recording.title = make_title(new_text)
    await db.commit()
    await db.refresh(recording)
    return recording_out(recording)


@app.delete("/api/recordings/{recording_id}", status_code=204)
async def delete_recording(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Response:
    recording = await find_recording(recording_id, db)
    recording.deleted_at = utcnow()
    await db.commit()
    return Response(status_code=204)


@app.post("/api/recordings/{recording_id}/restore", response_model=RecordingOut)
async def restore_recording(
    recording_id: uuid.UUID,
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> RecordingOut:
    check_parent_pin(x_parent_pin)
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
    await db.commit()
    return {"text": transcript, "processing_seconds": processing}


@app.post("/api/recordings/{recording_id}/audio")
async def upload_audio(
    recording_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await find_recording(recording_id, db)
    data = await file.read()
    suffix = Path(file.filename or "recording.wav").suffix or ".wav"
    path = save_bytes(recording.id, f"recording{suffix}", data)
    recording.audio_path = str(path)
    recording.audio_mime_type = file.content_type or "audio/wav"
    recording.audio_size = len(data)
    await db.commit()
    return {"stored": True, "bytes": len(data)}


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
    recording = await find_recording(recording_id, db)
    data = await file.read()
    suffix = Path(file.filename or "recording.wav").suffix or ".wav"
    path = save_bytes(recording.id, f"recording{suffix}", data)
    recording.audio_path = str(path)
    recording.audio_mime_type = file.content_type or "audio/wav"
    recording.audio_size = len(data)
    recording.status = "processing"
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
    recording.processing_seconds += time.perf_counter() - started
    recording.transcript_original = transcript
    recording.duration_seconds = duration_seconds
    recording.finished_at = utcnow()
    recording.status = "ready"
    recording.title = recording.title or make_title(transcript)
    await db.commit()
    await apply_recording_retention(recording, db)
    await db.refresh(recording)
    return recording_out(recording)


@app.post("/api/recordings/{recording_id}/finish", response_model=RecordingOut)
async def finish_recording(recording_id: uuid.UUID, payload: RecordingFinish, db: AsyncSession = Depends(get_db)) -> RecordingOut:
    recording = await find_recording(recording_id, db)
    recording.transcript_original = payload.transcript.strip()
    recording.duration_seconds = payload.duration_seconds
    recording.processing_seconds = max(recording.processing_seconds, payload.processing_seconds)
    recording.finished_at = utcnow()
    recording.status = "ready"
    recording.title = recording.title or make_title(recording.transcript_original)
    await db.commit()
    await apply_recording_retention(recording, db)
    await db.refresh(recording)
    return recording_out(recording)


@app.get("/api/recordings/{recording_id}/audio")
async def recording_audio(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> FileResponse:
    recording = await find_recording(recording_id, db)
    if not recording.audio_path or not Path(recording.audio_path).exists():
        raise HTTPException(status_code=404, detail="Audio not available")
    return FileResponse(recording.audio_path, media_type=recording.audio_mime_type or "audio/wav", filename=f"{recording.id}.wav")


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
    allowed = {"copy", "download", "read_aloud"}
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
    x_parent_pin: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    check_parent_pin(x_parent_pin)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    records = (
        await db.execute(
            select(Recording)
            .where(Recording.deleted_at.is_(None), Recording.created_at >= since, Recording.status == "ready")
            .order_by(Recording.created_at.asc())
        )
    ).scalars().all()
    events = (await db.execute(select(UsageEvent).where(UsageEvent.created_at >= since))).scalars().all()

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
