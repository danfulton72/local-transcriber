"""Recording titles start with the recording's local date as yyyymmdd.

A title gets the prefix the first time it is set (typed at creation or
generated from the transcript), so titles sort chronologically. Renaming
keeps the date: if the new title has no date of its own, the original
prefix is carried over. Typing a title that already starts with an 8-digit
date leaves it exactly as typed.
"""

import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config import settings

PLACEHOLDER_TITLE = "New recording"
_DATE_PREFIX = re.compile(r"^(\d{8})(?:\s+|$)")
MAX_TITLE = 240


def _zone() -> ZoneInfo:
    try:
        return ZoneInfo(settings.notes_timezone or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def date_prefix(when: datetime | None) -> str:
    moment = when or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_zone()).strftime("%Y%m%d")


def existing_prefix(title: str | None) -> str | None:
    match = _DATE_PREFIX.match((title or "").strip())
    return match.group(1) if match else None


def dated_title(title: str | None, when: datetime | None) -> str | None:
    """Prefix a first-time title with the recording date."""
    clean = (title or "").strip()
    if not clean or clean == PLACEHOLDER_TITLE or existing_prefix(clean):
        return clean or title
    return f"{date_prefix(when)} {clean}"[:MAX_TITLE]


def renamed_title(new_title: str, previous_title: str | None) -> str:
    """Keep the date prefix across a rename unless the new title brings its own."""
    clean = new_title.strip()[:MAX_TITLE]
    if existing_prefix(clean):
        return clean
    previous = existing_prefix(previous_title)
    return f"{previous} {clean}"[:MAX_TITLE] if previous else clean
