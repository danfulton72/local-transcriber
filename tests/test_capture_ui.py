from fastapi.testclient import TestClient

from app.main import app


def test_audio_source_selector_is_served():
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        html = response.text
        assert 'id="captureSource"' in html
        assert 'value="microphone"' in html
        assert 'value="computer"' in html
        assert 'value="mixed"' in html
        assert "screen video is not recorded or stored" in html
