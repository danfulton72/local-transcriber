#!/usr/bin/env python3
"""Detach Talk to Type's managed integration from the legacy AI stack."""

from __future__ import annotations

import argparse
import datetime as dt
import os
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
    lines = original.splitlines()

    cleaned: list[str] = []
    inside_block = False
    for line in lines:
        stripped = line.strip()
        if stripped == "# BEGIN TALK_TO_TYPE_SPEAKER_AUTO":
            inside_block = True
            continue
        if stripped == "# END TALK_TO_TYPE_SPEAKER_AUTO":
            inside_block = False
            continue
        if inside_block:
            continue
        if stripped.startswith("s: speaker_auto"):
            continue
        if stripped == 'speaker_only: "s"':
            continue
        cleaned.append(line)

    text = "\n".join(cleaned)
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    text = text.rstrip() + "\n"

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
    print("The old local-transcriber and speaker-analyzer containers should be stopped")
    print("and removed before running this detach step, as documented in deploy/voice-stack/README.md.")


if __name__ == "__main__":
    main()
