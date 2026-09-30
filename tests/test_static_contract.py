import re
from pathlib import Path


STATIC = Path(__file__).resolve().parents[1] / "app" / "static"


def test_javascript_dom_ids_exist_in_html():
    html = (STATIC / "index.html").read_text()
    javascript = (STATIC / "app.js").read_text()

    html_ids = set(re.findall(r'id="([^"]+)"', html))
    referenced_ids = set(re.findall(r"\$\('([^']+)'\)", javascript))

    missing = sorted(referenced_ids - html_ids)
    assert not missing, f"JavaScript references missing HTML ids: {missing}"


def test_pwa_shell_files_exist():
    for name in ("manifest.webmanifest", "sw.js", "icon.svg"):
        assert (STATIC / name).is_file(), f"Missing PWA shell file: {name}"



def test_admin_navigation_replaces_parent_pin():
    html = (STATIC / "index.html").read_text()
    javascript = (STATIC / "app.js").read_text()

    assert 'data-page="progress"' in html
    assert 'data-page="tools"' in html
    assert 'class="tab admin-only"' in html
    assert "Parent PIN" not in html
    assert "parentPin" not in javascript
    assert "parentHeaders" not in javascript
    assert "is_admin" in javascript



def test_html_ids_are_unique():
    html = (STATIC / "index.html").read_text()
    ids = re.findall(r'id="([^"]+)"', html)
    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    assert not duplicates, f"Duplicate HTML ids: {duplicates}"



def test_saved_title_and_known_speaker_picker_contract():
    html = (STATIC / "index.html").read_text()
    javascript = (STATIC / "app.js").read_text()

    assert 'id="recordingTitleRow"' in html
    assert 'id="recordingTitleInput"' in html
    assert 'id="saveRecordingTitleButton"' in html
    assert "speaker-name-select" in javascript
    assert "Choose a remembered voice" in javascript
    assert "＋ New name…" in javascript
    assert "/api/speaker-profiles" in javascript
    assert "target_profile_id" in javascript



def test_admin_speaker_tools_show_recording_owners():
    javascript = (STATIC / "app.js").read_text()

    assert "recording.owner_display_name" in javascript
    # The selected conversation's header names who recorded it.
    assert "'Recorded by ' + recording.owner_display_name" in javascript
    assert "sample.source_recording_owner" in javascript
    assert "sample.recording_owner" in javascript



def test_admin_act_as_controls_are_explicit_and_persistent():
    html = (STATIC / "index.html").read_text()
    javascript = (STATIC / "app.js").read_text()

    for control_id in (
        "actAsControl",
        "actAsSelect",
        "actAsBanner",
        "actAsName",
        "stopActAsButton",
    ):
        assert f'id="{control_id}"' in html

    assert "/api/admin/act-as/" in javascript
    assert "Return to my account" in html
    assert "Manage as user" in javascript
    assert "Recording disabled" in javascript
    assert "isActingAs()" in javascript
