import io
import tempfile
import warnings
import wave
from pathlib import Path

with warnings.catch_warnings():
    # audioop is deprecated in 3.12 and provided by audioop-lts on 3.13+.
    warnings.simplefilter("ignore", DeprecationWarning)
    import audioop

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

    try:
        total_frames, sample_rate = combine_wav_segments(
            [Path(segment.audio_path) for segment in segments],
            output_path,
        )
        return output_path, True, len(segments), total_frames / sample_rate
    except Exception:
        output_path.unlink(missing_ok=True)
        raise


# Common format used when a recording mixes segment formats, e.g. a 48 kHz
# recording made before 16 kHz capture, continued later with "Keep talking".
NORMALISED_CHANNELS = 1
NORMALISED_WIDTH = 2
NORMALISED_RATE = 16000
_COPY_BLOCK_FRAMES = 65536


def _normalise_pcm(data: bytes, channels: int, width: int, rate: int) -> bytes:
    if width == 1:
        # 8-bit WAV is unsigned; audioop expects signed samples.
        data = audioop.bias(data, 1, -128)
    if width != NORMALISED_WIDTH:
        data = audioop.lin2lin(data, width, NORMALISED_WIDTH)
    if channels == 2:
        data = audioop.tomono(data, NORMALISED_WIDTH, 0.5, 0.5)
    elif channels != 1:
        raise ValueError(f"Unsupported channel count: {channels}.")
    if rate != NORMALISED_RATE:
        data, _ = audioop.ratecv(data, NORMALISED_WIDTH, 1, rate, NORMALISED_RATE, None)
    return data


def combine_wav_segments(paths: list[Path], output_path: Path) -> tuple[int, int]:
    """Concatenate PCM WAV segments into ``output_path``.

    Segments that share a format are streamed through unchanged. If formats
    differ, every segment is converted to 16 kHz mono 16-bit so older
    recordings continued at the new capture rate still play and analyse.
    Returns ``(total_frames, sample_rate)``.
    """
    formats = []
    for index, path in enumerate(paths):
        try:
            with wave.open(str(path), "rb") as source:
                formats.append(
                    (
                        source.getnchannels(),
                        source.getsampwidth(),
                        source.getframerate(),
                        source.getcomptype(),
                    )
                )
        except (wave.Error, EOFError) as exc:
            raise ValueError(f"Audio segment {index + 1} is not a valid PCM WAV file.") from exc
    if not formats:
        raise ValueError("Audio is not available for this recording.")
    if any(item[3] != "NONE" for item in formats):
        raise ValueError("Voice segments must be uncompressed PCM WAV audio.")

    uniform = len(set(formats)) == 1
    channels, width, rate = (
        formats[0][:3] if uniform else (NORMALISED_CHANNELS, NORMALISED_WIDTH, NORMALISED_RATE)
    )

    total_frames = 0
    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(width)
        output.setframerate(rate)
        for path, (src_channels, src_width, src_rate, _) in zip(paths, formats):
            with wave.open(str(path), "rb") as source:
                if uniform:
                    while True:
                        data = source.readframes(_COPY_BLOCK_FRAMES)
                        if not data:
                            break
                        output.writeframesraw(data)
                    total_frames += source.getnframes()
                else:
                    data = _normalise_pcm(
                        source.readframes(source.getnframes()),
                        src_channels,
                        src_width,
                        src_rate,
                    )
                    output.writeframesraw(data)
                    total_frames += len(data) // (NORMALISED_WIDTH * NORMALISED_CHANNELS)
        output.writeframes(b"")
    return total_frames, rate



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
