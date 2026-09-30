import pytest
import io
import uuid
import wave

from fastapi.testclient import TestClient

from test_meeting_notes import login_admin


def make_wav(seconds: float = 12.0, rate: int = 8000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\x01\x00" * int(seconds * rate))
    return buffer.getvalue()


def test_turns_can_be_reassigned_heard_and_added_to_training(monkeypatch):
    from app import speaker_admin
    from app.main import app

    async def fake_analyze(path, language=None, num_speakers=None):
        return {
            "model": "fake",
            "speakers": [
                {"speaker_key": "S0", "embedding": [0.11, 0.23, 0.31, 0.97]},
                {"speaker_key": "S1", "embedding": [0.97, -0.31, 0.23, -0.11]},
            ],
            "turns": [
                {"speaker_key": "S0", "start_seconds": 0.0, "end_seconds": 4.0, "text": "First turn."},
                {"speaker_key": "S1", "start_seconds": 4.0, "end_seconds": 8.0, "text": "Second turn."},
                {"speaker_key": "S1", "start_seconds": 8.0, "end_seconds": 12.0, "text": "Third turn."},
            ],
        }

    monkeypatch.setattr(speaker_admin.speaker_service, "analyze", fake_analyze)
    tag = uuid.uuid4().hex[:6]

    with TestClient(app) as client:
        login_admin(client)
        recording = client.post("/api/recordings", json={"language": "en"}).json()
        rid = recording["id"]
        client.post(f"/api/recordings/{rid}/finish", json={"transcript": "x", "duration_seconds": 12})
        client.post(
            f"/api/recordings/{rid}/audio",
            files={"file": ("a.wav", make_wav(), "audio/wav")},
            data={"duration_seconds": "12"},
        )
        job = client.post(f"/api/admin/speakers/analyze/{rid}", json={}).json()
        analysis = client.get(f"/api/admin/speakers/analyses/{job['id']}").json()
        assert analysis["status"] == "completed"
        first, second, third = analysis["turns"]
        assert first["relabel_status"] is None and first["can_preview"] is True

        # Each turn can be heard on its own
        audio = client.get(f"/api/admin/speakers/analyses/{job['id']}/turns/{second['id']}/sample-audio")
        assert audio.status_code == 200
        assert audio.headers["content-type"] == "audio/wav"
        assert audio.content[:4] == b"RIFF"
        assert float(audio.headers["x-clip-end"]) - float(audio.headers["x-clip-start"]) > 3

        # Reassign one turn to a brand new name and add it to training data
        new_name = f"Jordan {tag}"
        updated = client.patch(
            f"/api/admin/speakers/analyses/{job['id']}/turns/{second['id']}/identity",
            json={"name": new_name, "scope": "turn", "add_to_training": True},
        )
        assert updated.status_code == 200, updated.text
        turns = {row["id"]: row for row in updated.json()["turns"]}
        assert turns[second["id"]]["display_name"] == new_name
        assert turns[second["id"]]["identity_override_name"] == new_name
        assert turns[second["id"]]["relabel_status"] == "approved"
        assert turns[third["id"]]["display_name"] == "Person 2"  # other turns untouched

        # A typed name that matches a remembered voice uses that voice
        voice = f"Priya {tag}"
        remembered = client.post(
            f"/api/admin/speakers/analyses/{job['id']}/detections/S0/remember", json={"name": voice}
        )
        assert remembered.status_code == 200
        updated = client.patch(
            f"/api/admin/speakers/analyses/{job['id']}/turns/{third['id']}/identity",
            json={"name": voice.upper(), "scope": "turn"},
        ).json()
        third_now = next(row for row in updated["turns"] if row["id"] == third["id"])
        assert third_now["display_name"] == voice
        assert third_now["identity_override_profile_id"] == remembered.json()["id"]
        assert third_now["relabel_status"] == "pending"  # not added to training

        # Unknown is never training data, even if asked
        updated = client.patch(
            f"/api/admin/speakers/analyses/{job['id']}/turns/{third['id']}/identity",
            json={"unknown": True, "scope": "turn", "add_to_training": True},
        ).json()
        assert next(row for row in updated["turns"] if row["id"] == third["id"])["relabel_status"] == "pending"

        # Naming a turn as the speaker it was detected as resets it
        updated = client.patch(
            f"/api/admin/speakers/analyses/{job['id']}/turns/{second['id']}/identity",
            json={"name": "person 2", "scope": "turn"},
        ).json()
        reset = next(row for row in updated["turns"] if row["id"] == second["id"])
        assert reset["identity_corrected"] is False and reset["relabel_id"] is None

        # Exactly one choice is required
        bad = client.patch(
            f"/api/admin/speakers/analyses/{job['id']}/turns/{second['id']}/identity",
            json={"name": "Someone", "unknown": True},
        )
        assert bad.status_code == 400


def test_turns_carry_voice_match_confidence(monkeypatch):
    from app import speaker_admin
    from app.main import app

    voice_a = [0.2, 0.9, 0.1, 0.3, 0.05]
    near_a = [0.25, 0.85, 0.2, 0.3, 0.1]      # ~0.99 similar to A: matched
    partly_a = [0.9, 0.4, -0.2, 0.1, 0.0]     # ~0.5 similar to A: below the 0.78 threshold

    embeddings = {"first": [voice_a, [0.0, 0.0, 1.0, 0.0, 0.0]], "second": [near_a, partly_a]}
    calls = []

    async def fake_analyze(path, language=None, num_speakers=None):
        pair = embeddings["first" if not calls else "second"]
        calls.append(1)
        return {
            "model": "fake",
            "speakers": [
                {"speaker_key": "S0", "embedding": pair[0]},
                {"speaker_key": "S1", "embedding": pair[1]},
            ],
            "turns": [
                {"speaker_key": "S0", "start_seconds": 0.0, "end_seconds": 4.0, "text": "One."},
                {"speaker_key": "S1", "start_seconds": 4.0, "end_seconds": 8.0, "text": "Two."},
            ],
        }

    monkeypatch.setattr(speaker_admin.speaker_service, "analyze", fake_analyze)
    name = f"Asha {uuid.uuid4().hex[:6]}"

    def analyse(client):
        recording = client.post("/api/recordings", json={"language": "en"}).json()
        client.post(f"/api/recordings/{recording['id']}/finish", json={"transcript": "x", "duration_seconds": 8})
        client.post(
            f"/api/recordings/{recording['id']}/audio",
            files={"file": ("a.wav", make_wav(8), "audio/wav")},
            data={"duration_seconds": "8"},
        )
        job = client.post(f"/api/admin/speakers/analyze/{recording['id']}", json={}).json()
        return client.get(f"/api/admin/speakers/analyses/{job['id']}").json()

    with TestClient(app) as client:
        login_admin(client)
        first = analyse(client)
        assert first["match_threshold"] == pytest.approx(0.78)
        saved = client.post(
            f"/api/admin/speakers/analyses/{first['id']}/detections/S0/remember", json={"name": name}
        )
        assert saved.status_code == 200
        first = client.get(f"/api/admin/speakers/analyses/{first['id']}").json()
        assert first["turns"][0]["match_source"] == "confirmed"  # named by a person

        second = analyse(client)
        matched_turn, unmatched_turn = second["turns"]
        assert matched_turn["display_name"] == name
        assert matched_turn["match_source"] == "matched"
        assert matched_turn["match_score"] > 0.9

        assert unmatched_turn["match_source"] == "unmatched"
        assert unmatched_turn["match_score"] is None
        assert unmatched_turn["closest_profile_name"] == name
        assert 0 < unmatched_turn["closest_score"] < 0.78

        detection = next(row for row in second["detections"] if row["speaker_key"] == "S1")
        assert detection["closest_profile_name"] == name and detection["match_source"] == "unmatched"

        corrected = client.patch(
            f"/api/admin/speakers/analyses/{second['id']}/turns/{unmatched_turn['id']}/identity",
            json={"name": "Someone new", "scope": "turn"},
        ).json()
        assert next(row for row in corrected["turns"] if row["id"] == unmatched_turn["id"])["match_source"] == "corrected"
