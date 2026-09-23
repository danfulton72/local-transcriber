FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /service

COPY requirements.txt /service/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch>=2.8,<3" "torchaudio>=2.8,<3" \
    && pip install --no-cache-dir -r /service/requirements.txt

COPY app.py /service/app.py

EXPOSE 9000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
