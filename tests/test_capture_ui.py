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


def test_word_first_shell_and_settings_drawer_are_served():
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        html = response.text
        assert 'id="menuButton"' in html
        assert 'id="appDrawer"' in html
        assert 'class="quick-actions"' in html
        assert 'id="hearButton"' in html
        assert 'id="focusButton"' in html
        assert 'id="useWordsButton"' in html
        assert 'id="editButton"' in html
        assert 'data-drawer-page="progress"' in html
        assert 'class="grown-up"' not in html
