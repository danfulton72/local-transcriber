import importlib.util
from pathlib import Path


def load_installer():
    path = Path("deploy/voice-stack/install.py")
    spec = importlib.util.spec_from_file_location("voice_stack_installer", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_voice_stack_overlay_uses_p4_and_internal_gateway():
    overlay = Path("deploy/voice-stack/compose.override.yml").read_text(encoding="utf-8")

    assert "${LOCAL_TRANSCRIBER_DIR:-/home/dan/voice/local-transcriber}" in overlay
    assert "GATEWAY_BASE_URL: http://wyoming-openai-gateway:8555/v1" in overlay
    assert "SPEAKER_SERVICE_URL: http://speaker-analyzer:9000" in overlay
    assert 'device_ids: ["${P4_UUID}"]' in overlay
    assert "NVIDIA_VISIBLE_DEVICES: ${P4_UUID}" in overlay
    assert "SPEAKER_UNLOAD_AFTER_DIARIZATION: \"true\"" in overlay
    assert "${VOICE_SPEAKER_MODELS_DIR:-/home/dan/voice/speaker-model-cache}:/models" in overlay
    assert "llama-swap" not in overlay
    assert "T4_UUID" not in overlay
    assert "networks: [ai]" not in overlay


def test_voice_stack_installer_targets_voice_home():
    source = Path("deploy/voice-stack/install.py").read_text(encoding="utf-8")

    assert "/home/dan/voice" in source
    assert "local-transcriber" in source
    assert "P4_UUID" in source
    assert "whisper" in source
    assert "piper" in source
    assert "wyoming-openai-gateway" in source


def test_voice_stack_override_name_matches_base_compose(tmp_path):
    installer = load_installer()

    docker = tmp_path / "docker-compose.yml"
    docker.write_text("services: {}\n", encoding="utf-8")
    assert installer.override_name(docker) == "docker-compose.override.yml"

    compose = tmp_path / "compose.yaml"
    compose.write_text("services: {}\n", encoding="utf-8")
    assert installer.override_name(compose) == "compose.override.yaml"


def test_voice_stack_find_compose_file_accepts_standard_names(tmp_path):
    installer = load_installer()

    for name in ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"):
        for existing in tmp_path.iterdir():
            if existing.is_file():
                existing.unlink()
        candidate = tmp_path / name
        candidate.write_text("services: {}\n", encoding="utf-8")
        assert installer.find_compose_file(tmp_path) == candidate
