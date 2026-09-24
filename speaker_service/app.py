import asyncio
import io
import os
import tempfile
import time
import traceback
import wave
from pathlib import Path

import httpx
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pyannote.audio import Pipeline


app = FastAPI(title="Local Speaker Analyzer", version="0.1.0")

MODEL = os.getenv("PYANNOTE_MODEL", "pyannote/speaker-diarization-community-1")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None
HF_HOME = os.getenv("HF_HOME", "/models")
GATEWAY_BASE_URL = os.getenv("GATEWAY_BASE_URL", "http://host.docker.internal:8555/v1").rstrip("/")
DEVICE = os.getenv("SPEAKER_DEVICE", "cpu").strip().lower()

_pipeline = None
_pipeline_lock = asyncio.Lock()


def _torch_runtime() -> dict:
    try:
        import torch
    except Exception as exc:
        return {
            "torch_available": False,
            "torch_error": f"{type(exc).__name__}: {exc}",
        }

    result = {
        "torch_available": True,
        "torch_version": str(torch.__version__),
        "torch_cuda": str(torch.version.cuda or ""),
        "cuda_available": bool(torch.cuda.is_available()),
        "compiled_arches": list(torch.cuda.get_arch_list()) if torch.version.cuda else [],
        "gpu_count": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,
        "gpus": [],
    }
    if torch.cuda.is_available():
        for index in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(index)
            capability = torch.cuda.get_device_capability(index)
            arch = f"sm_{capability[0]}{capability[1]}"
            result["gpus"].append({
                "index": index,
                "name": props.name,
                "capability": f"{capability[0]}.{capability[1]}",
                "arch": arch,
                "memory_gb": round(props.total_memory / (1024 ** 3), 1),
                "compiled_kernel": arch in result["compiled_arches"],
            })
    return result


def _selected_cuda_index() -> int:
    if not DEVICE.startswith("cuda"):
        return -1
    if ":" in DEVICE:
        try:
            return int(DEVICE.split(":", 1)[1])
        except ValueError:
            return 0
    return 0


def _validate_device_sync() -> None:
    if DEVICE == "cpu":
        return

    import torch

    if not DEVICE.startswith("cuda"):
        raise RuntimeError(f"Unsupported SPEAKER_DEVICE '{DEVICE}'. Use cpu, cuda, or cuda:N.")
    if not torch.cuda.is_available():
        raise RuntimeError("SPEAKER_DEVICE requests CUDA but PyTorch cannot see an NVIDIA GPU.")

    index = _selected_cuda_index()
    if index < 0 or index >= torch.cuda.device_count():
        raise RuntimeError(
            f"SPEAKER_DEVICE={DEVICE} selects GPU {index}, but only "
            f"{torch.cuda.device_count()} CUDA device(s) are visible."
        )

    capability = torch.cuda.get_device_capability(index)
    arch = f"sm_{capability[0]}{capability[1]}"
    compiled = list(torch.cuda.get_arch_list())
    if compiled and arch not in compiled:
        name = torch.cuda.get_device_name(index)
        raise RuntimeError(
            f"{name} uses CUDA architecture {arch}, but this PyTorch build "
            f"contains kernels for {', '.join(compiled)}. "
            "Use the CUDA 12.6 speaker image for Pascal GPUs such as Tesla P4."
        )


def _public_error(exc: Exception) -> str:
    message = str(exc).strip()
    lower = message.lower()

    if "no kernel image is available" in lower or "not compatible with the current pytorch" in lower:
        return (
            "The selected GPU is not supported by this PyTorch CUDA build. "
            "Tesla P4/Pascal requires the CUDA 12.6 speaker-analyzer image."
        )
    if "out of memory" in lower and "cuda" in lower:
        return (
            "Speaker analysis ran out of GPU memory. Try a shorter recording, "
            "reduce the expected speaker count, or use SPEAKER_DEVICE=cpu."
        )
    if (
        "401" in message
        or "403" in message
        or "gated repo" in lower
        or "access to model" in lower
        or "hugging face" in lower and ("token" in lower or "auth" in lower)
    ):
        return (
            "Pyannote model access failed. Check HF_TOKEN and confirm that the "
            "pyannote/speaker-diarization-community-1 access conditions were accepted."
        )
    if isinstance(exc, RuntimeError):
        return message[:900] or "Speaker analysis runtime error."
    return f"{type(exc).__name__}: {message[:800]}" if message else type(exc).__name__




def _load_pipeline_sync():
    _validate_device_sync()
    source = MODEL
    if Path(MODEL).exists():
        source = str(Path(MODEL).resolve())
    elif not HF_TOKEN:
        raise RuntimeError(
            "HF_TOKEN is not configured. Accept the pyannote Community-1 model terms "
            "and add a Hugging Face token to .env."
        )

    pipeline = Pipeline.from_pretrained(source, token=HF_TOKEN, cache_dir=HF_HOME)
    if DEVICE != "cpu":
        import torch
        pipeline.to(torch.device(DEVICE))
    return pipeline


async def get_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    async with _pipeline_lock:
        if _pipeline is None:
            _pipeline = await asyncio.to_thread(_load_pipeline_sync)
    return _pipeline


