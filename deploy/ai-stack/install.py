#!/usr/bin/env python3
"""Install Talk to Type into the existing /home/dan/ai Compose project.

This script is deliberately conservative:
- it never overwrites an existing unrelated compose.override.yml;
- it backs up llama-swap/t4.yaml before changing it;
- it copies (does not delete) existing recordings/model cache;
- it is idempotent and can be rerun after git pull.
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


def copy_tree_if_target_empty(source: Path, target: Path, label: str) -> None:
    target.mkdir(parents=True, exist_ok=True)
    if not source.exists() or not source.is_dir():
        return

    source_files = [item for item in source.rglob("*") if item.is_file()]
    if not source_files:
        return

    target_files = [item for item in target.rglob("*") if item.is_file()]
    if target_files:
        print(f"{label}: destination already contains files; leaving it unchanged")
        return

    print(f"{label}: copying {len(source_files)} file(s) from {source} -> {target}")
    for item in source_files:
        relative = item.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)


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


def install_app_env(ai_home: Path, repo: Path) -> Path:
    runtime_root = ai_home / "local-transcriber"
    runtime_root.mkdir(parents=True, exist_ok=True)
    target = runtime_root / "app.env"

    if target.exists():
        print(f"app env: keeping existing {target}")
        return target

    source = repo / ".env"
    if not source.exists():
        source = repo / ".env.example"
        print("app env: repo .env not found; using .env.example (edit before starting)")
    shutil.copy2(source, target)
    print(f"app env: copied {source} -> {target}")
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
        default=os.getenv("LOCAL_TRANSCRIBER_DIR", "/home/dan/local-transcriber"),
    )
    parser.add_argument(
        "--models-dir",
        default=os.getenv("MODELS_DIR", "/databases/aimodels"),
    )
    parser.add_argument("--skip-copy", action="store_true")
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

    runtime_root = ai_home / "local-transcriber"
    recordings_target = runtime_root / "recordings"
    runtime_dir = runtime_root / "runtime"
    model_target = models_dir / "talk-to-type" / "pyannote"

    runtime_dir.mkdir(parents=True, exist_ok=True)
    recordings_target.mkdir(parents=True, exist_ok=True)
    model_target.mkdir(parents=True, exist_ok=True)

    install_app_env(ai_home, repo)

    if not args.skip_copy:
        copy_tree_if_target_empty(
            repo / "recordings",
            recordings_target,
            "recordings",
        )
        copy_tree_if_target_empty(
            repo / "speaker-model-cache",
            model_target,
            "pyannote cache",
        )

    patch_t4_config(t4_config)
    install_override(ai_home, repo)
    validate_compose(ai_home)

    print()
    print("Talk to Type AI-stack integration is installed.")
    print("Review/edit:")
    print(f"  {runtime_root / 'app.env'}")
    print("Then migrate from the standalone project with:")
    print(f"  cd {repo} && docker compose down")
    print(f"  cd {ai_home} && docker compose up -d --build")
    print()
    print("Useful checks:")
    print("  docker compose ps")
    print("  docker compose logs --tail=100 llama-swap-t4 speaker-analyzer local-transcriber")
    print("  curl http://127.0.0.1:9293/running")


if __name__ == "__main__":
    main()
