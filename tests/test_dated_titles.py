import re
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.services.titles import dated_title, renamed_title


def test_dated_title_uses_local_date_and_respects_existing_dates():
    # 23:30 UTC on 30 Sep is already 1 Oct in London (BST, UTC+1)
    late = datetime(2026, 9, 30, 23, 30, tzinfo=timezone.utc)
    assert dated_title("Budget review", late) == "20261001 Budget review"
    assert dated_title("20250101 Kept as typed", late) == "20250101 Kept as typed"
    assert dated_title("New recording", late) == "New recording"  # placeholder, replaced later
    assert dated_title("   ", late) == "   "
    assert dated_title(None, late) is None
    # a title that merely starts with digits is not a date prefix
    assert dated_title("2026 plan", late) == "20261001 2026 plan"


def test_rename_keeps_the_date_unless_a_new_one_is_typed():
    assert renamed_title("Q4 budget", "20260930 so um let's start") == "20260930 Q4 budget"
    assert renamed_title("20261002 Moved", "20260930 so um") == "20261002 Moved"
    # older recordings without a prefix are not changed by a rename
    assert renamed_title("Old meeting", "Old auto title") == "Old meeting"


def test_new_recordings_get_dated_titles():
    from app.main import app

    with TestClient(app) as client:
        client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})

        auto = client.post("/api/recordings", json={"language": "en"}).json()
        finished = client.post(
            f"/api/recordings/{auto['id']}/finish",
            json={"transcript": "Right, let's go through the budget line by line today.", "duration_seconds": 5},
        ).json()
        assert re.fullmatch(r"\d{8} Right, let's go through the budget line by line…", finished["title"])

        typed = client.post("/api/recordings", json={"language": "en", "title": "Standup"}).json()
        assert re.fullmatch(r"\d{8} Standup", typed["title"])
        client.post(f"/api/recordings/{typed['id']}/finish", json={"transcript": "Standup notes.", "duration_seconds": 1})

        # clearing the title regenerates it from the transcript, dated again
        cleared = client.patch(f"/api/recordings/{auto['id']}", json={"title": ""}).json()
        assert re.fullmatch(r"\d{8} Right, let's go.*", cleared["title"])

        # empty transcript: placeholder until there is text, then a dated title
        empty = client.post("/api/recordings", json={"language": "en"}).json()
        placeholder = client.post(f"/api/recordings/{empty['id']}/finish", json={"transcript": "", "duration_seconds": 1}).json()
        assert placeholder["title"] == "New recording"
        edited = client.patch(
            f"/api/recordings/{empty['id']}", json={"transcript_edited": "Notes typed in afterwards."}
        ).json()
        assert re.fullmatch(r"\d{8} Notes typed in afterwards\.", edited["title"])
