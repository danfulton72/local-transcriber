from fastapi.testclient import TestClient

from app.main import app


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


def test_multiple_audio_segments_are_preserved():
    with TestClient(app) as client:
        created = client.post("/api/recordings", json={}).json()
        rid = created["id"]
        client.post(
            f"/api/recordings/{rid}/finish",
            json={"transcript": "A piece with two voice captures.", "duration_seconds": 2.0},
        )

        first = client.post(
            f"/api/recordings/{rid}/audio",
            files={"file": ("first.wav", b"RIFFfirst", "audio/wav")},
        )
        second = client.post(
            f"/api/recordings/{rid}/audio",
            files={"file": ("second.wav", b"RIFFsecond", "audio/wav")},
        )
        assert first.status_code == 200
        assert second.status_code == 200

        segments = client.get(f"/api/recordings/{rid}/audio-segments")
        assert segments.status_code == 200
        rows = segments.json()["segments"]
        assert len(rows) == 2

        fetched = client.get(rows[0]["url"])
        assert fetched.status_code == 200
        assert fetched.content == b"RIFFfirst"


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
