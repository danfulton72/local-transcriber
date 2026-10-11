import importlib.util
from pathlib import Path

import pytest


LAUNCHER_PATH = Path(__file__).resolve().parents[1] / "realtime_bridge" / "launcher.py"
spec = importlib.util.spec_from_file_location("realtime_bridge_launcher", LAUNCHER_PATH)
launcher = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(launcher)


def test_realtime_bridge_uses_existing_llm_config_as_fallback():
    config = launcher.build_config(
        {
            "LLM_BASE_URL": "http://llama-swap:9292/v1",
            "LLM_MODEL": "voice-router",
            "LLM_API_KEY": "secret",
            "DEFAULT_VOICE": "en_GB-northern_english_male-medium",
        }
    )

    assert config["stt"] == "openai"
    assert config["llm_backend"] == "chat-completions"
    assert config["tts"] == "openai"
    assert config["openai_stt_base_url"] == "http://wyoming-openai-gateway:8555/v1"
    assert config["openai_stt_model"] == "whisper-1"
    assert config["enable_live_transcription"] is False
    assert config["model_name"] == "voice-router"
    assert config["responses_api_base_url"] == "http://llama-swap:9292/v1"
    assert config["responses_api_api_key"] == "secret"
    assert config["openai_tts_base_url"] == "http://wyoming-openai-gateway:8555/v1"
    assert config["openai_tts_model"] == "wyoming"
    assert config["openai_tts_voice"] == "en_GB-northern_english_male-medium"
    assert config["openai_tts_response_format"] == "wav"
    assert config["openai_tts_stream"] is False
    assert config["smart_turn"] is False


def test_realtime_specific_llm_settings_override_meeting_notes_defaults():
    config = launcher.build_config(
        {
            "LLM_BASE_URL": "http://notes:8080/v1",
            "LLM_MODEL": "notes",
            "LLM_API_KEY": "notes-key",
            "REALTIME_LLM_BASE_URL": "http://voice:9292/v1/",
            "REALTIME_LLM_MODEL": "fast-tools",
            "REALTIME_LLM_API_KEY": "voice-key",
            "REALTIME_TTS_VOICE": "custom-voice",
            "REALTIME_NUM_PIPELINES": "2",
            "REALTIME_LIVE_TRANSCRIPTION": "true",
        }
    )

    assert config["responses_api_base_url"] == "http://voice:9292/v1"
    assert config["model_name"] == "fast-tools"
    assert config["responses_api_api_key"] == "voice-key"
    assert config["openai_tts_voice"] == "custom-voice"
    assert config["num_pipelines"] == 2
    assert config["enable_live_transcription"] is True


@pytest.mark.parametrize(
    "env, expected",
    [
        ({"LLM_MODEL": "model"}, "REALTIME_LLM_BASE_URL"),
        ({"LLM_BASE_URL": "http://llm/v1"}, "REALTIME_LLM_MODEL"),
    ],
)
def test_realtime_bridge_requires_llm_endpoint_and_model(env, expected):
    with pytest.raises(ValueError, match=expected):
        launcher.build_config(env)


def test_realtime_bridge_rejects_invalid_boolean():
    with pytest.raises(ValueError, match="REALTIME_LIVE_TRANSCRIPTION"):
        launcher.build_config(
            {
                "LLM_BASE_URL": "http://llm/v1",
                "LLM_MODEL": "voice",
                "REALTIME_LIVE_TRANSCRIPTION": "sometimes",
            }
        )
