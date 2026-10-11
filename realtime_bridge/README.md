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
      '-- TTS --> Wyoming OpenAI Gateway --> Piper / CPU
```

The bridge is based on Hugging Face `speech-to-speech`, pinned to upstream commit
`ee6b7a850f7833958b5101ebc22e5d084ea9be3f` because the released `1.0.0`
rejects Open WebUI 0.12 `chat_context_*` item IDs and lacks
`conversation.item.delete`. Silero VAD
runs locally on CPU. Smart Turn is disabled, and progressive/live STT is
disabled by default so one final Whisper request is made per spoken turn
instead of repeatedly retranscribing the growing utterance.

The bridge itself does not authenticate incoming Realtime connections. Keep
port 8765 on a trusted LAN or protect it with your reverse proxy/firewall.
Open WebUI may use any harmless placeholder API key.

The upstream LLM used by the bridge must support OpenAI-style function/tool
calling. Open WebUI's Realtime mode supplies a `generate_chat_completion`
tool so the voice agent can hand substantive requests to the model selected in
the Open WebUI chat.

See `deploy/dockhand/README.md` for the stack variables and Open WebUI fields.
