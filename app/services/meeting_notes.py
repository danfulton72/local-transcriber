"""Turn a speaker-labelled transcript into ordered meeting notes.

The pipeline is deliberately two-pass:

1. Extract: each part of the transcript (split to fit the model's context)
   is reduced to decisions, action items, open questions, topics and facts,
   each with a timestamp.
2. Organise: the extractions (not the raw transcript) are merged into the
   final notes template in chronological order.

Small and mid-sized local models are far more reliable at this than at
summarising a long transcript in one go.
"""

import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config import settings
from .llm import llm

CHARS_PER_TOKEN = 3.5
PROMPT_OVERHEAD_TOKENS = 1500
OVERLAP_LINES = 2
UNIDENTIFIED = "Unidentified"


@dataclass
class TranscriptLine:
    start_seconds: float | None
    speaker: str
    text: str


@dataclass
class MeetingMeta:
    title: str
    started_at: datetime | None
    duration_seconds: float | None
    attendees: list[str]
    recording_id: str


ProgressCallback = Callable[[str], Awaitable[None]]


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def format_timestamp(seconds: float | None) -> str:
    if seconds is None:
        return ""
    total = max(0, int(round(seconds)))
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"


def format_line(line: TranscriptLine) -> str:
    stamp = format_timestamp(line.start_seconds)
    prefix = f"[{stamp}] " if stamp else ""
    return f"{prefix}{line.speaker}: {line.text}"


def _split_sentences(text: str, max_chars: int) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    parts: list[str] = []
    current = ""
    for sentence in sentences:
        while len(sentence) > max_chars:  # a run-on with no punctuation
            if current:
                parts.append(current)
                current = ""
            parts.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        candidate = f"{current} {sentence}".strip()
        if current and len(candidate) > max_chars:
            parts.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def merge_turns(turns: list[dict]) -> list[TranscriptLine]:
    """Merge consecutive turns by the same speaker into single lines.

    ``turns`` use the speaker-analysis payload shape: ``display_name``,
    ``start_seconds`` and ``text`` (already the corrected text if edited).
    """
    lines: list[TranscriptLine] = []
    for turn in sorted(turns, key=lambda row: float(row.get("start_seconds") or 0)):
        text = " ".join(str(turn.get("text") or "").split())
        if not text:
            continue
        speaker = str(turn.get("display_name") or "").strip() or UNIDENTIFIED
        if speaker.casefold() == "unknown":
            speaker = UNIDENTIFIED
        if lines and lines[-1].speaker == speaker:
            lines[-1].text = f"{lines[-1].text} {text}"
        else:
            lines.append(TranscriptLine(float(turn.get("start_seconds") or 0), speaker, text))
    return lines


def plain_transcript_lines(transcript: str) -> list[TranscriptLine]:
    """Fallback for recordings that were never speaker-analysed."""
    return [
        TranscriptLine(None, UNIDENTIFIED, part)
        for part in _split_sentences(" ".join((transcript or "").split()), 1200)
        if part
    ]


def attendees_from_lines(lines: list[TranscriptLine]) -> list[str]:
    seen: list[str] = []
    for line in lines:
        if line.speaker != UNIDENTIFIED and line.speaker not in seen:
            seen.append(line.speaker)
    return seen


def chunk_lines(lines: list[TranscriptLine], max_tokens: int) -> list[list[TranscriptLine]]:
    """Split lines into parts under ``max_tokens``, overlapping by a few lines."""
    max_chars = max(400, int(max_tokens * CHARS_PER_TOKEN))
    # Break any single line that could not fit on its own.
    prepared: list[TranscriptLine] = []
    for line in lines:
        if len(format_line(line)) <= max_chars:
            prepared.append(line)
            continue
        for part in _split_sentences(line.text, max_chars - 80):
            prepared.append(TranscriptLine(line.start_seconds, line.speaker, part))

    chunks: list[list[TranscriptLine]] = []
    current: list[TranscriptLine] = []
    size = 0
    for line in prepared:
        line_size = len(format_line(line)) + 1
        if current and size + line_size > max_chars:
            chunks.append(current)
            overlap = current[-OVERLAP_LINES:]
            overlap_size = sum(len(format_line(item)) + 1 for item in overlap)
            if overlap_size + line_size > max_chars:
                overlap, overlap_size = [], 0
            current, size = list(overlap), overlap_size
        current.append(line)
        size += line_size
    if current:
        chunks.append(current)
    return chunks


