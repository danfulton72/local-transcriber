#!/usr/bin/env python3
"""Detach Talk to Type's managed integration from the legacy AI stack."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def remove_override(ai_home: Path, repo: Path) -> None:
    target = ai_home / "compose.override.yml"
    expected = (repo / "deploy" / "ai-stack" / "compose.override.yml").resolve()

    if target.is_symlink():
        if target.resolve() == expected:
            target.unlink()
            print(f"compose override: removed {target}")
        else:
            fail(f"{target} points to {target.resolve()}, not the Talk to Type overlay")
        return

    if target.exists():
        content = target.read_text(encoding="utf-8", errors="replace")
        if "Talk to Type integration for the existing ai-stack" in content:
            target.unlink()
            print(f"compose override: removed managed file {target}")
        else:
            fail(
                f"{target} exists but is not managed by Talk to Type; "
                "remove the Talk to Type services manually."
            )
    else:
        print("compose override: already absent")


def unpatch_t4(path: Path) -> None:
    if not path.exists():
        print(f"t4.yaml: {path} does not exist; skipped")
        return

    original = path.read_text(encoding="utf-8")
    text = original

    text = re.sub(
        r"\n?\s*# BEGIN TALK_TO_TYPE_SPEAKER_AUTO\n.*?"
        r"# END TALK_TO_TYPE_SPEAKER_AUTO\n?",
        "\n",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"^\s*s:\s*speaker_auto\s*(?:#.*)?\n",
        "",
        text,
        flags=re.MULTILINE,
    )
    text = re.sub(
        r'^\s*speaker_only:\s*"s"\s*\n',
        "",
        text,
        flags=re.MULTILINE,
    )
    text = re.sub(r"\n{3,}", "\n\n", text).rstrip() + "\n"

    if text == original:
        print("t4.yaml: no Talk to Type reservation found")
        return

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.before-talk-to-type-detach-{timestamp}")
    shutil.copy2(path, backup)
    path.write_text(text, encoding="utf-8")
    print(f"t4.yaml: removed Talk to Type reservation; backup saved as {backup}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ai-home", default=os.getenv("AI_HOME", "/home/dan/ai"))
    parser.add_argument(
        "--repo",
        default=os.getenv(
            "LOCAL_TRANSCRIBER_DIR",
            str(Path(__file__).resolve().parents[2]),
        ),
    )
    args = parser.parse_args()

    ai_home = Path(args.ai_home).expanduser().resolve()
    repo = Path(args.repo).expanduser().resolve()

    if not ai_home.is_dir():
        fail(f"AI_HOME does not exist: {ai_home}")

    remove_override(ai_home, repo)
    unpatch_t4(ai_home / "llama-swap" / "t4.yaml")

    print()
    print("Legacy AI-stack integration detached.")
    print("This script does not stop or remove running containers.")
    print("Before moving the repository, remove the old Talk to Type containers with:")
    print(
        "  docker compose -f /home/dan/ai/docker-compose.yaml "
        "-f /home/dan/ai/compose.override.yml "
        "rm -sf local-transcriber speaker-analyzer"
    )
    print("If the override has already been removed, use docker rm -f for those two containers only.")


if __name__ == "__main__":
    main()
