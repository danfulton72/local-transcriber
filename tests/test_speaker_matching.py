from types import SimpleNamespace

from app.speaker_admin import blend_embeddings, cosine_similarity, best_profile


def profile(name: str, values: list[float]):
    return SimpleNamespace(name=name, embedding=values)


def test_cosine_similarity_identical_and_opposite():
    assert round(cosine_similarity([1.0, 0.0], [1.0, 0.0]), 5) == 1.0
    assert round(cosine_similarity([1.0, 0.0], [-1.0, 0.0]), 5) == -1.0


def test_blend_embeddings_stays_normalised():
    blended = blend_embeddings([1.0, 0.0], [0.8, 0.2], 2)
    magnitude = sum(value * value for value in blended) ** 0.5
    assert abs(magnitude - 1.0) < 1e-6


def test_best_profile_respects_threshold(monkeypatch):
    from app import speaker_admin

    monkeypatch.setattr(speaker_admin.settings, "speaker_match_threshold", 0.8)
    close = profile("Known", [1.0, 0.0])
    far = profile("Other", [0.0, 1.0])

    matched, score = best_profile([0.99, 0.01], [close, far])
    assert matched.name == "Known"
    assert score > 0.8

    matched, score = best_profile([0.7, 0.7], [close, far])
    assert matched is None
    assert score is None


def test_speaker_admin_requires_parent_pin(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app import speaker_admin

    monkeypatch.setattr(speaker_admin.settings, "parent_pin", "2468")

    with TestClient(app) as client:
        denied = client.get("/api/admin/speakers/profiles")
        assert denied.status_code == 401

        allowed = client.get(
            "/api/admin/speakers/profiles",
            headers={"X-Parent-Pin": "2468"},
        )
        assert allowed.status_code == 200
