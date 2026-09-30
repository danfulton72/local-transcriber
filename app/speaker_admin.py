import math
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import actor_user_id, require_admin
from .config import settings
from .db import SessionLocal, get_db
from .models import (
    MeetingExport,
    Recording,
    User,
    SpeakerAnalysis,
    SpeakerDetection,
    SpeakerProfile,
    SpeakerProfileSample,
    SpeakerRelabelSample,
    SpeakerTurn,
)
from .services.progress import word_count
from .services.recording_audio import build_combined_wav, extract_wav_clip
from .services.speaker_service import speaker_service


router = APIRouter(prefix="/api/admin/speakers", tags=["speaker-analysis"], dependencies=[Depends(require_admin)])

MIN_SAMPLE_SPEECH_SECONDS = 3.0
MAX_PROFILE_SAMPLES = 8
MATCH_TOP_SAMPLES = 3


class AnalysisRequest(BaseModel):
    num_speakers: int | None = Field(default=None, ge=1, le=10)


class DetectionLabelUpdate(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)


class RememberSpeakerRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class RenameProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class TurnIdentityUpdate(BaseModel):
    target_profile_id: uuid.UUID | None = None
    target_detection_id: uuid.UUID | None = None
    unknown: bool = False
    clear: bool = False
    scope: str = Field(default="turn", pattern="^(turn|detection)$")


class RelabelStatusUpdate(BaseModel):
    status: str = Field(pattern="^(pending|approved|excluded)$")


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


def average_embeddings(embeddings: list[list[float]]) -> list[float]:
    valid = [normalise_embedding(values) for values in embeddings if values]
    if not valid:
        return []
    width = len(valid[0])
    valid = [values for values in valid if len(values) == width]
    if not valid:
        return []
    return normalise_embedding([
        sum(values[index] for values in valid) / len(valid)
        for index in range(width)
    ])


def robust_sample_score(embedding: list[float], samples: list[list[float]]) -> float:
    scores = sorted(
        (
            cosine_similarity(embedding, sample)
            for sample in samples
            if sample and len(sample) == len(embedding)
        ),
        reverse=True,
    )
    if not scores:
        return -1.0
    if len(scores) == 1:
        return scores[0]
    if len(scores) == 2:
        return scores[0] * 0.65 + scores[1] * 0.35
    top = scores[:MATCH_TOP_SAMPLES]
    return top[0] * 0.55 + top[1] * 0.30 + top[2] * 0.15


def profile_quality(sample_count: int) -> str:
    if sample_count >= 5:
        return "strong"
    if sample_count >= 3:
        return "good"
    if sample_count >= 2:
        return "building"
    return "starter"


def best_profile(
    embedding: list[float],
    profiles: list[SpeakerProfile],
    samples_by_profile: dict[uuid.UUID, list[SpeakerProfileSample]] | None = None,
) -> tuple[SpeakerProfile | None, float | None]:
    best = None
    best_score = -1.0
    for profile in profiles:
        bank = (samples_by_profile or {}).get(profile.id, [])
        sample_embeddings = [sample.embedding or [] for sample in bank]
        score = (
            robust_sample_score(embedding, sample_embeddings)
            if sample_embeddings
            else cosine_similarity(embedding, profile.embedding or [])
        )
        if score > best_score:
            best = profile
            best_score = score
    if best is None or best_score < settings.speaker_match_threshold:
        return None, None
    return best, best_score


async def detection_speech_seconds(db: AsyncSession, detection_id: uuid.UUID) -> float:
    turns = (
        await db.execute(
            select(SpeakerTurn).where(SpeakerTurn.detection_id == detection_id)
        )
    ).scalars().all()
    return sum(max(0.0, turn.end_seconds - turn.start_seconds) for turn in turns)


async def rebuild_profile_summary(profile: SpeakerProfile, db: AsyncSession) -> list[SpeakerProfileSample]:
    samples = (
        await db.execute(
            select(SpeakerProfileSample)
            .where(SpeakerProfileSample.profile_id == profile.id)
            .order_by(SpeakerProfileSample.created_at.asc())
        )
    ).scalars().all()
    profile.embedding = average_embeddings([sample.embedding or [] for sample in samples])
    profile.sample_count = len(samples)
    profile.updated_at = datetime.now(timezone.utc)
    return samples


