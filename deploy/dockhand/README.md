# Dockhand Git-stack deployment

This is the recommended deployment when the R720 voice stack is managed by
Dockhand through a Hawser environment.

The stack definition is the repository-root file:

```text
docker-compose.dockhand.yml
```

It keeps persistent data on the Docker host under `/opt/stacks/voice`, but
builds the two Talk to Type images directly from the Git checkout supplied by
Dockhand:

- `local-transcriber` builds from `.`
- `speaker-analyzer` builds from `./speaker_service`

Whisper remains the existing host-local
`local/faster-whisper-p4:v2.4.0-ls71` image. Piper, the OpenAI-compatible
Wyoming gateway and OpenWakeWord remain image-based services.

An optional `realtime-voice` profile adds an OpenAI Realtime-compatible
WebSocket bridge for Open WebUI 0.12 voice calls. It runs the protocol/VAD
layer on CPU and delegates STT to the existing Whisper service, TTS to
Kokoro, and LLM/tool calls to an OpenAI-compatible model such as llama-swap.

## Dockhand Git stack settings

Create the stack from the repository:

```text
Repository: https://github.com/danfulton72/local-transcriber
Branch: main
Compose file path: docker-compose.dockhand.yml
Context directory: .
Build images on deploy: ON
Disable build cache: OFF
Re-pull images: OFF
```

Keep **Re-pull images** off because the Faster Whisper image is a local image
on the Docker host rather than an image Dockhand can pull from a registry.

A manual Deploy always deploys the current Git checkout. Auto-sync/webhook
deployment can be enabled later if desired.

## Stack variables

Do not put secrets in the Compose file. Configure these as Dockhand stack
variables instead.

Required:

```text
T4_UUID=GPU-...
DATABASE_URL=postgresql+asyncpg://transcriber:...@192.168.1.32:5432/transcriber
DEFAULT_PASSWORD=...
HF_TOKEN=...
```

Recommended:

```text
DEFAULT_USERNAME=Dan
DEFAULT_DISPLAY_NAME=Dan
AUTH_SESSION_DAYS=30
AUTH_COOKIE_SECURE=true
DEFAULT_LANGUAGE=
DEFAULT_VOICE=en_GB-northern_english_male-medium
SPEAKER_MATCH_THRESHOLD=0.78
KEEP_LIVE_CHUNK_AUDIO=false
PYANNOTE_MODEL=pyannote/speaker-diarization-community-1
```

Optional, for **Tools → Meeting notes & Open Notebook** (leave `LLM_BASE_URL`
unset to hide notes, and `OPEN_NOTEBOOK_URL` unset to keep notes local):

```text
LLM_BASE_URL=http://<llama-server-host>:8080/v1
LLM_MODEL=meeting-llm
LLM_API_KEY=
LLM_CONTEXT_TOKENS=32768
LLM_CHUNK_TOKENS=12000
LLM_MAX_OUTPUT_TOKENS=4096
LLM_DISABLE_THINKING=true
NOTES_TIMEZONE=Europe/London
OPEN_NOTEBOOK_URL=http://<open-notebook-host>:5055
OPEN_NOTEBOOK_PASSWORD=...
OPEN_NOTEBOOK_NOTEBOOK_ID=
OPEN_NOTEBOOK_UI_URL=http://<open-notebook-host>:8502
```

These URLs are used from inside the `local-transcriber` container, so use a
LAN address, or `host.docker.internal` for a service running directly on the
Docker host. `LLM_MODEL` must match llama-server's `--alias`, and
`LLM_CONTEXT_TOKENS` its `-c`.

### Optional Open WebUI 0.12 Realtime voice

Enable the profile with this Dockhand stack variable:

```text
COMPOSE_PROFILES=realtime
```

The bridge can reuse the same OpenAI-compatible LLM settings used for Meeting
Notes. If `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` already point at
the desired llama-swap model, no additional LLM variables are required.

To use a separate/faster voice-router model, set:

```text
REALTIME_LLM_BASE_URL=http://<llama-swap-host>:<port>/v1
REALTIME_LLM_MODEL=<fast-tool-calling-model-id>
REALTIME_LLM_API_KEY=<llama-swap-api-key>
REALTIME_TTS_VOICE=bm_george
REALTIME_STT_LANGUAGE=en
REALTIME_NUM_PIPELINES=2
REALTIME_LLM_TIMEOUT_S=120
REALTIME_VAD_MIN_SILENCE_MS=250
REALTIME_LIVE_TRANSCRIPTION=false
REALTIME_DISABLE_THINKING=true
REALTIME_LOG_LEVEL=info
```

`REALTIME_LLM_MODEL` should be a low-latency model that supports OpenAI-style
function/tool calling. Open WebUI's Realtime client supplies a
`generate_chat_completion` function so substantive requests can still be
handed to the model selected in the Open WebUI chat.

`REALTIME_NUM_PIPELINES=2` is deliberate. After a hang-up the call's pipeline
stays busy ("draining") until its in-flight Whisper/LLM/TTS requests finish;
with a single pipeline, redialling in that window, or Open WebUI reconnecting
after a model or voice change, was rejected with `session_limit_reached`.

`REALTIME_LLM_TIMEOUT_S` is the per-read timeout for the voice LLM. It must
cover llama-swap loading or swapping the model before the first token. If the
voice model and the Open WebUI chat model share a GPU, every
`generate_chat_completion` hand-off can evict the voice model, so the next
voice reply waits for a reload.

`REALTIME_VAD_MIN_SILENCE_MS=250` cuts the number of speculative Whisper
requests: upstream's 64 ms re-sends the growing utterance on every
micro-pause. End-of-turn stays at roughly this value plus 0.8 s.

