import re
from collections import Counter
from difflib import SequenceMatcher

WORD_RE = re.compile(r"[\w'’-]+", re.UNICODE)


def words(text: str) -> list[str]:
    return WORD_RE.findall((text or "").lower())


def word_count(text: str) -> int:
    return len(words(text))


def correction_pairs(original: str, edited: str) -> list[tuple[str, str]]:
    before = words(original)
    after = words(edited)
    matcher = SequenceMatcher(a=before, b=after, autojunk=False)
    pairs: list[tuple[str, str]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "replace":
            continue
        left = before[i1:i2]
        right = after[j1:j2]
        if len(left) == len(right):
            pairs.extend((a, b) for a, b in zip(left, right) if a != b)
    return pairs


def top_corrections(items: list[tuple[str, str]], limit: int = 10) -> list[dict]:
    counts = Counter(items)
    return [
        {"from": old, "to": new, "count": count}
        for (old, new), count in counts.most_common(limit)
    ]
