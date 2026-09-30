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
- Captures at 16 kHz mono (Whisper/pyannote's native rate) using an AudioWorklet, and uploads full-quality audio in 60-second segments while recording, so long sessions never sit in browser memory
- Near-live chunks are cut at the quietest moment near each boundary; their duplicate chunk WAVs are removed once a recording finishes with its full audio stored (set `KEEP_LIVE_CHUNK_AUDIO=true` to keep them for troubleshooting)
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
- Admin-only **Tools → Speakers**:
  - post-process a saved conversation into Person 1 / Person 2 / Person 3 turns
  - optionally set the expected number of speakers
  - rename detected people for that analysis
  - **Remember this speaker** stores local speaker embeddings for future matching
  - each remembered person can keep up to 8 confirmed voice samples from different recordings
  - matching uses the strongest 1–3 samples rather than one running average, which is more tolerant of room/microphone variation and one poor sample
  - samples under 3 seconds of attributed speech are rejected
  - review/remove individual voice samples, rename the person, or forget the whole voiceprint at any time
  - recognised speakers are reviewed/managed in the parent area; after a parent completes an analysis, reopening that saved conversation in **Your words** shows the resolved speaker names beside their turns
- Admin-only **Tools → Meeting notes & Open Notebook**:
  - turns a speaker-analysed conversation into ordered meeting notes (summary, decisions, action items with owners, discussion by topic, open questions) using your own local model through any OpenAI-compatible endpoint, such as llama.cpp's `llama-server`
  - long meetings are split to fit the model's context, extracted part by part, then organised in one final pass
  - optionally sends the speaker-labelled transcript (as an embedded source) and the notes (as a note) to a self-hosted [Open Notebook](https://github.com/lfnovo/open-notebook) notebook; re-exporting replaces the previous copies
  - notes can be downloaded as Markdown, e.g. for Obsidian
- Admin-only storage tools:
  - recycle bin with restore and permanent delete
  - voice-audio retention (forever / 30 / 90 / 365 days)
  - optional delete-audio-after-transcription mode
  - local service/storage status
  - downloadable backup ZIP containing metadata and retained audio

The app deliberately does **not** track attention, mouse movement, mood, sentiment, reading ability or other passive behavioural signals.

## Architecture

The recommended R720 deployment now lives in the existing **voice stack**, alongside Faster Whisper and Piper:

```text
Browser (HTTPS)
      |
      v
Local Transcriber :8090  ───────> existing PostgreSQL
      |
      +──── live speech/read-aloud ──> wyoming-openai-gateway :8555
      |                                  |                 |
      |                                  v                 v
      |                           Faster Whisper         Piper
      |                                  |
      |                               Tesla P4
      |
      +──── admin speaker analysis ──> speaker-analyzer
                                         |
                                      Tesla P4
```

The app and analyzer join the voice stack's default Compose network. The production repository lives at `/home/dan/voice/local-transcriber`, recordings live inside that directory, and the pyannote/Hugging Face cache lives at `/home/dan/voice/speaker-model-cache`.

Both Faster Whisper and pyannote use the existing `${P4_UUID}`. Speaker analysis is still admin-triggered and post-recording only. In the voice-stack deployment the analyzer releases pyannote from CUDA immediately after diarization, before it sends per-speaker clips through the existing Whisper gateway. That prevents pyannote from remaining resident on the 8 GB P4 after an analysis.

The previous `deploy/ai-stack` integration remains available as a rollback/legacy path, but it is no longer the recommended production layout.

## Computer / system audio capture

Under **Grown-up settings → Audio source**, choose:

- **Microphone** — the normal Talk to Type microphone path.
- **Computer audio** — pressing **Start capture** opens the browser's share picker. For Teams or another desktop application, choose **Entire Screen** and enable **Share system audio**. For browser media, choose the relevant tab and enable **Share tab audio**.
- **Computer audio + microphone** — captures the selected computer/system audio and the device microphone, mixes them locally with the Web Audio API, and sends the resulting mono stream through the existing near-live Whisper pipeline.

The app never silently intercepts device audio. Browser screen/audio capture requires a fresh user action and permission each time. Browsers require a video/display track for this API, but Talk to Type does not read, encode or store screen pixels; it uses that track only to detect when sharing ends. Browser/OS support varies, and a requested screen share may contain no audio track; Talk to Type detects that case before creating a recording and gives mode-specific guidance. On Windows Chrome/Edge, **Entire Screen + Share system audio** is the recommended mode for Teams desktop and other application audio.

Stopping sharing from the browser's sharing controls automatically finishes and saves the current Talk to Type recording. The captured WAV is stored and handled exactly like microphone recordings, so parent-run speaker diarization can also be used afterwards.

This is primarily a desktop-browser feature. Chrome/Edge generally provide the most useful tab/system-audio choices; phones/tablets and other browsers may provide limited or no shared audio.

### Hear a speaker before tagging

In **Tools → Speakers**, every detected speaker with attributed speech now has a **Hear sample** button. It plays up to 8 seconds from that speaker's longest continuous diarized turn, trimmed slightly inside the turn boundaries to reduce neighbouring-speaker bleed.

The preview is generated on demand from the existing saved recording. It is admin-only, is never added as another stored audio file, and is intended to help the operator recognise the person before saving a tag or adding a remembered voice sample.

**Remembered speakers** also expose a **Hear** control beside each stored voice sample, using that sample's original detected turn. Voice profiles remain shared across app users. Normal users cannot access speaker-management source audio; admins can review source samples across user accounts so they can perform and verify voice matching.

### Listen, follow and edit

For saved conversations with speaker analysis, **My voice** now opens an interactive playback bar with pause/resume, ±5 second seeking, playback speed, elapsed/total time, and **Follow audio**.

While the original recording plays, the current speaker turn is highlighted and automatically kept in view. Manual scrolling or clicking into an inline edit pauses automatic following; **Follow audio** jumps back to the current spoken turn and resumes following.

Each speaker turn can be edited directly in **Your words** while audio continues playing. Turn edits autosave after a short pause in typing. The diarized original text is retained separately, while the corrected turn text is used to rebuild the recording's normal edited transcript for search, copy/share and later reopening. Clicking a turn timestamp starts or seeks the original recording at that point.

Speaker-name corrections in **My words** now start with a selector of remembered voices. Selecting **New name…** reveals a manual-name field, while **This turn**, **All matching turns**, **Unknown**, and **Reset** keep the correction scope explicit. Normal users see only remembered speaker names/IDs here; voiceprint metadata and source samples remain admin-only.

Saved recordings also show an editable **Title** above the transcript. Titles can be renamed without changing the transcript or recording audio. New titles start with the recording's date as `yyyymmdd` (London time, from `NOTES_TIMEZONE`), whether typed or generated from the transcript, so titles sort by date. Renaming keeps that date unless the new title starts with its own 8-digit date. Recordings titled before this change are not renamed.

### Responsive workspace

On desktop, Talk to Type uses the full available workspace beside the left navigation rail instead of imposing a narrow fixed content column. Admins see **Talk**, **My words**, **Progress** and **Tools** in the left rail. Non-admin users see only **Talk** and **My words**. Conversation-heavy panels use bounded internal scrolling so long transcripts and lists do not make pages grow indefinitely.

## Admin-only conversation speakers

Speaker diarization, voice recognition, user management, storage controls and Progress are protected by the signed-in user's admin permission.

### One-time pyannote model access

The open-source `pyannote/speaker-diarization-community-1` model is gated on Hugging Face. Before the first analysis:

1. Sign in to Hugging Face and accept the access conditions for `pyannote/speaker-diarization-community-1`.
2. Create a Hugging Face access token that can download the model.
3. Put the token in `.env` as `HF_TOKEN=...`.
4. Rebuild with `docker compose up -d --build`.

In the recommended AI-stack deployment, downloaded model files are cached under `/databases/aimodels/talk-to-type/pyannote`, alongside the rest of the AI model store. The standalone Compose deployment still uses `./speaker-model-cache`.

The speaker analyzer uses the NVIDIA GPU by default (`SPEAKER_DEVICE=cuda`). It is admin-triggered after recording, so it does not alter the normal live transcription path.


### GPU selection

The recommended AI-stack deployment borrows the existing **Tesla T4** through `llama-swap-t4`. The analyzer container is pinned to `${T4_UUID}`; the large T4 llama-server processes are evicted for the duration of admin-triggered speaker analysis, while the separate live Whisper workload remains untouched.

The CUDA 12.6 speaker image is retained because it works on the T4 and also leaves a Tesla P4/Pascal fallback available if you later choose to dedicate that card instead.

### Workflow

Open **Tools** as an admin, then use the **Speakers** section:

The **Conversation** list is sorted A–Z by title and hides conversations already sent to Open Notebook; tick **Include conversations already sent to Open Notebook** to see them. Each entry notes whether it has been analysed or sent.

1. Choose a saved recording.
2. Optionally specify the expected number of speakers.
3. Press **Analyse conversation**.
4. Review turns labelled Person 1, Person 2, etc.
5. Rename a detected person if useful.
6. Press **Remember this speaker** only when you want that local voiceprint used for future matching.
7. On later conversations, use **Add voice sample** for the same person to strengthen their profile.

Each remembered person keeps a small bank of up to 8 normalized speaker embeddings. The matcher scores a new voice against the strongest few samples rather than relying on one running average. Samples with less than 3 seconds of attributed speech are not accepted, and the same detected speaker cannot be added twice from one analysis. Existing single-embedding profiles are migrated into the bank as their first sample.

Remembered voiceprints are numeric speaker embeddings stored in your PostgreSQL database. The app does not expose voiceprint-management controls to non-admin users. Recognition is a similarity match, not proof of identity, so admin review remains authoritative.

## Meeting notes and Open Notebook export

Admin-only and post-recording, like speaker analysis. Nothing leaves your network: the notes model and Open Notebook are both services you run.

```
Record ─► Whisper ─► Tools → Speakers: analyse, then fix names
                                  │
            Tools → Meeting notes & Open Notebook: "Generate notes & export"
                     │                                │
                     ▼                                ▼
     llama-server (OpenAI-compatible)        Open Notebook API
     pass 1: extract per part                ├─ source: speaker-labelled transcript (embedded)
     pass 2: organise into notes ──────────► └─ note:   meeting notes
```

### Workflow

1. Analyse the conversation in **Tools → Speakers** and correct any speaker names. Notes use the corrected names and corrected turn text, so owners of action items come out right. Recordings with no speaker analysis still work, but every line is marked *Unidentified*.
2. In **Meeting notes & Open Notebook**, with the same conversation selected, press **Generate notes & export**. A picker loads the current list of notebooks live from Open Notebook; the default notebook (or the one this recording was last exported to) is preselected. Choose one and press **Export**. Progress is shown while each part is processed.
3. **Generate notes only** keeps the notes in this app. **Re-send saved notes** opens the same picker and pushes the saved transcript and notes again without re-running the model, replacing the earlier copies (including when you pick a different notebook). **Download .md** saves the notes as Markdown.

Export state is stored in the database. Conversations already in Open Notebook are marked **✓ Open Notebook** in the conversation list, and the panel shows which notebook they went to and when. For these, **Re-send saved notes** becomes the main button and **Generate notes & export** becomes **Regenerate & replace**. If you regenerate notes without exporting, the panel warns that newer notes have not been sent yet.

Permanently deleting a recording from the recycle bin also deletes its source and note from Open Notebook (best effort). Soft-deleting, audio retention and audio deletion leave exported notes alone.

### Notes model (llama.cpp)

Any OpenAI-compatible `/v1/chat/completions` endpoint works. For llama.cpp:

```
llama-server -m your-model.gguf --host 0.0.0.0 --port 8080 \
  -ngl 99 -c 32768 --jinja --alias meeting-llm
```

- Keep `LLM_CONTEXT_TOKENS` equal to `-c`. The transcript is split into parts of at most `LLM_CHUNK_TOKENS` (default 12000), leaving room for the prompt and `LLM_MAX_OUTPUT_TOKENS`.
- `LLM_DISABLE_THINKING=true` sends `chat_template_kwargs: {"enable_thinking": false}`, which switches off reasoning in Qwen3-style templates (needs `--jinja`). Any `<think>` block that still appears is stripped.
- `LLM_MODEL` must match the model name the server reports (`--alias`); the Tools status pill warns if it does not.

### Open Notebook

1. In Open Notebook, add your llama-server as an OpenAI-compatible provider and set an embedding model; the transcript source is embedded so Open Notebook's search and chat can find it.
2. Create a notebook (one per project or team works best, so you can ask questions across meetings).
3. Set `OPEN_NOTEBOOK_URL` (the API, normally port 5055), `OPEN_NOTEBOOK_PASSWORD` if you set one, and optionally `OPEN_NOTEBOOK_NOTEBOOK_ID` to preselect a notebook in the export picker and `OPEN_NOTEBOOK_UI_URL` (normally port 8502) for an **Open in Open Notebook** link.

Both URLs must be reachable **from inside the local-transcriber container**. Use the other host's LAN address, a shared Docker network name, or `http://host.docker.internal:<port>` for services on the same host (the Compose files add the `host-gateway` mapping).

```
LLM_BASE_URL=http://192.168.1.40:8080/v1
LLM_MODEL=meeting-llm
OPEN_NOTEBOOK_URL=http://192.168.1.40:5055
OPEN_NOTEBOOK_PASSWORD=...
OPEN_NOTEBOOK_NOTEBOOK_ID=notebook:abc123
OPEN_NOTEBOOK_UI_URL=http://192.168.1.40:8502
```

For Dockhand, supply the same names as stack variables. Leave `LLM_BASE_URL` empty to hide notes generation, and `OPEN_NOTEBOOK_URL` empty to keep notes local.

## Users and sign-in

The app has database-backed user accounts. Each logged-in user has their own:

- recordings and stored audio
- interrupted-draft recovery
- My words history and favourites
- recordings and My words history
- transcript and speaker-label corrections in their own saved conversations

Remembered speaker voiceprints are intentionally shared across users. Admins can access retained recordings and source samples across user accounts inside **Tools → Speakers** to run and review voice matching; non-admin users remain restricted to their own My Words recordings.

Admins can also temporarily **act as** an active non-admin user. Use the **View as** selector in the header or **Manage as user** in **Tools → Users**. While active, the persistent banner shows whose data is in scope: **My words** and **Progress** use that user's recordings, and saved recordings can be opened, heard, retitled, transcript-corrected, and speaker-corrected. The signed-in admin remains the security actor and is recorded as the correction author. New/continued recording and moving recordings to the bin are blocked until **Return to my account** is selected.

The selected acting-as user is stored only on the admin's login session. Promoting or deactivating the target clears any sessions currently acting as that user.

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

On that first startup, the default account is created if it does not already exist and all recordings created before user support are assigned to it. The environment password is a bootstrap value: changing `DEFAULT_PASSWORD` later does not silently overwrite the password already stored for that user. Use **Tools → Users** as an admin to reset passwords or grant/revoke admin access after bootstrap.

The application has fallback bootstrap values so an upgrade cannot permanently lock itself out, but you should set your own credentials before first startup.

## Dockhand / Hawser deployment

For a Dockhand-managed R720 voice host, use the repository-root
`docker-compose.dockhand.yml` as a **Git stack** with **Context directory
`.`** and **Build images on deploy** enabled. Dockhand then builds
`local-transcriber` and `speaker-analyzer` directly from this repository,
while persistent recordings/model data stay on the Docker host under
`/opt/stacks/voice`.

Secrets such as the PostgreSQL URL, bootstrap password and Hugging Face token
are supplied as Dockhand stack variables rather than committed to Git. The
Dockhand stack also pins both application services to the in-stack
`wyoming-openai-gateway` service name, avoiding host-loopback routing.

The full one-time conversion, stack-variable list, verification and update
workflow is in [deploy/dockhand/README.md](deploy/dockhand/README.md).

## Recommended: install inside the existing voice stack

Use the existing voice-stack root:

```text
/home/dan/voice
```

and place this repository at:

```text
/home/dan/voice/local-transcriber
```

The uploaded/production voice stack already provides `whisper`, `piper`, `wyoming-openai-gateway`, `openwakeword`, and `P4_UUID`. Talk to Type adds only two services through a managed Compose override: `local-transcriber` and `speaker-analyzer`.

For a clean install:

```bash
cd /home/dan/voice
git clone https://github.com/danfulton72/local-transcriber.git
cd local-transcriber

python deploy/voice-stack/install.py
nano .env
```

Then build and start only the Talk to Type services:

```bash
cd /home/dan/voice
docker compose build local-transcriber speaker-analyzer
docker compose run --rm --no-deps local-transcriber alembic upgrade head
docker compose up -d local-transcriber speaker-analyzer
```

The base voice-stack `docker-compose.yml` is not modified. The installer creates the matching managed Compose override symlink and validates the combined project.

Full migration, verification, P4-sharing and rollback instructions are in `deploy/voice-stack/README.md`.

The older AI-stack/T4 integration remains under `deploy/ai-stack` only for rollback or installations that intentionally keep Talk to Type in that project.

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


# First account / legacy recording owner
DEFAULT_USERNAME=local
DEFAULT_PASSWORD=choose-a-long-password
DEFAULT_DISPLAY_NAME=Local user
AUTH_SESSION_DAYS=30
AUTH_COOKIE_SECURE=true

DEFAULT_LANGUAGE=
DEFAULT_VOICE=en_GB-northern_english_male-medium

# Admin-only speaker diarization / remembered speakers
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

The `recordings/` volume stores the full recording as 16 kHz mono WAV segments. Near-live chunk WAVs are kept only while a recording is in progress (or when `KEEP_LIVE_CHUNK_AUDIO=true`); chunk text and timing stay in PostgreSQL. Recordings made before 16 kHz capture keep their original audio, and mixed-rate recordings are normalised to 16 kHz when combined for playback or speaker analysis.

### Backups

A complete backup needs **both** the PostgreSQL `transcriber` database and the `recordings/` directory/volume. Keeping only one loses either searchable history or the original voice recordings.

## Privacy model

The Progress page is based only on data needed for the app itself plus explicit actions. Correction counts compare the saved original Whisper transcript with the transcript the user deliberately edited and saved.

Nothing is sent to a cloud transcription or analytics service by this application. Meeting notes are only sent to the notes model and Open Notebook addresses you configure; point both at services on your own network.

## Updating the voice-stack install

For the recommended R720 layout:

```bash
cd /home/dan/voice/local-transcriber
git pull --ff-only

cd /home/dan/voice
docker compose build local-transcriber speaker-analyzer
docker compose run --rm --no-deps local-transcriber alembic upgrade head
docker compose up -d local-transcriber speaker-analyzer
docker compose logs --tail=100 local-transcriber speaker-analyzer
```

Rerun `python deploy/voice-stack/install.py` whenever the voice-stack integration files change. The installer leaves Whisper, Piper and OpenWakeWord untouched.

The container also runs `alembic upgrade head` automatically during normal startup, but running the migration explicitly with the newly built image before recreating the service gives a safer upgrade checkpoint.

Then hard-refresh the browser. If you previously installed the PWA, its service worker uses network-first updates for the app shell so refreshed versions are picked up rather than being permanently pinned to an old JavaScript/CSS cache.

### Install on a phone, tablet or desktop

Open **Grown-up settings → Install on this device**. On browsers with a native install prompt it will open directly. On iPhone/iPad, use **Share → Add to Home Screen**.

### Admin tools

Admin accounts see separate **Progress** and **Tools** pages. Progress contains analytics for the signed-in admin account. Tools contains:

- **Users** — add accounts, change display names, reset passwords, grant/revoke admin access, and deactivate/reactivate accounts. A password or permission change revokes that user's existing sessions.

- **Speakers** — analyse saved conversations, manage remembered voices, and review relabelled samples. The relabelled list opens on **Needs review**; approved or excluded samples move to **All history**, which can be filtered by date range and status, and **Back to review** returns one to the queue.
- **Meeting notes & Open Notebook** — generate ordered notes from an analysed conversation and export them with the transcript to Open Notebook.
- **Voice recording retention** — controls stored audio only; transcripts/history remain.
- **Backup & status** — checks PostgreSQL, the speech gateway and local audio storage, and can download an application backup ZIP.
- **Recycle bin** — restore soft-deleted work or permanently remove it.

Retention cleanup runs on application startup and whenever a recording finishes. Permanent delete removes the database history for that recording and its stored audio.

The downloadable ZIP is a convenient app-level backup. It includes remembered speaker embeddings, speaker-analysis metadata and generated meeting notes when those features have been used, so treat backup ZIPs as sensitive data just like the stored voice recordings. For infrastructure/disaster recovery, retaining your normal PostgreSQL backup as well is still recommended.

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
