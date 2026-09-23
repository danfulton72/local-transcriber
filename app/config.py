from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://transcriber:change-me@postgres/transcriber"
    gateway_base_url: str = "http://host.docker.internal:8555/v1"
    recordings_dir: Path = Path("/data/recordings")
    parent_pin: str = ""
    default_username: str = "local"
    default_password: str = "change-me-now"
    default_display_name: str = "Local user"
    auth_session_days: int = 30
    auth_cookie_secure: bool = False
    default_language: str = ""
    default_voice: str = "en_GB-northern_english_male-medium"
    speaker_service_url: str = "http://speaker-analyzer:9000"
    speaker_match_threshold: float = 0.78


settings = Settings()
