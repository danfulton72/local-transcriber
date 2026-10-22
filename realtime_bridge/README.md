# Open WebUI 0.12 Realtime bridge

This service exposes an OpenAI Realtime-compatible WebSocket at:

```text
ws://<voice-host>:8765/v1/realtime
```

It is intentionally only a protocol/orchestration layer:

```text
Open WebUI Realtime
      |
      v
speech-to-speech bridge (CPU)
      |-- STT --> Wyoming OpenAI Gateway --> Faster Whisper / P4
      |-- LLM --> llama-swap / T4
      '-- TTS --> Kokoro-FastAPI (GPU)
```

The bridge is based on Hugging Face `speech-to-speech` v1.1.0 (commit
`8ebde045`), the first release that honours `turn_detection.create_response`.
Open WebUI 0.12 sets `create_response: false` and requests each reply itself
after saving the transcript; earlier builds also answered on their own, the two
responses collided, and Open WebUI hung up the call. Silero VAD runs locally on
CPU. Smart Turn is disabled, and progressive/live STT is disabled by default.

Two build-time patches adapt it to Open WebUI:

- `patch_24k.py` defaults TTS output to the 24 kHz PCM Open WebUI plays.
- `patch_openwebui.py` keeps calls alive. Open WebUI ends a call on *any*
  provider `error` event, so the bridge accepts `input_audio_buffer.clear`
  (the Mute button), logs recoverable per-turn errors (`response_failed`,
  `conversation_item_not_found`, ...) instead of sending them, and makes the
  LLM read timeout configurable (`REALTIME_LLM_TIMEOUT_S`, default 120 s;
  upstream hard-codes 20 s, less than a llama-swap model load). A failed turn
  still ends with `response.done`, so the call simply carries on.

`REALTIME_NUM_PIPELINES` defaults to 2: a hung-up call keeps its pipeline until
its in-flight Whisper/LLM/TTS requests finish, and with one pipeline a quick
redial was rejected. `GET /v1/pool` on port 8765 shows each pipeline's state.

The bridge itself does not authenticate incoming Realtime connections. Keep
port 8765 on a trusted LAN or protect it with your reverse proxy/firewall.
Open WebUI may use any harmless placeholder API key.

The upstream LLM used by the bridge must support OpenAI-style function/tool
calling. Open WebUI's Realtime mode supplies a `generate_chat_completion`
tool so the voice agent can hand substantive requests to the model selected in
the Open WebUI chat.

See `deploy/dockhand/README.md` for the stack variables and Open WebUI fields.
