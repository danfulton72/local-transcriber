import uuid
from pathlib import Path

from ..config import settings


def recording_dir(recording_id: uuid.UUID) -> Path:
    path = settings.recordings_dir / str(recording_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_bytes(recording_id: uuid.UUID, relative_path: str, data: bytes) -> Path:
    root = recording_dir(recording_id)
    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path
