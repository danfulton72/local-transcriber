(function (root) {
  // Joining near-live chunks.
  //
  // Each chunk re-sends ~0.9 s of the previous one so words at the cut are
  // not lost; the repeated words then have to be removed from the text. The
  // overlap is transcribed twice at the *edges* of two clips, so the two
  // versions rarely match word for word: the new chunk can start with a
  // clipped or misheard word ("ing", "um"), and the old one can end with a
  // half word ("sh" for "shop"). An exact suffix/prefix match then finds
  // nothing and the whole overlap is repeated in the transcript.
  //
  // mergeOverlap looks for the longest run of matching words between the end
  // of the existing text and the start of the incoming text, allowing:
  //   - up to 3 junk words at the start of the incoming text,
  //   - up to 2 garbled words at the very end of the existing text,
  //   - clipped words ("sh" ~ "shop") and one-letter slips ("shob" ~ "shop").
  // Fuzzy matches need at least two words in a row, so a single common word
  // ("the") is never treated as an overlap unless it matches exactly at the
  // join. Mirrored in app/main.py (merge_overlapping_text) for the server.

  const MAX_OVERLAP = 28;
  const MAX_INCOMING_SKIP = 3;
  const MAX_EXISTING_DROP = 2;
  // Short common words line up by chance ("is the"), so any match that skips
  // words or matches approximately must include at least one word that isn't
  // one of these and has four or more letters.
  const COMMON_WORDS = new Set([
    'that', 'this', 'with', 'from', 'have', 'they', 'there', 'their', 'then', 'than', 'what', 'when',
    'where', 'which', 'will', 'would', 'could', 'should', 'about', 'just', 'like', 'some', 'been',
    'were', 'your', 'into', 'over', 'also', 'very', 'yeah', 'okay', 'well', 'know', 'think', 'going',
  ]);
  const isStrong = (word) => word.length >= 4 && !COMMON_WORDS.has(word);

  function normalizeToken(token) {
    return String(token || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '').replace(/'/g, '');
  }

  function withinOneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i += 1; j += 1; continue; }
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else { i += 1; j += 1; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  function similarTokens(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const shorter = Math.min(left.length, right.length);
    if (shorter >= 3 && (left.startsWith(right) || right.startsWith(left))) return true;
    return shorter >= 4 && withinOneEdit(left, right);
  }

  // Returns { keep, add }: keep the first `keep` words of the existing text,
  // then append the `add` words.
  function mergeOverlap(existingText, incomingText) {
    const a = String(existingText || '').trim().split(/\s+/).filter(Boolean);
    const b = String(incomingText || '').trim().split(/\s+/).filter(Boolean);
    if (!b.length) return { keep: a.length, add: [] };
    if (!a.length) return { keep: 0, add: b };
    const na = a.map(normalizeToken);
    const nb = b.map(normalizeToken);

    for (let size = Math.min(MAX_OVERLAP, a.length, b.length); size >= 1; size -= 1) {
      let best = null;
      for (let skip = 0; skip <= MAX_INCOMING_SKIP; skip += 1) {
        for (let drop = 0; drop <= MAX_EXISTING_DROP; drop += 1) {
          if (skip + size > b.length || drop + size > a.length) continue;
          const fuzzyAllowed = size >= 2;
          if (!fuzzyAllowed && (skip || drop)) continue;
          const startA = a.length - drop - size;
          let ok = true;
          let exact = true;
          let strong = false;
          for (let k = 0; k < size; k += 1) {
            const left = na[startA + k];
            const right = nb[skip + k];
            // The new clip's first word can lose its start ("ing" for "going").
            const clippedStart = k === 0 && skip === 0 && right.length >= 2 && left.length > right.length && left.endsWith(right);
            if (fuzzyAllowed ? !(similarTokens(left, right) || clippedStart) : (!left || left !== right)) { ok = false; break; }
            if (left !== right) exact = false;
            if (isStrong(left) || isStrong(right)) strong = true;
          }
          // Two-word loose matches need a meaningful word; three or more in a
          // row lining up by chance at the join is unlikely.
          if (ok && (skip || drop || !exact) && size < 3 && !strong) ok = false;
          if (ok && (!best || skip + drop < best.skip + best.drop)) best = { skip, drop, startA };
        }
      }
      if (!best) continue;

      // Within the matched words prefer the complete version of a clipped word.
      const block = [];
      let changed = best.drop > 0;
      for (let k = 0; k < size; k += 1) {
        const left = a[best.startA + k];
        const right = b[best.skip + k];
        const nl = na[best.startA + k];
        const nr = nb[best.skip + k];
        // The last overlapping word sits at the old clip's cut, where Whisper
        // guesses the punctuation ("going." mid-sentence); the new clip heard
        // what came next, so its version of that word wins.
        const lastWord = k === size - 1;
        const pick = (nr.length > nl.length && nr.startsWith(nl)) || (lastWord && nl === nr && size > 1) ? right : left;
        if (pick !== left) changed = true;
        block.push(pick);
      }
      const rest = b.slice(best.skip + size);
      if (!changed) return { keep: a.length, add: rest };
      return { keep: best.startA, add: block.concat(rest) };
    }
    return { keep: a.length, add: b };
  }

  function mergeTranscripts(existingText, incomingText) {
    const words = String(existingText || '').trim().split(/\s+/).filter(Boolean);
    const { keep, add } = mergeOverlap(existingText, incomingText);
    return words.slice(0, keep).concat(add).join(' ');
  }

  root.TalkToTypeText = { mergeOverlap, mergeTranscripts, normalizeToken, similarTokens };
})(typeof window !== 'undefined' ? window : globalThis);