async def _analysis_payload(analysis: SpeakerAnalysis, db: AsyncSession) -> dict:
    recording = await db.get(Recording, analysis.recording_id)
    owner = await db.get(User, recording.user_id) if recording and recording.user_id else None
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
    profiles = (await db.execute(select(SpeakerProfile))).scalars().all()
    profiles_by_id = {item.id: item for item in profiles}
    speech_by_detection: dict[uuid.UUID, float] = {}
    longest_turn_by_detection: dict[uuid.UUID, float] = {}
    for turn in turns:
        turn_seconds = max(0.0, turn.end_seconds - turn.start_seconds)
        speech_by_detection[turn.detection_id] = (
            speech_by_detection.get(turn.detection_id, 0.0) + turn_seconds
        )
        longest_turn_by_detection[turn.detection_id] = max(
            longest_turn_by_detection.get(turn.detection_id, 0.0),
            turn_seconds,
        )

    return {
        "id": str(analysis.id),
        "recording_id": str(analysis.recording_id),
        "recording_title": recording.title if recording else None,
        "recording_owner": (owner.display_name or owner.username) if owner else None,
        "recording_owner_username": owner.username if owner else None,
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
                "speech_seconds": round(speech_by_detection.get(item.id, 0.0), 2),
                "can_remember": speech_by_detection.get(item.id, 0.0) >= MIN_SAMPLE_SPEECH_SECONDS,
                "preview_seconds": round(min(longest_turn_by_detection.get(item.id, 0.0), 8.0), 2),
                "can_preview": longest_turn_by_detection.get(item.id, 0.0) > 0.0,
            }
            for item in detections
        ],
        "turns": [
            {
                "id": str(turn.id),
                "detection_id": str(turn.detection_id),
                "speaker_key": by_id[turn.detection_id].speaker_key if turn.detection_id in by_id else "",
                "detected_display_name": by_id[turn.detection_id].display_name if turn.detection_id in by_id else "Speaker",
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
                "effective_profile_id": (
                    str(turn.identity_override_profile_id)
                    if turn.identity_override_profile_id in profiles_by_id
                    else (
                        str(by_id[turn.identity_override_detection_id].profile_id)
                        if by_id[turn.identity_override_detection_id].profile_id
                        else None
                    )
                    if turn.identity_override_detection_id in by_id
                    else str(by_id[turn.detection_id].profile_id)
                    if turn.detection_id in by_id and by_id[turn.detection_id].profile_id
                    else None
                ),
                "identity_corrected": bool(
                    turn.identity_override_unknown
                    or turn.identity_override_name
                    or turn.identity_override_profile_id
                    or turn.identity_override_detection_id
                ),
                "identity_override_name": turn.identity_override_name,
                "identity_override_profile_id": (
                    str(turn.identity_override_profile_id)
                    if turn.identity_override_profile_id else None
                ),
                "identity_override_detection_id": (
                    str(turn.identity_override_detection_id)
                    if turn.identity_override_detection_id else None
                ),
                "identity_override_unknown": bool(turn.identity_override_unknown),
                "start_seconds": round(turn.start_seconds, 2),
                "end_seconds": round(turn.end_seconds, 2),
                "text": turn.edited_text if turn.edited_text is not None else turn.text,
                "original_text": turn.text,
                "edited": turn.edited_text is not None,
            }
            for turn in turns
        ],
    }


