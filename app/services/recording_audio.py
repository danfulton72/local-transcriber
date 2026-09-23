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
