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
    assert 'cmdStop: sh /scripts/speaker-stop.sh "${PID}"' in patched

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
    assert "${LOCAL_TRANSCRIBER_DIR:-/home/dan/ai/local-transcriber}/.env" in overlay
    assert "${LOCAL_TRANSCRIBER_DIR:-/home/dan/ai/local-transcriber}/recordings:/data/recordings" in overlay
    assert "${LOCAL_TRANSCRIBER_DIR:-/home/dan/ai/local-transcriber}/runtime" in overlay
    assert "/home/dan/local-transcriber" not in overlay
    assert "app.env" not in overlay
    assert "networks: [ai]" in overlay
    assert "container_name: local-transcriber-speaker-analyzer" not in overlay


def test_installer_defaults_to_repo_location_inside_ai():
    source = Path("deploy/ai-stack/install.py").read_text(encoding="utf-8")

    assert "/home/dan/ai/local-transcriber" in source
    assert "copy_tree_if_target_empty" not in source
    assert "app.env" not in source
    assert 'repo / ".env"' in source
    assert 'repo / "recordings"' in source
    assert 'repo / "runtime"' in source


def test_find_compose_file_accepts_standard_names(tmp_path):
    installer = load_installer()

    for name in ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"):
        for existing in tmp_path.iterdir():
            if existing.is_file():
                existing.unlink()
        candidate = tmp_path / name
        candidate.write_text("services: {}\n", encoding="utf-8")
        assert installer.find_compose_file(tmp_path) == candidate



def load_uninstaller():
    path = Path("deploy/ai-stack/uninstall.py")
    spec = importlib.util.spec_from_file_location("ai_stack_uninstaller", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_ai_stack_uninstaller_removes_only_talk_to_type_t4_entries(tmp_path):
    uninstaller = load_uninstaller()
    path = tmp_path / "t4.yaml"
    path.write_text(
        """healthCheckTimeout: 300
matrix:
  vars:
    a: nomic-embed
    e: qwen3.5-9b
    s: speaker_auto          # Talk to Type T4 reservation
  sets:
    chat_plus_embed: "(e) & a"
    speaker_only: "s"

models:
  "qwen":
    cmd: llama-server

  # BEGIN TALK_TO_TYPE_SPEAKER_AUTO
  "speaker_auto":
    name: "Talk to Type speaker analysis reservation"
    proxy: "http://speaker-analyzer:9000"
  # END TALK_TO_TYPE_SPEAKER_AUTO

other:
  keep: true
""",
        encoding="utf-8",
    )

    uninstaller.unpatch_t4(path)
    cleaned = path.read_text(encoding="utf-8")

    assert "speaker_auto" not in cleaned
    assert 'speaker_only: "s"' not in cleaned
    assert '"qwen":' in cleaned
    assert "other:" in cleaned
    assert "keep: true" in cleaned
    assert list(tmp_path.glob("t4.yaml.before-talk-to-type-detach-*"))
