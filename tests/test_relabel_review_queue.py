import asyncio
from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select


def seed_relabels() -> dict[str, str]:
    """Three relabelled samples: pending (Sep 29), approved (Sep 20), excluded (Sep 10)."""
    from app.db import SessionLocal
    from app.models import (
        Recording, SpeakerAnalysis, SpeakerDetection, SpeakerRelabelSample, SpeakerTurn, User,
    )

    async def seed():
        async with SessionLocal() as db:
            user = (await db.execute(select(User).where(User.username == "local"))).scalar_one()
            recording = Recording(user_id=user.id, status="ready", title="Relabel queue", transcript_original="x")
            db.add(recording)
            await db.flush()
            analysis = SpeakerAnalysis(recording_id=recording.id, status="completed", speaker_count=1)
            db.add(analysis)
            await db.flush()
            detection = SpeakerDetection(
                analysis_id=analysis.id, speaker_key="S0", person_index=1,
                display_name="Person 1", embedding=[1.0, 0.0],
            )
            db.add(detection)
            await db.flush()
            ids = {}
            for index, (status, day) in enumerate([("pending", 29), ("approved", 20), ("excluded", 10)]):
                turn = SpeakerTurn(
                    analysis_id=analysis.id, detection_id=detection.id,
                    start_seconds=float(index * 5), end_seconds=float(index * 5 + 4), text=status,
                )
                db.add(turn)
                await db.flush()
                created = datetime(2026, 9, day, 12, 0, tzinfo=timezone.utc)
                sample = SpeakerRelabelSample(
                    recording_id=recording.id, analysis_id=analysis.id, turn_id=turn.id,
                    original_display_name="Person 1", corrected_display_name="Sam",
                    status=status, created_at=created,
                    reviewed_at=None if status == "pending" else created,
                )
                db.add(sample)
                await db.flush()
                ids[status] = str(sample.id)
            await db.commit()
            return ids

    return asyncio.run(seed())


def test_relabel_queue_history_and_date_filters():
    from app.main import app

    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"}).status_code == 200
        before = client.get("/api/admin/speakers/relabels/summary").json()
        ids = seed_relabels()

        summary = client.get("/api/admin/speakers/relabels/summary").json()
        assert summary["pending"] == before["pending"] + 1
        assert summary["approved"] == before["approved"] + 1
        assert summary["excluded"] == before["excluded"] + 1
        assert summary["total"] == before["total"] + 3

        def listed(query: str = "") -> set[str]:
            response = client.get("/api/admin/speakers/relabels" + query)
            assert response.status_code == 200, response.text
            return {row["id"] for row in response.json()} & set(ids.values())

        # Unfiltered keeps the old behaviour: everything
        assert listed() == set(ids.values())
        # Review queue
        assert listed("?status=pending") == {ids["pending"]}
        # History narrowed by status
        assert listed("?status=reviewed") == {ids["approved"], ids["excluded"]}
        assert listed("?status=excluded") == {ids["excluded"]}
        # Date range (inclusive, timezone-aware)
        assert listed("?created_from=2026-09-15T00:00:00%2B00:00") == {ids["pending"], ids["approved"]}
        assert listed(
            "?created_from=2026-09-15T00:00:00%2B00:00&created_to=2026-09-25T23:59:59%2B00:00"
        ) == {ids["approved"]}
        assert listed("?created_to=2026-09-10T23:59:59%2B00:00&status=excluded") == {ids["excluded"]}
        assert client.get("/api/admin/speakers/relabels?status=bogus").status_code == 422

        # Reviewing moves a sample out of the queue; "Back to review" returns it
        client.patch(f"/api/admin/speakers/relabels/{ids['pending']}", json={"status": "approved"})
        assert ids["pending"] not in listed("?status=pending")
        client.patch(f"/api/admin/speakers/relabels/{ids['pending']}", json={"status": "pending"})
        assert ids["pending"] in listed("?status=pending")
