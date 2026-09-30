import asyncio
import gc
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

from whisper_guard import filter_transcript


app = FastAPI(title="Local Speaker Analyzer", version="0.1.4")

MODEL = os.getenv("PYANNOTE_MODEL", "pyannote/speaker-diarization-community-1")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None
HF_HOME = os.getenv("HF_HOME", "/models")
GATEWAY_BASE_URL = os.getenv("GATEWAY_BASE_URL", "http://host.docker.internal:8555/v1").rstrip("/")
DEVICE = os.getenv("SPEAKER_DEVICE", "cpu").strip().lower()
BUSY_FILE_RAW = os.getenv("SPEAKER_BUSY_FILE", "").strip()
BUSY_FILE = Path(BUSY_FILE_RAW) if BUSY_FILE_RAW else None
UNLOAD_AFTER_DIARIZATION = os.getenv(
    "SPEAKER_UNLOAD_AFTER_DIARIZATION",
    "false",
).strip().lower() in {"1", "true", "yes", "on"}

_pipeline = None
# CPU-resident copy kept after unloading from CUDA. Moving it back to the GPU
# is much faster than re-reading the pipeline from the Hugging Face cache.
_cpu_pipeline = None
_pipeline_lock = asyncio.Lock()
_analysis_run_lock = asyncio.Lock()


def _set_busy_file(active: bool) -> None:
    if BUSY_FILE is None:
        return
    try:
        BUSY_FILE.parent.mkdir(parents=True, exist_ok=True)
        if active:
            BUSY_FILE.write_text(
                f"{os.getpid()} {time.time():.6f}\n",
                encoding="utf-8",
            )
        else:
            BUSY_FILE.unlink(missing_ok=True)
    except OSError:
        # The in-process lock remains authoritative for the service. The file
        # is only an inter-container coordination hint for llama-swap.
        pass


@app.on_event("startup")
async def clear_stale_busy_file() -> None:
    _set_busy_file(False)


def _compiled_arch_supports(
    capability: tuple[int, int],
    compiled_arches: list[str],
) -> bool:
    device_major, device_minor = capability
    for arch in compiled_arches:
        if not arch.startswith("sm_"):
            continue
        digits = arch.removeprefix("sm_")
        if not digits.isdigit() or len(digits) < 2:
            continue
        code = int(digits)
        compiled_major, compiled_minor = divmod(code, 10)
        if compiled_major == device_major and compiled_minor <= device_minor:
            return True
    return False


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
                "compiled_kernel": _compiled_arch_supports(
                    capability,
                    result["compiled_arches"],
                ),
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
    name = torch.cuda.get_device_name(index)

    # NVIDIA cubins are forward-compatible within a compute-capability major
    # version: for example sm_60 code can execute on a 6.1 Tesla P4. Do not
    # require an exact sm_61 entry in torch.cuda.get_arch_list().
    if compiled and not _compiled_arch_supports(capability, compiled):
        raise RuntimeError(
            f"{name} uses CUDA architecture {arch}, but this PyTorch build "
            f"contains no compatible kernels in {', '.join(compiled)}."
        )

    # Prove that this image can actually dispatch a CUDA kernel on the selected
    # device. This catches unsupported binaries more reliably than arch strings.
    try:
        device = torch.device(f"cuda:{index}")
        probe = torch.ones(1, device=device)
        probe.add_(1)
        torch.cuda.synchronize(index)
        del probe
    except Exception as exc:
        raise RuntimeError(
            f"{name} failed a CUDA runtime compatibility probe: {exc}"
        ) from exc


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


def _move_pipeline_to_device_sync(pipeline):
    _validate_device_sync()
    import torch
    pipeline.to(torch.device(DEVICE))
    return pipeline


async def get_pipeline():
    global _pipeline, _cpu_pipeline
    if _pipeline is not None:
        return _pipeline
    async with _pipeline_lock:
        if _pipeline is None:
            cached = _cpu_pipeline
            _cpu_pipeline = None
            if cached is not None and DEVICE != "cpu":
                try:
                    _pipeline = await asyncio.to_thread(_move_pipeline_to_device_sync, cached)
                except Exception:
                    traceback.print_exc()
                    cached = None
                    await asyncio.to_thread(_empty_cuda_cache_sync)
            if _pipeline is None:
                _pipeline = await asyncio.to_thread(_load_pipeline_sync)
    return _pipeline


