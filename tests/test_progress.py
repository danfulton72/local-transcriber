from app.services.progress import correction_pairs, top_corrections, word_count


def test_word_count_handles_plain_text():
    assert word_count("Hello, brave new world!") == 4


def test_correction_pairs_only_counts_replacements():
    assert correction_pairs("their dog is big", "there dog is big") == [("their", "there")]


def test_top_corrections_orders_by_frequency():
    items = [("their", "there"), ("night", "knight"), ("their", "there")]
    assert top_corrections(items)[0] == {"from": "their", "to": "there", "count": 2}
