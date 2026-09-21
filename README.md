# Local Transcriber

A local-first, kid-friendly speech-to-text app for turning spoken ideas into editable text while keeping recordings, transcripts and progress history on your own infrastructure.

## What it does

- Large, simple **Talk** screen with calmer near-live transcription:
  - confirmed words stay solid
  - the newest, still-being-checked words are shown more lightly
  - gentle auto-follow pauses when the reader scrolls back
- **Keep talking** appends new dictation to the same saved piece
- Crash/interruption recovery with immediate browser drafts plus server-side autosave
- Sentence-by-sentence editing with autosaved edit drafts
- **Reading focus** mode that turns the screen into a large, distraction-light transcript
- **Use my words** uses the device share sheet when available and falls back to clipboard
- Installable home-screen PWA for supported desktop, tablet and mobile browsers
- Saves voice captures as separate audio segments plus the Whisper transcript and timestamp
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
- Parent storage tools:
  - recycle bin with restore and permanent delete
  - voice-audio retention (forever / 30 / 90 / 365 days)
  - optional delete-audio-after-transcription mode
  - local service/storage status
  - downloadable backup ZIP containing metadata and retained audio

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

The database schema is managed with **Alembic migrations**. Migrations run automatically when the application starts, including when upgrading an existing installation.

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

## Updating an existing install

Before a significant upgrade, keep your normal PostgreSQL/recordings backup. Then:

```bash
cd ~/local-transcriber
git pull
docker compose up -d --build
docker compose logs --tail=100 local-transcriber
```

The container runs `alembic upgrade head` automatically during startup. Existing PostgreSQL data and the `recordings/` directory are preserved; this release adds draft/recovery fields and an audio-segment table without replacing existing recordings.

Then hard-refresh the browser. If you previously installed the PWA, its service worker uses network-first updates for the app shell so refreshed versions are picked up rather than being permanently pinned to an old JavaScript/CSS cache.

### Install on a phone, tablet or desktop

Open **Grown-up settings → Install on this device**. On browsers with a native install prompt it will open directly. On iPhone/iPad, use **Share → Add to Home Screen**.

### Parent storage tools

Open **Progress**, enter the parent PIN, and press **Show progress**. The lower part of the page contains:

- **Voice recording retention** — controls stored audio only; transcripts/history remain.
- **Backup & status** — checks PostgreSQL, the speech gateway and local audio storage, and can download an application backup ZIP.
- **Recycle bin** — restore soft-deleted work or permanently remove it.

Retention cleanup runs on application startup and whenever a recording finishes. Permanent delete removes the database history for that recording and its stored audio.

The downloadable ZIP is a convenient app-level backup. For infrastructure/disaster recovery, retaining your normal PostgreSQL backup as well is still recommended.

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[test]'

DATABASE_URL=sqlite+aiosqlite:///./dev.db alembic upgrade head

DATABASE_URL=sqlite+aiosqlite:///./dev.db \
RECORDINGS_DIR=./recordings \
uvicorn app.main:app --reload --port 8090
```

Run checks:

```bash
pytest -q
node --check app/static/app.js
node --check app/static/sw.js
python -m json.tool app/static/manifest.webmanifest > /dev/null
python -m compileall -q app migrations
```
