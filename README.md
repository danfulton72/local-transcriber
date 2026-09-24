# Local Transcriber

A local-first, kid-friendly speech-to-text app for turning spoken ideas into editable text while keeping recordings, transcripts and progress history on your own infrastructure.

## What it does

- Username/password sign-in with separate per-user recordings, drafts, history and progress
- Parent-only user management for adding accounts, resetting passwords and deactivating/reactivating users
- Shared remembered speaker voiceprints across all app users
- Selectable recording input:
  - device microphone
  - browser tab / window / computer audio when the browser supplies shared audio
  - mixed computer audio + microphone for calls and conversations
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
- Parent-only **Conversation speakers** tools:
  - post-process a saved conversation into Person 1 / Person 2 / Person 3 turns
  - optionally set the expected number of speakers
  - rename detected people for that analysis
  - **Remember this speaker** stores local speaker embeddings for future matching
  - each remembered person can keep up to 8 confirmed voice samples from different recordings
  - matching uses the strongest 1–3 samples rather than one running average, which is more tolerant of room/microphone variation and one poor sample
  - samples under 3 seconds of attributed speech are rejected
  - review/remove individual voice samples, rename the person, or forget the whole voiceprint at any time
  - recognised speakers are reviewed/managed in the parent area; after a parent completes an analysis, reopening that saved conversation in **Your words** shows the resolved speaker names beside their turns
- Parent storage tools:
  - recycle bin with restore and permanent delete
  - voice-audio retention (forever / 30 / 90 / 365 days)
  - optional delete-audio-after-transcription mode
  - local service/storage status
  - downloadable backup ZIP containing metadata and retained audio

The app deliberately does **not** track attention, mouse movement, mood, sentiment, reading ability or other passive behavioural signals.

## Architecture

The recommended deployment is now part of the existing R720 `ai-stack` Compose project:

```text
Browser (HTTPS)
      |
      v
Local Transcriber :8090  ───────> existing PostgreSQL
      |
      +──── live speech ─────────> existing Wyoming OpenAI Gateway :8555
      |                              |                 |
      |                              v                 v
      |                       Faster Whisper        Piper
      |
      +──── parent analysis ──────> llama-swap-t4
                                      |
                                 speaker_auto
                                      |
                                      v
                               speaker-analyzer
                                      |
                                   Tesla T4
```

The app and analyzer share the existing `ai` bridge network. Pyannote model/cache data lives under `/databases/aimodels/talk-to-type/pyannote`, while application state and recordings live under `/home/dan/ai/local-transcriber`.

Whisper, Piper and the Wyoming OpenAI Gateway remain separate and unchanged. Speaker analysis is still parent-triggered and post-recording only; live transcription is unchanged.

When speaker analysis starts, Talk to Type asks the existing `llama-swap-t4` instance to load a hidden `speaker_auto` reservation. The T4 matrix evicts the current Qwen/embedding processes first, pyannote runs, and the app restores the previously-running T4 models afterwards unless another request has already claimed the GPU.

## Computer / system audio capture

Under **Grown-up settings → Audio source**, choose:

- **Microphone** — the normal Talk to Type microphone path.
- **Computer audio** — pressing **Start capture** opens the browser's share picker. For Teams or another desktop application, choose **Entire Screen** and enable **Share system audio**. For browser media, choose the relevant tab and enable **Share tab audio**.
- **Computer audio + microphone** — captures the selected computer/system audio and the device microphone, mixes them locally with the Web Audio API, and sends the resulting mono stream through the existing near-live Whisper pipeline.

The app never silently intercepts device audio. Browser screen/audio capture requires a fresh user action and permission each time. Browsers require a video/display track for this API, but Talk to Type does not read, encode or store screen pixels; it uses that track only to detect when sharing ends. Browser/OS support varies, and a requested screen share may contain no audio track; Talk to Type detects that case before creating a recording and gives mode-specific guidance. On Windows Chrome/Edge, **Entire Screen + Share system audio** is the recommended mode for Teams desktop and other application audio.

Stopping sharing from the browser's sharing controls automatically finishes and saves the current Talk to Type recording. The captured WAV is stored and handled exactly like microphone recordings, so parent-run speaker diarization can also be used afterwards.

This is primarily a desktop-browser feature. Chrome/Edge generally provide the most useful tab/system-audio choices; phones/tablets and other browsers may provide limited or no shared audio.

### Hear a speaker before tagging

In **Progress → Conversation speakers**, every detected speaker with attributed speech now has a **Hear sample** button. It plays up to 8 seconds from that speaker's longest continuous diarized turn, trimmed slightly inside the turn boundaries to reduce neighbouring-speaker bleed.