async def admin_analysis(analysis_id: uuid.UUID, db: AsyncSession) -> SpeakerAnalysis:
    analysis = await db.get(SpeakerAnalysis, analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Speaker analysis not found")
    recording = await db.get(Recording, analysis.recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Speaker analysis not found")
    return analysis


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
            profile_samples = (await db.execute(select(SpeakerProfileSample))).scalars().all()
            samples_by_profile: dict[uuid.UUID, list[SpeakerProfileSample]] = {}
            for sample in profile_samples:
                samples_by_profile.setdefault(sample.profile_id, []).append(sample)

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
                profile, score = best_profile(embedding, profiles, samples_by_profile)
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
    db: AsyncSession = Depends(get_db),
) -> dict:
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
    limit: int = Query(default=300, ge=1, le=1000),
    view: str = Query(default="all", pattern="^(all|todo)$"),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Saved conversations for the Speakers tools, sorted by title (A–Z).

    ``view=todo`` hides conversations already sent to Open Notebook, leaving
    ones still to analyse or still to send. Titles start with yyyymmdd, so
    A–Z is also oldest-first within a day-prefixed set.
    """
    rows = (
        await db.execute(
            select(Recording, User)
            .join(User, Recording.user_id == User.id)
            .where(
                Recording.deleted_at.is_(None),
                Recording.status == "ready",
                Recording.audio_path.is_not(None),
            )
            .order_by(Recording.created_at.desc())
            .limit(limit)
        )
    ).all()
    recording_ids = [recording.id for recording, _ in rows]
    exports: dict[uuid.UUID, MeetingExport] = {}
    latest_analysis: dict[uuid.UUID, SpeakerAnalysis] = {}
    if recording_ids:
        exports = {
            row.recording_id: row
            for row in (
                await db.execute(select(MeetingExport).where(MeetingExport.recording_id.in_(recording_ids)))
            ).scalars().all()
        }
        analyses = (
            await db.execute(
                select(SpeakerAnalysis)
                .where(
                    SpeakerAnalysis.recording_id.in_(recording_ids),
                    SpeakerAnalysis.status == "completed",
                )
                .order_by(SpeakerAnalysis.completed_at.asc(), SpeakerAnalysis.created_at.asc())
            )
        ).scalars().all()
        for analysis in analyses:  # ascending, so the newest wins
            latest_analysis[analysis.recording_id] = analysis

    def export_state(recording_id: uuid.UUID) -> dict:
        export = exports.get(recording_id)
        exported = bool(export and export.open_notebook_note_id and export.exported_at)
        outdated = bool(
            exported
            and export.notes_generated_at
            and export.notes_generated_at > export.exported_at
        )
        return {
            "notes_ready": bool(export and export.notes_markdown),
            "open_notebook_exported": exported,
            "export_outdated": outdated,
        }

    items = []
    for recording, user in rows:
        analysis = latest_analysis.get(recording.id)
        state = export_state(recording.id)
        # "Done" means in Open Notebook and up to date; everything else is to do.
        if view == "todo" and state["open_notebook_exported"] and not state["export_outdated"]:
            continue
        items.append({
            "id": str(recording.id),
            "title": recording.title or "Recording",
            "created_at": recording.created_at.isoformat(),
            "duration_seconds": recording.duration_seconds,
            "words": word_count(recording.transcript),
            "owner_id": str(user.id),
            "owner_username": user.username,
            "owner_display_name": user.display_name,
            "analysed": analysis is not None,
            "latest_analysis_id": str(analysis.id) if analysis else None,
            "speaker_count": analysis.speaker_count if analysis else None,
            **state,
        })
    items.sort(key=lambda item: (item["title"].casefold(), item["created_at"]))
    return items


@router.post("/analyze/{recording_id}", status_code=202)
async def start_speaker_analysis(
    recording_id: uuid.UUID,
    payload: AnalysisRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await db.get(Recording, recording_id)
    if (
        not recording
        or recording.deleted_at is not None
        or recording.status != "ready"
    ):
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
    db: AsyncSession = Depends(get_db),
) -> dict:
    analysis = await admin_analysis(analysis_id, db)
    return await _analysis_payload(analysis, db)


@router.get("/analyses/{analysis_id}/detections/{speaker_key}/sample-audio")
async def speaker_sample_audio(
    analysis_id: uuid.UUID,
    speaker_key: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    analysis = await admin_analysis(analysis_id, db)
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

    turns = (
        await db.execute(
            select(SpeakerTurn).where(SpeakerTurn.detection_id == detection.id)
        )
    ).scalars().all()
    if not turns:
        raise HTTPException(status_code=404, detail="No attributed speech is available for this speaker.")

    longest = max(
        turns,
        key=lambda turn: max(0.0, turn.end_seconds - turn.start_seconds),
    )
    if longest.end_seconds <= longest.start_seconds:
        raise HTTPException(status_code=404, detail="No playable speech is available for this speaker.")

    recording = await db.get(Recording, analysis.recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    combined_path = None
    delete_combined = False
    try:
        combined_path, delete_combined, _, _ = await build_combined_wav(recording, db)
        clip, clip_start, clip_end = extract_wav_clip(
            combined_path,
            longest.start_seconds,
            longest.end_seconds,
            max_seconds=8.0,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    finally:
        if delete_combined and combined_path is not None:
            combined_path.unlink(missing_ok=True)

    return Response(
        content=clip,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Speaker-Key": detection.speaker_key,
            "X-Clip-Start": f"{clip_start:.3f}",
            "X-Clip-End": f"{clip_end:.3f}",
        },
    )


@router.patch("/analyses/{analysis_id}/detections/{speaker_key}")
async def label_detection(
    analysis_id: uuid.UUID,
    speaker_key: str,
    payload: DetectionLabelUpdate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await admin_analysis(analysis_id, db)
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


@router.patch("/analyses/{analysis_id}/turns/{turn_id}/identity")
async def correct_turn_identity(
    analysis_id: uuid.UUID,
    turn_id: uuid.UUID,
    payload: TurnIdentityUpdate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    analysis = await admin_analysis(analysis_id, db)
    turn = await db.get(SpeakerTurn, turn_id)
    if not turn or turn.analysis_id != analysis.id:
        raise HTTPException(status_code=404, detail="Speaker turn not found")

    selected = sum(bool(value) for value in (
        payload.target_profile_id,
        payload.target_detection_id,
        payload.unknown,
        payload.clear,
    ))
    if selected != 1:
        raise HTTPException(
            status_code=400,
            detail="Choose exactly one corrected identity, Unknown, or reset to the detected identity.",
        )

    source_detection = await db.get(SpeakerDetection, turn.detection_id)
    if not source_detection:
        raise HTTPException(status_code=409, detail="The original detected speaker is no longer available.")

    target_profile = None
    target_detection = None
    corrected_name = source_detection.display_name
    corrected_profile_id = source_detection.profile_id

    if payload.target_profile_id:
        target_profile = await db.get(SpeakerProfile, payload.target_profile_id)
        if not target_profile:
            raise HTTPException(status_code=404, detail="Remembered speaker not found")
        corrected_name = target_profile.name
        corrected_profile_id = target_profile.id
    elif payload.target_detection_id:
        target_detection = await db.get(SpeakerDetection, payload.target_detection_id)
        if not target_detection or target_detection.analysis_id != analysis.id:
            raise HTTPException(status_code=404, detail="Detected speaker not found")
        corrected_name = target_detection.display_name
        corrected_profile_id = target_detection.profile_id
    elif payload.unknown:
        corrected_name = "Unknown"
        corrected_profile_id = None

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

    now = datetime.now(timezone.utc)
    user_id = actor_user_id()
    for item in turns:
        item_source = await db.get(SpeakerDetection, item.detection_id)
        if not item_source:
            continue

        existing = (
            await db.execute(
                select(SpeakerRelabelSample).where(SpeakerRelabelSample.turn_id == item.id)
            )
        ).scalar_one_or_none()

        if payload.clear or (
            target_detection is not None and target_detection.id == item.detection_id
        ):
            item.identity_override_profile_id = None
            item.identity_override_detection_id = None
            item.identity_override_unknown = False
            item.identity_override_name = None
            item.identity_corrected_by_user_id = None
            item.identity_corrected_at = None
            if existing:
                await db.delete(existing)
            continue

        item.identity_override_profile_id = target_profile.id if target_profile else None
        item.identity_override_detection_id = target_detection.id if target_detection else None
        item.identity_override_unknown = bool(payload.unknown)
        item.identity_override_name = None
        item.identity_corrected_by_user_id = user_id
        item.identity_corrected_at = now

        if existing is None:
            existing = SpeakerRelabelSample(
                recording_id=analysis.recording_id,
                analysis_id=analysis.id,
                turn_id=item.id,
                original_profile_id=item_source.profile_id,
                original_display_name=item_source.display_name,
                corrected_display_name=corrected_name,
                corrected_profile_id=corrected_profile_id,
                corrected_by_user_id=user_id,
                status="pending",
                created_at=now,
            )
            db.add(existing)
        else:
            existing.corrected_profile_id = corrected_profile_id
            existing.corrected_display_name = corrected_name
            existing.corrected_by_user_id = user_id
            existing.status = "pending"
            existing.reviewed_at = None

    await db.commit()
    return await _analysis_payload(analysis, db)


@router.post("/analyses/{analysis_id}/detections/{speaker_key}/remember")
async def remember_speaker(
    analysis_id: uuid.UUID,
    speaker_key: str,
    payload: RememberSpeakerRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await admin_analysis(analysis_id, db)
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
    if not analysis:
        raise HTTPException(status_code=404, detail="Speaker analysis not found")

    speech_seconds = await detection_speech_seconds(db, detection.id)
    if speech_seconds < MIN_SAMPLE_SPEECH_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Need at least {MIN_SAMPLE_SPEECH_SECONDS:.0f} seconds of this person's "
                f"speech before adding a voice sample. This detection has {speech_seconds:.1f}s."
            ),
        )

    name = payload.name.strip()
    profile = (
        await db.execute(
            select(SpeakerProfile).where(func.lower(SpeakerProfile.name) == name.lower())
        )
    ).scalar_one_or_none()

    prior_sample = (
        await db.execute(
            select(SpeakerProfileSample).where(
                SpeakerProfileSample.source_detection_id == detection.id
            )
        )
    ).scalar_one_or_none()
    if prior_sample:
        prior_profile = await db.get(SpeakerProfile, prior_sample.profile_id)
        if prior_profile and (not profile or prior_profile.id != profile.id):
            raise HTTPException(
                status_code=409,
                detail=f"This detected voice is already stored for {prior_profile.name}.",
            )
        if prior_profile:
            detection.profile_id = prior_profile.id
            detection.display_name = prior_profile.name
            detection.match_score = 1.0
            await db.commit()
            return {
                "id": str(prior_profile.id),
                "name": prior_profile.name,
                "sample_count": prior_profile.sample_count,
                "profile_quality": profile_quality(prior_profile.sample_count),
                "already_saved": True,
            }

    if profile:
        samples = (
            await db.execute(
                select(SpeakerProfileSample).where(SpeakerProfileSample.profile_id == profile.id)
            )
        ).scalars().all()
        if len(samples) >= MAX_PROFILE_SAMPLES:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{profile.name} already has {MAX_PROFILE_SAMPLES} voice samples. "
                    "Remove an older sample before adding another."
                ),
            )
    else:
        profile = SpeakerProfile(
            name=name,
            embedding=normalise_embedding(detection.embedding or []),
            sample_count=0,
            source_recording_id=analysis.recording_id,
        )
        db.add(profile)
        await db.flush()

    sample = SpeakerProfileSample(
        profile_id=profile.id,
        embedding=normalise_embedding(detection.embedding or []),
        source_recording_id=analysis.recording_id,
        source_analysis_id=analysis.id,
        source_detection_id=detection.id,
        speech_seconds=speech_seconds,
    )
    db.add(sample)
    await db.flush()
    samples = await rebuild_profile_summary(profile, db)

    detection.profile_id = profile.id
    detection.display_name = profile.name
    detection.match_score = 1.0
    await db.commit()
    return {
        "id": str(profile.id),
        "name": profile.name,
        "sample_count": len(samples),
        "profile_quality": profile_quality(len(samples)),
        "already_saved": False,
    }


@router.get("/profiles")
async def list_speaker_profiles(
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    profiles = (await db.execute(select(SpeakerProfile).order_by(SpeakerProfile.name.asc()))).scalars().all()
    samples = (
        await db.execute(
            select(SpeakerProfileSample).order_by(SpeakerProfileSample.created_at.desc())
        )
    ).scalars().all()
    recording_ids = {sample.source_recording_id for sample in samples if sample.source_recording_id}
    recording_rows = (
        await db.execute(
            select(Recording, User)
            .join(User, Recording.user_id == User.id)
            .where(Recording.id.in_(recording_ids))
        )
    ).all() if recording_ids else []
    recordings_by_id = {recording.id: recording for recording, _ in recording_rows}
    recording_titles = {
        recording.id: recording.title or "Recording"
        for recording, _ in recording_rows
    }
    recording_owners = {
        recording.id: user.display_name or user.username
        for recording, user in recording_rows
    }
    available_recording_ids = set(recordings_by_id)

    detection_ids = {
        sample.source_detection_id
        for sample in samples
        if sample.source_detection_id
        and sample.source_recording_id in available_recording_ids
    }
    sample_turns = (
        await db.execute(
            select(SpeakerTurn).where(SpeakerTurn.detection_id.in_(detection_ids))
        )
    ).scalars().all() if detection_ids else []
    longest_turn_seconds: dict[uuid.UUID, float] = {}
    for turn in sample_turns:
        seconds = max(0.0, turn.end_seconds - turn.start_seconds)
        longest_turn_seconds[turn.detection_id] = max(
            longest_turn_seconds.get(turn.detection_id, 0.0),
            seconds,
        )

    by_profile: dict[uuid.UUID, list[SpeakerProfileSample]] = {}
    for sample in samples:
        by_profile.setdefault(sample.profile_id, []).append(sample)

    result = []
    for profile in profiles:
        bank = by_profile.get(profile.id, [])
        actual_count = len(bank)
        if profile.sample_count != actual_count:
            profile.sample_count = actual_count
        result.append({
            "id": str(profile.id),
            "name": profile.name,
            "sample_count": actual_count,
            "profile_quality": profile_quality(actual_count),
            "max_samples": MAX_PROFILE_SAMPLES,
            "created_at": profile.created_at.isoformat(),
            "updated_at": profile.updated_at.isoformat(),
            "samples": [
                {
                    "id": str(sample.id),
                    "speech_seconds": round(sample.speech_seconds, 1) if sample.speech_seconds is not None else None,
                    "source_recording_id": str(sample.source_recording_id) if sample.source_recording_id else None,
                    "source_detection_id": str(sample.source_detection_id) if sample.source_detection_id else None,
                    "source_recording_title": recording_titles.get(sample.source_recording_id, "Saved voice sample"),
                    "source_recording_owner": recording_owners.get(sample.source_recording_id),
                    "can_preview": bool(
                        sample.source_recording_id in available_recording_ids
                        and sample.source_detection_id
                        and longest_turn_seconds.get(sample.source_detection_id, 0.0) > 0.0
                    ),
                    "preview_seconds": round(
                        min(longest_turn_seconds.get(sample.source_detection_id, 0.0), 8.0),
                        2,
                    ) if sample.source_detection_id else 0.0,
                    "created_at": sample.created_at.isoformat(),
                }
                for sample in bank
            ],
        })
    await db.commit()
    return result


RELABEL_STATUS_FILTERS = {
    "pending": ["pending"],
    "approved": ["approved"],
    "excluded": ["excluded"],
    "reviewed": ["approved", "excluded"],
}


@router.get("/relabels/summary")
async def relabel_summary(
    db: AsyncSession = Depends(get_db),
) -> dict:
    rows = (
        await db.execute(
            select(SpeakerRelabelSample.status, func.count())
            .group_by(SpeakerRelabelSample.status)
        )
    ).all()
    counts = {status: int(count) for status, count in rows}
    return {
        "pending": counts.get("pending", 0),
        "approved": counts.get("approved", 0),
        "excluded": counts.get("excluded", 0),
        "total": sum(counts.values()),
    }


@router.get("/relabels")
async def list_relabel_samples(
    status: str | None = Query(default=None, pattern="^(pending|approved|excluded|reviewed)$"),
    created_from: datetime | None = Query(default=None),
    created_to: datetime | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Relabelled samples, newest first.

    With no filters every sample is returned. ``status`` narrows to one review
    state ("reviewed" = approved or excluded); ``created_from``/``created_to``
    bound when the correction was made (inclusive, timezone-aware).
    """
    query = select(SpeakerRelabelSample).order_by(SpeakerRelabelSample.created_at.desc())
    if status:
        query = query.where(SpeakerRelabelSample.status.in_(RELABEL_STATUS_FILTERS[status]))
    if created_from is not None:
        if created_from.tzinfo is None:
            created_from = created_from.replace(tzinfo=timezone.utc)
        query = query.where(SpeakerRelabelSample.created_at >= created_from)
    if created_to is not None:
        if created_to.tzinfo is None:
            created_to = created_to.replace(tzinfo=timezone.utc)
        query = query.where(SpeakerRelabelSample.created_at <= created_to)
    rows = (await db.execute(query)).scalars().all()
    recording_ids = {row.recording_id for row in rows}
    recording_rows = (
        await db.execute(
            select(Recording, User)
            .join(User, Recording.user_id == User.id)
            .where(Recording.id.in_(recording_ids))
        )
    ).all() if recording_ids else []
    recordings_by_id = {recording.id: recording for recording, _ in recording_rows}
    recording_owners = {
        recording.id: user.display_name or user.username
        for recording, user in recording_rows
    }
    turns = (
        await db.execute(
            select(SpeakerTurn).where(SpeakerTurn.id.in_({row.turn_id for row in rows}))
        )
    ).scalars().all() if rows else []
    turns_by_id = {row.id: row for row in turns}

    result = []
    for row in rows:
        recording = recordings_by_id.get(row.recording_id)
        turn = turns_by_id.get(row.turn_id)
        if not recording or not turn:
            continue
        seconds = max(0.0, turn.end_seconds - turn.start_seconds)
        result.append({
            "id": str(row.id),
            "recording_id": str(row.recording_id),
            "recording_title": recording.title or "Recording",
            "recording_owner": recording_owners.get(recording.id),
            "analysis_id": str(row.analysis_id),
            "turn_id": str(row.turn_id),
            "original_profile_id": str(row.original_profile_id) if row.original_profile_id else None,
            "corrected_profile_id": str(row.corrected_profile_id) if row.corrected_profile_id else None,
            "original_display_name": row.original_display_name,
            "corrected_display_name": row.corrected_display_name,
            "status": row.status,
            "start_seconds": round(turn.start_seconds, 2),
            "end_seconds": round(turn.end_seconds, 2),
            "preview_seconds": round(min(seconds, 8.0), 2),
            "can_preview": seconds > 0.0,
            "training_ready": bool(
                seconds > 0.0 and row.corrected_display_name.casefold() != "unknown"
            ),
            "created_at": row.created_at.isoformat(),
            "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
        })
    return result


async def admin_relabel_sample(
    sample_id: uuid.UUID,
    db: AsyncSession,
) -> tuple[SpeakerRelabelSample, Recording, SpeakerTurn]:
    sample = await db.get(SpeakerRelabelSample, sample_id)
    if not sample:
        raise HTTPException(status_code=404, detail="Relabelled voice sample not found")
    recording = await db.get(Recording, sample.recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Relabelled voice sample not found")
    turn = await db.get(SpeakerTurn, sample.turn_id)
    if not turn:
        raise HTTPException(status_code=404, detail="Source speaker turn not found")
    return sample, recording, turn


@router.get("/relabels/{sample_id}/sample-audio")
async def relabel_sample_audio(
    sample_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    sample, recording, turn = await admin_relabel_sample(sample_id, db)
    if turn.end_seconds <= turn.start_seconds:
        raise HTTPException(status_code=404, detail="No playable speech is available for this sample.")

    combined_path = None
    delete_combined = False
    try:
        combined_path, delete_combined, _, _ = await build_combined_wav(recording, db)
        clip, clip_start, clip_end = extract_wav_clip(
            combined_path,
            turn.start_seconds,
            turn.end_seconds,
            max_seconds=8.0,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    finally:
        if delete_combined and combined_path is not None:
            combined_path.unlink(missing_ok=True)

    return Response(
        content=clip,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Relabel-Sample": str(sample.id),
            "X-Clip-Start": f"{clip_start:.3f}",
            "X-Clip-End": f"{clip_end:.3f}",
        },
    )


@router.patch("/relabels/{sample_id}")
async def review_relabel_sample(
    sample_id: uuid.UUID,
    payload: RelabelStatusUpdate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    sample, _, _ = await admin_relabel_sample(sample_id, db)
    sample.status = payload.status
    sample.reviewed_at = None if payload.status == "pending" else datetime.now(timezone.utc)
    await db.commit()
    return {
        "id": str(sample.id),
        "status": sample.status,
        "reviewed_at": sample.reviewed_at.isoformat() if sample.reviewed_at else None,
    }


@router.delete("/relabels/{sample_id}/correction", status_code=204)
async def undo_relabel_correction(
    sample_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    sample, _, turn = await admin_relabel_sample(sample_id, db)
    turn.identity_override_profile_id = None
    turn.identity_override_detection_id = None
    turn.identity_override_unknown = False
    turn.identity_override_name = None
    turn.identity_corrected_by_user_id = None
    turn.identity_corrected_at = None
    await db.delete(sample)
    await db.commit()


@router.patch("/profiles/{profile_id}")
async def rename_speaker_profile(
    profile_id: uuid.UUID,
    payload: RenameProfileRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
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


@router.get("/profiles/{profile_id}/samples/{sample_id}/sample-audio")
async def remembered_speaker_sample_audio(
    profile_id: uuid.UUID,
    sample_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    profile = await db.get(SpeakerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Remembered speaker not found")

    sample = await db.get(SpeakerProfileSample, sample_id)
    if not sample or sample.profile_id != profile.id:
        raise HTTPException(status_code=404, detail="Voice sample not found")
    if not sample.source_recording_id or not sample.source_detection_id:
        raise HTTPException(status_code=404, detail="This legacy voice sample has no playable source audio.")

    recording = await db.get(Recording, sample.source_recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Voice sample source recording is not available.")

    turns = (
        await db.execute(
            select(SpeakerTurn).where(SpeakerTurn.detection_id == sample.source_detection_id)
        )
    ).scalars().all()
    if not turns:
        raise HTTPException(status_code=404, detail="No attributed speech is available for this voice sample.")

    longest = max(
        turns,
        key=lambda turn: max(0.0, turn.end_seconds - turn.start_seconds),
    )
    if longest.end_seconds <= longest.start_seconds:
        raise HTTPException(status_code=404, detail="No playable speech is available for this voice sample.")

    combined_path = None
    delete_combined = False
    try:
        combined_path, delete_combined, _, _ = await build_combined_wav(recording, db)
        clip, clip_start, clip_end = extract_wav_clip(
            combined_path,
            longest.start_seconds,
            longest.end_seconds,
            max_seconds=8.0,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    finally:
        if delete_combined and combined_path is not None:
            combined_path.unlink(missing_ok=True)

    return Response(
        content=clip,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Voice-Sample": str(sample.id),
            "X-Clip-Start": f"{clip_start:.3f}",
            "X-Clip-End": f"{clip_end:.3f}",
        },
    )


@router.delete("/profiles/{profile_id}/samples/{sample_id}", status_code=204)
async def remove_speaker_sample(
    profile_id: uuid.UUID,
    sample_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    profile = await db.get(SpeakerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Remembered speaker not found")
    samples = (
        await db.execute(
            select(SpeakerProfileSample)
            .where(SpeakerProfileSample.profile_id == profile.id)
            .order_by(SpeakerProfileSample.created_at.asc())
        )
    ).scalars().all()
    sample = next((item for item in samples if item.id == sample_id), None)
    if not sample:
        raise HTTPException(status_code=404, detail="Voice sample not found")
    if len(samples) <= 1:
        raise HTTPException(
            status_code=400,
            detail="A voiceprint needs at least one sample. Use Forget voiceprint to remove it completely.",
        )

    await db.delete(sample)
    await db.flush()
    await rebuild_profile_summary(profile, db)
    await db.commit()


@router.delete("/profiles/{profile_id}", status_code=204)
async def forget_speaker_profile(
    profile_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    profile = await db.get(SpeakerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Remembered speaker not found")
    detections = (
        await db.execute(select(SpeakerDetection).where(SpeakerDetection.profile_id == profile.id))
    ).scalars().all()
    for detection in detections:
        detection.profile_id = None
        detection.match_score = None
    await db.execute(delete(SpeakerProfileSample).where(SpeakerProfileSample.profile_id == profile.id))
    await db.delete(profile)
    await db.commit()
