from fastapi.testclient import TestClient

from app.main import app


def test_parent_tools_recycle_retention_status_and_backup():
    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
        assert login.status_code == 200
        created = client.post("/api/recordings", json={"language": "en"}).json()
        rid = created["id"]

        finished = client.post(
            f"/api/recordings/{rid}/finish",
            json={"transcript": "A saved piece for the recycle bin.", "duration_seconds": 2.0},
        )
        assert finished.status_code == 200

        deleted = client.delete(f"/api/recordings/{rid}")
        assert deleted.status_code == 204

        bin_items = client.get("/api/admin/recycle-bin")
        assert bin_items.status_code == 200
        assert any(item["id"] == rid for item in bin_items.json())

        restored = client.post(f"/api/admin/recycle-bin/{rid}/restore")
        assert restored.status_code == 200

        retention = client.patch(
            "/api/admin/retention",
            json={"audio_retention_days": 30, "delete_audio_after_transcription": False},
        )
        assert retention.status_code == 200
        assert retention.json()["audio_retention_days"] == 30

        status = client.get("/api/admin/status")
        assert status.status_code == 200
        assert status.json()["database"] is True

        backup = client.get("/api/admin/backup")
        assert backup.status_code == 200
        assert backup.headers["content-type"] == "application/zip"
        assert backup.content[:2] == b"PK"

        reset = client.patch(
            "/api/admin/retention",
            json={"audio_retention_days": 0, "delete_audio_after_transcription": False},
        )
        assert reset.status_code == 200

        client.delete(f"/api/recordings/{rid}")
        permanent = client.delete(f"/api/admin/recycle-bin/{rid}")
        assert permanent.status_code == 204
