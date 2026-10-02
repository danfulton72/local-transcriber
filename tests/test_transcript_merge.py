import json
from pathlib import Path

import pytest

from app.main import merge_overlapping_text
from app.services.transcript_merge import merge_transcripts

CASES = json.loads((Path(__file__).parent / "fixtures" / "transcript_merge_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[case["note"] for case in CASES])
def test_merge_matches_browser_behaviour(case):
    # Same cases as tests/test_transcript_utils.js, so browser and server agree.
    assert merge_transcripts(case["existing"], case["incoming"]) == case["expected"]


def test_server_merge_used_by_keep_talking_and_recovery():
    assert merge_overlapping_text("We are going to the", "ing to the shop.") == "We are going to the shop."
    assert merge_overlapping_text("", "Hello") == "Hello"
    assert merge_overlapping_text("Hello", "") == "Hello"
