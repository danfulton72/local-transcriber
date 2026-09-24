import asyncio
import uuid
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.speaker_admin import (
    average_embeddings,
    best_profile,
    cosine_similarity,
    profile_quality,
    robust_sample_score,
)


def profile(name: str, values: list[float]):
    return SimpleNamespace(id=uuid.uuid4(), name=name, embedding=values)


def sample(values: list[float]):
    return SimpleNamespace(embedding=values)


def test_cosine_similarity_identical_and_opposite():
    assert round(cosine_similarity([1.0, 0.0], [1.0, 0.0]), 5) == 1.0
    assert round(cosine_similarity([1.0, 0.0], [-1.0, 0.0]), 5) == -1.0


def test_average_embeddings_stays_normalised():
    averaged = average_embeddings([[1.0, 0.0], [0.8, 0.2], [0.9, 0.1]])
    magnitude = sum(value * value for value in averaged) ** 0.5
    assert abs(magnitude - 1.0) < 1e-6


def test_robust_sample_score_keeps_best_samples_dominant():
    candidate = [1.0, 0.0]
    bank = [
        [1.0, 0.0],
        [0.98, 0.02],
        [0.95, 0.05],
        [0.0, 1.0],  # one poor/outlier sample should not dominate the profile
    ]
    score = robust_sample_score(candidate, bank)
    assert score > 0.95


def test_best_profile_uses_sample_bank_and_respects_threshold(monkeypatch):
    from app import speaker_admin

    monkeypatch.setattr(speaker_admin.settings, "speaker_match_threshold", 0.8)
    close = profile("Known", [0.7, 0.7])
    far = profile("Other", [0.0, 1.0])
    samples = {
        close.id: [sample([1.0, 0.0]), sample([0.98, 0.02]), sample([0.95, 0.05])],
        far.id: [sample([0.0, 1.0])],
    }

    matched, score = best_profile([0.99, 0.01], [close, far], samples)
    assert matched.name == "Known"
    assert score > 0.9

    matched, score = best_profile([0.7, 0.7], [close, far], samples)
    assert matched is None
    assert score is None


def test_profile_quality_grows_with_sample_bank():
    assert profile_quality(1) == "starter"
    assert profile_quality(2) == "building"
    assert profile_quality(3) == "good"
    assert profile_quality(5) == "strong"


def test_speaker_admin_requires_parent_pin(monkeypatch):
    from app.main import app
    from app import speaker_admin

    monkeypatch.setattr(speaker_admin.settings, "parent_pin", "2468")

    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
        assert login.status_code == 200
        denied = client.get("/api/admin/speakers/profiles")
        assert denied.status_code == 401

        allowed = client.get(
            "/api/admin/speakers/profiles",
            headers={"X-Parent-Pin": "2468"},
        )
        assert allowed.status_code == 200


