import os
import sqlite3
import subprocess
import uuid


def test_upgrade_from_released_07_to_head(tmp_path):
    database = tmp_path / "upgrade-from-07.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{database}"

    subprocess.run(
        ["alembic", "upgrade", "20260924_07"],
        check=True,
        env=env,
    )
    subprocess.run(
        ["alembic", "upgrade", "head"],
        check=True,
        env=env,
    )

    with sqlite3.connect(database) as connection:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(speaker_turns)")
        }
        user_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(users)")
        }
        revision = connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone()[0]

    assert "identity_override_name" in columns
    assert "is_admin" in user_columns
    assert revision == "20260924_09"



def test_existing_oldest_user_becomes_initial_admin(tmp_path):
    database = tmp_path / "upgrade-admin.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{database}"

    subprocess.run(
        ["alembic", "upgrade", "20260924_08"],
        check=True,
        env=env,
    )

    first_id = uuid.uuid4().hex
    second_id = uuid.uuid4().hex
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            INSERT INTO users
              (id, username, display_name, password_hash, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, TRUE, ?, ?)
            """,
            (
                first_id,
                "first-user",
                "First user",
                "placeholder",
                "2026-09-23 10:00:00",
                "2026-09-23 10:00:00",
            ),
        )
        connection.execute(
            """
            INSERT INTO users
              (id, username, display_name, password_hash, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, TRUE, ?, ?)
            """,
            (
                second_id,
                "second-user",
                "Second user",
                "placeholder",
                "2026-09-23 11:00:00",
                "2026-09-23 11:00:00",
            ),
        )
        connection.commit()

    subprocess.run(
        ["alembic", "upgrade", "head"],
        check=True,
        env=env,
    )

    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT username, is_admin FROM users ORDER BY created_at ASC"
        ).fetchall()

    assert rows == [("first-user", 1), ("second-user", 0)]