`REALTIME_LIVE_TRANSCRIPTION=false` is intentional. With the external
OpenAI-compatible STT backend, progressive transcription would repeatedly
upload the growing utterance to Whisper while the user is talking. The default
sends one final transcription request per spoken turn instead.

The bridge listens on host port `8765` and does not authenticate incoming
Realtime connections. Keep that port on a trusted LAN or protect it with your
normal reverse proxy/firewall. The upstream llama-swap API key is still used
for bridge-to-LLM requests.

Mark `REALTIME_LLM_API_KEY` as a secret when you set it.

In **Open WebUI 0.12 → Admin Panel → Settings → Audio → Voice calls** use:

```text
Call mode: Realtime
OpenAI API Base URL: http://192.168.1.32:8765/v1
API Key: local
Voice Model: local
Voice: bm_george
Input Transcription Model: whisper-1
Input Parameters: leave blank
Prompt Template: leave blank unless you want custom voice-agent instructions
```

The Voice value must be a Kokoro voice (for example `bm_george`). Open WebUI
sends the Realtime session voice to the bridge, and that voice is then
forwarded to Kokoro's `POST /v1/audio/speech`.

The ordinary Open WebUI Speech-to-Text/Text-to-Speech settings can remain on
`http://192.168.1.32:8555/v1` for Standard call mode. Only the Realtime
Voice Calls section points to port `8765`.

Mark `DATABASE_URL`, `DEFAULT_PASSWORD` and `HF_TOKEN` as secrets in
Dockhand, and also `OPEN_NOTEBOOK_PASSWORD` and `LLM_API_KEY` if you use them.
`T4_UUID` is not secret.

The Compose file deliberately does not use `env_file:`. Dockhand resolves
the stack variables and sends the rendered environment to Hawser.

The following values are fixed inside the stack so they cannot accidentally
fall back to host networking:

```text
local-transcriber -> http://wyoming-openai-gateway:8555/v1
local-transcriber -> http://speaker-analyzer:9000
speaker-analyzer  -> http://wyoming-openai-gateway:8555/v1
```

## Persistent host paths

The Git checkout is build input only. Persistent data remains on the Docker
host:

```text
/opt/stacks/voice/whisper-data
/opt/stacks/voice/piper-data
/opt/stacks/voice/openwakeword
/opt/stacks/voice/speaker-model-cache
/opt/stacks/voice/local-transcriber/recordings
```

Deleting or replacing Dockhand's Git checkout therefore does not remove the
recordings or model data.

## Converting an existing Internal Dockhand stack

Do not create a second deployed stack while the current `voice` stack is
still running: the fixed container names and published ports intentionally
match the existing production stack.

For the one-time conversion:

1. Confirm the current stack is healthy and that the directories above contain
   the expected data.
2. Save/export the current Internal stack definition as a rollback reference.
3. In Dockhand, **Down** the existing `voice` stack with volume removal
   disabled. This removes containers/network only; the stack uses absolute bind
   mounts, so the data under `/opt/stacks/voice` is untouched.
4. Remove the old Internal stack entry from Dockhand.
5. Create a new **Git** stack named `voice` using the settings and variables
   above.
6. Deploy it with **Build images on deploy** enabled.
7. Verify the checks below.

This causes a short voice-service outage during the one-time handover, but
does not copy or migrate persistent data.

Do not select any option that deletes host bind data or volumes during the
handover.

## Verification

After deployment, on the Docker host:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' \
  | grep -E 'whisper|piper|wyoming-openai-gateway|openwakeword|local-transcriber|speaker-analyzer|realtime-voice'
```

Check the Talk to Type version:

```bash
docker exec local-transcriber \
  python -c 'from app.main import app; print(app.version)'
```

Check application/gateway health:

```bash
curl -fsS http://127.0.0.1:8090/healthz
echo
```

Check the analyzer's gateway wiring:

```bash
docker exec speaker-analyzer printenv GATEWAY_BASE_URL
```

Expected:

```text
http://wyoming-openai-gateway:8555/v1
```

Check analyzer health and P4 visibility:

```bash
docker exec -i local-transcriber python - <<'PY'
import json
import httpx

r = httpx.get("http://speaker-analyzer:9000/healthz", timeout=30)
r.raise_for_status()
print(json.dumps(r.json(), indent=2))
PY
```

If the `realtime` profile is enabled, verify the bridge is healthy and
listening:

```bash
docker inspect --format '{{json .State.Health}}' realtime-voice | jq
docker exec realtime-voice python -c "import socket; s=socket.create_connection(('127.0.0.1',8765),5); print('realtime bridge listening'); s.close()"
docker logs --tail=100 realtime-voice
curl -fsS http://127.0.0.1:8765/v1/pool | jq
```

`/v1/pool` should show idle units between calls. A unit stuck in `draining`
or `stuck` means a backend request never returned; `docker logs` names it.
"Not forwarding recoverable error" log lines are turns that failed without
ending the call.

The bridge warms up both external audio endpoints during startup, so a healthy
container is also a useful check that the Wyoming STT and TTS endpoints are
reachable.

Then make one short recording and run one admin speaker analysis.

## Updating

For normal application updates, do not SSH in and manually rebuild the two Talk
to Type images. Sync/deploy the Git stack in Dockhand. With **Build images on
deploy** enabled, Dockhand rebuilds the repository-backed images before
recreating services whose image/configuration changed.

The app performs `alembic upgrade head` during startup. For a release with a
database migration, take the normal PostgreSQL backup before deploying.

Whisper's custom image is not rebuilt by this Git stack. Rebuilding that image
remains a separate host-level maintenance task because its Dockerfile is not in
this repository.
