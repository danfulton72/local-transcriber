import asyncio
import json
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import settings
from app.services import llm as llm_module
from app.services import meeting_notes
from app.services import open_notebook as open_notebook_module
from app.services.llm import strip_thinking
from app.services.meeting_notes import (
    MeetingMeta,
    TranscriptLine,
    chunk_lines,
    format_line,
    generate_notes,
    merge_turns,
    plain_transcript_lines,
)


# ---------------------------------------------------------------- unit tests


def test_merge_turns_joins_consecutive_speakers_and_marks_unknown():
    lines = merge_turns([
        {"display_name": "Dan", "start_seconds": 0.0, "text": "Morning all."},
        {"display_name": "Dan", "start_seconds": 3.2, "text": "Let's start with the budget."},
        {"display_name": "Unknown", "start_seconds": 9.0, "text": "Sounds good."},
        {"display_name": "Sam", "start_seconds": 12.0, "text": "   "},
        {"display_name": "Sam", "start_seconds": 14.5, "text": "I'll send the figures by Friday."},
    ])
    assert [(line.speaker, line.start_seconds) for line in lines] == [
        ("Dan", 0.0),
        ("Unidentified", 9.0),
        ("Sam", 14.5),
    ]
    assert lines[0].text == "Morning all. Let's start with the budget."
    assert format_line(lines[2]) == "[00:00:14] Sam: I'll send the figures by Friday."


def test_chunk_lines_respects_budget_and_overlaps():
    lines = [TranscriptLine(float(i * 10), f"P{i % 3}", "word " * 60) for i in range(40)]
    chunks = chunk_lines(lines, max_tokens=500)
    assert len(chunks) > 3
    max_chars = int(500 * meeting_notes.CHARS_PER_TOKEN)
    for chunk in chunks:
        assert sum(len(format_line(line)) + 1 for line in chunk) <= max_chars
    # consecutive parts share their boundary lines
    assert chunks[1][0] is chunks[0][-2]
    # every original line is covered, in order
    seen = []
    for chunk in chunks:
        for line in chunk:
            if line not in seen:
                seen.append(line)
    assert seen == lines


def test_chunk_lines_splits_a_single_oversized_monologue():
    long_text = " ".join(f"Sentence number {i} is here." for i in range(400))
    chunks = chunk_lines([TranscriptLine(0.0, "Dan", long_text)], max_tokens=400)
    assert len(chunks) > 1
    assert all(line.speaker == "Dan" for chunk in chunks for line in chunk)


def test_plain_transcript_fallback_has_no_timestamps():
    lines = plain_transcript_lines("First point. Second point! " * 200)
    assert len(lines) > 1
    assert all(line.start_seconds is None and line.speaker == "Unidentified" for line in lines)
    assert not format_line(lines[0]).startswith("[")


def test_strip_thinking_removes_reasoning_blocks():
    assert strip_thinking("<think>hmm</think>\n## Summary\nDone") == "## Summary\nDone"
    assert strip_thinking("leaked reasoning</think>## Summary") == "## Summary"
    assert strip_thinking("## Summary") == "## Summary"


def test_generate_notes_runs_extract_then_organise(monkeypatch):
    calls: list[str] = []

    async def fake_chat(messages, max_tokens=None):
        user = messages[-1]["content"]
        if "<transcript>" in user:
            calls.append("extract")
            return "### Decisions\n- [00:00:00] Ship it (Dan)"
        if "<extractions>" in user and "Template:" in user:
            calls.append("organise")
            return "```markdown\n## Summary\nWe agreed to ship.\n\n## Decisions\n- Ship it\n```"
        calls.append("condense")
        return "### Decisions\n- merged"

    monkeypatch.setattr(meeting_notes.llm, "chat", fake_chat)
    monkeypatch.setattr(settings, "llm_chunk_tokens", 1000)
    monkeypatch.setattr(settings, "llm_context_tokens", 32768)

    lines = [TranscriptLine(float(i * 30), "Dan" if i % 2 else "Sam", "text " * 150) for i in range(20)]
    meta = MeetingMeta("Launch review", None, 1800.0, ["Dan", "Sam"], "rec-1")
    progress: list[str] = []

    async def record(stage):
        progress.append(stage)

    notes = asyncio.run(generate_notes(meta, lines, record))

    assert calls.count("extract") > 1
    assert calls[-1] == "organise"
    assert notes.startswith("# Launch review\n")
    assert "- **Identified attendees:** Dan, Sam" in notes
    assert "## Summary\nWe agreed to ship." in notes
    assert "```" not in notes
    assert progress[0].startswith("Extracting part 1 of")
    assert progress[-1] == "Organising notes"


