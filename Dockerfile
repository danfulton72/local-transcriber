FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml /app/
COPY app /app/app
COPY alembic.ini /app/alembic.ini
COPY migrations /app/migrations
RUN pip install --no-cache-dir .

RUN mkdir -p /data/recordings

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
