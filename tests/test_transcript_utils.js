const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../app/static/transcript-utils.js');

const { mergeTranscripts } = globalThis.TalkToTypeText;
// Shared with tests/test_transcript_merge.py so browser and server agree.
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'transcript_merge_cases.json'), 'utf8'));

for (const item of cases) {
  assert.equal(mergeTranscripts(item.existing, item.incoming), item.expected, item.note);
}
console.log('transcript merge tests passed (' + cases.length + ' cases)');
