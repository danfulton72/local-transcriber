from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://transcriber:change-me@postgres/transcriber"
    gateway_base_url: str = "http://host.docker.internal:8555/v1"
    recordings_dir: Path = Path("/data/recordings")
    default_username: str = "local"
    default_password: str = "change-me-now"
    default_display_name: str = "Local user"
    auth_session_days: int = 30
    auth_cookie_secure: bool = False
    default_language: str = ""
    default_voice: str = "en_GB-northern_english_male-medium"
    speaker_service_url: str = "http://speaker-analyzer:9000"
    speaker_swap_url: str = ""
    speaker_swap_model: str = "speaker_auto"
    speaker_swap_key: str = ""
    speaker_restore_previous: bool = True
    speaker_match_threshold: float = 0.78
    # Near-live chunk WAVs duplicate the full recording. Keep them only when
    # troubleshooting transcription; by default they are removed once a
    # recording finishes with its full audio safely stored.
    keep_live_chunk_audio: bool = False

    # Meeting notes: an OpenAI-compatible chat endpoint such as llama.cpp's
    # llama-server. Leave LLM_BASE_URL empty to disable notes generation.
    llm_base_url: str = ""
    llm_model: str = "meeting-llm"
    llm_api_key: str = ""
    llm_temperature: float = 0.2
    # Keep in step with llama-server's -c value. The transcript is split into
    # parts of at most LLM_CHUNK_TOKENS so each extraction pass stays well
    # inside the context window.
    llm_context_tokens: int = 32768
    llm_chunk_tokens: int = 12000
    llm_max_output_tokens: int = 4096
    # Qwen3-style hybrid reasoning models: turn thinking off for notes.
    llm_disable_thinking: bool = True
    llm_timeout_seconds: float = 900.0
    notes_timezone: str = "Europe/London"

    # Open Notebook export. Leave OPEN_NOTEBOOK_URL empty to keep notes local.
    open_notebook_url: str = ""
    open_notebook_password: str = ""
    open_notebook_notebook_id: str = ""
    open_notebook_embed: bool = True
    # Optional browser URL of the Open Notebook UI (e.g. http://host:8502),
    # used only to show an "Open in Open Notebook" link.
    open_notebook_ui_url: str = ""


settings = Settings()
