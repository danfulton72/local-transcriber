"""Build-time patch: force the OpenAI Realtime bridge TTS *output* to 24 kHz PCM.

Open WebUI voice mode hard-requires 24 kHz: its frontend creates an AudioContext
at sampleRate 24000 and rejects any other rate, and its backend requests
``output.format = {type: "audio/pcm", rate: 24000}`` from the upstream bridge.
The speech-to-speech pipeline synthesises at 16 kHz (PIPELINE_SAMPLE_RATE) and
only resamples to the client-requested rate when the session config carries an
explicit output format; in practice the negotiated session has
output.format=None, so the bridge streams 16 kHz PCM and Open WebUI plays it
back through a 24 kHz context -> 1.5x too fast / pitched-up / garbled.

This edits the two output-rate fallbacks in handlers/audio.py to default to
24000 instead of PIPELINE_SAMPLE_RATE. The input/VAD sample rate is untouched.
Idempotent: safe to run multiple times.
"""
import sys

PATH = "/usr/local/lib/python3.12/site-packages/speech_to_speech/api/openai_realtime/handlers/audio.py"
MARKER = "OWUI-24K-PATCHED"

with open(PATH) as f:
    src = f.read()

if MARKER in src:
    print("already patched, nothing to do")
    sys.exit(0)

old1 = '                client_out_rate = getattr(audio_cfg.output.format, "rate", None) or PIPELINE_SAMPLE_RATE\n'
new1 = ("                # %s Open WebUI voice mode requires 24 kHz output.\n"
        "                client_out_rate = getattr(audio_cfg.output.format, \"rate\", None) or 24000\n" % MARKER)

old2 = "                client_out_rate = PIPELINE_SAMPLE_RATE\n"
new2 = ("                # %s default output rate for Open WebUI compatibility.\n"
        "                client_out_rate = 24000\n" % MARKER)

assert src.count(old1) == 1, f"expected 1 match for output-format fallback, got {src.count(old1)}"
assert src.count(old2) == 1, f"expected 1 match for no-config fallback, got {src.count(old2)}"

src = src.replace(old1, new1).replace(old2, new2)
with open(PATH, "w") as f:
    f.write(src)
print("patched speech_to_speech audio.py -> TTS output defaults to 24 kHz")
