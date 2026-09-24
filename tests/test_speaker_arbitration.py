from pathlib import Path

import httpx
import pytest

from app.services.speaker_service import SpeakerService


class FakeAsyncClient:
    def __init__(self, *args, **kwargs):
        self.calls = []
        self.running_checks = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def _response(self, method: str, url: str, status: int = 200, json=None):
        return httpx.Response(
            status,
            json=json,
            request=httpx.Request(method, url),
        )

    async def get(self, url, headers=None):
        self.calls.append(("GET", url))
        if url.endswith("/running"):
            self.running_checks += 1
            if self.running_checks == 1:
                return self._response(
                    "GET",
                    url,
                    json={
                        "running": [
                            {"model": "qwen3.6-reap48", "state": "ready"},
                            {"model": "nomic-embed", "state": "ready"},
                        ]
                    },
                )
            return self._response("GET", url, json={"running": []})
        if "/upstream/" in url and url.endswith("/health"):
            return self._response("GET", url, json={"status": "ok"})
        raise AssertionError(f"Unexpected GET {url}")

    async def post(self, url, headers=None, data=None, files=None):
        self.calls.append(("POST", url))
        if url.endswith("/upstream/speaker_auto/analyze"):
            return self._response(
                "POST",
                url,
                json={
                    "model": "pyannote/speaker-diarization-community-1",
                    "speaker_count": 1,
                    "speakers": [],
                    "turns": [],
                },
            )
        if url.endswith("/api/models/unload/speaker_auto"):
            return self._response("POST", url, status=200, json={"ok": True})
        raise AssertionError(f"Unexpected POST {url}")


@pytest.mark.asyncio
async def test_analysis_claims_t4_then_restores_previous_models(monkeypatch, tmp_path: Path):
    from app.services import speaker_service as module

    fake = FakeAsyncClient()
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda *args, **kwargs: fake)

    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"RIFF-placeholder")

    service = SpeakerService()
    service.swap_url = "http://llama-swap-t4:8080"
    service.swap_model = "speaker_auto"
    service.swap_key = "sk-local"
    service.restore_previous = True

    result = await service.analyze(audio)

    assert result["speaker_count"] == 1
    assert fake.calls == [
        ("GET", "http://llama-swap-t4:8080/running"),
        ("POST", "http://llama-swap-t4:8080/upstream/speaker_auto/analyze"),
        ("POST", "http://llama-swap-t4:8080/api/models/unload/speaker_auto"),
        ("GET", "http://llama-swap-t4:8080/running"),
        ("GET", "http://llama-swap-t4:8080/upstream/qwen3.6-reap48/health"),
        ("GET", "http://llama-swap-t4:8080/upstream/nomic-embed/health"),
    ]