def chunk_budget_tokens() -> int:
    room = settings.llm_context_tokens - settings.llm_max_output_tokens - PROMPT_OVERHEAD_TOKENS
    return max(1000, min(settings.llm_chunk_tokens, room))


def _zone() -> ZoneInfo:
    try:
        return ZoneInfo(settings.notes_timezone or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def describe_meeting(meta: MeetingMeta) -> str:
    lines = [f"Title: {meta.title}"]
    if meta.started_at:
        lines.append("Date: " + meta.started_at.astimezone(_zone()).strftime("%a %d %b %Y, %H:%M"))
    if meta.duration_seconds:
        lines.append(f"Duration: {max(1, round(meta.duration_seconds / 60))} minutes")
    lines.append(
        "Identified attendees: " + (", ".join(meta.attendees) if meta.attendees else "none identified")
    )
    return "\n".join(lines)


def transcript_document(meta: MeetingMeta, lines: list[TranscriptLine]) -> str:
    """Speaker-labelled transcript as sent to Open Notebook."""
    header = [f"# {meta.title} — transcript", ""]
    for row in describe_meeting(meta).splitlines()[1:]:
        key, _, value = row.partition(": ")
        header.append(f"- **{key}:** {value}")
    header.append(f"- **Source:** Local Transcriber recording {meta.recording_id}")
    header.append("")
    return "\n".join(header) + "\n" + "\n\n".join(format_line(line) for line in lines) + "\n"


SYSTEM_PROMPT = (
    "You take minutes from meeting transcripts. Work only from the text you are given. "
    "Never invent names, dates, numbers, owners or commitments. Transcript lines look like "
    "`[HH:MM:SS] Speaker: text`. Speaker names come from voice recognition; "
    f"'{UNIDENTIFIED}' or 'Person N' means the speaker was not identified. The text comes from "
    "speech recognition and may contain misheard words: use context for meaning, but do not "
    "guess specifics that are unclear. Reply in Markdown only, with no preamble."
)

EXTRACTION_FORMAT = """### Topics
- [HH:MM:SS] Topic — one-line gist of what was discussed
### Decisions
- [HH:MM:SS] What was decided (who decided or agreed)
### Action items
- [HH:MM:SS] Owner: task (due: date as stated, or "not stated")
### Open questions
- [HH:MM:SS] Question or unresolved issue (raised by)
### Key facts and figures
- [HH:MM:SS] Fact, number, date or name worth recording"""

NOTES_TEMPLATE = """## Summary
3–5 sentences: the purpose of the meeting and its main outcomes.

## Decisions
- Decision _(HH:MM:SS)_

## Action items
- [ ] **Owner** — task (due: …) _(HH:MM:SS)_

## Discussion by topic
### Topic name _(HH:MM:SS)_
- Key points, in the order they came up

## Open questions
- Question (raised by) _(HH:MM:SS)_"""


def extraction_messages(meta: MeetingMeta, part_text: str, index: int, total: int, span: str) -> list[dict]:
    where = f"This is part {index} of {total} of the transcript ({span})." if total > 1 else "This is the full transcript."
    user = (
        f"{describe_meeting(meta)}\n\n{where}\n\n"
        "Extract everything a minute-taker would record from this part, using exactly these headings. "
        "Write 'None' under a heading with nothing to record. An action item needs someone to have "
        "agreed, or been asked, to do something; if nobody was named, write 'Owner not stated'. "
        "Keep each bullet to one line and keep the timestamp of the line it came from.\n\n"
        f"{EXTRACTION_FORMAT}\n\n<transcript>\n{part_text}\n</transcript>"
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def condense_messages(meta: MeetingMeta, extractions: str) -> list[dict]:
    user = (
        f"{describe_meeting(meta)}\n\n"
        "Below are extractions from consecutive parts of one meeting. Merge them into a single "
        "extraction with the same headings: remove duplicates caused by overlapping parts, keep "
        "every distinct decision, action item and open question, keep timestamps, and keep "
        f"chronological order.\n\n{EXTRACTION_FORMAT}\n\n<extractions>\n{extractions}\n</extractions>"
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def organise_messages(meta: MeetingMeta, extractions: str) -> list[dict]:
    user = (
        f"{describe_meeting(meta)}\n\n"
        "Write the final meeting notes from the extractions below. Follow the template exactly, "
        "starting with '## Summary'. Merge duplicates (the parts overlap slightly), order topics "
        "and discussion points chronologically, and group related points under one topic. Use "
        "only names that appear in the attendee list or the extractions. Keep every action item "
        "and decision. Write 'None recorded.' under a section with nothing in it.\n\n"
        f"Template:\n{NOTES_TEMPLATE}\n\n<extractions>\n{extractions}\n</extractions>"
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def notes_header(meta: MeetingMeta) -> str:
    rows = [f"# {meta.title}", ""]
    for row in describe_meeting(meta).splitlines()[1:]:
        key, _, value = row.partition(": ")
        rows.append(f"- **{key}:** {value}")
    return "\n".join(rows) + "\n\n"


def _clean_body(text: str) -> str:
    body = text.strip()
    fence = re.match(r"^```(?:markdown|md)?\s*\n(.*)\n```$", body, re.DOTALL)
    if fence:
        body = fence.group(1).strip()
    start = body.find("## Summary")
    return body[start:] if start > 0 else body


async def _noop(_: str) -> None:
    return None


async def generate_notes(
    meta: MeetingMeta,
    lines: list[TranscriptLine],
    progress: ProgressCallback = _noop,
) -> str:
    if not lines:
        raise ValueError("This recording has no transcript text to take notes from.")

    budget = chunk_budget_tokens()
    parts = chunk_lines(lines, budget)
    extractions: list[str] = []
    for index, part in enumerate(parts, start=1):
        await progress(f"Extracting part {index} of {len(parts)}")
        stamps = [line.start_seconds for line in part if line.start_seconds is not None]
        span = f"{format_timestamp(stamps[0])}–{format_timestamp(stamps[-1])}" if stamps else "untimed"
        text = "\n".join(format_line(line) for line in part)
        result = await llm.chat(extraction_messages(meta, text, index, len(parts), span))
        label = f"## Part {index} ({span})" if len(parts) > 1 else "## Extraction"
        extractions.append(f"{label}\n{result.strip()}")

    # Very long meetings: condense groups of extractions until they fit.
    while len(extractions) > 1 and estimate_tokens("\n\n".join(extractions)) > budget:
        await progress("Condensing extractions")
        groups: list[list[str]] = [[]]
        for item in extractions:
            if groups[-1] and estimate_tokens("\n\n".join(groups[-1] + [item])) > budget:
                groups.append([])
            groups[-1].append(item)
        if len(groups) == len(extractions):  # each part alone is too large; pair them anyway
            groups = [extractions[i:i + 2] for i in range(0, len(extractions), 2)]
        condensed = []
        for number, group in enumerate(groups, start=1):
            merged = await llm.chat(condense_messages(meta, "\n\n".join(group)))
            condensed.append(f"## Merged section {number}\n{merged.strip()}")
        extractions = condensed

    await progress("Organising notes")
    body = await llm.chat(organise_messages(meta, "\n\n".join(extractions)))
    footer = (
        f"\n\n---\n_Generated by {settings.llm_model} from a speaker-labelled transcript. "
        "Check names, owners and dates against the recording._\n"
    )
    return notes_header(meta) + _clean_body(body) + footer
