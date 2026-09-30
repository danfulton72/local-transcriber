"""Client for the Open Notebook REST API (lfnovo/open-notebook)."""

import logging
from urllib.parse import quote

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

# Tests swap this for an httpx.MockTransport.
http_transport: httpx.AsyncBaseTransport | None = None


class OpenNotebookError(RuntimeError):
    pass


def _path_id(value: str) -> str:
    # Open Notebook record ids look like "source:abc123"; keep the colon.
    return quote(value, safe=":")


class OpenNotebookClient:
    @property
    def configured(self) -> bool:
        return bool(settings.open_notebook_url.strip())

    @property
    def base_url(self) -> str:
        return settings.open_notebook_url.strip().rstrip("/")

    def _client(self, timeout: float = 60) -> httpx.AsyncClient:
        headers = {}
        password = settings.open_notebook_password.strip()
        if password:
            headers["Authorization"] = f"Bearer {password}"
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout, connect=10),
            transport=http_transport,
        )

    @staticmethod
    def _raise_for(response: httpx.Response, action: str) -> None:
        if not response.is_error:
            return
        detail = ""
        try:
            payload = response.json()
            detail = payload.get("detail", "") if isinstance(payload, dict) else ""
        except ValueError:
            detail = response.text.strip()[:300]
        if response.status_code == 401:
            detail = "check OPEN_NOTEBOOK_PASSWORD"
        raise OpenNotebookError(
            f"Open Notebook could not {action} (HTTP {response.status_code})"
            + (f": {detail}" if detail else ".")
        )

    async def notebooks(self) -> list[dict]:
        async with self._client(10) as client:
            response = await client.get("/api/notebooks")
            self._raise_for(response, "list notebooks")
            rows = response.json()
        return [
            {"id": str(row.get("id")), "name": str(row.get("name") or row.get("id"))}
            for row in rows
            if isinstance(row, dict) and row.get("id") and not row.get("archived")
        ]

    async def create_source(self, *, title: str, content: str, notebook_id: str) -> str:
        payload = {
            "type": "text",
            "title": title,
            "content": content,
            "notebooks": [notebook_id],
            "embed": bool(settings.open_notebook_embed),
            "async_processing": True,
        }
        try:
            async with self._client(120) as client:
                response = await client.post("/api/sources/json", json=payload)
        except httpx.HTTPError as exc:
            raise OpenNotebookError(f"Could not reach Open Notebook at {self.base_url}: {exc}") from exc
        self._raise_for(response, "create the transcript source")
        source_id = str(response.json().get("id") or "")
        if not source_id:
            raise OpenNotebookError("Open Notebook did not return a source id.")
        return source_id

    async def create_note(self, *, title: str, content: str, notebook_id: str) -> str:
        payload = {
            "title": title,
            "content": content,
            "note_type": "ai",
            "notebook_id": notebook_id,
        }
        try:
            async with self._client(60) as client:
                response = await client.post("/api/notes", json=payload)
        except httpx.HTTPError as exc:
            raise OpenNotebookError(f"Could not reach Open Notebook at {self.base_url}: {exc}") from exc
        self._raise_for(response, "create the meeting notes")
        note_id = str(response.json().get("id") or "")
        if not note_id:
            raise OpenNotebookError("Open Notebook did not return a note id.")
        return note_id

    async def _delete(self, kind: str, item_id: str) -> bool:
        """Delete a source or note. Missing items count as already deleted."""
        try:
            async with self._client(30) as client:
                response = await client.delete(f"/api/{kind}/{_path_id(item_id)}")
        except httpx.HTTPError as exc:
            raise OpenNotebookError(f"Could not reach Open Notebook at {self.base_url}: {exc}") from exc
        if response.status_code == 404:
            return False
        self._raise_for(response, f"delete {kind[:-1]} {item_id}")
        return True

    async def delete_source(self, source_id: str) -> bool:
        return await self._delete("sources", source_id)

    async def delete_note(self, note_id: str) -> bool:
        return await self._delete("notes", note_id)

    async def delete_quietly(self, *, source_id: str | None, note_id: str | None) -> None:
        """Best-effort clean-up used when a recording is permanently deleted."""
        if not self.configured:
            return
        for kind, item_id in (("sources", source_id), ("notes", note_id)):
            if not item_id:
                continue
            try:
                await self._delete(kind, item_id)
            except OpenNotebookError as exc:
                logger.warning("Open Notebook clean-up failed for %s: %s", item_id, exc)


open_notebook = OpenNotebookClient()
