"""Admin-only meeting notes generation and export to Open Notebook."""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import actor_user_id, require_admin
from .config import settings
from .db import SessionLocal, get_db
from .models import MeetingExport, Recording, SpeakerAnalysis
from .services.llm import LLMError, llm
from .services.meeting_notes import (
    MeetingMeta,
    attendees_from_lines,
    generate_notes,
    merge_turns,
    plain_transcript_lines,
    transcript_document,
)
from .services.open_notebook import OpenNotebookError, open_notebook
from .speaker_admin import _analysis_payload

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin/meeting-notes",
    tags=["meeting-notes"],
    dependencies=[Depends(require_admin)],
)

ACTIVE_STATUSES = {"queued", "processing"}
STATUS_TIMEOUT_SECONDS = 5.0


class MeetingNotesRequest(BaseModel):
    # Regenerate notes with the LLM. False re-exports the notes already saved.
    regenerate_notes: bool = True
    # Push the transcript and notes to Open Notebook.
    export: bool = True
    notebook_id: str | None = Field(default=None, max_length=200)
    # Display name of the chosen notebook, shown in the export status.
    notebook_name: str | None = Field(default=None, max_length=120)
    analysis_id: uuid.UUID | None = None
    # Optional per-generation override. LLM_MODEL remains the default.
    model: str | None = Field(default=None, max_length=200)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _payload(recording: Recording, export: MeetingExport | None) -> dict:
    if export is None:
        return {"recording_id": str(recording.id), "status": "none"}
    return {
        "id": str(export.id),
        "recording_id": str(export.recording_id),
        "recording_title": recording.title or "Recording",
        "analysis_id": str(export.analysis_id) if export.analysis_id else None,
        "status": export.status,
        # "regenerate"/"export" are internal queue markers, not progress text.
        "stage": "" if export.status == "queued" else export.stage,
        "error": export.error,
        "model": export.model,
        "notes_markdown": export.notes_markdown,
        "has_notes": bool(export.notes_markdown),
        "export_requested": export.export_requested,
        "open_notebook_notebook_id": export.open_notebook_notebook_id,
        "open_notebook_source_id": export.open_notebook_source_id,
        "open_notebook_note_id": export.open_notebook_note_id,
        "processing_seconds": round(export.processing_seconds or 0, 1),
        "created_at": export.created_at.isoformat() if export.created_at else None,
        "notes_generated_at": export.notes_generated_at.isoformat() if export.notes_generated_at else None,
        "notes_stale": bool(export.notes_stale),
        "exported_at": export.exported_at.isoformat() if export.exported_at else None,
        # A copy currently lives in Open Notebook.
        "exported": bool(export.open_notebook_note_id and export.exported_at),
        "open_notebook_notebook_name": export.open_notebook_notebook_name,
        # Notes were regenerated after the last export, so Open Notebook is behind.
        "export_outdated": bool(
            export.open_notebook_note_id
            and export.exported_at
            and export.notes_generated_at
            and export.notes_generated_at > export.exported_at
        ),
    }


async def _get_export(recording_id: uuid.UUID, db: AsyncSession) -> MeetingExport | None:
    return (
        await db.execute(select(MeetingExport).where(MeetingExport.recording_id == recording_id))
    ).scalar_one_or_none()


async def _ready_recording(recording_id: uuid.UUID, db: AsyncSession) -> Recording:
    recording = await db.get(Recording, recording_id)
    if not recording or recording.deleted_at is not None or recording.status != "ready":
        raise HTTPException(status_code=404, detail="Saved recording not found")
    return recording


