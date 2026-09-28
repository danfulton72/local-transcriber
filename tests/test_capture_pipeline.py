import io
import wave
from pathlib import Path

from fastapi.testclient import TestClient

import app.main as main_module
from app.config import settings
from app.main import app
from app.services.recording_audio import combine_wav_segments


STATIC = Path(__file__).resolve().parents[1] / "app" / "static"


def make_wav(frame_count: int, sample_rate: int, value: int = 1000, channels: int = 1) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(value.to_bytes(2, "little", signed=True) * frame_count * channels)
    return buffer.getvalue()


def wav_info(data: bytes) -> tuple[int, int, int]:
    with wave.open(io.BytesIO(data), "rb") as audio:
        return audio.getframerate(), audio.getnchannels(), audio.getnframes()


def login(client: TestClient) -> None:
    response = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
    assert response.status_code == 200


def test_combine_same_format_is_byte_exact(tmp_path):
    first = tmp_path / "a.wav"
    second = tmp_path / "b.wav"
    first.write_bytes(make_wav(1600, 16000, 10))
    second.write_bytes(make_wav(800, 16000, -10))
    out = tmp_path / "out.wav"

    frames, rate = combine_wav_segments([first, second], out)

    assert (frames, rate) == (2400, 16000)
    with wave.open(str(out), "rb") as audio:
        data = audio.readframes(audio.getnframes())
    assert data == (10).to_bytes(2, "little", signed=True) * 1600 + (-10).to_bytes(2, "little", signed=True) * 800


def test_combine_mixed_formats_normalises_to_16k_mono(tmp_path):
    legacy = tmp_path / "legacy.wav"
    current = tmp_path / "current.wav"
    legacy.write_bytes(make_wav(48000, 48000, channels=2))  # 1 s stereo 48 kHz
    current.write_bytes(make_wav(16000, 16000))  # 1 s mono 16 kHz
    out = tmp_path / "out.wav"

    frames, rate = combine_wav_segments([legacy, current], out)

    assert rate == 16000
    assert abs(frames - 32000) <= 2
    assert wav_info(out.read_bytes())[:2] == (16000, 1)


def test_combined_endpoint_handles_keep_talking_after_rate_change():
    with TestClient(app) as client:
        login(client)
        rid = client.post("/api/recordings", json={}).json()["id"]
        for data in (make_wav(4800, 48000), make_wav(1600, 16000)):
            uploaded = client.post(
                f"/api/recordings/{rid}/audio",
                files={"file": ("segment.wav", data, "audio/wav")},
                data={"duration_seconds": "0.1"},
            )
            assert uploaded.status_code == 200

        combined = client.get(f"/api/recordings/{rid}/audio-combined")
        assert combined.status_code == 200
        rate, channels, frames = wav_info(combined.content)
        assert (rate, channels) == (16000, 1)
        assert abs(frames - 3200) <= 2
        assert combined.headers["x-audio-duration"] == "0.200"
        # Do not leave an in-progress recording behind for the recovery tests.
        assert client.post(f"/api/recordings/{rid}/abandon").status_code == 200


def _record_with_chunk(client: TestClient, monkeypatch, upload_segment: bool) -> str:
    async def fake_transcribe(*_args, **_kwargs):
        return "hello there"

    monkeypatch.setattr(main_module.gateway, "transcribe", fake_transcribe)
    rid = client.post("/api/recordings", json={}).json()["id"]
    chunk = client.post(
        f"/api/recordings/{rid}/chunks",
        files={"file": ("chunk-00001.wav", make_wav(1600, 16000), "audio/wav")},
        data={"chunk_number": "1"},
    )
    assert chunk.status_code == 200
    assert (settings.recordings_dir / rid / "chunks" / "00001.wav").exists()

    if upload_segment:
        segment = client.post(
            f"/api/recordings/{rid}/audio",
            files={"file": ("segment-0001.wav", make_wav(1600, 16000), "audio/wav")},
            data={"duration_seconds": "0.1"},
        )
        assert segment.status_code == 200

    finished = client.post(
        f"/api/recordings/{rid}/finish",
        json={"transcript": "hello there", "duration_seconds": 0.1, "processing_seconds": 0},
    )
    assert finished.status_code == 200
    return rid


def test_finish_prunes_duplicate_chunk_audio(monkeypatch):
    with TestClient(app) as client:
        login(client)
        rid = _record_with_chunk(client, monkeypatch, upload_segment=True)

        assert not (settings.recordings_dir / rid / "chunks").exists()
        assert list((settings.recordings_dir / rid / "segments").iterdir())
        assert client.get(f"/api/recordings/{rid}/audio-combined").status_code == 200


def test_finish_keeps_chunks_when_full_audio_is_missing(monkeypatch):
    with TestClient(app) as client:
        login(client)
        rid = _record_with_chunk(client, monkeypatch, upload_segment=False)

        assert (settings.recordings_dir / rid / "chunks" / "00001.wav").exists()


def test_finish_keeps_chunks_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "keep_live_chunk_audio", True)
    with TestClient(app) as client:
        login(client)
        rid = _record_with_chunk(client, monkeypatch, upload_segment=True)

        assert (settings.recordings_dir / rid / "chunks" / "00001.wav").exists()


def test_capture_uses_16k_worklet_and_streams_segments():
    javascript = (STATIC / "app.js").read_text()
    worklet = (STATIC / "capture-worklet.js").read_text()
    service_worker = (STATIC / "sw.js").read_text()

    assert "const CAPTURE_SAMPLE_RATE = 16000;" in javascript
    assert "new AudioWorkletNode(ctx, 'talk-to-type-capture'" in javascript
    assert "audioWorklet.addModule('/audio-utils.js')" in javascript
    assert "registerProcessor('talk-to-type-capture'" in worklet
    assert "createResampler(sampleRate, targetRate)" in worklet
    assert "flushAudioSegment" in javascript
    assert "fullBuffers" not in javascript
    assert "findQuietCut" in javascript
    assert "'/capture-worklet.js'" in service_worker
