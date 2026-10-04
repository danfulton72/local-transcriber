from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MeetingExport


async def mark_meeting_notes_stale(recording_id, db: AsyncSession) -> None:
    """Mark generated notes stale when their source words or speaker labels change."""
    await db.execute(
        update(MeetingExport)
        .where(
            MeetingExport.recording_id == recording_id,
            MeetingExport.notes_markdown.is_not(None),
        )
        .values(notes_stale=True)
    )