async def _latest_analysis(recording_id: uuid.UUID, db: AsyncSession) -> SpeakerAnalysis | None:
    return (
        await db.execute(
            select(SpeakerAnalysis)
            .where(
                SpeakerAnalysis.recording_id == recording_id,
                SpeakerAnalysis.status == "completed",
            )
            .order_by(SpeakerAnalysis.completed_at.desc(), SpeakerAnalysis.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def mark_interrupted_exports() -> None:
    """Background jobs do not survive a restart; release their lock."""
    async with SessionLocal() as db:
        await db.execute(
            update(MeetingExport)
            .where(MeetingExport.status.in_(ACTIVE_STATUSES))
            .values(status="error", error="Interrupted by an app restart. Run it again.", stage="")
        )
        await db.commit()


async def process_meeting_export(export_id: uuid.UUID, notebook_label: str | None = None) -> None:
    started = time.perf_counter()
    async with SessionLocal() as db:
        export = await db.get(MeetingExport, export_id)
        if not export:
            return
        recording = await db.get(Recording, export.recording_id)
        if not recording:
            export.status = "error"
            export.error = "Recording no longer exists."
            await db.commit()
            return

        async def progress(stage: str) -> None:
            export.stage = stage
            await db.commit()

        regenerate = export.status == "queued" and export.stage == "regenerate"
        export.status = "processing"
        export.error = None
        await progress("Building transcript")

        try:
            if regenerate:
                analysis = await db.get(SpeakerAnalysis, export.analysis_id) if export.analysis_id else None
                if analysis is not None and analysis.status == "completed":
                    turns = (await _analysis_payload(analysis, db))["turns"]
                    lines = merge_turns(turns)
                else:
                    export.analysis_id = None
                    lines = plain_transcript_lines(recording.transcript)
                if not lines:
                    raise ValueError("This recording has no transcript text to take notes from.")

                meta = MeetingMeta(
                    title=(recording.title or "").strip() or "Meeting "
                    + recording.created_at.strftime("%Y-%m-%d %H:%M"),
                    started_at=recording.created_at,
                    duration_seconds=recording.duration_seconds,
                    attendees=attendees_from_lines(lines),
                    recording_id=str(recording.id),
                )
                export.transcript_markdown = transcript_document(meta, lines)
                selected_model = (export.model or "").strip() or settings.llm_model
                export.notes_markdown = await generate_notes(
                    meta,
                    lines,
                    progress,
                    model=selected_model,
                )
                export.model = selected_model
                export.notes_generated_at = utcnow()
                export.notes_stale = False
                await db.commit()

            if export.export_requested:
                await progress("Sending to Open Notebook")
                notebook_id = export.open_notebook_notebook_id or ""
                title = (recording.title or "").strip() or "Meeting " + recording.created_at.strftime(
                    "%Y-%m-%d %H:%M"
                )

                # Replace, never duplicate, a previous export of this recording.
                if export.open_notebook_source_id:
                    await open_notebook.delete_source(export.open_notebook_source_id)
                    export.open_notebook_source_id = None
                if export.open_notebook_note_id:
                    await open_notebook.delete_note(export.open_notebook_note_id)
                    export.open_notebook_note_id = None
                await db.commit()

                export.open_notebook_source_id = await open_notebook.create_source(
                    title=f"{title} — transcript",
                    content=export.transcript_markdown or "",
                    notebook_id=notebook_id,
                )
                await db.commit()
                export.open_notebook_note_id = await open_notebook.create_note(
                    title=f"Meeting notes — {title}",
                    content=export.notes_markdown or "",
                    notebook_id=notebook_id,
                )
                export.exported_at = utcnow()
                export.open_notebook_notebook_name = notebook_label

            export.status = "completed"
            if export.export_requested:
                export.stage = f"Exported to Open Notebook · {notebook_label}"[:160] if notebook_label else "Exported to Open Notebook"
            else:
                export.stage = "Notes ready"
            export.error = None
        except (LLMError, OpenNotebookError, ValueError) as exc:
            export.status = "error"
            export.stage = ""
            export.error = str(exc)[:2000]
        except Exception as exc:  # keep the job from staying "processing" forever
            logger.exception("Meeting notes export failed")
            export.status = "error"
            export.stage = ""
            export.error = f"Unexpected error: {exc}"[:2000]
        finally:
            export.processing_seconds = time.perf_counter() - started
            await db.commit()


async def _probe_llm() -> dict:
    info: dict = {
        "configured": llm.configured,
        "reachable": False,
        "model": settings.llm_model,
        "default_model": settings.llm_model,
    }
    if not llm.configured:
        return info
    try:
        models = await asyncio.wait_for(llm.models(), timeout=STATUS_TIMEOUT_SECONDS)
        info["reachable"] = True
        info["model_available"] = not models or settings.llm_model in models
        info["models"] = models
    except (asyncio.TimeoutError, httpx.HTTPError, OSError, ValueError) as exc:
        info["error"] = str(exc)[:300] or "timed out"
    return info


async def _probe_open_notebook() -> dict:
    info: dict = {
        "configured": open_notebook.configured,
        "reachable": False,
        "default_notebook_id": settings.open_notebook_notebook_id or None,
        "ui_url": settings.open_notebook_ui_url.strip().rstrip("/") or None,
        "notebook_count": 0,
    }
    if not open_notebook.configured:
        return info
    try:
        # Reachability only; the picker fetches the live list on export.
        notebooks = await asyncio.wait_for(open_notebook.notebooks(), timeout=STATUS_TIMEOUT_SECONDS)
        info["notebook_count"] = len(notebooks)
        info["reachable"] = True
    except (asyncio.TimeoutError, httpx.HTTPError, OSError, ValueError, OpenNotebookError) as exc:
        info["error"] = str(exc)[:300] or "timed out"
    return info


@router.get("/status")
async def meeting_notes_status() -> dict:
    # Both probes run at once and are capped, so an unreachable host shows as
    # offline within a few seconds instead of holding the panel on "Checking".
    llm_info, notebook_info = await asyncio.gather(_probe_llm(), _probe_open_notebook())
    return {"llm": llm_info, "open_notebook": notebook_info}


@router.get("/notebooks")
async def list_open_notebook_notebooks() -> dict:
    """Live list of notebooks, fetched when the admin chooses where to export."""
    if not open_notebook.configured:
        raise HTTPException(status_code=400, detail="Set OPEN_NOTEBOOK_URL to export to Open Notebook.")
    try:
        notebooks = await open_notebook.notebooks()
    except OpenNotebookError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (httpx.HTTPError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach Open Notebook at {open_notebook.base_url}: {exc}",
        ) from exc
    return {
        "notebooks": sorted(notebooks, key=lambda row: row["name"].casefold()),
        "default_notebook_id": settings.open_notebook_notebook_id.strip() or None,
    }


@router.get("/recordings/{recording_id}")
async def get_meeting_notes(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await _ready_recording(recording_id, db)
    return _payload(recording, await _get_export(recording.id, db))


@router.post("/recordings/{recording_id}", status_code=202)
async def start_meeting_notes(
    recording_id: uuid.UUID,
    payload: MeetingNotesRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    recording = await _ready_recording(recording_id, db)
    export = await _get_export(recording.id, db)
    if export is not None and export.status in ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="Notes are already being prepared for this recording.")

    if payload.regenerate_notes and not llm.configured:
        raise HTTPException(status_code=400, detail="Set LLM_BASE_URL to your llama-server to generate notes.")
    if not payload.regenerate_notes and not (export and export.notes_markdown and export.transcript_markdown):
        raise HTTPException(status_code=400, detail="Generate notes for this recording first.")
    if not payload.regenerate_notes and export and export.notes_stale:
        raise HTTPException(
            status_code=409,
            detail="The transcript or speaker labels changed. Regenerate the meeting notes before sending them.",
        )

    notebook_id = None
    if payload.export:
        if not open_notebook.configured:
            raise HTTPException(status_code=400, detail="Set OPEN_NOTEBOOK_URL to export to Open Notebook.")
        notebook_id = (payload.notebook_id or "").strip() or settings.open_notebook_notebook_id.strip()
        if not notebook_id:
            raise HTTPException(
                status_code=400,
                detail="Choose an Open Notebook notebook or set OPEN_NOTEBOOK_NOTEBOOK_ID.",
            )

    analysis_id = None
    if payload.regenerate_notes:
        if payload.analysis_id:
            analysis = await db.get(SpeakerAnalysis, payload.analysis_id)
            if not analysis or analysis.recording_id != recording.id or analysis.status != "completed":
                raise HTTPException(status_code=404, detail="Completed speaker analysis not found for this recording")
            analysis_id = analysis.id
        else:
            latest = await _latest_analysis(recording.id, db)
            analysis_id = latest.id if latest else None

    if export is None:
        export = MeetingExport(recording_id=recording.id)
        db.add(export)
    if payload.regenerate_notes:
        export.model = (payload.model or "").strip() or settings.llm_model
    export.status = "queued"
    # The worker reads this marker to decide whether to call the LLM.
    export.stage = "regenerate" if payload.regenerate_notes else "export"
    export.error = None
    export.export_requested = payload.export
    if payload.regenerate_notes:
        export.analysis_id = analysis_id
    if notebook_id:
        # If this moves the export to another notebook, the worker deletes the
        # stored source/note ids before creating the new copy.
        export.open_notebook_notebook_id = notebook_id
    export.requested_by_user_id = actor_user_id()
    await db.commit()
    await db.refresh(export)

    notebook_label = ((payload.notebook_name or "").strip() or None) if payload.export else None
    background_tasks.add_task(process_meeting_export, export.id, notebook_label)
    result = _payload(recording, export)
    result["speaker_labelled"] = analysis_id is not None if payload.regenerate_notes else bool(export.analysis_id)
    return result


@router.get("/recordings/{recording_id}/notes.md")
async def download_meeting_notes(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    recording = await _ready_recording(recording_id, db)
    export = await _get_export(recording.id, db)
    if not export or not export.notes_markdown:
        raise HTTPException(status_code=404, detail="No meeting notes have been generated yet.")
    base = "".join(
        char if char.isalnum() or char in "-_ " else "-"
        for char in (recording.title or "meeting-notes")
    ).strip().replace(" ", "-")[:80] or "meeting-notes"
    stamp = recording.created_at.strftime("%Y-%m-%d")
    return Response(
        content=export.notes_markdown,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{stamp}-{base}.md"',
            "Cache-Control": "no-store",
        },
    )
