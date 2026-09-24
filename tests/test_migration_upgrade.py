import os
import sqlite3
import subprocess


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
