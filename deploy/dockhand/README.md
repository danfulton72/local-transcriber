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
P4_UUID=GPU-...
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

Mark `DATABASE_URL`, `DEFAULT_PASSWORD` and `HF_TOKEN` as secrets in
Dockhand. `P4_UUID` is not secret.

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
  | grep -E 'whisper|piper|wyoming-openai-gateway|openwakeword|local-transcriber|speaker-analyzer'
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
