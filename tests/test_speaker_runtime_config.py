from pathlib import Path


def test_speaker_image_keeps_pascal_compatible_cuda_build():
    dockerfile = Path("speaker_service/Dockerfile").read_text()
    assert "pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime" in dockerfile
    assert "cuda12.8" not in dockerfile
    assert "nvidia-cuda-nvrtc-cu12==12.6.77" in dockerfile
    assert 'find_library("nvrtc")' in dockerfile
    assert "nvidia-nvrtc.conf" in dockerfile
    assert 'torch.__version__.split("+", 1)[0] == "2.8.0"' in dockerfile

    constraints = Path("speaker_service/constraints.txt").read_text()
    assert "pyannote.audio==4.0.7" in constraints
    assert "torch==2.8.0" in constraints
    assert "torchaudio==2.8.0" in constraints
    assert "torchcodec==0.7.0" in constraints


def test_speaker_service_uses_pcm_waveform_input_and_diagnostics():
    source = Path("speaker_service/app.py").read_text()
    assert "def _load_pcm_waveform" in source
    assert '"waveform": torch.from_numpy(waveform)' in source
    assert '"compiled_arches"' in source
    assert '"device_error"' in source
    assert "Tesla P4/Pascal requires the CUDA 12.6" in source
