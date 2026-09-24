#!/usr/bin/env python3
"""Install Talk to Type as /home/dan/ai/local-transcriber.

The repository itself is the application directory. Source, .env, recordings
and runtime coordination files stay together under /home/dan/ai/local-transcriber.
Only large ML cache data lives in the shared /databases/aimodels store.

The script is idempotent and backs up llama-swap/t4.yaml before changing it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys
from pathlib import Path


SPEAKER_MODEL_BLOCK = r'''
  # BEGIN TALK_TO_TYPE_SPEAKER_AUTO
  "speaker_auto":
    name: "Talk to Type speaker analysis reservation"
    unlisted: true
    cmd: "tail -f /dev/null"
    proxy: "http://speaker-analyzer:9000"
    checkEndpoint: /healthz
    ttl: 0
    unloadTimeout: 7200
    concurrencyLimit: 1
    cmdStop: sh /scripts/speaker-stop.sh "${PID}"
  # END TALK_TO_TYPE_SPEAKER_AUTO
'''.strip("\n")


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def patch_t4_config(path: Path) -> Path | None:
    original = path.read_text(encoding="utf-8")
    text = original

    if "speaker_auto" not in text:
        var_anchor = "    e: qwen3.5-9b"
        if var_anchor not in text:
            fail("Could not find the qwen3.5-9b matrix variable in t4.yaml")
        text = text.replace(
            var_anchor,
            var_anchor + "\n    s: speaker_auto          # Talk to Type T4 reservation",
            1,
        )

        set_anchor = '    chat_plus_embed: "(b | c | d | e) & a"'
        if set_anchor not in text:
            fail("Could not find the chat_plus_embed matrix set in t4.yaml")
        text = text.replace(
            set_anchor,
            set_anchor + '\n    speaker_only: "s"',
            1,
        )

        lines = text.splitlines()
        try:
            models_index = next(i for i, line in enumerate(lines) if line.strip() == "models:")
        except StopIteration:
            fail("Could not find models: in t4.yaml")

        insert_at = len(lines)
        for index in range(models_index + 1, len(lines)):
            line = lines[index]
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line.startswith((" ", "\t")) and line.rstrip().endswith(":"):
                insert_at = index
                break

        block_lines = [""] + SPEAKER_MODEL_BLOCK.splitlines() + [""]
        lines[insert_at:insert_at] = block_lines
        text = "\n".join(lines).rstrip() + "\n"

    if text == original:
        print("t4.yaml: speaker_auto already installed")
        return None

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.before-talk-to-type-{timestamp}")
    shutil.copy2(path, backup)
    path.write_text(text, encoding="utf-8")
    print(f"t4.yaml: patched; backup saved as {backup}")
    return backup


def install_override(ai_home: Path, repo: Path) -> None:
    target = ai_home / "compose.override.yml"
    source = (repo / "deploy" / "ai-stack" / "compose.override.yml").resolve()

    if not source.exists():
        fail(f"Missing integration overlay: {source}")

    if target.is_symlink():
        if target.resolve() == source:
            print(f"compose override: already linked to {source}")
            return
        fail(f"{target} is already a symlink to {target.resolve()}")

    if target.exists():
        content = target.read_text(encoding="utf-8", errors="replace")
        if "Talk to Type integration for the existing ai-stack" in content:
            target.unlink()
        else:
            fail(
                f"{target} already exists and is not managed by Talk to Type. "
                "Merge deploy/ai-stack/compose.override.yml into it manually."
            )

    target.symlink_to(source)
    print(f"compose override: {target} -> {source}")


def ensure_app_env(repo: Path) -> Path:
    target = repo / ".env"
    if target.exists():
        print(f"app env: keeping existing {target}")
        return target

    source = repo / ".env.example"
    if not source.exists():
        fail(f"Missing {source}")
    shutil.copy2(source, target)
    print(f"app env: copied {source} -> {target}; edit it before starting")
    return target


def validate_compose(ai_home: Path) -> None:
    try:
        subprocess.run(
            ["docker", "compose", "config", "-q"],
            cwd=ai_home,
            check=True,
        )
    except FileNotFoundError:
        print("compose validation: docker executable not found; skipped")
    except subprocess.CalledProcessError as exc:
        fail(f"docker compose config failed with exit code {exc.returncode}")
    else:
        print("compose validation: OK")


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
    parser.add_argument(
        "--models-dir",
        default=os.getenv("MODELS_DIR", "/databases/aimodels"),
    )
    args = parser.parse_args()

    ai_home = Path(args.ai_home).expanduser().resolve()
    repo = Path(args.repo).expanduser().resolve()
    models_dir = Path(args.models_dir).expanduser().resolve()

    if not ai_home.is_dir():
        fail(f"AI_HOME does not exist: {ai_home}")
    if not repo.is_dir():
        fail(f"local-transcriber repo does not exist: {repo}")

    base_compose = ai_home / "compose.yml"
    if not base_compose.exists():
        fail(f"Expected AI stack Compose file at {base_compose}")

    t4_config = ai_home / "llama-swap" / "t4.yaml"
    if not t4_config.exists():
        fail(f"Expected T4 llama-swap config at {t4_config}")

    expected_repo = (ai_home / "local-transcriber").resolve()
    if repo != expected_repo:
        fail(
            f"For the unified install, clone this repository at {expected_repo}; "
            f"current path is {repo}."
        )

    (repo / "recordings").mkdir(parents=True, exist_ok=True)
    (repo / "runtime").mkdir(parents=True, exist_ok=True)
    (models_dir / "talk-to-type" / "pyannote").mkdir(parents=True, exist_ok=True)

    ensure_app_env(repo)
    patch_t4_config(t4_config)
    install_override(ai_home, repo)
    validate_compose(ai_home)

    print()
    print("Talk to Type AI-stack integration is installed.")
    print("Review/edit:")
    print(f"  {repo / '.env'}")
    print("Then start the unified AI stack with:")
    print(f"  cd {ai_home} && docker compose up -d --build")
    print()
    print("Useful checks:")
    print("  docker compose ps")
    print("  docker compose logs --tail=100 llama-swap-t4 speaker-analyzer local-transcriber")
    print("  curl http://127.0.0.1:9293/running")


if __name__ == "__main__":
    main()
