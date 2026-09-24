import asyncio
import io
import wave
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


def make_test_wav(seconds: float = 4.0, sample_rate: int = 8000) -> bytes:
    frames = int(seconds * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(b"\x00\x00" * frames)
    return buffer.getvalue()


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

        uploaded = client.post(
            f"/api/recordings/{recording_id}/audio",
            files={"file": ("conversation.wav", make_test_wav(), "audio/wav")},
            data={"duration_seconds": "4.0"},
        )
        assert uploaded.status_code == 200

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
                        end_seconds=3.2,
                        text="Jack says hello.",
                    ),
                    SpeakerTurn(
                        analysis_id=analysis.id,
                        detection_id=paul.id,
                        start_seconds=3.2,
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

        preview = client.get(
            f"/api/admin/speakers/analyses/{payload['analysis_id']}/detections/SPEAKER_00/sample-audio"
        )
        assert preview.status_code == 200
        assert preview.headers["content-type"].startswith("audio/wav")
        assert len(preview.content) > 44
        assert float(preview.headers["x-clip-end"]) > float(preview.headers["x-clip-start"])

        remembered = client.post(
            f"/api/admin/speakers/analyses/{payload['analysis_id']}/detections/SPEAKER_00/remember",
            json={"name": "Jack Clancy"},
        )
        assert remembered.status_code == 200

        profiles = client.get("/api/admin/speakers/profiles").json()
        jack_profile = next(row for row in profiles if row["name"] == "Jack Clancy")
        saved_sample = jack_profile["samples"][0]
        assert saved_sample["can_preview"] is True
        assert saved_sample["preview_seconds"] > 0

        remembered_preview = client.get(
            f"/api/admin/speakers/profiles/{jack_profile['id']}/samples/{saved_sample['id']}/sample-audio"
        )
        assert remembered_preview.status_code == 200
        assert remembered_preview.headers["content-type"].startswith("audio/wav")
        assert len(remembered_preview.content) > 44

        second_username = "speaker-private-" + uuid.uuid4().hex[:8]
        second_password = "speaker-private-password"
        created_user = client.post(
            "/api/admin/users",
            json={
                "username": second_username,
                "display_name": "Second speaker user",
                "password": second_password,
            },
        )
        assert created_user.status_code == 201

        client.post("/api/auth/logout")
        login_second = client.post(
            "/api/auth/login",
            json={"username": second_username, "password": second_password},
        )
        assert login_second.status_code == 200

        shared_profiles = client.get("/api/admin/speakers/profiles").json()
        shared_jack = next(row for row in shared_profiles if row["name"] == "Jack Clancy")
        shared_sample = next(row for row in shared_jack["samples"] if row["id"] == saved_sample["id"])
        assert shared_sample["source_recording_title"] == "Shared voice sample"
        assert shared_sample["can_preview"] is False

        blocked_preview = client.get(
            f"/api/admin/speakers/profiles/{jack_profile['id']}/samples/{saved_sample['id']}/sample-audio"
        )
        assert blocked_preview.status_code == 404

        client.post("/api/auth/logout")
        relogin = client.post(
            "/api/auth/login",
            json={"username": "local", "password": "change-me-now"},
        )
        assert relogin.status_code == 200

        first_turn = payload["turns"][0]
        edited = client.patch(
            f"/api/recordings/{recording_id}/speaker-turns/{first_turn['id']}",
            json={"text": "Jack says hello clearly."},
        )
        assert edited.status_code == 200
        assert edited.json()["text"] == "Jack says hello clearly."
        assert edited.json()["original_text"] == "Jack says hello."
        assert edited.json()["edited"] is True
        assert edited.json()["transcript"] == "Jack says hello clearly. Paul answers."

        reloaded = client.get(f"/api/recordings/{recording_id}/speaker-turns").json()
        assert reloaded["turns"][0]["text"] == "Jack says hello clearly."
        assert reloaded["turns"][0]["original_text"] == "Jack says hello."
        assert reloaded["turns"][0]["edited"] is True

        recording = client.get(f"/api/recordings/{recording_id}").json()
        assert recording["transcript_original"] == "Jack says hello. Paul answers."
        assert recording["transcript_edited"] == "Jack says hello clearly. Paul answers."


def test_speaker_identity_corrections_create_private_retraining_samples(monkeypatch):
    from app.main import app
    from app import speaker_admin
    from app.db import SessionLocal
    from app.models import (
        Recording,
        SpeakerAnalysis,
        SpeakerDetection,
        SpeakerProfile,
        SpeakerTurn,
    )

    monkeypatch.setattr(speaker_admin.settings, "parent_pin", "")
    suffix = uuid.uuid4().hex[:8]
    target_name = f"Correct Speaker {suffix}"

    with TestClient(app) as client:
        login = client.post(
            "/api/auth/login",
            json={"username": "local", "password": "change-me-now"},
        )
        assert login.status_code == 200

        created = client.post("/api/recordings", json={"language": "en"}).json()
        recording_id = created["id"]
        finished = client.post(
            f"/api/recordings/{recording_id}/finish",
            json={"transcript": "First turn. Second turn.", "duration_seconds": 6.0},
        )
        assert finished.status_code == 200
        uploaded = client.post(
            f"/api/recordings/{recording_id}/audio",
            files={"file": ("conversation.wav", make_test_wav(6.0), "audio/wav")},
            data={"duration_seconds": "6.0"},
        )
        assert uploaded.status_code == 200

        async def seed():
            async with SessionLocal() as db:
                wrong_profile = SpeakerProfile(
                    name=f"Wrong Speaker {suffix}",
                    embedding=[1.0, 0.0],
                    sample_count=1,
                )
                correct_profile = SpeakerProfile(
                    name=target_name,
                    embedding=[0.0, 1.0],
                    sample_count=1,
                )
                db.add_all([wrong_profile, correct_profile])
                await db.flush()

                analysis = SpeakerAnalysis(
                    recording_id=uuid.UUID(recording_id),
                    status="completed",
                    speaker_count=1,
                )
                db.add(analysis)
                await db.flush()

                detection = SpeakerDetection(
                    analysis_id=analysis.id,
                    speaker_key="SPEAKER_00",
                    person_index=1,
                    display_name=wrong_profile.name,
                    embedding=[1.0, 0.0],
                    profile_id=wrong_profile.id,
                    match_score=0.91,
                )
                db.add(detection)
                await db.flush()

                first = SpeakerTurn(
                    analysis_id=analysis.id,
                    detection_id=detection.id,
                    start_seconds=0.0,
                    end_seconds=3.0,
                    text="First turn.",
                )
                second = SpeakerTurn(
                    analysis_id=analysis.id,
                    detection_id=detection.id,
                    start_seconds=3.0,
                    end_seconds=6.0,
                    text="Second turn.",
                )
                db.add_all([first, second])
                await db.commit()
                return (
                    str(analysis.id),
                    str(first.id),
                    str(second.id),
                    str(correct_profile.id),
                    wrong_profile.name,
                )

        analysis_id, first_turn_id, second_turn_id, target_profile_id, wrong_name = asyncio.run(seed())

        corrected = client.patch(
            f"/api/admin/speakers/analyses/{analysis_id}/turns/{first_turn_id}/identity",
            json={"target_profile_id": target_profile_id, "scope": "detection"},
        )
        assert corrected.status_code == 200
        turns = corrected.json()["turns"]
        assert [row["display_name"] for row in turns] == [target_name, target_name]
        assert all(row["identity_corrected"] for row in turns)
        assert all(row["detected_display_name"] == wrong_name for row in turns)

        reopened = client.get(f"/api/recordings/{recording_id}/speaker-turns")
        assert reopened.status_code == 200
        assert [row["display_name"] for row in reopened.json()["turns"]] == [
            target_name,
            target_name,
        ]

        relabels = client.get("/api/admin/speakers/relabels")
        assert relabels.status_code == 200
        rows = [
            row for row in relabels.json()
            if row["analysis_id"] == analysis_id
        ]
        assert len(rows) == 2
        assert all(row["original_display_name"] == wrong_name for row in rows)
        assert all(row["corrected_display_name"] == target_name for row in rows)
        assert all(row["training_ready"] is True for row in rows)

        sample = next(row for row in rows if row["turn_id"] == first_turn_id)
        preview = client.get(f"/api/admin/speakers/relabels/{sample['id']}/sample-audio")
        assert preview.status_code == 200
        assert preview.headers["content-type"].startswith("audio/wav")

        approved = client.patch(
            f"/api/admin/speakers/relabels/{sample['id']}",
            json={"status": "approved"},
        )
        assert approved.status_code == 200
        assert approved.json()["status"] == "approved"

        second_username = f"relabel-private-{suffix}"
        second_password = "relabel-private-password"
        created_user = client.post(
            "/api/admin/users",
            json={
                "username": second_username,
                "display_name": "Relabel privacy user",
                "password": second_password,
            },
        )
        assert created_user.status_code == 201
        client.post("/api/auth/logout")
        second_login = client.post(
            "/api/auth/login",
            json={"username": second_username, "password": second_password},
        )
        assert second_login.status_code == 200

        private_list = client.get("/api/admin/speakers/relabels")
        assert private_list.status_code == 200
        assert all(row["analysis_id"] != analysis_id for row in private_list.json())
        blocked_audio = client.get(f"/api/admin/speakers/relabels/{sample['id']}/sample-audio")
        assert blocked_audio.status_code == 404
        blocked_undo = client.delete(
            f"/api/admin/speakers/relabels/{sample['id']}/correction"
        )
        assert blocked_undo.status_code == 404

        client.post("/api/auth/logout")
        relogin = client.post(
            "/api/auth/login",
            json={"username": "local", "password": "change-me-now"},
        )
        assert relogin.status_code == 200

        reset = client.patch(
            f"/api/admin/speakers/analyses/{analysis_id}/turns/{second_turn_id}/identity",
            json={"clear": True, "scope": "turn"},
        )
        assert reset.status_code == 200
        reset_turns = {row["id"]: row for row in reset.json()["turns"]}
        assert reset_turns[second_turn_id]["display_name"] == wrong_name
        assert reset_turns[second_turn_id]["identity_corrected"] is False
        assert reset_turns[first_turn_id]["display_name"] == target_name

        undo = client.delete(
            f"/api/admin/speakers/relabels/{sample['id']}/correction"
        )
        assert undo.status_code == 204
        final_turns = client.get(f"/api/recordings/{recording_id}/speaker-turns").json()["turns"]
        assert [row["display_name"] for row in final_turns] == [wrong_name, wrong_name]

        inline = client.patch(
            f"/api/recordings/{recording_id}/speaker-turns/{first_turn_id}/identity",
            json={"name": "Corrected from My words", "scope": "turn"},
        )
        assert inline.status_code == 200
        inline_turns = {row["id"]: row for row in inline.json()["turns"]}
        assert inline_turns[first_turn_id]["display_name"] == "Corrected from My words"
        assert inline_turns[first_turn_id]["identity_corrected"] is True
        assert inline_turns[second_turn_id]["display_name"] == wrong_name

        inline_relabels = client.get("/api/admin/speakers/relabels").json()
        inline_sample = next(
            row for row in inline_relabels
            if row["turn_id"] == first_turn_id
        )
        assert inline_sample["corrected_display_name"] == "Corrected from My words"
        assert inline_sample["training_ready"] is True

        inline_all = client.patch(
            f"/api/recordings/{recording_id}/speaker-turns/{first_turn_id}/identity",
            json={"name": target_name, "scope": "detection"},
        )
        assert inline_all.status_code == 200
        assert [row["display_name"] for row in inline_all.json()["turns"]] == [
            target_name,
            target_name,
        ]

        inline_unknown = client.patch(
            f"/api/recordings/{recording_id}/speaker-turns/{first_turn_id}/identity",
            json={"unknown": True, "scope": "turn"},
        )
        assert inline_unknown.status_code == 200
        unknown_turn = next(
            row for row in inline_unknown.json()["turns"]
            if row["id"] == first_turn_id
        )
        assert unknown_turn["display_name"] == "Unknown"
