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
      "torch==2.6.0+cpu"

RUN python -m pip install \
      "speech-to-speech==1.0.0" --no-deps \
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
      "rich>=13" \
      "scipy>=1.10" \
      "soxr>=0.3.2" \
      "transformers>=5.15.1,<6" \
      "uvicorn>=0.30" \
      "websockets>=12"

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
