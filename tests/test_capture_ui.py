from fastapi.testclient import TestClient

from app.main import app


def test_audio_source_selector_is_served():
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        html = response.text
        assert 'id="captureSource"' in html
        assert 'value="microphone"' in html
        assert 'value="computer">Computer audio</option>' in html
        assert 'value="mixed">Computer audio + microphone</option>' in html
        assert "Entire Screen" in html
        assert "Share system audio" in html
        assert "Share tab audio" in html
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



def test_computer_capture_requests_system_audio_hints():
    from pathlib import Path

    source = Path("app/static/app.js").read_text(encoding="utf-8")
    assert "systemAudio: 'include'" in source
    assert "windowAudio: 'system'" in source
    assert "monitorTypeSurfaces: 'include'" in source
    assert "surfaceSwitching: 'include'" in source
    assert "selfBrowserSurface: 'exclude'" in source
    assert "Entire Screen + Share system audio" in source
    assert "Share tab audio" in source
