#!/bin/sh
set -eu

PID="${1:-}"
BUSY_FILE="${SPEAKER_BUSY_FILE:-/run/talk-to-type/speaker.busy}"

if [ -z "$PID" ]; then
  echo "speaker-stop: missing reservation PID" >&2
  exit 1
fi

echo "speaker-stop: waiting for Talk to Type speaker analysis to finish"
while [ -e "$BUSY_FILE" ]; do
  sleep 1
done

echo "speaker-stop: speaker analyzer is idle; releasing reservation pid=$PID"
kill -TERM "$PID" 2>/dev/null || true
