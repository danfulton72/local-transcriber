# Local Transcriber

A local-first, kid-friendly speech-to-text app for turning spoken ideas into editable text while keeping recordings, transcripts and progress history on your own infrastructure.

## What it does

- Large, simple **Talk** screen with near-live transcription
- Saves the full voice recording plus the Whisper transcript and timestamp
- Stores near-live audio chunks for troubleshooting/recovery
- Keeps the original Whisper transcript separately from later edits
- **My words** history with search, favourites, playback and soft-delete
- Piper read-aloud for full transcripts or individual sentences
- **Progress** page for grown-ups with:
  - recording sessions
  - minutes spoken
  - words dictated
  - average session length
  - sessions edited
  - read-aloud usage
  - frequently corrected word pairs based only on explicit edits
  - longest saved piece
  - words dictated over time
- Optional parent PIN for the Progress API/page

The app deliberately does **not** track attention, mouse movement, mood, sentiment, reading ability or other passive behavioural signals.

## Architecture

```text
Browser (HTTPS)
      |
      v
Local Transcriber :8090
  |       |       |
  |       |       +--> recordings volume (WAV + chunk WAVs)
  |       +----------> existing PostgreSQL server
  +------------------> existing Wyoming OpenAI Gateway :8555
                           |                 |
                           v                 v
                    Faster Whisper        Piper
```

Your existing Whisper, Piper and Wyoming OpenAI Gateway containers remain separate and unchanged.

## PostgreSQL

Use your existing PostgreSQL **server**, but give this app a dedicated database and login. For example, as a PostgreSQL administrator:

```sql
CREATE USER transcriber WITH PASSWORD 'choose-a-long-password';
CREATE DATABASE transcriber OWNER transcriber;
```

The application creates its initial tables automatically on first start.

## Install

```bash
git clone https://github.com/danfulton72/local-transcriber.git
cd local-transcriber
cp .env.example .env
mkdir -p recordings
```

Edit `.env`:

```env
DATABASE_URL=postgresql+asyncpg://transcriber:YOUR_PASSWORD@192.168.1.32:5432/transcriber
GATEWAY_BASE_URL=http://host.docker.internal:8555/v1
RECORDINGS_DIR=/data/recordings

# Optional but recommended for the grown-up Progress page
PARENT_PIN=1234

DEFAULT_LANGUAGE=
DEFAULT_VOICE=en_GB-northern_english_male-medium
```

Then build and start:

```bash
docker compose up -d --build
```

Check it:

```bash
docker compose ps
curl http://localhost:8090/healthz
```

The app listens on port `8090`. Keep using your HTTPS reverse proxy in front of it so browsers allow microphone access.

## Existing speech services

The default Compose configuration reaches the already-running gateway through:

```text
host.docker.internal:8555
```

On Linux, `extra_hosts: host.docker.internal:host-gateway` is already included in `compose.yml`.

Expected gateway endpoints:

```text
POST /v1/audio/transcriptions
POST /v1/audio/speech
GET  /v1/voices
```

## Stored data

PostgreSQL stores recording timestamps/duration/status, title/favourite state, original and edited transcripts, edit revisions, near-live chunk transcript metadata, and explicit usage events such as read-aloud and copy.

The `recordings/` volume stores the full WAV recording and near-live chunk WAV files.

### Backups

A complete backup needs **both** the PostgreSQL `transcriber` database and the `recordings/` directory/volume. Keeping only one loses either searchable history or the original voice recordings.

## Privacy model

The Progress page is based only on data needed for the app itself plus explicit actions. Correction counts compare the saved original Whisper transcript with the transcript the user deliberately edited and saved.

Nothing is sent to a cloud transcription or analytics service by this application.

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[test]'

DATABASE_URL=sqlite+aiosqlite:///./dev.db \
RECORDINGS_DIR=./recordings \
uvicorn app.main:app --reload --port 8090
```

Run checks:

```bash
pytest -q
node --check app/static/app.js
python -m compileall -q app
```
