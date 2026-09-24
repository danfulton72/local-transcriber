from pathlib import Path


def test_speaker_image_keeps_pascal_compatible_cuda_build():
    dockerfile = Path("speaker_service/Dockerfile").read_text()
    assert "pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime" in dockerfile
    assert "cuda12.8" not in dockerfile


def test_speaker_service_uses_pcm_waveform_input_and_diagnostics():
    source = Path("speaker_service/app.py").read_text()
    assert "def _load_pcm_waveform" in source
    assert '"waveform": torch.from_numpy(waveform)' in source
    assert '"compiled_arches"' in source
    assert '"device_error"' in source
    assert "Tesla P4/Pascal requires the CUDA 12.6" in source
