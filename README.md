# Local Transcriber

A local-first, kid-friendly speech-to-text app that stores recordings and transcripts, supports read-back through Piper, and provides a private grown-up progress view.

## Architecture

- Browser UI for recording, near-live transcription, history and progress
- FastAPI backend
- PostgreSQL for recordings, transcript revisions and usage metrics
- Filesystem volume for recorded audio
- Existing Wyoming/OpenAI gateway for Faster Whisper STT and Piper TTS

The app is designed to keep data on your own infrastructure.

## Status

Initial application scaffold.