The preview is generated on demand from the existing saved recording. It is parent-only, is never added as another stored audio file, and is intended to help the operator recognise the person before saving a tag or adding a remembered voice sample.

### Listen, follow and edit

For saved conversations with speaker analysis, **My voice** now opens an interactive playback bar with pause/resume, ±5 second seeking, playback speed, elapsed/total time, and **Follow audio**.

While the original recording plays, the current speaker turn is highlighted and automatically kept in view. Manual scrolling or clicking into an inline edit pauses automatic following; **Follow audio** jumps back to the current spoken turn and resumes following.

Each speaker turn can be edited directly in **Your words** while audio continues playing. Turn edits autosave after a short pause in typing. The diarized original text is retained separately, while the corrected turn text is used to rebuild the recording's normal edited transcript for search, copy/share and later reopening. Clicking a turn timestamp starts or seeks the original recording at that point.

### Responsive workspace

On desktop, Talk to Type uses the full available workspace beside the left navigation rail instead of imposing a narrow fixed content column. **Talk**, **My words**, **Progress** and parent tools all expand with the viewport, while phone layouts keep the compact bottom navigation and touch-friendly spacing.

## Parent-only conversation speakers

Speaker diarization and voice recognition are deliberately kept behind the parent PIN.

### One-time pyannote model access

The open-source `pyannote/speaker-diarization-community-1` model is gated on Hugging Face. Before the first analysis:

1. Sign in to Hugging Face and accept the access conditions for `pyannote/speaker-diarization-community-1`.
2. Create a Hugging Face access token that can download the model.
3. Put the token in `.env` as `HF_TOKEN=...`.
4. Rebuild with `docker compose up -d --build`.

In the recommended AI-stack deployment, downloaded model files are cached under `/databases/aimodels/talk-to-type/pyannote`, alongside the rest of the AI model store. The standalone Compose deployment still uses `./speaker-model-cache`.

The speaker analyzer uses the NVIDIA GPU by default (`SPEAKER_DEVICE=cuda`). It is parent-triggered after recording, so it does not alter the child-facing live transcription path.


### GPU selection

The recommended AI-stack deployment borrows the existing **Tesla T4** through `llama-swap-t4`. The analyzer container is pinned to `${T4_UUID}`; the large T4 llama-server processes are evicted for the duration of parent-triggered speaker analysis, while the separate live Whisper workload remains untouched.

The CUDA 12.6 speaker image is retained because it works on the T4 and also leaves a Tesla P4/Pascal fallback available if you later choose to dedicate that card instead.

### Workflow

Open **Progress**, enter the parent PIN, then use **Conversation speakers**:

1. Choose a saved recording.
2. Optionally specify the expected number of speakers.
3. Press **Analyse conversation**.
4. Review turns labelled Person 1, Person 2, etc.
5. Rename a detected person if useful.
6. Press **Remember this speaker** only when you want that local voiceprint used for future matching.
7. On later conversations, use **Add voice sample** for the same person to strengthen their profile.

Each remembered person keeps a small bank of up to 8 normalized speaker embeddings. The matcher scores a new voice against the strongest few samples rather than relying on one running average. Samples with less than 3 seconds of attributed speech are not accepted, and the same detected speaker cannot be added twice from one analysis. Existing single-embedding profiles are migrated into the bank as their first sample.

Remembered voiceprints are numeric speaker embeddings stored in your PostgreSQL database. The app does not expose them to the child-facing Talk or My words pages. Recognition is a similarity match, not proof of identity, so parent review remains authoritative.

## Users and sign-in

The app has database-backed user accounts. Each logged-in user has their own:

- recordings and stored audio
- interrupted-draft recovery
- My words history and favourites
- progress statistics and correction history
- recycle bin
- parent-run conversation analyses for their recordings

Remembered speaker voiceprints are intentionally shared across users, so a voice remembered while reviewing one user's conversation can be recognised in another user's parent-run conversation analysis.

Passwords are stored only as salted PBKDF2-SHA256 hashes. Login sessions use an HTTP-only SameSite cookie; the database stores only a SHA-256 hash of each random session token.

### First upgrade to multi-user

Before the **first** startup of the multi-user release, add these values to your existing `.env`:

```env
DEFAULT_USERNAME=your-login-name
DEFAULT_PASSWORD=choose-a-long-password
DEFAULT_DISPLAY_NAME=Display name
AUTH_SESSION_DAYS=30
AUTH_COOKIE_SECURE=true
```

On that first startup, the default account is created if it does not already exist and all recordings created before user support are assigned to it. The environment password is a bootstrap value: changing `DEFAULT_PASSWORD` later does not silently overwrite the password already stored for that user. Use **Progress → Users** with the parent PIN to reset passwords after bootstrap.

The application has fallback bootstrap values so an upgrade cannot permanently lock itself out, but you should set your own credentials before first startup.

