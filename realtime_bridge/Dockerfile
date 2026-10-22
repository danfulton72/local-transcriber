FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# The bridge only runs Silero VAD locally. STT, LLM and TTS are remote, so use
# CPU PyTorch and avoid speech-to-speech's heavyweight local Parakeet/Qwen-TTS
# dependencies.
RUN python -m pip install \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch==2.6.0+cpu" \
      "torchaudio==2.6.0+cpu"

RUN python -m pip install \
      "anyio>=4,<5" \
      "fastapi>=0.115" \
      "huggingface-hub>=0.34" \
      "httpx>=0.28" \
      "jsonschema>=4" \
      "nltk==3.10.0" \
      "numpy>=1.26" \
      "openai==2.28.0" \
      "pillow>=10" \
      "pydantic>=2" \
      "PyYAML>=6,<7" \
      "requests>=2.31" \
      "rich>=13" \
      "scipy>=1.10" \
      "soxr>=0.3.2" \
      "transformers>=5.15.1,<6" \
      "uvicorn>=0.30" \
      "websockets>=12"

# Skip only speech-to-speech's default local inference dependency set. This
# service delegates STT, LLM and TTS, so packages such as nano-parakeet and
# faster-qwen3-tts would add substantial image weight without being used.
#
# v1.1.0 is the first release that honours turn_detection.create_response.
# Open WebUI 0.12 sets create_response=false and sends its own response.create
# once it has saved the transcript; older builds (including the previous pin,
# ee6b7a8) answered every turn automatically as well, so Open WebUI's request
# collided with the bridge's own reply and the call was torn down with
# conversation_already_has_active_response. v1.1.0 also keeps the 0.12
# chat_context_* item IDs and conversation.item.delete support.
ARG SPEECH_TO_SPEECH_REF=8ebde045cb7d72f5acd55327b80cfa1670a33936
RUN python -m pip install \
      "speech-to-speech @ git+https://github.com/huggingface/speech-to-speech.git@${SPEECH_TO_SPEECH_REF}" \
      --no-deps

# Catch missing runtime imports and the Open WebUI 0.12 protocol requirements
# before the image reaches production.
RUN speech-to-speech --help >/dev/null \
    && python - <<'PY'
from speech_to_speech.api.openai_realtime.service import _EVENT_TYPE_TO_MODEL
from speech_to_speech.LLM.chat import _ensure_id
from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
from speech_to_speech.LLM.chat_completions_language_model import ChatCompletionsApiModelHandler
from speech_to_speech.STT.openai_compatible_handler import OpenAICompatibleSTTHandler
from speech_to_speech.TTS.openai_compatible_handler import OpenAICompatibleTTSHandler
from speech_to_speech.VAD.vad_handler import VADHandler

assert _ensure_id("chat_context_1", "sys") == "chat_context_1"
assert "conversation.item.delete" in _EVENT_TYPE_TO_MODEL
assert hasattr(RuntimeConfig, "create_response_enabled"), "bridge must honour create_response=false"
print("realtime bridge handlers and Open WebUI protocol compatibility verified")
PY

# Force the Realtime TTS *output* to 24 kHz PCM so Open WebUI voice mode can
# play it back correctly (its AudioContext is fixed at 24 kHz). speech-to-speech
# otherwise defaults the output to the 16 kHz pipeline rate.
COPY patch_24k.py /tmp/patch_24k.py
RUN python /tmp/patch_24k.py && rm /tmp/patch_24k.py

# Keep Open WebUI calls alive through recoverable per-turn failures (slow LLM,
# a Whisper/Kokoro error, the Mute button). See patch_openwebui.py.
COPY patch_openwebui.py /tmp/patch_openwebui.py
RUN python /tmp/patch_openwebui.py && rm /tmp/patch_openwebui.py

# Cache the only local model plus NLTK assets at build time so production
# startup does not depend on GitHub/NLTK availability.
RUN python - <<'PY'
import nltk
import torch

nltk.download("punkt_tab", quiet=True)
nltk.download("averaged_perceptron_tagger_eng", quiet=True)
torch.hub.load(
    "snakers4/silero-vad:master",
    "silero_vad",
    trust_repo=True,
    skip_validation=True,
)
PY

COPY launcher.py /app/launcher.py

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import socket; s=socket.create_connection(('127.0.0.1',8765),5); s.close()"

CMD ["python", "/app/launcher.py"]
