import io
import math
import random
import wave
from pathlib import Path

from fastapi.testclient import TestClient

from app.services.whisper_guard import filter_transcript, is_phantom_phrase, speech_profile

RATE = 16000


def make_wav(parts, rate=RATE) -> bytes:
    """parts: ("quiet" | "speech" | "click", seconds)."""
    rng = random.Random(7)
    data = bytearray()
    for kind, seconds in parts:
        count = int(seconds * rate)
        for i in range(count):
            value = rng.randint(-60, 60)  # room noise
            if kind == "speech":
                envelope = 0.6 + 0.4 * math.sin(2 * math.pi * 4 * i / rate)
                value += int(9000 * math.sin(2 * math.pi * 180 * i / rate) * envelope)
            elif kind == "click" and i < rate // 100:
                value = rng.randint(-8000, 8000)
            data += max(-32768, min(32767, value)).to_bytes(2, "little", signed=True)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(bytes(data))
    return buffer.getvalue()


SILENT = make_wav([("quiet", 5)])
CLICKS = make_wav([("quiet", 2), ("click", 0.05), ("quiet", 2), ("click", 0.05), ("quiet", 1)])
SAID_THANKS = make_wav([("quiet", 2), ("speech", 0.5), ("quiet", 2.5)])
TALKING = make_wav([("quiet", 0.5), ("speech", 3), ("quiet", 1.5)])


def test_phantom_phrases_are_recognised():
    assert is_phantom_phrase("Thank you.")
    assert is_phantom_phrase("  thank you!! ")
    assert is_phantom_phrase("Thanks for watching!")
    assert is_phantom_phrase("Thank you. Thank you. Thank you.")
    assert is_phantom_phrase("Subtitles by the Amara.org community")
    assert not is_phantom_phrase("Thank you for coming in today")
    assert not is_phantom_phrase("Let's start")
    assert not is_phantom_phrase("")


def test_speech_profile_separates_silence_from_speech():
    assert speech_profile(SILENT).speech_seconds < 0.05
    assert speech_profile(CLICKS).speech_seconds < 0.12
    assert 0.4 <= speech_profile(SAID_THANKS).speech_seconds <= 0.6
    assert speech_profile(TALKING).speech_seconds >= 2.9
    assert speech_profile(b"not a wav") is None


def test_filter_drops_invented_text_but_keeps_real_speech():
    # Silence and clicks: anything Whisper says was invented.
    assert filter_transcript("Thank you.", SILENT) == ""
    assert filter_transcript("Thanks for watching!", CLICKS) == ""
    assert filter_transcript("I think we should go ahead.", SILENT) == ""
    # A real, short "thank you" is kept.
    assert filter_transcript("Thank you.", SAID_THANKS) == "Thank you."
    # Normal speech is untouched, including a genuine closing "thank you".
    assert filter_transcript("Let's start. Thank you.", TALKING) == "Let's start. Thank you."
    # Unreadable audio: leave the text alone rather than guess.
    assert filter_transcript("Thank you.", b"garbage") == "Thank you."


def test_live_chunk_endpoint_drops_phantoms_on_silent_chunks(monkeypatch):
    from app.main import app, gateway

    replies = {}

    async def fake_transcribe(data, filename, content_type, language=None, prompt=None, task="transcriptions"):
        return replies[filename]

    monkeypatch.setattr(gateway, "transcribe", fake_transcribe)
    replies.update({"silent.wav": "Thank you.", "speech.wav": "Right, let's get going.", "thanks.wav": "Thank you."})

    with TestClient(app) as client:
        client.post("/api/auth/login", json={"username": "local", "password": "change-me-now"})
        recording = client.post("/api/recordings", json={"language": "en"}).json()
        url = f"/api/recordings/{recording['id']}/chunks"

        def send(name, audio, number):
            response = client.post(
                url, files={"file": (name, audio, "audio/wav")}, data={"chunk_number": str(number)}
            )
            assert response.status_code == 200, response.text
            return response.json()["text"]

        assert send("silent.wav", SILENT, 1) == ""
        assert send("speech.wav", TALKING, 2) == "Right, let's get going."
        assert send("thanks.wav", SAID_THANKS, 3) == "Thank you."
        client.post(f"/api/recordings/{recording['id']}/finish", json={"transcript": "done", "duration_seconds": 15})


def test_speaker_service_ships_the_same_guard():
    root = Path(__file__).resolve().parents[1]
    app_copy = (root / "app" / "services" / "whisper_guard.py").read_text()
    service_copy = (root / "speaker_service" / "whisper_guard.py").read_text()
    assert app_copy == service_copy, "Copy app/services/whisper_guard.py to speaker_service/ after editing it"
    dockerfile = (root / "speaker_service" / "Dockerfile").read_text()
    assert "whisper_guard.py" in dockerfile
    assert "from whisper_guard import filter_transcript" in (root / "speaker_service" / "app.py").read_text()