## Recommended: install directly inside the existing AI stack

For the Dell R720 deployment, clone Talk to Type directly as:

```text
/home/dan/ai/local-transcriber
```

This keeps source code, `.env`, recordings, and runtime coordination files together in one app directory under the AI stack. The only app-owned files stored elsewhere are the large pyannote/Hugging Face cache files, which live under `/databases/aimodels/talk-to-type/pyannote` with the rest of the model store.

For a clean install:

```bash
cd /home/dan/ai
git clone https://github.com/danfulton72/local-transcriber.git
cd local-transcriber

python deploy/ai-stack/install.py
nano .env
```

The installer backs up `/home/dan/ai/llama-swap/t4.yaml`, adds the hidden `speaker_auto` T4 reservation, creates `recordings/` and `runtime/`, creates the shared pyannote model directory, links the Compose override into `/home/dan/ai`, and validates the combined stack.

Then start from the main AI-stack directory:

```bash
cd /home/dan/ai
docker compose up -d --build
```

From then on:

```bash
cd /home/dan/ai/local-transcriber
git pull

cd /home/dan/ai
docker compose up -d --build
```

Directory layout:

```text
/home/dan/ai/local-transcriber/
    source code
    .env
    recordings/
    runtime/

/databases/aimodels/talk-to-type/pyannote/
    pyannote / Hugging Face cache
```

Full setup, verification and rollback instructions are in `deploy/ai-stack/README.md`.

## PostgreSQL

Use your existing PostgreSQL **server**, but give this app a dedicated database and login. For example, as a PostgreSQL administrator:

```sql
CREATE USER transcriber WITH PASSWORD 'choose-a-long-password';
CREATE DATABASE transcriber OWNER transcriber;
```

The database schema is managed with **Alembic migrations**. Migrations run automatically when the application starts, including when upgrading an existing installation.

## Standalone install

The root `compose.yml` remains available for development or a standalone deployment. The R720 production layout should use the AI-stack install above.

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

# First account / legacy recording owner
DEFAULT_USERNAME=local
DEFAULT_PASSWORD=choose-a-long-password
DEFAULT_DISPLAY_NAME=Local user
AUTH_SESSION_DAYS=30
AUTH_COOKIE_SECURE=true

DEFAULT_LANGUAGE=
DEFAULT_VOICE=en_GB-northern_english_male-medium

# Parent-only speaker diarization / remembered speakers
SPEAKER_SERVICE_URL=http://speaker-analyzer:9000
SPEAKER_MATCH_THRESHOLD=0.78
HF_TOKEN=YOUR_HUGGINGFACE_TOKEN
PYANNOTE_MODEL=pyannote/speaker-diarization-community-1
SPEAKER_DEVICE=cuda
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

## Updating the AI-stack install

For the recommended R720 layout:

```bash
cd ~/ai/local-transcriber
git pull

cd ~/ai
docker compose up -d --build
docker compose logs --tail=100 local-transcriber speaker-analyzer
```

Rerun `python deploy/ai-stack/install.py` from `~/ai/local-transcriber` whenever the integration/T4 arbitration files change.

The container runs `alembic upgrade head` automatically during startup. Existing PostgreSQL data and the `recordings/` directory are preserved. The current schema migrations also add users/sessions and assign legacy recordings to the bootstrap account on startup without replacing existing recordings.

Then hard-refresh the browser. If you previously installed the PWA, its service worker uses network-first updates for the app shell so refreshed versions are picked up rather than being permanently pinned to an old JavaScript/CSS cache.

### Install on a phone, tablet or desktop

Open **Grown-up settings → Install on this device**. On browsers with a native install prompt it will open directly. On iPhone/iPad, use **Share → Add to Home Screen**.

### Parent storage tools

Open **Progress**, enter the parent PIN, and press **Show progress**. Progress and the recycle bin apply only to the currently logged-in user. The lower part of the page contains:

- **Users** — add accounts, change display names, reset passwords, and deactivate/reactivate accounts. A password reset revokes that user's existing sessions.

- **Voice recording retention** — controls stored audio only; transcripts/history remain.
- **Backup & status** — checks PostgreSQL, the speech gateway and local audio storage, and can download an application backup ZIP.
- **Recycle bin** — restore soft-deleted work or permanently remove it.

Retention cleanup runs on application startup and whenever a recording finishes. Permanent delete removes the database history for that recording and its stored audio.

The downloadable ZIP is a convenient app-level backup. It includes remembered speaker embeddings and speaker-analysis metadata when those features have been used, so treat backup ZIPs as sensitive data just like the stored voice recordings. For infrastructure/disaster recovery, retaining your normal PostgreSQL backup as well is still recommended.

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
