from pathlib import Path
from urllib.parse import quote

import httpx

from ..config import settings


class SpeakerService:
    def __init__(self) -> None:
        self.base_url = settings.speaker_service_url.rstrip("/")
        self.swap_url = settings.speaker_swap_url.rstrip("/")
        self.swap_model = settings.speaker_swap_model.strip() or "speaker_auto"
        self.swap_key = settings.speaker_swap_key.strip()
        self.restore_previous = bool(settings.speaker_restore_previous)

    def _headers(self) -> dict[str, str]:
        if not self.swap_key:
            return {}
        return {"Authorization": f"Bearer {self.swap_key}"}

    async def health(self) -> dict:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{self.base_url}/healthz")
            response.raise_for_status()
            payload = response.json()
        if isinstance(payload, dict):
            payload["arbitrated"] = bool(self.swap_url)
            payload["swap_model"] = self.swap_model if self.swap_url else None
        return payload

    async def _running_models(self, client: httpx.AsyncClient) -> list[str]:
        if not self.swap_url:
            return []
        response = await client.get(
            f"{self.swap_url}/running",
            headers=self._headers(),
        )
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("running", []) if isinstance(payload, dict) else []
        models = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            model = str(row.get("model", "")).strip()
            if model and model != self.swap_model:
                models.append(model)
        return models

    async def _unload_reservation(self, client: httpx.AsyncClient) -> None:
        if not self.swap_url:
            return
        model = quote(self.swap_model, safe="")
        response = await client.post(
            f"{self.swap_url}/api/models/unload/{model}",
            headers=self._headers(),
        )
        if response.status_code not in {200, 204, 404}:
            response.raise_for_status()

    async def _wake_model(self, client: httpx.AsyncClient, model: str) -> None:
        encoded = quote(model, safe="")
        response = await client.get(
            f"{self.swap_url}/upstream/{encoded}/health",
            headers=self._headers(),
        )
        response.raise_for_status()

    async def _restore_models(
        self,
        client: httpx.AsyncClient,
        previous: list[str],
    ) -> None:
        if not self.swap_url or not self.restore_previous or not previous:
            return

        try:
            current = await self._running_models(client)
        except httpx.HTTPError:
            return

        # If another request already claimed the T4 while diarization was
        # finishing, respect that request rather than swapping it back out.
        if current:
            return

        for model in previous:
            try:
                await self._wake_model(client, model)
            except httpx.HTTPError:
                # Restoration is convenience only. A later real request will
                # still wake the model through llama-swap.
                continue

    @staticmethod
    def _error_message(response: httpx.Response) -> str:
        detail = None
        try:
            payload = response.json()
            raw_detail = payload.get("detail") if isinstance(payload, dict) else None
            if isinstance(raw_detail, str):
                detail = raw_detail
            elif raw_detail is not None:
                detail = str(raw_detail)
        except ValueError:
            detail = response.text.strip()
        return detail or f"Speaker analyzer returned HTTP {response.status_code}."

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

        timeout = httpx.Timeout(3600, connect=30)
        async with httpx.AsyncClient(timeout=timeout) as client:
            previous: list[str] = []
            if self.swap_url:
                previous = await self._running_models(client)
                target = (
                    f"{self.swap_url}/upstream/"
                    f"{quote(self.swap_model, safe='')}/analyze"
                )
                headers = self._headers()
            else:
                target = f"{self.base_url}/analyze"
                headers = {}

            try:
                with audio_path.open("rb") as handle:
                    files = {"file": (audio_path.name, handle, "audio/wav")}
                    response = await client.post(
                        target,
                        headers=headers,
                        data=data,
                        files=files,
                    )
                if response.is_error:
                    raise RuntimeError(self._error_message(response))
                return response.json()
            finally:
                if self.swap_url:
                    try:
                        await self._unload_reservation(client)
                    finally:
                        await self._restore_models(client, previous)


speaker_service = SpeakerService()
