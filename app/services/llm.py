"""Minimal client for an OpenAI-compatible chat endpoint (llama.cpp llama-server)."""

import re

import httpx

from ..config import settings

# Tests swap this for an httpx.MockTransport.
http_transport: httpx.AsyncBaseTransport | None = None

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


class LLMError(RuntimeError):
    pass


def strip_thinking(text: str) -> str:
    """Remove reasoning blocks some models emit even when asked not to."""
    cleaned = _THINK_BLOCK.sub("", text or "")
    # A template may open the block in the prompt, leaving only a closing tag.
    if "</think>" in cleaned.lower():
        cleaned = re.split(r"</think>", cleaned, flags=re.IGNORECASE)[-1]
    return cleaned.strip()


class ChatLLM:
    @property
    def configured(self) -> bool:
        return bool(settings.llm_base_url.strip())

    @property
    def base_url(self) -> str:
        return settings.llm_base_url.strip().rstrip("/")

    def _headers(self) -> dict[str, str]:
        key = settings.llm_api_key.strip()
        return {"Authorization": f"Bearer {key}"} if key else {}

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=15),
            headers=self._headers(),
            transport=http_transport,
        )

    async def models(self) -> list[str]:
        async with self._client(10) as client:
            response = await client.get(f"{self.base_url}/models")
            response.raise_for_status()
            payload = response.json()
        rows = payload.get("data", []) if isinstance(payload, dict) else []
        return [str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")]

    async def chat(self, messages: list[dict], *, max_tokens: int | None = None) -> str:
        if not self.configured:
            raise LLMError("LLM_BASE_URL is not set.")
        payload: dict = {
            "model": settings.llm_model,
            "messages": messages,
            "temperature": settings.llm_temperature,
            "max_tokens": max_tokens or settings.llm_max_output_tokens,
            "stream": False,
        }
        if settings.llm_disable_thinking:
            # Honoured by llama-server --jinja for Qwen3-style templates and
            # ignored by templates that have no thinking switch.
            payload["chat_template_kwargs"] = {"enable_thinking": False}

        try:
            async with self._client(settings.llm_timeout_seconds) as client:
                response = await client.post(f"{self.base_url}/chat/completions", json=payload)
        except httpx.HTTPError as exc:
            raise LLMError(f"Could not reach the notes model at {self.base_url}: {exc}") from exc

        if response.is_error:
            detail = response.text.strip()[:500]
            raise LLMError(f"Notes model returned HTTP {response.status_code}: {detail}")

        try:
            message = response.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError("Notes model returned an unexpected response.") from exc

        text = strip_thinking(str(message.get("content") or ""))
        if not text:
            raise LLMError(
                "Notes model returned no text. If it is a reasoning model, keep "
                "LLM_DISABLE_THINKING=true or raise LLM_MAX_OUTPUT_TOKENS."
            )
        return text


llm = ChatLLM()