def _run_pipeline(pipeline, path: str, num_speakers: int | None):
    if num_speakers:
        return pipeline(path, num_speakers=num_speakers)
    return pipeline(path)


def _normalise(values) -> list[float]:
    array = np.asarray(values, dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(array))
    if norm > 0:
        array = array / norm
    return [float(value) for value in array.tolist()]


def _merge_turns(annotation, max_gap: float = 0.45) -> list[dict]:
    raw = []
    for segment, _, speaker in annotation.itertracks(yield_label=True):
        raw.append({
            "speaker_key": str(speaker),
            "start_seconds": float(segment.start),
            "end_seconds": float(segment.end),
        })
    raw.sort(key=lambda item: (item["start_seconds"], item["end_seconds"]))

    merged = []
    for item in raw:
        if (
            merged
            and merged[-1]["speaker_key"] == item["speaker_key"]
            and item["start_seconds"] - merged[-1]["end_seconds"] <= max_gap
        ):
            merged[-1]["end_seconds"] = max(merged[-1]["end_seconds"], item["end_seconds"])
        else:
            merged.append(dict(item))
    return merged


def _wav_clip(path: Path, start_seconds: float, end_seconds: float) -> bytes:
    with wave.open(str(path), "rb") as source:
        rate = source.getframerate()
        channels = source.getnchannels()
        width = source.getsampwidth()
        compression = source.getcomptype()
        compression_name = source.getcompname()
        total = source.getnframes()
        start = max(0, min(total, int(start_seconds * rate)))
        end = max(start, min(total, int(end_seconds * rate)))
        source.setpos(start)
        frames = source.readframes(end - start)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(width)
        output.setframerate(rate)
        output.setcomptype(compression, compression_name)
        output.writeframes(frames)
    return buffer.getvalue()


async def _transcribe_turn(client: httpx.AsyncClient, wav_data: bytes, language: str | None) -> str:
    form = {"model": "whisper-1", "response_format": "json", "temperature": "0"}
    if language:
        form["language"] = language
    response = await client.post(
        f"{GATEWAY_BASE_URL}/audio/transcriptions",
        data=form,
        files={"file": ("speaker-turn.wav", wav_data, "audio/wav")},
    )
    response.raise_for_status()
    return str(response.json().get("text", "")).strip()


@app.get("/healthz")
async def health() -> dict:
    local_model = Path(MODEL).exists()
    configured = local_model or bool(HF_TOKEN)
    runtime = await asyncio.to_thread(_torch_runtime)

    status = "ok" if configured else "needs_token"
    device_error = None
    if configured and DEVICE != "cpu":
        try:
            await asyncio.to_thread(_validate_device_sync)
        except Exception as exc:
            status = "device_error"
            device_error = _public_error(exc)

    return {
        "status": status,
        "configured": configured,
        "loaded": _pipeline is not None,
        "model": MODEL,
        "device": DEVICE,
        "local_model": local_model,
        "device_error": device_error,
        **runtime,
    }


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    num_speakers: int | None = Form(default=None),
) -> dict:
    if num_speakers is not None and not 1 <= num_speakers <= 10:
        raise HTTPException(status_code=400, detail="num_speakers must be between 1 and 10")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    temp = tempfile.NamedTemporaryFile(prefix="speaker-analysis-", suffix=".wav", delete=False)
    path = Path(temp.name)
    temp.write(raw)
    temp.close()

    started = time.perf_counter()
    try:
        try:
            with wave.open(str(path), "rb"):
                pass
        except (wave.Error, EOFError) as exc:
            raise HTTPException(status_code=400, detail="Speaker analysis requires PCM WAV audio") from exc

        pipeline = await get_pipeline()
        output = await asyncio.to_thread(_run_pipeline, pipeline, str(path), num_speakers)

        diarization = getattr(output, "exclusive_speaker_diarization", None)
        if diarization is None:
            diarization = output.speaker_diarization

        labels = list(output.speaker_diarization.labels())
        embeddings = np.asarray(output.speaker_embeddings)
        speakers = []
        for index, label in enumerate(labels):
            if index >= len(embeddings):
                continue
            speakers.append({"speaker_key": str(label), "embedding": _normalise(embeddings[index])})

        turns = _merge_turns(diarization)
        async with httpx.AsyncClient(timeout=600) as client:
            for turn in turns:
                if turn["end_seconds"] - turn["start_seconds"] < 0.18:
                    turn["text"] = ""
                    continue
                wav_data = _wav_clip(
                    path,
                    max(0.0, turn["start_seconds"] - 0.03),
                    turn["end_seconds"] + 0.03,
                )
                try:
                    turn["text"] = await _transcribe_turn(client, wav_data, language)
                except httpx.HTTPError as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Whisper failed while transcribing a speaker turn: {exc}",
                    ) from exc

        return {
            "model": MODEL,
            "device": DEVICE,
            "speaker_count": len(speakers),
            "speakers": speakers,
            "turns": turns,
            "processing_seconds": round(time.perf_counter() - started, 3),
        }
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=_public_error(exc)) from exc
    finally:
        path.unlink(missing_ok=True)
