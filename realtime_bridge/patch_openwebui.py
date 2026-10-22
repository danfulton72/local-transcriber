"""Build-time patch: make speech-to-speech survive Open WebUI 0.12 Realtime calls.

Open WebUI's Realtime backend (backend/open_webui/routers/audio/realtime.py)
ends the whole call on *any* provider ``error`` event except
``response_cancel_not_active``. speech-to-speech uses ``error`` events for
several recoverable, per-turn conditions, so a single slow LLM reply, one
Whisper/Kokoro hiccup or pressing Mute hangs up the call. This patch:

1. Accepts ``input_audio_buffer.clear`` (sent by Open WebUI's Mute button).
   speech-to-speech does not implement it and answered with an
   ``unknown_or_invalid_event`` error.
2. Downgrades recoverable error events to log warnings instead of sending them
   to the client (``REALTIME_SUPPRESS_ERROR_TYPES``, comma separated). The
   failed response still ends with ``response.done``, which is what Open WebUI
   needs to carry on with the next turn.
3. Makes the LLM read timeout configurable (``REALTIME_LLM_TIMEOUT_S``).
   Upstream hard-codes 20 s, which a llama-swap model load/swap easily exceeds.

Each edit asserts an exact match so an upstream change fails the image build
instead of silently shipping an unpatched bridge. Idempotent.
"""
import sys
from pathlib import Path

import speech_to_speech

ROOT = Path(speech_to_speech.__file__).resolve().parent
MARKER = "OWUI-COMPAT-PATCHED"


def patch(rel: str, old: str, new: str) -> None:
    path = ROOT / rel
    src = path.read_text()
    if MARKER in src and new in src:
        print(f"{rel}: already patched")
        return
    count = src.count(old)
    assert count == 1, f"{rel}: expected 1 match, got {count}"
    path.write_text(src.replace(old, new))
    print(f"{rel}: patched")


# 1. Open WebUI's Mute button sends input_audio_buffer.clear.
patch(
    "api/openai_realtime/websocket_router.py",
    "    event = service.parse_client_event(raw)\n",
    "    # %s: Open WebUI's Mute sends input_audio_buffer.clear; acknowledge it\n"
    "    # instead of answering with an error that ends the call.\n"
    "    if raw.get(\"type\") == \"input_audio_buffer.clear\":\n"
    "        logger.info(\"input_audio_buffer.clear received (client muted); acknowledged\")\n"
    "        cleared = InputAudioBufferClearedEvent(\n"
    "            type=\"input_audio_buffer.cleared\", event_id=f\"event_{uuid.uuid4().hex}\"\n"
    "        )\n"
    "        await transport.send_events([cleared])\n"
    "        return\n"
    "\n"
    "    event = service.parse_client_event(raw)\n" % MARKER,
)
patch(
    "api/openai_realtime/websocket_router.py",
    "logger = logging.getLogger(__name__)\n",
    "logger = logging.getLogger(__name__)\n"
    "import uuid  # %s\n"
    "from openai.types.realtime import InputAudioBufferClearedEvent\n" % MARKER,
)

# 2. Recoverable per-turn errors must not hang up an Open WebUI call.
patch(
    "api/openai_realtime/transports.py",
    "    async def send_events(self, events: list[ServerEvent]) -> None:\n"
    "        async with self._send_lock:\n",
    "    async def send_events(self, events: list[ServerEvent]) -> None:\n"
    "        # %s: Open WebUI treats every error event as fatal for the call.\n"
    "        kept = []\n"
    "        for event in events:\n"
    "            error = getattr(event, \"error\", None) if getattr(event, \"type\", None) == \"error\" else None\n"
    "            if error is not None and getattr(error, \"type\", None) in _SUPPRESSED_ERROR_TYPES:\n"
    "                logger.warning(\"Not forwarding recoverable error to client: %%s: %%s\", error.type, error.message)\n"
    "                continue\n"
    "            kept.append(event)\n"
    "        events = kept\n"
    "        async with self._send_lock:\n" % MARKER,
)
patch(
    "api/openai_realtime/transports.py",
    "class WebSocketTransport(SessionTransport):\n",
    "import os as _os  # %s\n"
    "\n"
    "_SUPPRESSED_ERROR_TYPES = frozenset(\n"
    "    t.strip()\n"
    "    for t in _os.environ.get(\n"
    "        \"REALTIME_SUPPRESS_ERROR_TYPES\",\n"
    "        \"response_failed,conversation_item_not_found,input_audio_buffer_commit_empty,unknown_or_invalid_event\",\n"
    "    ).split(\",\")\n"
    "    if t.strip()\n"
    ")\n"
    "\n"
    "\n"
    "class WebSocketTransport(SessionTransport):\n" % MARKER,
)

# 3. Configurable LLM read timeout.
patch(
    "LLM/base_openai_compatible_language_model.py",
    "        request_timeout_s: float = 20.0,\n",
    "        request_timeout_s: float = float(os.environ.get(\"REALTIME_LLM_TIMEOUT_S\") or 20.0),  # %s\n" % MARKER,
)

print("speech-to-speech patched for Open WebUI Realtime compatibility")
sys.exit(0)
