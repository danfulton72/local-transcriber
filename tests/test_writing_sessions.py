import io
import wave

from fastapi.testclient import TestClient

from app.main import app


def make_wav(samples: list[int], sample_rate: int = 8000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        frames = b"".join(int(sample).to_bytes(2, "little", signed=True) for sample in samples)
        audio.writeframes(frames)
    return buffer.getvalue()


def read_wav_samples(data: bytes) -> tuple[int, list[int]]:
    with wave.open(io.BytesIO(data), "rb") as audio:
        rate = audio.getframerate()
        frames = audio.readframes(audio.getnframes())
    samples = [
        int.from_bytes(frames[index:index + 2], "little", signed=True)
        for index in range(0, len(frames), 2)
    ]
    return rate, samples



def test_recovery_and_keep_talking_append():
    with TestClient(app) as client:
        created = client.post("/api/recordings", json={"language": "en"}).json()
        rid = created["id"]

        first = client.post(
            f"/api/recordings/{rid}/finish",
            json={
                "transcript": "First idea.",
                "duration_seconds": 1.0,
                "processing_seconds": 0,
                "append": False,
            },
        )
        assert first.status_code == 200
        assert first.json()["transcript"] == "First idea."

        draft = client.patch(
            f"/api/recordings/{rid}/draft",
            json={"text": "First idea. Second idea.", "active_capture": True},
        )
        assert draft.status_code == 200
        assert draft.json()["status"] == "recording"
        assert draft.json()["draft_text"] == "First idea. Second idea."

        recoverable = client.get("/api/recoverable")
        assert recoverable.status_code == 200
        assert recoverable.json()["id"] == rid
        assert recoverable.json()["transcript"] == "First idea. Second idea."

        continued = client.post(
            f"/api/recordings/{rid}/finish",
            json={
                "transcript": "Second idea.",
                "duration_seconds": 2.0,
                "processing_seconds": 0,
                "append": True,
            },
        )
        assert continued.status_code == 200
        result = continued.json()
        assert result["status"] == "ready"
        assert result["transcript"] == "First idea. Second idea."
        assert result["duration_seconds"] == 3.0
        assert result["draft_text"] is None


def test_edit_draft_does_not_change_ready_status_and_final_edit_clears_it():
    with TestClient(app) as client:
        created = client.post("/api/recordings", json={}).json()
        rid = created["id"]
        client.post(
            f"/api/recordings/{rid}/finish",
            json={"transcript": "Original sentence.", "duration_seconds": 1.0},
        )

        autosave = client.patch(
            f"/api/recordings/{rid}/draft",
            json={"text": "Edited sentence.", "active_capture": False},
        )
        assert autosave.status_code == 200
        assert autosave.json()["status"] == "ready"
        assert autosave.json()["draft_text"] == "Edited sentence."

        saved = client.patch(
            f"/api/recordings/{rid}",
            json={"transcript_edited": "Edited sentence."},
        )
        assert saved.status_code == 200
        assert saved.json()["transcript"] == "Edited sentence."
        assert saved.json()["draft_text"] is None


def test_multiple_audio_segments_are_preserved_and_combined_in_order():
    with TestClient(app) as client:
        created = client.post("/api/recordings", json={}).json()
        rid = created["id"]
        client.post(
            f"/api/recordings/{rid}/finish",
            json={"transcript": "A piece with two voice captures.", "duration_seconds": 2.0},
        )

        first_wav = make_wav([100, 200, 300, 400])
        second_wav = make_wav([-100, -200, -300])

        first = client.post(
            f"/api/recordings/{rid}/audio",
            files={"file": ("first.wav", first_wav, "audio/wav")},
            data={"duration_seconds": "0.0005"},
        )
        second = client.post(
            f"/api/recordings/{rid}/audio",
            files={"file": ("second.wav", second_wav, "audio/wav")},
            data={"duration_seconds": "0.000375"},
        )
        assert first.status_code == 200
        assert second.status_code == 200

        segments = client.get(f"/api/recordings/{rid}/audio-segments")
        assert segments.status_code == 200
        rows = segments.json()["segments"]
        assert len(rows) == 2

        fetched = client.get(rows[0]["url"])
        assert fetched.status_code == 200
        assert fetched.content == first_wav

        combined = client.get(f"/api/recordings/{rid}/audio-combined")
        assert combined.status_code == 200
        assert combined.headers["x-audio-segments"] == "2"
        rate, samples = read_wav_samples(combined.content)
        assert rate == 8000
        assert samples == [100, 200, 300, 400, -100, -200, -300]


def test_share_event_is_allowed():
    with TestClient(app) as client:
        created = client.post("/api/recordings", json={}).json()
        rid = created["id"]
        client.post(
            f"/api/recordings/{rid}/finish",
            json={"transcript": "Share these words.", "duration_seconds": 1.0},
        )
        response = client.post(
            "/api/events",
            json={"event_type": "share", "recording_id": rid, "event_data": {}},
        )
        assert response.status_code == 204
