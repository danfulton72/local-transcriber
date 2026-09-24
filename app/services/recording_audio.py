import io
import tempfile
import wave
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Recording, RecordingAudioSegment


async def build_combined_wav(
    recording: Recording,
    db: AsyncSession,
) -> tuple[Path, bool, int, float | None]:
    segments = (
        await db.execute(
            select(RecordingAudioSegment)
            .where(RecordingAudioSegment.recording_id == recording.id)
            .order_by(RecordingAudioSegment.created_at.asc(), RecordingAudioSegment.id.asc())
        )
    ).scalars().all()

    if not segments:
        if not recording.audio_path:
            raise ValueError("Audio is not available for this recording.")
        path = Path(recording.audio_path)
        if not path.exists():
            raise ValueError("The saved audio file is missing.")
        if path.suffix.lower() != ".wav":
            raise ValueError("Speaker analysis currently supports microphone/WAV recordings.")
        duration = recording.duration_seconds
        if duration is None:
            with wave.open(str(path), "rb") as source:
                duration = source.getnframes() / source.getframerate()
        return path, False, 1, duration

    missing = [
        str(segment.id)
        for segment in segments
        if not segment.audio_path or not Path(segment.audio_path).exists()
    ]
    if missing:
        raise ValueError(
            f"Voice recording is incomplete: {len(missing)} audio segment(s) are missing."
        )

    temp = tempfile.NamedTemporaryFile(
        prefix=f"speaker-analysis-{recording.id}-",
        suffix=".wav",
        delete=False,
    )
    output_path = Path(temp.name)
    temp.close()

    expected_format = None
    total_frames = 0
    try:
        with wave.open(str(output_path), "wb") as output:
            for index, segment in enumerate(segments):
                try:
                    source = wave.open(str(segment.audio_path), "rb")
                except (wave.Error, EOFError) as exc:
                    raise ValueError(f"Audio segment {index + 1} is not a valid PCM WAV file.") from exc

                with source:
                    current_format = (
                        source.getnchannels(),
                        source.getsampwidth(),
                        source.getframerate(),
                        source.getcomptype(),
                        source.getcompname(),
                    )
                    if expected_format is None:
                        expected_format = current_format
                        output.setnchannels(source.getnchannels())
                        output.setsampwidth(source.getsampwidth())
                        output.setframerate(source.getframerate())
                        output.setcomptype(source.getcomptype(), source.getcompname())
                    elif current_format != expected_format:
                        raise ValueError("Voice segments use different audio formats.")

                    frame_count = source.getnframes()
                    output.writeframesraw(source.readframes(frame_count))
                    total_frames += frame_count
            output.writeframes(b"")

        duration = total_frames / expected_format[2] if expected_format else None
        return output_path, True, len(segments), duration
    except Exception:
        output_path.unlink(missing_ok=True)
        raise



def extract_wav_clip(
    path: Path,
    start_seconds: float,
    end_seconds: float,
    *,
    max_seconds: float = 8.0,
    edge_trim_seconds: float = 0.12,
) -> tuple[bytes, float, float]:
    """Return an in-memory PCM WAV excerpt without modifying the source file."""
    if end_seconds <= start_seconds:
        raise ValueError("Speaker sample has no usable duration.")

    try:
        source = wave.open(str(path), "rb")
    except (wave.Error, EOFError) as exc:
        raise ValueError("The saved recording is not a valid PCM WAV file.") from exc

    with source:
        frame_rate = source.getframerate()
        if frame_rate <= 0:
            raise ValueError("The saved recording has an invalid sample rate.")

        recording_seconds = source.getnframes() / frame_rate
        start = max(0.0, min(float(start_seconds), recording_seconds))
        end = max(start, min(float(end_seconds), recording_seconds))

        # Pull slightly inward from diarization boundaries where practical to
        # reduce the chance of including a neighbouring speaker.
        if end - start > (edge_trim_seconds * 2 + 0.5):
            start += edge_trim_seconds
            end -= edge_trim_seconds

        duration = end - start
        if duration > max_seconds:
            midpoint = start + duration / 2
            half = max_seconds / 2
            start = midpoint - half
            end = midpoint + half

        start_frame = max(0, int(start * frame_rate))
        end_frame = min(source.getnframes(), int(end * frame_rate))
        if end_frame <= start_frame:
            raise ValueError("Speaker sample is too short to play.")

        source.setpos(start_frame)
        frames = source.readframes(end_frame - start_frame)

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            output.setnchannels(source.getnchannels())
            output.setsampwidth(source.getsampwidth())
            output.setframerate(frame_rate)
            output.setcomptype(source.getcomptype(), source.getcompname())
            output.writeframes(frames)

    actual_start = start_frame / frame_rate
    actual_end = end_frame / frame_rate
    return buffer.getvalue(), actual_start, actual_end
