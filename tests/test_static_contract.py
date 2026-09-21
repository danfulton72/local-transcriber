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
