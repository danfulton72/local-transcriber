import httpx

from ..config import settings


class SpeechGateway:
    def __init__(self) -> None:
        self.base_url = settings.gateway_base_url.rstrip("/")

    async def health(self) -> dict:
        root = self.base_url.removesuffix("/v1")
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{root}/healthz")
            response.raise_for_status()
            return response.json()

    async def voices(self) -> dict:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{self.base_url}/voices")
            response.raise_for_status()
            return response.json()

    async def transcribe(
        self,
        data: bytes,
        filename: str,
        content_type: str,
        language: str | None = None,
        prompt: str | None = None,
        task: str = "transcriptions",
    ) -> str:
        form = {"model": "whisper-1", "response_format": "json", "temperature": "0"}
        if language:
            form["language"] = language
        if prompt:
            form["prompt"] = prompt
        files = {"file": (filename, data, content_type or "audio/wav")}
        async with httpx.AsyncClient(timeout=600) as client:
            response = await client.post(f"{self.base_url}/audio/{task}", data=form, files=files)
            response.raise_for_status()
            payload = response.json()
            return str(payload.get("text", "")).strip()

    async def speak(self, text: str, voice: str, speed: float) -> tuple[bytes, str]:
        payload = {
            "model": "wyoming",
            "input": text,
            "voice": voice,
            "response_format": "wav",
            "speed": speed,
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self.base_url}/audio/speech", json=payload)
            response.raise_for_status()
            return response.content, response.headers.get("content-type", "audio/wav")


gateway = SpeechGateway()
