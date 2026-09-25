#!/usr/bin/env python3
"""Install Talk to Type inside the existing /home/dan/voice Compose project."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path


REQUIRED_SERVICES = {"whisper", "piper", "wyoming-openai-gateway"}


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def find_compose_file(voice_home: Path) -> Path:
    for name in ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"):
        path = voice_home / name
        if path.is_file():
            return path
    checked = ", ".join(str(voice_home / name) for name in (
        "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"
    ))
    fail(f"Could not find the voice-stack Compose file. Checked: {checked}")


def override_name(base_compose: Path) -> str:
    if base_compose.name.startswith("docker-compose."):
        return "docker-compose.override." + base_compose.suffix.lstrip(".")
    return "compose.override." + base_compose.suffix.lstrip(".")


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


def read_env_value(path: Path, key: str) -> str:
    if not path.exists():
        return ""
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        current, value = line.split("=", 1)
        if current.strip() == key:
            return value.strip().strip('"').strip("'")
    return ""


def validate_p4_uuid(voice_home: Path) -> None:
    value = os.getenv("P4_UUID") or read_env_value(voice_home / ".env", "P4_UUID")
    if not value or value == "GPU-REPLACE-ME":
        fail(
            f"Set P4_UUID in {voice_home / '.env'} to the Tesla P4 UUID before installing."
        )
    print(f"P4 UUID: {value}")


def install_override(voice_home: Path, repo: Path, base_compose: Path) -> Path:
    target = voice_home / override_name(base_compose)
    source = (repo / "deploy" / "voice-stack" / "compose.override.yml").resolve()
    if not source.exists():
        fail(f"Missing integration overlay: {source}")

    if target.is_symlink():
        if target.resolve() == source:
            print(f"compose override: already linked to {source}")
            return target
        fail(f"{target} is already a symlink to {target.resolve()}")

    if target.exists():
        content = target.read_text(encoding="utf-8", errors="replace")
        if "Talk to Type integration for the existing voice-stack" in content:
            target.unlink()
        else:
            fail(
                f"{target} already exists and is not managed by Talk to Type. "
                "Merge deploy/voice-stack/compose.override.yml into it manually."
            )

    target.symlink_to(source)
    print(f"compose override: {target} -> {source}")
    return target


def compose_services(voice_home: Path) -> set[str]:
    try:
        result = subprocess.run(
            ["docker", "compose", "config", "--services"],
            cwd=voice_home,
            check=True,
            text=True,
            capture_output=True,
        )
    except FileNotFoundError:
        print("service validation: docker executable not found; skipped")
        return set()
    except subprocess.CalledProcessError as exc:
        fail(
            "docker compose config --services failed: "
            + (exc.stderr.strip() or f"exit code {exc.returncode}")
        )
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def validate_compose(voice_home: Path) -> None:
    try:
        subprocess.run(["docker", "compose", "config", "-q"], cwd=voice_home, check=True)
    except FileNotFoundError:
        print("compose validation: docker executable not found; skipped")
    except subprocess.CalledProcessError as exc:
        fail(f"docker compose config failed with exit code {exc.returncode}")
    else:
        print("compose validation: OK")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-home", default=os.getenv("VOICE_HOME", "/home/dan/voice"))
    parser.add_argument(
        "--repo",
        default=os.getenv(
            "LOCAL_TRANSCRIBER_DIR",
            str(Path(__file__).resolve().parents[2]),
        ),
    )
    parser.add_argument(
        "--speaker-models",
        default=os.getenv(
            "VOICE_SPEAKER_MODELS_DIR",
            "/home/dan/voice/speaker-model-cache",
        ),
    )
    args = parser.parse_args()

    voice_home = Path(args.voice_home).expanduser().resolve()
    repo = Path(args.repo).expanduser().resolve()
    speaker_models = Path(args.speaker_models).expanduser().resolve()

    if not voice_home.is_dir():
        fail(f"VOICE_HOME does not exist: {voice_home}")
    if not repo.is_dir():
        fail(f"local-transcriber repo does not exist: {repo}")

    base_compose = find_compose_file(voice_home)
    print(f"voice stack Compose: {base_compose}")

    expected_repo = (voice_home / "local-transcriber").resolve()
    if repo != expected_repo:
        fail(
            f"For the voice-stack install, move/clone this repository to {expected_repo}; "
            f"current path is {repo}."
        )

    validate_p4_uuid(voice_home)
    (repo / "recordings").mkdir(parents=True, exist_ok=True)
    speaker_models.mkdir(parents=True, exist_ok=True)
    ensure_app_env(repo)
    install_override(voice_home, repo, base_compose)

    services = compose_services(voice_home)
    if services:
        missing = sorted(REQUIRED_SERVICES - services)
        if missing:
            fail("Voice stack is missing required services: " + ", ".join(missing))
        print("voice stack services: OK")

    validate_compose(voice_home)

    print()
    print("Talk to Type voice-stack integration is installed.")
    print("Review/edit:")
    print(f"  {repo / '.env'}")
    print("Then build and start only the Talk to Type services:")
    print(f"  cd {voice_home}")
    print("  docker compose build local-transcriber speaker-analyzer")
    print("  docker compose up -d local-transcriber speaker-analyzer")
    print()
    print("Useful checks:")
    print("  docker compose ps local-transcriber speaker-analyzer whisper wyoming-openai-gateway")
    print("  docker compose logs --tail=100 local-transcriber speaker-analyzer")
    print("  curl -fsS http://127.0.0.1:8090/healthz")


if __name__ == "__main__":
    main()
