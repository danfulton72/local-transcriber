"""Join overlapping transcript chunks without repeating words.

Python twin of app/static/transcript-utils.js (mergeOverlap); both are
checked against tests/fixtures/transcript_merge_cases.json. See the JS file
for the reasoning.
"""

from __future__ import annotations

import re

MAX_OVERLAP = 28
MAX_INCOMING_SKIP = 3
MAX_EXISTING_DROP = 2
COMMON_WORDS = frozenset({
    "that", "this", "with", "from", "have", "they", "there", "their", "then", "than", "what", "when",
    "where", "which", "will", "would", "could", "should", "about", "just", "like", "some", "been",
    "were", "your", "into", "over", "also", "very", "yeah", "okay", "well", "know", "think", "going",
})


def normalise_token(token: str) -> str:
    return re.sub(r"[^\w']", "", (token or "").lower()).replace("'", "").replace("_", "")


def _within_one_edit(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1:
        return False
    i = j = edits = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(a) > len(b):
            i += 1
        elif len(b) > len(a):
            j += 1
        else:
            i += 1
            j += 1
    return edits + (len(a) - i) + (len(b) - j) <= 1


def similar_tokens(left: str, right: str) -> bool:
    if not left or not right:
        return False
    if left == right:
        return True
    shorter = min(len(left), len(right))
    if shorter >= 3 and (left.startswith(right) or right.startswith(left)):
        return True
    return shorter >= 4 and _within_one_edit(left, right)


def _strong(word: str) -> bool:
    return len(word) >= 4 and word not in COMMON_WORDS


def merge_overlap(existing: str, incoming: str) -> tuple[int, list[str]]:
    """Return (keep, add): keep the first `keep` existing words, then append `add`."""
    a = (existing or "").split()
    b = (incoming or "").split()
    if not b:
        return len(a), []
    if not a:
        return 0, b
    na = [normalise_token(t) for t in a]
    nb = [normalise_token(t) for t in b]

    for size in range(min(MAX_OVERLAP, len(a), len(b)), 0, -1):
        best = None
        for skip in range(MAX_INCOMING_SKIP + 1):
            for drop in range(MAX_EXISTING_DROP + 1):
                if skip + size > len(b) or drop + size > len(a):
                    continue
                fuzzy_allowed = size >= 2
                if not fuzzy_allowed and (skip or drop):
                    continue
                start_a = len(a) - drop - size
                ok = True
                exact = True
                strong = False
                for k in range(size):
                    left, right = na[start_a + k], nb[skip + k]
                    clipped_start = (
                        k == 0 and skip == 0 and len(right) >= 2
                        and len(left) > len(right) and left.endswith(right)
                    )
                    matched = (similar_tokens(left, right) or clipped_start) if fuzzy_allowed else (bool(left) and left == right)
                    if not matched:
                        ok = False
                        break
                    if left != right:
                        exact = False
                    if _strong(left) or _strong(right):
                        strong = True
                if ok and (skip or drop or not exact) and size < 3 and not strong:
                    ok = False
                if ok and (best is None or skip + drop < best[0] + best[1]):
                    best = (skip, drop, start_a)
        if best is None:
            continue

        skip, drop, start_a = best
        block = []
        changed = drop > 0
        for k in range(size):
            left, right = a[start_a + k], b[skip + k]
            nl, nr = na[start_a + k], nb[skip + k]
            last_word = k == size - 1
            pick = right if (len(nr) > len(nl) and nr.startswith(nl)) or (last_word and nl == nr and size > 1) else left
            if pick != left:
                changed = True
            block.append(pick)
        rest = b[skip + size:]
        if not changed:
            return len(a), rest
        return start_a, block + rest
    return len(a), b


def merge_transcripts(existing: str, incoming: str) -> str:
    words = (existing or "").split()
    keep, add = merge_overlap(existing, incoming)
    return " ".join(words[:keep] + add)
