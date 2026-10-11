"""Launch the OpenAI Realtime bridge with remote STT/LLM/TTS backends."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _env(source: dict[str, str], name: str, default: str = "") -> str:
    return (source.get(name) or default).strip()


def _bool(source: dict[str, str], name: str, default: bool) -> bool:
    raw = _env(source, name)
    if not raw:
        return default
    value = raw.lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true/false, got {raw!r}")


def _int(source: dict[str, str], name: str, default: int) -> int:
    raw = _env(source, name)
    return int(raw) if raw else default


def build_config(source: dict[str, str] | None = None) -> dict:
    env = dict(os.environ if source is None else source)

    llm_base = _env(env, "REALTIME_LLM_BASE_URL") or _env(env, "LLM_BASE_URL")
    llm_model = _env(env, "REALTIME_LLM_MODEL") or _env(env, "LLM_MODEL")
    llm_key = _env(env, "REALTIME_LLM_API_KEY") or _env(env, "LLM_API_KEY")

    if not llm_base:
        raise ValueError(
            "Set REALTIME_LLM_BASE_URL (or LLM_BASE_URL) to the llama-swap/OpenAI-compatible /v1 endpoint."
        )
    if not llm_model:
        raise ValueError(
            "Set REALTIME_LLM_MODEL (or LLM_MODEL) to a fast model that supports OpenAI-style function calling."
        )

    voice = (
        _env(env, "REALTIME_TTS_VOICE")
        or _env(env, "DEFAULT_VOICE")
        or "en_GB-northern_english_male-medium"
    )

    return {
        "stt": "openai",
        "llm_backend": "chat-completions",
        "tts": "openai",
        "host": "0.0.0.0",
        "port": _int(env, "REALTIME_PORT", 8765),
        "num_pipelines": _int(env, "REALTIME_NUM_PIPELINES", 1),
        # Smart Turn needs another model; basic Silero VAD is enough for this
        # bridge and keeps the service CPU-only and predictable.
        "smart_turn": False,
        # The OpenAI-compatible STT backend implements live text by repeatedly
        # re-uploading the accumulated utterance. Keep that off for the P4:
        # one final request per turn is much cheaper and matches our existing
        # Whisper service well.
        "enable_live_transcription": _bool(env, "REALTIME_LIVE_TRANSCRIPTION", False),
        "log_level": _env(env, "REALTIME_LOG_LEVEL", "info"),
        "openai_stt_base_url": _env(
            env,
            "REALTIME_STT_BASE_URL",
            "http://wyoming-openai-gateway:8555/v1",
        ),
        "openai_stt_model": _env(env, "REALTIME_STT_MODEL", "whisper-1"),
        "openai_stt_language": _env(env, "REALTIME_STT_LANGUAGE", "en") or None,
        "openai_stt_response_format": "json",
        "openai_stt_timeout": 90.0,
        "model_name": llm_model,
        "responses_api_base_url": llm_base.rstrip("/"),
        "responses_api_api_key": llm_key or None,
        "responses_api_stream": True,
        "responses_api_disable_thinking": _bool(env, "REALTIME_DISABLE_THINKING", True),
        "openai_tts_base_url": _env(
            env,
            "REALTIME_TTS_BASE_URL",
            "http://wyoming-openai-gateway:8555/v1",
        ),
        "openai_tts_model": _env(env, "REALTIME_TTS_MODEL", "wyoming"),
        "openai_tts_voice": voice,
        "openai_tts_response_format": "wav",
        "openai_tts_stream": False,
        "openai_tts_speed": 1.0,
        "openai_tts_timeout": 120.0,
    }


def main() -> None:
    try:
        config = build_config()
    except (ValueError, TypeError) as exc:
        print(f"realtime bridge configuration error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    path = Path("/tmp/realtime-bridge.json")
    path.write_text(json.dumps(config, indent=2))

    safe = dict(config)
    if safe.get("responses_api_api_key"):
        safe["responses_api_api_key"] = "***configured***"
    print("Starting OpenAI Realtime bridge with configuration:")
    print(json.dumps(safe, indent=2), flush=True)

    os.execvp("speech-to-speech", ["speech-to-speech", "serve", str(path)])


if __name__ == "__main__":
    main()
