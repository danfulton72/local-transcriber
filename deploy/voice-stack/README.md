# Talk to Type in the voice stack

This is the recommended production deployment for the R720 voice stack.

It targets the existing stack layout:

```text
/home/dan/voice/
    docker-compose.yml
    .env                  # contains P4_UUID
    whisper/
    whisper-data/
    piper-data/
    openwakeword/
    local-transcriber/    # this repository
    speaker-model-cache/  # pyannote/Hugging Face cache
```

The existing `docker-compose.yml` is left unchanged. The installer symlinks
`deploy/voice-stack/compose.override.yml` to
`/home/dan/voice/docker-compose.override.yml`, so normal `docker compose`
commands automatically include Talk to Type.

## Architecture

```text
Browser / PWA
    |
    v
local-transcriber :8090
    |
    +---- STT/TTS ----> wyoming-openai-gateway :8555
    |                       |               |
    |                       v               v
    |                    whisper           piper
    |                       |
    |                    Tesla P4
    |
    +---- speaker analysis ----> speaker-analyzer
                                  |
                               Tesla P4
```

Both Faster Whisper and pyannote are pinned to the same `${P4_UUID}`.
The speaker analyzer is admin-triggered and loads pyannote only when needed.
With `SPEAKER_UNLOAD_AFTER_DIARIZATION=true`, it releases pyannote's CUDA
residency after diarization and before sending speaker-turn clips through the
existing Whisper gateway. This prevents pyannote from remaining resident on
the 8 GB P4 after an analysis.

The app talks to the gateway over the Compose network using
`http://wyoming-openai-gateway:8555/v1`; no host-loopback bridge is required.

## Fresh install

Place this repository at:

```text
/home/dan/voice/local-transcriber
```

Ensure the voice stack root `.env` already contains the Tesla P4 UUID:

```env
P4_UUID=GPU-...
```

Then:

```bash
cd /home/dan/voice/local-transcriber
python deploy/voice-stack/install.py
nano .env
```

The app `.env` still contains Talk to Type settings such as PostgreSQL
credentials, login bootstrap values and `HF_TOKEN`. The Compose overlay
overrides the gateway and speaker-service addresses with the in-stack service
names.

Build only the two Talk to Type images:

```bash
cd /home/dan/voice
docker compose build local-transcriber speaker-analyzer
```

Run migrations using the newly built app image:

```bash
docker compose run --rm --no-deps local-transcriber alembic upgrade head
docker compose run --rm --no-deps local-transcriber alembic current
```

Then start the two services:

```bash
docker compose up -d local-transcriber speaker-analyzer
```

This does not rebuild or recreate Whisper, Piper or OpenWakeWord.

## Move an existing AI-stack install

Do these steps from the currently deployed `main` branch.

### 1. Stop and remove only the old Talk to Type containers

While the old AI-stack override still exists:

```bash
cd /home/dan/ai

docker compose \
  -f /home/dan/ai/docker-compose.yaml \
  -f /home/dan/ai/compose.override.yml \
  stop local-transcriber speaker-analyzer

docker compose \
  -f /home/dan/ai/docker-compose.yaml \
  -f /home/dan/ai/compose.override.yml \
  rm -f local-transcriber speaker-analyzer
```

Do not stop or recreate `llama-swap-t4` or the rest of the AI stack.

### 2. Detach the managed AI-stack integration

```bash
python /home/dan/ai/local-transcriber/deploy/ai-stack/uninstall.py
```

This removes only the Talk to Type managed Compose override and the
`speaker_auto` entries from `llama-swap/t4.yaml`. It makes a backup before
editing the T4 config. It does not restart the T4 service.

### 3. Move the pyannote cache into the voice stack

```bash
mkdir -p /home/dan/voice/speaker-model-cache

rsync -a \
  /databases/aimodels/talk-to-type/pyannote/ \
  /home/dan/voice/speaker-model-cache/
```

Keep the old cache until speaker analysis has been tested successfully from
the voice stack.

### 4. Move the repository, including .env and recordings

```bash
mv /home/dan/ai/local-transcriber /home/dan/voice/local-transcriber
```

Because `recordings/` is inside the repository directory, the retained WAV
files move with it. PostgreSQL remains external and is not moved.

### 5. Install the voice-stack override

```bash
cd /home/dan/voice/local-transcriber
python deploy/voice-stack/install.py
```

The installer checks that `P4_UUID` is configured and that the Compose
project contains `whisper`, `piper` and `wyoming-openai-gateway`.

### 6. Build, migrate and start

```bash
cd /home/dan/voice

docker compose build local-transcriber speaker-analyzer

docker compose run --rm --no-deps local-transcriber alembic upgrade head
docker compose run --rm --no-deps local-transcriber alembic current

docker compose up -d local-transcriber speaker-analyzer
```

## Verification

```bash
cd /home/dan/voice

docker compose ps \
  local-transcriber speaker-analyzer whisper piper wyoming-openai-gateway

docker compose exec -T local-transcriber \
  python -c 'from app.main import app; print(app.version)'

docker compose exec -T speaker-analyzer python - <<'PY'
import torch
print("CUDA:", torch.version.cuda)
print("available:", torch.cuda.is_available())
print("count:", torch.cuda.device_count())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    print("capability:", torch.cuda.get_device_capability(0))
PY

curl -fsS http://127.0.0.1:8090/healthz
echo
```

The speaker analyzer should report one visible GPU, the Tesla P4.

Then run one admin speaker analysis. After it completes, Tools → Speakers
should report the analyzer as not loaded until the next analysis because the
voice-stack deployment deliberately unloads pyannote after diarization.

## P4 sharing notes

The P4 is shared, not exclusively reserved:

- Faster Whisper remains the normal live STT service.
- pyannote uses the P4 only during an admin-triggered diarization pass.
- pyannote releases its CUDA model before per-turn Whisper transcription.
- normal Talk to Type capture does not start speaker analysis automatically.

If simultaneous live transcription and speaker analysis causes CUDA OOM on
your workload, do not increase container privileges or mount the Docker socket
into the app. The next safe escalation is an explicit voice-stack GPU
scheduler that serializes Whisper and diarization. The default integration
does not require that complexity.

## Rollback

Before deleting anything from the old AI layout, keep:

- the PostgreSQL database
- `/home/dan/voice/local-transcriber/recordings`
- the old pyannote cache until the new analyzer is verified
- the backup created by `deploy/ai-stack/uninstall.py`

To move back, stop/remove only `local-transcriber` and `speaker-analyzer`
from the voice stack, remove the managed voice-stack override symlink, move the
repo back to `/home/dan/ai/local-transcriber`, and rerun
`deploy/ai-stack/install.py`.
