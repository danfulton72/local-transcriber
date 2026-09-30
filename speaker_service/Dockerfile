FROM pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /service

COPY requirements.txt constraints.txt /service/
RUN pip install -c /service/constraints.txt -r /service/requirements.txt \
    && pip install nvidia-cuda-nvrtc-cu12==12.6.77 \
    && python - <<'PY'
from pathlib import Path
import site

candidates = []
for root in site.getsitepackages():
    base = Path(root)
    candidates.extend(base.glob("nvidia/cuda_nvrtc/lib"))
    candidates.extend(base.glob("nvidia/cuda_nvrtc/lib64"))

paths = [path.resolve() for path in candidates if path.is_dir()]
if not paths:
    raise SystemExit("Could not locate NVIDIA NVRTC wheel library directory")

Path("/etc/ld.so.conf.d/nvidia-nvrtc.conf").write_text(
    "\n".join(str(path) for path in paths) + "\n",
    encoding="utf-8",
)
print("NVRTC library directories:", paths)
PY
RUN ldconfig

# Fail the image build rather than discovering a CUDA runtime mismatch only
# after deployment.
RUN python - <<'PY'
import ctypes
import ctypes.util
import torch

assert torch.__version__.split("+", 1)[0] == "2.8.0", torch.__version__
assert str(torch.version.cuda or "").startswith("12.6"), torch.version.cuda
nvrtc = ctypes.util.find_library("nvrtc")
assert nvrtc, "libnvrtc was not found by the dynamic linker"
ctypes.CDLL(nvrtc)
print("speaker CUDA runtime:", torch.__version__, torch.version.cuda, nvrtc)
PY

COPY app.py whisper_guard.py /service/

EXPOSE 9000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