def test_remembered_speaker_collects_multiple_samples_and_rejects_short_speech(monkeypatch):
    from app.main import app
    from app import speaker_admin
    from app.db import SessionLocal
    from app.models import Recording, SpeakerAnalysis, SpeakerDetection, SpeakerTurn, User

    monkeypatch.setattr(speaker_admin.settings, "parent_pin", "")

    async def seed_detection(seconds: float, embedding: list[float]):
        async with SessionLocal() as db:
            user = (await db.execute(select(User).where(User.username == "local"))).scalar_one()
            recording = Recording(
                user_id=user.id,
                status="ready",
                transcript_original="speaker sample",
                duration_seconds=seconds,
                title="Voice sample source",
            )
            db.add(recording)
            await db.flush()
            analysis = SpeakerAnalysis(
                recording_id=recording.id,
                status="completed",
                speaker_count=1,
            )
            db.add(analysis)
            await db.flush()
            detection = SpeakerDetection(
                analysis_id=analysis.id,
                speaker_key="SPEAKER_00",
                person_index=1,
                display_name="Person 1",
                embedding=embedding,
            )
            db.add(detection)
            await db.flush()
            db.add(
                SpeakerTurn(
                    analysis_id=analysis.id,
                    detection_id=detection.id,
                    start_seconds=0.0,
                    end_seconds=seconds,
                    text="sample speech",
                )
            )
            await db.commit()
            return str(analysis.id), detection.speaker_key

    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
        assert login.status_code == 200
        short_analysis, short_key = asyncio.run(seed_detection(1.5, [1.0, 0.0]))
        short = client.post(
            f"/api/admin/speakers/analyses/{short_analysis}/detections/{short_key}/remember",
            json={"name": "Test Speaker"},
        )
        assert short.status_code == 400
        assert "at least 3 seconds" in short.json()["detail"]

        first_analysis, first_key = asyncio.run(seed_detection(4.2, [1.0, 0.0]))
        first = client.post(
            f"/api/admin/speakers/analyses/{first_analysis}/detections/{first_key}/remember",
            json={"name": "Test Speaker"},
        )
        assert first.status_code == 200
        assert first.json()["sample_count"] == 1

        second_analysis, second_key = asyncio.run(seed_detection(5.1, [0.98, 0.02]))
        second = client.post(
            f"/api/admin/speakers/analyses/{second_analysis}/detections/{second_key}/remember",
            json={"name": "Test Speaker"},
        )
        assert second.status_code == 200
        assert second.json()["sample_count"] == 2
        assert second.json()["profile_quality"] == "building"

        profiles = client.get("/api/admin/speakers/profiles").json()
        profile_row = next(row for row in profiles if row["name"] == "Test Speaker")
        assert profile_row["sample_count"] == 2
        assert len(profile_row["samples"]) == 2

        sample_id = profile_row["samples"][0]["id"]
        removed = client.delete(
            f"/api/admin/speakers/profiles/{profile_row['id']}/samples/{sample_id}"
        )
        assert removed.status_code == 204

        refreshed = client.get("/api/admin/speakers/profiles").json()
        profile_row = next(row for row in refreshed if row["name"] == "Test Speaker")
        assert profile_row["sample_count"] == 1



def test_recording_owner_can_reload_resolved_speaker_turns():
    from app.main import app
    from app.db import SessionLocal
    from app.models import SpeakerAnalysis, SpeakerDetection, SpeakerTurn

    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
        assert login.status_code == 200

        created = client.post("/api/recordings", json={"language": "en"}).json()
        recording_id = created["id"]
        finished = client.post(
            f"/api/recordings/{recording_id}/finish",
            json={
                "transcript": "Jack says hello. Paul answers.",
                "duration_seconds": 4.0,
            },
        )
        assert finished.status_code == 200

        async def seed_analysis():
            async with SessionLocal() as db:
                analysis = SpeakerAnalysis(
                    recording_id=uuid.UUID(recording_id),
                    status="completed",
                    speaker_count=2,
                )
                db.add(analysis)
                await db.flush()

                jack = SpeakerDetection(
                    analysis_id=analysis.id,
                    speaker_key="SPEAKER_00",
                    person_index=1,
                    display_name="Jack Clancy",
                    embedding=[1.0, 0.0],
                )
                paul = SpeakerDetection(
                    analysis_id=analysis.id,
                    speaker_key="SPEAKER_01",
                    person_index=2,
                    display_name="Paul Elswood",
                    embedding=[0.0, 1.0],
                )
                db.add_all([jack, paul])
                await db.flush()
                db.add_all([
                    SpeakerTurn(
                        analysis_id=analysis.id,
                        detection_id=jack.id,
                        start_seconds=0.0,
                        end_seconds=2.0,
                        text="Jack says hello.",
                    ),
                    SpeakerTurn(
                        analysis_id=analysis.id,
                        detection_id=paul.id,
                        start_seconds=2.0,
                        end_seconds=4.0,
                        text="Paul answers.",
                    ),
                ])
                await db.commit()

        asyncio.run(seed_analysis())

        response = client.get(f"/api/recordings/{recording_id}/speaker-turns")
        assert response.status_code == 200
        payload = response.json()
        assert payload["speaker_count"] == 2
        assert [turn["display_name"] for turn in payload["turns"]] == [
            "Jack Clancy",
            "Paul Elswood",
        ]
        assert [turn["text"] for turn in payload["turns"]] == [
            "Jack says hello.",
            "Paul answers.",
        ]
