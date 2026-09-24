import uuid

from fastapi.testclient import TestClient

from app.main import app


def login(client: TestClient, username: str, password: str):
    response = client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200
    return response.json()["user"]


def test_login_required_and_users_are_isolated():
    suffix = uuid.uuid4().hex[:8]
    second_username = f"second-{suffix}"
    second_password = "second-password-123"

    with TestClient(app) as first:
        unauthenticated = first.get("/api/recordings")
        assert unauthenticated.status_code == 401

        default_user = login(first, "local", "change-me-now")
        assert default_user["username"] == "local"
        assert default_user["is_admin"] is True

        created_user = first.post(
            "/api/admin/users",
            json={
                "username": second_username,
                "display_name": "Second user",
                "password": second_password,
            },
        )
        assert created_user.status_code == 201

        own_recording = first.post("/api/recordings", json={"language": "en"}).json()
        first.post(
            f"/api/recordings/{own_recording['id']}/finish",
            json={"transcript": "Only the first user should see this.", "duration_seconds": 2.0},
        )

        first.post("/api/auth/logout")

        second_user = login(first, second_username, second_password)
        assert second_user["username"] == second_username

        listing = first.get("/api/recordings")
        assert listing.status_code == 200
        assert all(row["id"] != own_recording["id"] for row in listing.json())

        forbidden_by_ownership = first.get(f"/api/recordings/{own_recording['id']}")
        assert forbidden_by_ownership.status_code == 404

        second_recording = first.post("/api/recordings", json={"language": "en"}).json()
        first.post(
            f"/api/recordings/{second_recording['id']}/finish",
            json={"transcript": "This belongs to the second user.", "duration_seconds": 3.0},
        )

        progress = first.get("/api/progress")
        assert progress.status_code == 403

        admin_users = first.get("/api/admin/users")
        assert admin_users.status_code == 403

        first.post("/api/auth/logout")
        login(first, "local", "change-me-now")
        cross_user = first.get(f"/api/recordings/{second_recording['id']}")
        assert cross_user.status_code == 404


def test_parent_can_reset_password_and_old_session_is_invalidated():
    suffix = uuid.uuid4().hex[:8]
    username = f"reset-{suffix}"

    with TestClient(app) as parent:
        login(parent, "local", "change-me-now")
        created = parent.post(
            "/api/admin/users",
            json={
                "username": username,
                "display_name": "Reset test",
                "password": "original-password",
            },
        )
        assert created.status_code == 201
        user_id = created.json()["id"]

        with TestClient(app) as child:
            login(child, username, "original-password")
            assert child.get("/api/recordings").status_code == 200

            reset = parent.patch(
                f"/api/admin/users/{user_id}",
                json={"password": "replacement-password"},
            )
            assert reset.status_code == 200

            assert child.get("/api/recordings").status_code == 401

            old_password = child.post(
                "/api/auth/login",
                json={"username": username, "password": "original-password"},
            )
            assert old_password.status_code == 401

            login(child, username, "replacement-password")
            assert child.get("/api/recordings").status_code == 200



def test_admin_can_assign_admin_permission():
    suffix = uuid.uuid4().hex[:8]
    username = f"admin-{suffix}"
    password = "admin-password-123"

    with TestClient(app) as client:
        owner = login(client, "local", "change-me-now")
        assert owner["is_admin"] is True

        created = client.post(
            "/api/admin/users",
            json={
                "username": username,
                "display_name": "Second admin",
                "password": password,
                "is_admin": True,
            },
        )
        assert created.status_code == 201
        assert created.json()["is_admin"] is True

        client.post("/api/auth/logout")
        second = login(client, username, password)
        assert second["is_admin"] is True
        assert client.get("/api/progress").status_code == 200
        assert client.get("/api/admin/status").status_code == 200



def test_recording_title_can_be_renamed():
    suffix = uuid.uuid4().hex[:8]

    with TestClient(app) as client:
        login(client, "local", "change-me-now")
        created = client.post("/api/recordings", json={"language": "en"}).json()
        recording_id = created["id"]
        finished = client.post(
            f"/api/recordings/{recording_id}/finish",
            json={
                "transcript": "A short recording that needs a clearer title.",
                "duration_seconds": 2.0,
            },
        )
        assert finished.status_code == 200

        new_title = f"Renamed conversation {suffix}"
        renamed = client.patch(
            f"/api/recordings/{recording_id}",
            json={"title": new_title},
        )
        assert renamed.status_code == 200
        assert renamed.json()["title"] == new_title

        reloaded = client.get(f"/api/recordings/{recording_id}")
        assert reloaded.status_code == 200
        assert reloaded.json()["title"] == new_title
