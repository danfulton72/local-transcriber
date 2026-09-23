FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /service

COPY requirements.txt /service/requirements.txt
RUN pip install -r /service/requirements.txt

COPY app.py /service/app.py

EXPOSE 9000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
