from pathlib import Path

import httpx

from ..config import settings


class SpeakerService:
    def __init__(self) -> None:
        self.base_url = settings.speaker_service_url.rstrip("/")

    async def health(self) -> dict:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{self.base_url}/healthz")
            response.raise_for_status()
            return response.json()

    async def analyze(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        num_speakers: int | None = None,
    ) -> dict:
        data = {}
        if language:
            data["language"] = language
        if num_speakers:
            data["num_speakers"] = str(num_speakers)

        async with httpx.AsyncClient(timeout=3600) as client:
            with audio_path.open("rb") as handle:
                files = {"file": (audio_path.name, handle, "audio/wav")}
                response = await client.post(f"{self.base_url}/analyze", data=data, files=files)
            response.raise_for_status()
            return response.json()


speaker_service = SpeakerService()
