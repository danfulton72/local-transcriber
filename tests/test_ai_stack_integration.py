import importlib.util
from pathlib import Path


def load_installer():
    path = Path("deploy/ai-stack/install.py")
    spec = importlib.util.spec_from_file_location("ai_stack_installer", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_t4_patch_adds_exclusive_speaker_reservation(tmp_path):
    installer = load_installer()
    path = tmp_path / "t4.yaml"
    path.write_text(
        """healthCheckTimeout: 300
matrix:
  vars:
    a: nomic-embed
    b: qwen3.6-reap48
    c: qwen3.6-35b-a3b-mtp
    d: qwen3.6-35b-a3b-vision
    e: qwen3.5-9b
  sets:
    chat_plus_embed: "(b | c | d | e) & a"

models:
  "qwen3.6-reap48":
    cmd: llama-server
  "nomic-embed":
    cmd: llama-server --embedding
""",
        encoding="utf-8",
    )

    backup = installer.patch_t4_config(path)
    patched = path.read_text(encoding="utf-8")

    assert backup is not None
    assert "s: speaker_auto" in patched
    assert 'speaker_only: "s"' in patched
    assert '"speaker_auto":' in patched
    assert 'proxy: "http://speaker-analyzer:9000"' in patched
    assert 'cmdStop: sh -lc \'/scripts/speaker-stop.sh "${PID}"\'' in patched

    # Idempotent: a second run should not create another backup or duplicate.
    assert installer.patch_t4_config(path) is None
    patched_again = path.read_text(encoding="utf-8")
    assert patched_again.count('"speaker_auto":') == 1
    assert patched_again.count('speaker_only: "s"') == 1


def test_ai_stack_overlay_pins_analyzer_to_t4_and_shared_model_store():
    overlay = Path("deploy/ai-stack/compose.override.yml").read_text(encoding="utf-8")

    assert 'device_ids: ["${T4_UUID}"]' in overlay
    assert "${MODELS_DIR:-/databases/aimodels}/talk-to-type/pyannote:/models" in overlay
    assert "SPEAKER_SWAP_URL: http://llama-swap-t4:8080" in overlay
    assert "SPEAKER_BUSY_FILE: /run/talk-to-type/speaker.busy" in overlay
    assert "networks: [ai]" in overlay
