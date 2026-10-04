from typing import Literal

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MeetingExport


async def mark_meeting_notes_stale(
    recording_id,
    db: AsyncSession,
    *,
    source: Literal["all", "recording"] = "all",
) -> None:
    """Mark generated notes stale when data they were built from changes.

    source="recording" affects only notes generated without a speaker
    analysis. Speaker-labelled notes are built from SpeakerTurn rows, so a
    plain Recording transcript edit does not make those notes stale.
    """
    query = update(MeetingExport).where(
        MeetingExport.recording_id == recording_id,
        MeetingExport.notes_markdown.is_not(None),
    )
    if source == "recording":
        query = query.where(MeetingExport.analysis_id.is_(None))
    await db.execute(query.values(notes_stale=True))