# --------------------------------------------------------- integration tests


class FakeServices:
    """Records requests to llama-server and Open Notebook."""

    def __init__(self) -> None:
        self.llm_requests: list[dict] = []
        self.on_requests: list[tuple[str, str, dict | None]] = []
        self.counter = 0

    def llm(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "meeting-llm"}]})
        body = json.loads(request.content)
        self.llm_requests.append(body)
        user = body["messages"][-1]["content"]
        if "<transcript>" in user:
            content = "<think>private</think>### Action items\n- [00:00:04] Sam: send figures (due: Friday)"
        else:
            content = "## Summary\nBudget review.\n\n## Action items\n- [ ] **Sam** — send figures (due: Friday)"
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    def open_notebook(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.on_requests.append((request.method, request.url.path, body))
        assert request.headers.get("authorization") == "Bearer on-secret"
        if request.method == "GET" and request.url.path == "/api/notebooks":
            return httpx.Response(200, json=[
                {"id": "notebook:meetings", "name": "Meetings", "archived": False},
                {"id": "notebook:atlas", "name": "Atlas project", "archived": False},
                {"id": "notebook:old", "name": "Old", "archived": True},
            ])
        if request.method == "POST" and request.url.path == "/api/sources/json":
            self.counter += 1
            return httpx.Response(200, json={"id": f"source:s{self.counter}"})
        if request.method == "POST" and request.url.path == "/api/notes":
            self.counter += 1
            return httpx.Response(200, json={"id": f"note:n{self.counter}"})
        if request.method == "DELETE":
            return httpx.Response(200, json={"message": "deleted"})
        return httpx.Response(404, json={"detail": "not found"})


@pytest.fixture
def services(monkeypatch):
    fake = FakeServices()
    monkeypatch.setattr(settings, "llm_base_url", "http://llm.test/v1")
    monkeypatch.setattr(settings, "llm_model", "meeting-llm")
    monkeypatch.setattr(settings, "open_notebook_url", "http://on.test")
    monkeypatch.setattr(settings, "open_notebook_password", "on-secret")
    monkeypatch.setattr(settings, "open_notebook_notebook_id", "notebook:meetings")
    monkeypatch.setattr(llm_module, "http_transport", httpx.MockTransport(fake.llm))
    monkeypatch.setattr(open_notebook_module, "http_transport", httpx.MockTransport(fake.open_notebook))
    return fake


def login_admin(client: TestClient) -> None:
    response = client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
    assert response.status_code == 200


def seed_analysed_recording(title: str = "Budget review") -> tuple[str, str]:
    from app.db import SessionLocal
    from app.models import Recording, SpeakerAnalysis, SpeakerDetection, SpeakerTurn, User

    async def seed():
        async with SessionLocal() as db:
            user = (await db.execute(select(User).where(User.username == "local"))).scalar_one()
            recording = Recording(
                user_id=user.id,
                status="ready",
                title=title,
                transcript_original="Morning. I'll send the figures by Friday.",
                duration_seconds=65.0,
            )
            db.add(recording)
            await db.flush()
            analysis = SpeakerAnalysis(recording_id=recording.id, status="completed", speaker_count=2)
            db.add(analysis)
            await db.flush()
            dan = SpeakerDetection(
                analysis_id=analysis.id, speaker_key="SPEAKER_00", person_index=1,
                display_name="Dan", embedding=[1.0, 0.0],
            )
            other = SpeakerDetection(
                analysis_id=analysis.id, speaker_key="SPEAKER_01", person_index=2,
                display_name="Person 2", embedding=[0.0, 1.0],
            )
            db.add_all([dan, other])
            await db.flush()
            db.add_all([
                SpeakerTurn(analysis_id=analysis.id, detection_id=dan.id,
                            start_seconds=0.0, end_seconds=3.0, text="Morning."),
                SpeakerTurn(analysis_id=analysis.id, detection_id=other.id,
                            start_seconds=4.0, end_seconds=8.0, text="I'll send figures by Friday.",
                            identity_override_name="Sam"),
            ])
            await db.commit()
            return str(recording.id), str(analysis.id)

    return asyncio.run(seed())


def test_generate_and_export_meeting_notes_end_to_end(services):
    from app.main import app

    with TestClient(app) as client:
        login_admin(client)
        recording_id, analysis_id = seed_analysed_recording()

        status = client.get("/api/admin/meeting-notes/status").json()
        assert status["llm"]["reachable"] is True
        assert status["open_notebook"]["reachable"] is True

        # The export picker loads the live list (archived notebooks hidden, sorted)
        picker = client.get("/api/admin/meeting-notes/notebooks").json()
        assert picker["notebooks"] == [
            {"id": "notebook:atlas", "name": "Atlas project"},
            {"id": "notebook:meetings", "name": "Meetings"},
        ]
        assert picker["default_notebook_id"] == "notebook:meetings"

        assert client.get(f"/api/admin/meeting-notes/recordings/{recording_id}").json()["status"] == "none"

        started = client.post(
            f"/api/admin/meeting-notes/recordings/{recording_id}",
            json={"notebook_id": "notebook:atlas", "notebook_name": "Atlas project"},
        )
        assert started.status_code == 202, started.text
        assert started.json()["speaker_labelled"] is True

        result = client.get(f"/api/admin/meeting-notes/recordings/{recording_id}").json()
        assert result["status"] == "completed", result
        assert result["analysis_id"] == analysis_id
        assert result["open_notebook_notebook_id"] == "notebook:atlas"
        assert result["stage"] == "Exported to Open Notebook · Atlas project"
        assert result["open_notebook_source_id"] == "source:s1"
        assert result["open_notebook_note_id"] == "note:n2"
        assert result["notes_markdown"].startswith("# Budget review\n")
        assert "**Sam** — send figures" in result["notes_markdown"]

        # llama-server: thinking disabled, low temperature, speaker names used
        extract = services.llm_requests[0]
        assert extract["model"] == "meeting-llm"
        assert extract["chat_template_kwargs"] == {"enable_thinking": False}
        assert extract["temperature"] == settings.llm_temperature
        transcript_prompt = extract["messages"][-1]["content"]
        assert "[00:00:00] Dan: Morning." in transcript_prompt
        assert "[00:00:04] Sam: I'll send figures by Friday." in transcript_prompt
        assert "Identified attendees: Dan, Sam" in transcript_prompt

        # Open Notebook: transcript as an embedded text source + notes as a note
        posts = [(path, body) for method, path, body in services.on_requests if method == "POST"]
        source_body = dict(posts)["/api/sources/json"]
        assert source_body["type"] == "text"
        assert source_body["notebooks"] == ["notebook:atlas"]
        assert source_body["embed"] is True
        assert source_body["title"] == "Budget review — transcript"
        assert "[00:00:04] Sam: I'll send figures by Friday." in source_body["content"]
        note_body = dict(posts)["/api/notes"]
        assert note_body["notebook_id"] == "notebook:atlas"
        assert note_body["note_type"] == "ai"
        assert note_body["title"] == "Meeting notes — Budget review"

        # Re-export only: no LLM calls, old copies replaced rather than duplicated
        llm_calls = len(services.llm_requests)
        services.on_requests.clear()
        again = client.post(
            f"/api/admin/meeting-notes/recordings/{recording_id}",
            json={"regenerate_notes": False, "notebook_id": "notebook:meetings", "notebook_name": "Meetings"},
        )
        assert again.status_code == 202
        assert len(services.llm_requests) == llm_calls
        methods = [(method, path) for method, path, _ in services.on_requests]
        assert ("DELETE", "/api/sources/source:s1") in methods
        assert ("DELETE", "/api/notes/note:n2") in methods
        refreshed = client.get(f"/api/admin/meeting-notes/recordings/{recording_id}").json()
        assert refreshed["open_notebook_source_id"] == "source:s3"
        assert refreshed["open_notebook_notebook_id"] == "notebook:meetings"
        moved = [body for method, path, body in services.on_requests if path == "/api/sources/json"]
        assert moved[0]["notebooks"] == ["notebook:meetings"]

        download = client.get(f"/api/admin/meeting-notes/recordings/{recording_id}/notes.md")
        assert download.status_code == 200
        assert download.headers["content-type"].startswith("text/markdown")
        assert "Budget-review.md" in download.headers["content-disposition"]

        # Permanent delete removes the Open Notebook copies too
        services.on_requests.clear()
        assert client.delete(f"/api/recordings/{recording_id}").status_code == 204
        assert client.delete(f"/api/admin/recycle-bin/{recording_id}").status_code == 204
        methods = [(method, path) for method, path, _ in services.on_requests]
        assert ("DELETE", "/api/sources/source:s3") in methods
        assert ("DELETE", "/api/notes/note:n4") in methods


def test_notes_only_when_open_notebook_is_not_used(services, monkeypatch):
    from app.main import app

    monkeypatch.setattr(settings, "open_notebook_url", "")
    with TestClient(app) as client:
        login_admin(client)
        recording_id, _ = seed_analysed_recording("Notes only")

        refused = client.post(f"/api/admin/meeting-notes/recordings/{recording_id}", json={})
        assert refused.status_code == 400
        assert "OPEN_NOTEBOOK_URL" in refused.json()["detail"]
        assert client.get("/api/admin/meeting-notes/notebooks").status_code == 400

        started = client.post(
            f"/api/admin/meeting-notes/recordings/{recording_id}", json={"export": False}
        )
        assert started.status_code == 202
        result = client.get(f"/api/admin/meeting-notes/recordings/{recording_id}").json()
        assert result["status"] == "completed"
        assert result["stage"] == "Notes ready"
        assert result["open_notebook_source_id"] is None
        assert services.on_requests == []


def test_llm_failure_is_reported_and_releases_the_job(services, monkeypatch):
    from app.main import app

    def broken(request):
        return httpx.Response(503, text="model loading")

    monkeypatch.setattr(llm_module, "http_transport", httpx.MockTransport(broken))
    with TestClient(app) as client:
        login_admin(client)
        recording_id, _ = seed_analysed_recording("Broken model")
        client.post(f"/api/admin/meeting-notes/recordings/{recording_id}", json={"export": False})
        result = client.get(f"/api/admin/meeting-notes/recordings/{recording_id}").json()
        assert result["status"] == "error"
        assert "HTTP 503" in result["error"]

        # a failed job can be run again
        monkeypatch.setattr(llm_module, "http_transport", httpx.MockTransport(services.llm))
        retry = client.post(f"/api/admin/meeting-notes/recordings/{recording_id}", json={"export": False})
        assert retry.status_code == 202


def test_recording_without_speaker_analysis_uses_plain_transcript(services):
    from app.main import app

    with TestClient(app) as client:
        login_admin(client)
        created = client.post("/api/recordings", json={"language": "en"}).json()
        rid = created["id"]
        client.post(
            f"/api/recordings/{rid}/finish",
            json={"transcript": "We agreed the plan. Sam will book the room.", "duration_seconds": 30.0},
        )
        started = client.post(f"/api/admin/meeting-notes/recordings/{rid}", json={"export": False})
        assert started.status_code == 202
        assert started.json()["speaker_labelled"] is False
        result = client.get(f"/api/admin/meeting-notes/recordings/{rid}").json()
        assert result["status"] == "completed"
        prompt = services.llm_requests[0]["messages"][-1]["content"]
        assert "Unidentified: We agreed the plan." in prompt


def test_meeting_notes_require_admin():
    from app.main import app

    suffix = uuid.uuid4().hex[:8]
    with TestClient(app) as client:
        login_admin(client)
        created = client.post(
            "/api/admin/users",
            json={"username": f"notes-{suffix}", "display_name": "Notes", "password": "notes-password"},
        )
        assert created.status_code == 201
        client.post("/api/auth/logout")
        client.post("/api/auth/login", json={"username": f"notes-{suffix}", "password": "notes-password"})
        assert client.get("/api/admin/meeting-notes/status").status_code == 403


def test_notebook_list_reports_open_notebook_errors(services, monkeypatch):
    from app.main import app

    def unauthorised(request):
        return httpx.Response(401, json={"detail": "Invalid password"})

    monkeypatch.setattr(open_notebook_module, "http_transport", httpx.MockTransport(unauthorised))
    with TestClient(app) as client:
        login_admin(client)
        response = client.get("/api/admin/meeting-notes/notebooks")
        assert response.status_code == 502
        assert "OPEN_NOTEBOOK_PASSWORD" in response.json()["detail"]


def test_status_reports_unreachable_services_quickly(services, monkeypatch):
    import time
    from app.main import app

    def refused(request):
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setattr(llm_module, "http_transport", httpx.MockTransport(refused))
    monkeypatch.setattr(open_notebook_module, "http_transport", httpx.MockTransport(refused))
    with TestClient(app) as client:
        login_admin(client)
        started = time.perf_counter()
        status = client.get("/api/admin/meeting-notes/status").json()
        assert time.perf_counter() - started < 5
        assert status["llm"]["reachable"] is False
        assert "connection refused" in status["llm"]["error"]
        assert status["open_notebook"]["reachable"] is False


def test_app_shell_is_revalidated_but_api_is_untouched():
    from app.main import app

    with TestClient(app) as client:
        for path in ("/", "/app.js", "/styles.css"):
            assert client.get(path).headers.get("cache-control") == "no-cache", path
        login_admin(client)
        assert client.get("/api/recordings").headers.get("cache-control") != "no-cache"