def _move_pipeline_to_cpu_sync(pipeline) -> bool:
    if pipeline is None or DEVICE == "cpu":
        return False
    try:
        import torch
        pipeline.to(torch.device("cpu"))
        return True
    except Exception:
        # Dropping the final reference below is still useful even if a
        # particular pipeline implementation cannot move itself back to CPU.
        return False


def _empty_cuda_cache_sync() -> None:
    gc.collect()
    if DEVICE == "cpu":
        return
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


async def unload_pipeline() -> None:
    global _pipeline, _cpu_pipeline
    async with _pipeline_lock:
        pipeline = _pipeline
        _pipeline = None

        if pipeline is None:
            return

        moved = await asyncio.to_thread(_move_pipeline_to_cpu_sync, pipeline)
        # Keep the CPU copy for the next analysis only if it really left CUDA.
        _cpu_pipeline = pipeline if moved else None
        pipeline = None
        await asyncio.to_thread(_empty_cuda_cache_sync)


def _load_pcm_waveform(path: Path) -> dict:
    import torch

    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        sample_rate = source.getframerate()
        compression = source.getcomptype()
        frames = source.readframes(source.getnframes())

    if compression != "NONE":
        raise RuntimeError("Speaker analysis requires uncompressed PCM WAV audio.")

    if width == 1:
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        samples = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError(
            f"Unsupported PCM sample width: {width * 8}-bit. "
            "Use 8-bit, 16-bit, or 32-bit PCM WAV audio."
        )

    if channels < 1:
        raise RuntimeError("PCM WAV audio has no channels.")
    if samples.size % channels:
        raise RuntimeError("PCM WAV audio contains an incomplete sample frame.")

    waveform = samples.reshape(-1, channels).T.copy()
    return {
        "waveform": torch.from_numpy(waveform),
        "sample_rate": sample_rate,
    }


def _run_pipeline(pipeline, audio: dict, num_speakers: int | None):
    if num_speakers:
        return pipeline(audio, num_speakers=num_speakers)
    return pipeline(audio)


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
        "cpu_cached": _cpu_pipeline is not None,
        "model": MODEL,
        "device": DEVICE,
        "local_model": local_model,
        "device_error": device_error,
        "busy": _analysis_run_lock.locked(),
        "busy_file": str(BUSY_FILE) if BUSY_FILE else None,
        "unload_after_diarization": UNLOAD_AFTER_DIARIZATION,
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

    if _analysis_run_lock.locked():
        raise HTTPException(
            status_code=409,
            detail="Speaker analysis is already running. Wait for it to finish and try again.",
        )

    temp = tempfile.NamedTemporaryFile(prefix="speaker-analysis-", suffix=".wav", delete=False)
    path = Path(temp.name)
    temp.write(raw)
    temp.close()

    await _analysis_run_lock.acquire()
    _set_busy_file(True)
    started = time.perf_counter()
    try:
        try:
            with wave.open(str(path), "rb"):
                pass
        except (wave.Error, EOFError) as exc:
            raise HTTPException(status_code=400, detail="Speaker analysis requires PCM WAV audio") from exc

        pipeline = await get_pipeline()
        audio = await asyncio.to_thread(_load_pcm_waveform, path)
        output = await asyncio.to_thread(_run_pipeline, pipeline, audio, num_speakers)

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

        # On a shared speech GPU, pyannote is needed only for the diarization
        # phase. Release its CUDA residency before per-turn Whisper requests so
        # Faster Whisper gets the P4 memory back for transcription.
        if UNLOAD_AFTER_DIARIZATION:
            pipeline = None
            output = None
            diarization = None
            embeddings = None
            audio = None
            await unload_pipeline()

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
                    text = await _transcribe_turn(client, wav_data, language)
                    # Short or silent turns (a cough, "mm") come back as "Thank you."
                    turn["text"] = filter_transcript(
                        text, wav_data, context=f"turn at {turn['start_seconds']:.1f}s"
                    )
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
        if UNLOAD_AFTER_DIARIZATION and _pipeline is not None:
            await unload_pipeline()
        path.unlink(missing_ok=True)
        _set_busy_file(False)
        if _analysis_run_lock.locked():
            _analysis_run_lock.release()
