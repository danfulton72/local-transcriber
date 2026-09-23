from fastapi.testclient import TestClient

from app.main import app


def test_recording_lifecycle():
    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
        assert login.status_code == 200
        created = client.post("/api/recordings", json={"language": "en"})
        assert created.status_code == 200
        recording = created.json()
        assert recording["status"] == "recording"

        finished = client.post(
            f"/api/recordings/{recording['id']}/finish",
            json={"transcript": "This is a test recording.", "duration_seconds": 4.2},
        )
        assert finished.status_code == 200
        saved = finished.json()
        assert saved["status"] == "ready"
        assert saved["word_count"] == 5

        edited = client.patch(
            f"/api/recordings/{recording['id']}",
            json={"transcript_edited": "This is an edited recording."},
        )
        assert edited.status_code == 200
        assert edited.json()["transcript"] == "This is an edited recording."

        listing = client.get("/api/recordings")
        assert listing.status_code == 200
        assert any(item["id"] == recording["id"] for item in listing.json())
