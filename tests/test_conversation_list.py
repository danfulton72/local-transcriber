import uuid

from fastapi.testclient import TestClient

from test_meeting_notes import login_admin, seed_analysed_recording, services  # noqa: F401 (fixture)


def test_conversation_list_hides_sent_and_sorts_by_title(services):  # noqa: F811
    from app.main import app

    tag = uuid.uuid4().hex[:6]
    with TestClient(app) as client:
        login_admin(client)
        sent_id, _ = seed_analysed_recording(f"b-{tag} sent")
        analysed_id, _ = seed_analysed_recording(f"C-{tag} analysed")
        # A recording with audio but no speaker analysis
        plain = client.post("/api/recordings", json={"language": "en"}).json()
        client.post(f"/api/recordings/{plain['id']}/finish", json={"transcript": "Plain.", "duration_seconds": 1})
        client.post(
            f"/api/recordings/{plain['id']}/audio",
            files={"file": ("a.wav", b"RIFF" + b"\x00" * 40, "audio/wav")},
            data={"duration_seconds": "1"},
        )
        client.patch(f"/api/recordings/{plain['id']}", json={"title": f"20200101 a-{tag} plain"})

        exported = client.post(
            f"/api/admin/meeting-notes/recordings/{sent_id}",
            json={"notebook_id": "notebook:meetings", "notebook_name": "Meetings"},
        )
        assert exported.status_code == 202

        def mine(view: str) -> list[dict]:
            rows = client.get(f"/api/admin/speakers/recordings?view={view}").json()
            return [row for row in rows if tag in row["title"]]

        todo = mine("todo")
        assert [row["id"] for row in todo] == [plain["id"], analysed_id]
        assert [row["analysed"] for row in todo] == [False, True]
        assert not any(row["open_notebook_exported"] for row in todo)

        everything = mine("all")
        # A–Z, case-insensitive: "20200101 a-…", "…b-… sent", "…C-… analysed"
        titles = [row["title"] for row in everything]
        assert titles == sorted(titles, key=str.casefold)
        assert {row["id"] for row in everything} == {plain["id"], sent_id, analysed_id}
        assert next(row for row in everything if row["id"] == sent_id)["open_notebook_exported"] is True

        assert client.get("/api/admin/speakers/recordings?view=bogus").status_code == 422


def test_voice_samples_report_their_source_detection():
    from app.main import app

    with TestClient(app) as client:
        login_admin(client)
        _, analysis_id = seed_analysed_recording(f"sample-source-{uuid.uuid4().hex[:6]}")
        analysis = client.get(f"/api/admin/speakers/analyses/{analysis_id}").json()
        dan = next(row for row in analysis["detections"] if row["display_name"] == "Dan")
        name = f"Dan-{uuid.uuid4().hex[:6]}"
        saved = client.post(
            f"/api/admin/speakers/analyses/{analysis_id}/detections/{dan['speaker_key']}/remember",
            json={"name": name},
        )
        assert saved.status_code == 200, saved.text
        profile = next(row for row in client.get("/api/admin/speakers/profiles").json() if row["name"] == name)
        assert [sample["source_detection_id"] for sample in profile["samples"]] == [dan["id"]]
