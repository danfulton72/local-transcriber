"""Admin-only transcription reprocessing against retained recording audio."""

import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import actor_user_id, current_user_id, require_admin
from .db import SessionLocal, get_db
from .models import (
    Recording,
    SpeakerAnalysis,
    SpeakerTurn,
    TranscriptRevision,
    TranscriptionRun,
    UsageEvent,
)
from .services.gateway import gateway
from .services.meeting_state import mark_meeting_notes_stale
from .services.recording_audio import build_combined_wav, extract_wav_clip
from .services.transcript_merge import merge_transcripts
from .services.whisper_guard import filter_transcript


router = APIRouter(
    prefix="/api/admin/reprocess",
    tags=["reprocess"],
    dependencies=[Depends(require_admin)],
)

ACTIVE_STATUSES = {"queued", "processing"}
WINDOW_SECONDS = 300.0
WINDOW_OVERLAP_SECONDS = 0.9


class AcceptReprocessRequest(BaseModel):
    clear_edits: bool = False


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def mark_interrupted_reprocesses() -> None:
    """Background jobs do not survive an app restart; release their lock."""
    async with SessionLocal() as db:
        await db.execute(
            update(TranscriptionRun)
            .where(TranscriptionRun.status.in_(ACTIVE_STATUSES))
            .values(
                status="error",
                error="Interrupted by an app restart. Run it again.",
                completed_at=utcnow(),
            )
        )
        await db.commit()


