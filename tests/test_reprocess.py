import asyncio
import io
import uuid
import wave
from pathlib import Path

from fastapi.testclient import TestClient

import app.reprocess_admin as reprocess_module
from app.db import SessionLocal
from app.main import app
from app.models import (
    MeetingExport,
    Recording,
    SpeakerAnalysis,
    SpeakerDetection,
    SpeakerTurn,
)


STATIC = Path(__file__).resolve().parents[1] / "app" / "static"


def make_wav(seconds: float = 1.0, sample_rate: int = 16000, value: int = 1200) -> bytes:
    frames = int(seconds * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(value.to_bytes(2, "little", signed=True) * frames)
    return buffer.getvalue()


def login(client: TestClient) -> None:
    response = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
    assert response.status_code == 200


def ready_recording(client: TestClient, transcript: str = "old words") -> str:
    rid = client.post("/api/recordings", json={"language": "en"}).json()["id"]
    uploaded = client.post(
        f"/api/recordings/{rid}/audio",
        files={"file": ("segment.wav", make_wav(), "audio/wav")},
        data={"duration_seconds": "1.0"},
    )
    assert uploaded.status_code == 200
    finished = client.post(
        f"/api/recordings/{rid}/finish",
        json={"transcript": transcript, "duration_seconds": 1.0},
    )
    assert finished.status_code == 200
    return rid


async def add_export(recording_id: str) -> None:
    async with SessionLocal() as db:
        db.add(
            MeetingExport(
                recording_id=uuid.UUID(recording_id),
                status="completed",
                transcript_markdown="old transcript",
                notes_markdown="old notes",
                notes_stale=False,
            )
        )
        await db.commit()


async def add_speaker_analysis(recording_id: str) -> str:
    async with SessionLocal() as db:
        analysis = SpeakerAnalysis(
            recording_id=uuid.UUID(recording_id),
            status="completed",
            model="pyannote/test",
            speaker_count=1,
        )
        db.add(analysis)
        await db.flush()
        detection = SpeakerDetection(
            analysis_id=analysis.id,
            speaker_key="SPEAKER_00",
            person_index=1,
            display_name="Person 1",
            embedding=[1.0, 0.0],
        )
        db.add(detection)
        await db.flush()
        db.add(
            SpeakerTurn(
                analysis_id=analysis.id,
                detection_id=detection.id,
                start_seconds=0.0,
                end_seconds=0.8,
                text="old speaker words",
                edited_text="human correction",
            )
        )
        await db.commit()
        return str(analysis.id)


def test_recording_reprocess_is_reviewed_before_replacing(monkeypatch):
    async def fake_transcribe(*_args, **_kwargs):
        return "better words from current whisper"

    monkeypatch.setattr(reprocess_module.gateway, "transcribe", fake_transcribe)

    with TestClient(app) as client:
        login(client)
        rid = ready_recording(client)
        asyncio.run(add_export(rid))

        started = client.post(f"/api/admin/reprocess/recordings/{rid}")
        assert started.status_code == 202

        run = client.get(f"/api/admin/reprocess/recordings/{rid}").json()
        assert run["status"] == "completed"
        assert run["candidate_transcript"] == "better words from current whisper"
        assert run["decision"] is None

        # Reprocessing alone never changes the saved transcript.
        assert client.get(f"/api/recordings/{rid}").json()["transcript"] == "old words"

        accepted = client.post(
            f"/api/admin/reprocess/runs/{run['id']}/accept",
            json={"clear_edits": False},
        )
        assert accepted.status_code == 200
        assert client.get(f"/api/recordings/{rid}").json()["transcript"] == "better words from current whisper"

        notes = client.get(f"/api/admin/meeting-notes/recordings/{rid}").json()
        assert notes["notes_stale"] is True


def test_recording_reprocess_requires_confirmation_to_replace_manual_edits(monkeypatch):
    async def fake_transcribe(*_args, **_kwargs):
        return "fresh machine transcript"

    monkeypatch.setattr(reprocess_module.gateway, "transcribe", fake_transcribe)

    with TestClient(app) as client:
        login(client)
        rid = ready_recording(client)
        edited = client.patch(
            f"/api/recordings/{rid}",
            json={"transcript_edited": "carefully corrected by a person"},
        )
        assert edited.status_code == 200

        assert client.post(f"/api/admin/reprocess/recordings/{rid}").status_code == 202
        run = client.get(f"/api/admin/reprocess/recordings/{rid}").json()
        assert run["has_manual_edits"] is True

        blocked = client.post(
            f"/api/admin/reprocess/runs/{run['id']}/accept",
            json={"clear_edits": False},
        )
        assert blocked.status_code == 409
        assert client.get(f"/api/recordings/{rid}").json()["transcript"] == "carefully corrected by a person"

        accepted = client.post(
            f"/api/admin/reprocess/runs/{run['id']}/accept",
            json={"clear_edits": True},
        )
        assert accepted.status_code == 200
        saved = client.get(f"/api/recordings/{rid}").json()
        assert saved["transcript"] == "fresh machine transcript"
        assert saved["transcript_edited"] is None


def test_speaker_word_reprocess_preserves_manual_turn_edit(monkeypatch):
    async def fake_transcribe(*_args, **_kwargs):
        return "new automatic turn words"

    monkeypatch.setattr(reprocess_module.gateway, "transcribe", fake_transcribe)

    with TestClient(app) as client:
        login(client)
        rid = ready_recording(client)
        analysis_id = asyncio.run(add_speaker_analysis(rid))
        asyncio.run(add_export(rid))

        started = client.post(f"/api/admin/reprocess/analyses/{analysis_id}/speaker-turns")
        assert started.status_code == 202
        run = client.get(f"/api/admin/reprocess/runs/{started.json()['id']}").json()
        assert run["status"] == "completed"
        assert run["result_data"]["changed_turns"] == 1
        assert run["result_data"]["manual_edits_preserved"] == 1

        analysis = client.get(f"/api/admin/speakers/analyses/{analysis_id}").json()
        assert len(analysis["turns"]) == 1
        assert analysis["turns"][0]["original_text"] == "new automatic turn words"
        assert analysis["turns"][0]["text"] == "human correction"
        assert analysis["turns"][0]["edited"] is True

        recording = client.get(f"/api/recordings/{rid}").json()
        assert recording["transcript_original"] == "new automatic turn words"
        assert recording["transcript_edited"] == "human correction"
        assert recording["transcript"] == "human correction"

        notes = client.get(f"/api/admin/meeting-notes/recordings/{rid}").json()
        assert notes["notes_stale"] is True


def test_reprocess_controls_are_present_in_ui():
    javascript = (STATIC / "app.js").read_text()
    html = (STATIC / "index.html").read_text()

    assert "↻ Reprocess audio" in javascript
    assert "↻ Reprocess words" in javascript
    assert "/api/admin/reprocess/recordings/" in javascript
    assert "/api/admin/reprocess/analyses/" in javascript
    assert 'id="reprocessDialog"' in html
    assert "Use reprocessed transcript" in html
