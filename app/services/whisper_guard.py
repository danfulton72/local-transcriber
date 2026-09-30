"""Drop text Whisper invents for silence.

Whisper was trained largely on subtitled video, so given silence or
near-silence it tends to "hear" sign-offs such as "Thank you." or
"Thanks for watching!". This module measures how much speech a WAV clip
actually contains and discards text that cannot have come from it:

* no speech at all          -> any text is dropped;
* a known phantom phrase    -> dropped unless the clip holds enough speech
  for someone to have really said it.

Pure standard library so the speaker-analyzer image can ship an identical
copy (speaker_service/whisper_guard.py; a test keeps the two in sync).
"""

from __future__ import annotations

import io
import logging
import math
import re
import wave
from array import array
from dataclasses import dataclass

try:  # C implementation when present (stdlib <= 3.12, or audioop-lts); else pure Python.
    import audioop  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - depends on the Python build
    audioop = None

logger = logging.getLogger("whisper_guard")
if not logger.handlers:  # visible in `docker logs` without app-wide logging config
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     [whisper-guard] %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

FRAME_SECONDS = 0.02
# Below this much speech-like audio a clip is treated as silence.
MIN_SPEECH_SECONDS = 0.12
# A phantom phrase is kept only if at least this much speech is present;
# a real "thank you" has roughly 0.3-0.6 s above the speech threshold.
MIN_PHANTOM_SPEECH_SECONDS = 0.3

PHANTOM_PHRASES = frozenset({
    "thank you",
    "thank you very much",
    "thank you so much",
    "thanks",
    "thanks very much",
    "thank you for watching",
    "thanks for watching",
    "thanks for watching and see you next time",
    "thank you for listening",
    "thanks for listening",
    "please subscribe",
    "please subscribe to my channel",
    "like and subscribe",
    "bye",
    "bye bye",
    "goodbye",
    "you",
    "subtitles by the amara org community",
    "subtitles by the amaraorg community",
})


@dataclass
class SpeechProfile:
    duration_seconds: float
    speech_seconds: float
    peak_rms: float


def normalise_text(text: str) -> str:
    cleaned = re.sub(r"[^\w\s']", " ", (text or "").lower())
    return " ".join(cleaned.replace("'", "").split())


def is_phantom_phrase(text: str) -> bool:
    """True when the text is only a known phantom phrase, possibly repeated."""
    words = normalise_text(text)
    if not words:
        return False
    if words in PHANTOM_PHRASES:
        return True
    # "Thank you. Thank you. Thank you."
    for phrase in PHANTOM_PHRASES:
        count = words.count(phrase)
        if count > 1 and " ".join([phrase] * count) == words:
            return True
    return False


def _frame_levels(samples: array, rate: int) -> list[float]:
    frame = max(1, int(rate * FRAME_SECONDS))
    levels = []
    scale = 32768.0
    if audioop is not None:
        raw = samples.tobytes()
        step = frame * 2
        for start in range(0, len(raw), step):
            chunk = raw[start:start + step]
            if chunk:
                levels.append(audioop.rms(chunk, 2) / scale)
        return levels
    for start in range(0, len(samples), frame):
        chunk = samples[start:start + frame]
        if not chunk:
            break
        total = 0
        for value in chunk:
            total += value * value
        levels.append(math.sqrt(total / len(chunk)) / scale)
    return levels


def speech_profile(wav_bytes: bytes) -> SpeechProfile | None:
    """Estimate how many seconds of a WAV clip contain speech-like energy.

    Returns None when the bytes are not a readable PCM WAV (the caller then
    leaves the text alone).
    """
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as source:
            channels = source.getnchannels()
            width = source.getsampwidth()
            rate = source.getframerate()
            frames = source.readframes(source.getnframes())
    except (wave.Error, EOFError, OSError):
        return None
    if width != 2 or not rate:
        return None
    samples = array("h")
    samples.frombytes(frames[: len(frames) - len(frames) % 2])
    if channels > 1:
        samples = array("h", samples[::channels])
    if not samples:
        return SpeechProfile(0.0, 0.0, 0.0)

    levels = _frame_levels(samples, rate)
    ordered = sorted(levels)
    noise_floor = ordered[int((len(ordered) - 1) * 0.2)]
    peak = ordered[-1]
    # Adapt to a measured noise floor only when it is clearly below the signal.
    usable_floor = 0 < noise_floor < peak * 0.55
    threshold = max(0.0075, noise_floor * 2.8 if usable_floor else 0.0)
    active = sum(1 for level in levels if level >= threshold)
    return SpeechProfile(
        duration_seconds=len(samples) / rate,
        speech_seconds=active * FRAME_SECONDS,
        peak_rms=peak,
    )


def filter_transcript(text: str, wav_bytes: bytes, *, context: str = "") -> str:
    """Return the transcript, or "" when it cannot have come from the audio."""
    if not (text or "").strip():
        return text or ""
    profile = speech_profile(wav_bytes)
    if profile is None:
        return text
    if profile.speech_seconds < MIN_SPEECH_SECONDS:
        logger.info(
            "Dropped Whisper text for silent audio%s: %r (%.2fs speech in %.2fs)",
            f" ({context})" if context else "", text, profile.speech_seconds, profile.duration_seconds,
        )
        return ""
    if is_phantom_phrase(text) and profile.speech_seconds < MIN_PHANTOM_SPEECH_SECONDS:
        logger.info(
            "Dropped Whisper phantom phrase%s: %r (%.2fs speech in %.2fs)",
            f" ({context})" if context else "", text, profile.speech_seconds, profile.duration_seconds,
        )
        return ""
    return text