async def _active_job(db: AsyncSession) -> TranscriptionRun | None:
    return (
        await db.execute(
            select(TranscriptionRun)
            .where(TranscriptionRun.status.in_(ACTIVE_STATUSES))
            .order_by(TranscriptionRun.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _ensure_reprocess_idle(db: AsyncSession) -> None:
    active = await _active_job(db)
    if active is not None:
        raise HTTPException(
            status_code=409,
            detail="Another transcription reprocessing job is already running.",
        )
    analysis = (
        await db.execute(
            select(SpeakerAnalysis)
            .where(SpeakerAnalysis.status.in_(ACTIVE_STATUSES))
            .limit(1)
        )
    ).scalar_one_or_none()
    if analysis is not None:
        raise HTTPException(
            status_code=409,
            detail="Speaker analysis is currently using the speech GPU. Try again when it finishes.",
        )


async def _owned_ready_recording(recording_id: uuid.UUID, db: AsyncSession) -> Recording:
    recording = (
        await db.execute(
            select(Recording).where(
                Recording.id == recording_id,
                Recording.user_id == current_user_id(),
                Recording.deleted_at.is_(None),
                Recording.status == "ready",
            )
        )
    ).scalar_one_or_none()
    if not recording:
        raise HTTPException(status_code=404, detail="Saved recording not found")
    if not recording.audio_path:
        raise HTTPException(status_code=400, detail="This recording has no retained voice audio.")
    return recording


def _payload(run: TranscriptionRun, recording: Recording | None = None) -> dict:
    result = {
        "id": str(run.id),
        "recording_id": str(run.recording_id),
        "analysis_id": str(run.analysis_id) if run.analysis_id else None,
        "mode": run.mode,
        "status": run.status,
        "model": run.model,
        "candidate_transcript": run.transcript_candidate,
        "result_data": run.result_data or {},
        "error": run.error,
        "processing_seconds": round(run.processing_seconds or 0.0, 2),
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "accepted_at": run.accepted_at.isoformat() if run.accepted_at else None,
        "discarded_at": run.discarded_at.isoformat() if run.discarded_at else None,
        "decision": "accepted" if run.accepted_at else "discarded" if run.discarded_at else None,
    }
    if recording is not None:
        result.update(
            {
                "current_transcript": recording.transcript,
                "has_manual_edits": recording.transcript_edited is not None,
                "recording_title": recording.title or "Recording",
            }
        )
    return result


async def _transcribe_windowed(
    path: Path,
    duration_seconds: float,
    *,
    language: str | None,
    context: str,
) -> tuple[str, int]:
    """Transcribe a retained WAV in bounded overlapping windows.

    The overlap protects words at five-minute request boundaries while keeping
    uploads bounded even for long meetings.
    """
    duration = max(0.0, float(duration_seconds or 0.0))
    if duration <= 0:
        raise ValueError("The retained recording has no usable audio duration.")

    merged = ""
    window_count = 0
    cursor = 0.0
    while cursor < duration:
        start = 0.0 if cursor == 0 else max(0.0, cursor - WINDOW_OVERLAP_SECONDS)
        end = min(duration, cursor + WINDOW_SECONDS)
        wav_data, _, _ = extract_wav_clip(
            path,
            start,
            end,
            max_seconds=max(WINDOW_SECONDS + WINDOW_OVERLAP_SECONDS + 1.0, end - start + 1.0),
            edge_trim_seconds=0.0,
        )
        text = await gateway.transcribe(
            wav_data,
            f"reprocess-{window_count + 1:04d}.wav",
            "audio/wav",
            language=language,
        )
        text = filter_transcript(text, wav_data, context=f"{context} window {window_count + 1}")
        merged = merge_transcripts(merged, text)
        window_count += 1
        cursor += WINDOW_SECONDS
    return merged.strip(), window_count


async def process_recording_reprocess(run_id: uuid.UUID) -> None:
    started = time.perf_counter()
    temp_path: Path | None = None
    delete_temp = False

    async with SessionLocal() as db:
        run = await db.get(TranscriptionRun, run_id)
        if not run:
            return
        recording = await db.get(Recording, run.recording_id)
        if not recording:
            run.status = "error"
            run.error = "Recording no longer exists."
            run.completed_at = utcnow()
            await db.commit()
            return

        run.status = "processing"
        run.error = None
        await db.commit()

        try:
            temp_path, delete_temp, segment_count, duration = await build_combined_wav(recording, db)
            candidate, window_count = await _transcribe_windowed(
                temp_path,
                duration or 0.0,
                language=recording.language,
                context="reprocessed recording",
            )
            run.transcript_candidate = candidate
            run.result_data = {
                "segment_count": segment_count,
                "window_count": window_count,
                "duration_seconds": round(float(duration or 0.0), 3),
            }
            run.status = "completed"
            run.completed_at = utcnow()
            run.error = None
        except (ValueError, httpx.HTTPError, OSError) as exc:
            run.status = "error"
            run.error = str(exc)[:2000]
            run.completed_at = utcnow()
        except Exception as exc:
            run.status = "error"
            run.error = f"Unexpected error: {exc}"[:2000]
            run.completed_at = utcnow()
        finally:
            run.processing_seconds = time.perf_counter() - started
            await db.commit()
            if delete_temp and temp_path is not None:
                temp_path.unlink(missing_ok=True)


async def process_speaker_turn_reprocess(run_id: uuid.UUID) -> None:
    started = time.perf_counter()
    temp_path: Path | None = None
    delete_temp = False

    async with SessionLocal() as db:
        run = await db.get(TranscriptionRun, run_id)
        if not run:
            return
        analysis = await db.get(SpeakerAnalysis, run.analysis_id) if run.analysis_id else None
        recording = await db.get(Recording, run.recording_id)
        if not analysis or not recording or analysis.status != "completed":
            run.status = "error"
            run.error = "The completed speaker analysis is no longer available."
            run.completed_at = utcnow()
            await db.commit()
            return

        run.status = "processing"
        run.error = None
        await db.commit()

        try:
            temp_path, delete_temp, _, duration = await build_combined_wav(recording, db)
            turns = (
                await db.execute(
                    select(SpeakerTurn)
                    .where(SpeakerTurn.analysis_id == analysis.id)
                    .order_by(SpeakerTurn.start_seconds.asc(), SpeakerTurn.id.asc())
                )
            ).scalars().all()

            candidates: list[dict] = []
            for index, turn in enumerate(turns, start=1):
                turn_seconds = max(0.0, turn.end_seconds - turn.start_seconds)
                if turn_seconds < 0.18:
                    text = ""
                else:
                    start = max(0.0, turn.start_seconds - 0.03)
                    end = min(float(duration or turn.end_seconds + 0.03), turn.end_seconds + 0.03)
                    wav_data, _, _ = extract_wav_clip(
                        temp_path,
                        start,
                        end,
                        max_seconds=max(1.0, end - start + 0.5),
                        edge_trim_seconds=0.0,
                    )
                    text = await gateway.transcribe(
                        wav_data,
                        f"speaker-turn-{index:04d}.wav",
                        "audio/wav",
                        language=recording.language,
                    )
                    text = filter_transcript(text, wav_data, context=f"reprocessed speaker turn {index}")
                candidates.append({"id": str(turn.id), "text": text.strip()})

            by_id = {str(turn.id): turn for turn in turns}
            changed = 0
            edited_preserved = 0
            for item in candidates:
                turn = by_id.get(item["id"])
                if turn is None:
                    continue
                if turn.text != item["text"]:
                    turn.text = item["text"]
                    changed += 1
                if turn.edited_text is not None:
                    edited_preserved += 1

            machine_transcript = " ".join(
                turn.text.strip()
                for turn in turns
                if turn.text.strip()
            ).strip()
            effective_transcript = " ".join(
                (turn.edited_text if turn.edited_text is not None else turn.text).strip()
                for turn in turns
                if (turn.edited_text if turn.edited_text is not None else turn.text).strip()
            ).strip()
            previous_transcript = recording.transcript
            if effective_transcript != previous_transcript:
                db.add(
                    TranscriptRevision(
                        recording_id=recording.id,
                        previous_text=previous_transcript,
                        new_text=effective_transcript,
                    )
                )
            recording.transcript_original = machine_transcript
            recording.transcript_edited = effective_transcript if edited_preserved else None
            recording.draft_text = None
            recording.last_activity_at = utcnow()

            run.result_data = {
                "turn_count": len(turns),
                "changed_turns": changed,
                "manual_edits_preserved": edited_preserved,
            }
            run.status = "completed"
            run.completed_at = utcnow()
            await mark_meeting_notes_stale(recording.id, db)
            db.add(
                UsageEvent(
                    recording_id=recording.id,
                    event_type="speaker_words_reprocessed",
                    event_data={
                        "analysis_id": str(analysis.id),
                        "run_id": str(run.id),
                        "changed_turns": changed,
                    },
                )
            )
            await db.commit()
        except (ValueError, httpx.HTTPError, OSError) as exc:
            run.status = "error"
            run.error = str(exc)[:2000]
            run.completed_at = utcnow()
            await db.commit()
        except Exception as exc:
            run.status = "error"
            run.error = f"Unexpected error: {exc}"[:2000]
            run.completed_at = utcnow()
            await db.commit()
        finally:
            run.processing_seconds = time.perf_counter() - started
            await db.commit()
            if delete_temp and temp_path is not None:
                temp_path.unlink(missing_ok=True)


@router.get("/recordings/{recording_id}")
async def latest_recording_reprocess(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await _owned_ready_recording(recording_id, db)
    run = (
        await db.execute(
            select(TranscriptionRun)
            .where(
                TranscriptionRun.recording_id == recording.id,
                TranscriptionRun.mode == "recording",
            )
            .order_by(TranscriptionRun.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return {"status": "none", "recording_id": str(recording.id)} if run is None else _payload(run, recording)


@router.post("/recordings/{recording_id}", status_code=202)
async def start_recording_reprocess(
    recording_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await _owned_ready_recording(recording_id, db)
    await _ensure_reprocess_idle(db)

    run = TranscriptionRun(
        recording_id=recording.id,
        mode="recording",
        status="queued",
        model="whisper-1",
        requested_by_user_id=actor_user_id(),
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    background_tasks.add_task(process_recording_reprocess, run.id)
    return _payload(run, recording)


@router.get("/runs/{run_id}")
async def get_reprocess_run(
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    run = await db.get(TranscriptionRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Reprocessing job not found")
    recording = await db.get(Recording, run.recording_id)
    return _payload(run, recording)


@router.post("/runs/{run_id}/accept")
async def accept_recording_reprocess(
    run_id: uuid.UUID,
    payload: AcceptReprocessRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    run = await db.get(TranscriptionRun, run_id)
    if not run or run.mode != "recording":
        raise HTTPException(status_code=404, detail="Reprocessed transcript not found")
    recording = await db.get(Recording, run.recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    if recording.user_id != current_user_id():
        raise HTTPException(status_code=404, detail="Recording not found")
    if run.status != "completed" or run.transcript_candidate is None:
        raise HTTPException(status_code=409, detail="The reprocessed transcript is not ready yet.")
    if run.accepted_at or run.discarded_at:
        raise HTTPException(status_code=409, detail="This reprocessed transcript has already been reviewed.")
    if recording.transcript_edited is not None and not payload.clear_edits:
        raise HTTPException(
            status_code=409,
            detail="This recording has manual edits. Confirm replacing them with the reprocessed transcript.",
        )

    previous = recording.transcript
    candidate = run.transcript_candidate.strip()
    if candidate != previous:
        db.add(
            TranscriptRevision(
                recording_id=recording.id,
                previous_text=previous,
                new_text=candidate,
            )
        )
    recording.transcript_original = candidate
    recording.transcript_edited = None
    recording.draft_text = None
    recording.last_activity_at = utcnow()
    recording.whisper_model = run.model
    run.accepted_at = utcnow()
    db.add(
        UsageEvent(
            recording_id=recording.id,
            event_type="reprocess_accept",
            event_data={
                "run_id": str(run.id),
                "replaced_manual_edits": bool(payload.clear_edits),
            },
        )
    )
    await mark_meeting_notes_stale(recording.id, db)
    await db.commit()
    await db.refresh(run)
    await db.refresh(recording)
    return _payload(run, recording)


@router.post("/runs/{run_id}/discard")
async def discard_recording_reprocess(
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    run = await db.get(TranscriptionRun, run_id)
    if not run or run.mode != "recording":
        raise HTTPException(status_code=404, detail="Reprocessed transcript not found")
    recording = await db.get(Recording, run.recording_id)
    if not recording or recording.user_id != current_user_id():
        raise HTTPException(status_code=404, detail="Recording not found")
    if run.status != "completed":
        raise HTTPException(status_code=409, detail="The reprocessed transcript is not ready yet.")
    if run.accepted_at or run.discarded_at:
        raise HTTPException(status_code=409, detail="This reprocessed transcript has already been reviewed.")
    run.discarded_at = utcnow()
    await db.commit()
    await db.refresh(run)
    return _payload(run, recording)


@router.post("/analyses/{analysis_id}/speaker-turns", status_code=202)
async def start_speaker_turn_reprocess(
    analysis_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    analysis = await db.get(SpeakerAnalysis, analysis_id)
    if not analysis or analysis.status != "completed":
        raise HTTPException(status_code=404, detail="Completed speaker analysis not found")
    recording = await db.get(Recording, analysis.recording_id)
    if not recording or recording.deleted_at is not None or recording.status != "ready":
        raise HTTPException(status_code=404, detail="Saved recording not found")
    if not recording.audio_path:
        raise HTTPException(status_code=400, detail="This recording has no retained voice audio.")

    await _ensure_reprocess_idle(db)
    run = TranscriptionRun(
        recording_id=recording.id,
        analysis_id=analysis.id,
        mode="speaker_turns",
        status="queued",
        model="whisper-1",
        requested_by_user_id=actor_user_id(),
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    background_tasks.add_task(process_speaker_turn_reprocess, run.id)
    return _payload(run, recording)
