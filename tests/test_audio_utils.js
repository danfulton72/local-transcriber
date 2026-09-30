const assert = require('node:assert/strict');

require('../app/static/audio-utils.js');

const { analyzeFinalTail } = globalThis.TalkToTypeAudio;

function sine(sampleRate, seconds, amplitude) {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin(2 * Math.PI * 180 * i / sampleRate) * amplitude;
  }
  return out;
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const sampleRate = 48000;

const silence = new Float32Array(Math.round(sampleRate * 0.25));
assert.equal(analyzeFinalTail(silence, sampleRate).hasSpeech, false);

const lowNoise = new Float32Array(Math.round(sampleRate * 0.25)).fill(0.002);
assert.equal(analyzeFinalTail(lowNoise, sampleRate).hasSpeech, false);

const speech = sine(sampleRate, 0.22, 0.05);
assert.equal(analyzeFinalTail(speech, sampleRate).hasSpeech, true);

const briefClick = concat(
  new Float32Array(Math.round(sampleRate * 0.18)),
  sine(sampleRate, 0.02, 0.08),
  new Float32Array(Math.round(sampleRate * 0.05)),
);
assert.equal(analyzeFinalTail(briefClick, sampleRate).hasSpeech, false);

const shortWordLike = concat(
  new Float32Array(Math.round(sampleRate * 0.05)),
  sine(sampleRate, 0.12, 0.035),
  new Float32Array(Math.round(sampleRate * 0.05)),
);
assert.equal(analyzeFinalTail(shortWordLike, sampleRate).hasSpeech, true);

console.log('audio tail detector tests passed');

// --- 16 kHz streaming resampler ---
const { createResampler, findQuietCut, rms } = globalThis.TalkToTypeAudio;

function tone(rate, seconds, freq, amplitude = 1) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin(2 * Math.PI * freq * i / rate) * amplitude;
  return out;
}

function resampleInFrames(input, inputRate, outputRate, frame = 128) {
  const resampler = createResampler(inputRate, outputRate);
  const parts = [];
  for (let i = 0; i < input.length; i += frame) parts.push(resampler.process(input.subarray(i, i + frame)));
  return concat(...parts);
}

for (const inputRate of [48000, 44100]) {
  const seconds = 2;
  const speechBand = resampleInFrames(tone(inputRate, seconds, 1000), inputRate, 16000);
  assert.ok(Math.abs(speechBand.length - 16000 * seconds) <= 2, `length at ${inputRate}: ${speechBand.length}`);
  // Skip the filter warm-up; a full-scale sine has RMS 1/sqrt(2).
  const passRms = rms(speechBand, 800, speechBand.length - 800);
  assert.ok(Math.abs(passRms - Math.SQRT1_2) < 0.02, `1 kHz passband RMS at ${inputRate}: ${passRms}`);

  // Above the 8 kHz output Nyquist must be strongly attenuated, not aliased.
  const aliased = resampleInFrames(tone(inputRate, seconds, 12000), inputRate, 16000);
  const stopRms = rms(aliased, 800, aliased.length - 800);
  assert.ok(stopRms < 0.02, `12 kHz stopband RMS at ${inputRate}: ${stopRms}`);

  // Frame size must not change the output (state carries across calls).
  const a = resampleInFrames(tone(inputRate, 0.5, 440), inputRate, 16000, 128);
  const b = resampleInFrames(tone(inputRate, 0.5, 440), inputRate, 16000, 4096);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) < 1e-5);
}

const passthrough = createResampler(16000, 16000).process(new Float32Array([0.1, 0.2]));
assert.deepEqual(Array.from(passthrough).map((v) => Number(v.toFixed(3))), [0.1, 0.2]);

// --- quiet chunk boundary ---
const cutRate = 16000;
const gapped = concat(
  tone(cutRate, 1.0, 200, 0.2),
  new Float32Array(Math.round(cutRate * 0.1)),
  tone(cutRate, 1.0, 200, 0.2),
);
const cut = findQuietCut(gapped, cutRate, 0.5 * cutRate, 1.8 * cutRate);
assert.ok(cut > 1.0 * cutRate && cut < 1.1 * cutRate, `cut landed at ${cut / cutRate}s`);
assert.equal(findQuietCut(gapped, cutRate, 100, 110), 110);

console.log('resampler and quiet-cut tests passed');

// --- Phantom-text guards -------------------------------------------------
{
  const { trimSilence } = globalThis.TalkToTypeAudio;
  const rate = 16000;
  const quiet = (seconds) => new Float32Array(Math.round(rate * seconds));
  const clip = concat(quiet(2), sine(rate, 1, 0.3), quiet(2));

  const [start, end] = trimSilence(clip, rate);
  assert.ok(Math.abs(start - rate * 1.7) < rate * 0.05, 'keeps ~300 ms before speech');
  assert.ok(Math.abs(end - rate * 3.3) < rate * 0.05, 'keeps ~300 ms after speech');

  const [allStart, allEnd] = trimSilence(quiet(3), rate);
  assert.deepEqual([allStart, allEnd], [0, rate * 3], 'silent clip is left whole');

  const tight = concat(quiet(0.3), sine(rate, 1, 0.3), quiet(0.3));
  assert.deepEqual(trimSilence(tight, rate), [0, tight.length], 'short edges are not trimmed');

  // Regular chunks need a little more speech than the lenient final-tail check.
  const blip = concat(quiet(2), sine(rate, 0.08, 0.3), quiet(2));
  assert.equal(globalThis.TalkToTypeAudio.analyzeFinalTail(blip, rate).hasSpeech, true);
  assert.equal(globalThis.TalkToTypeAudio.analyzeFinalTail(blip, rate, { minActiveMs: 100 }).hasSpeech, false);
  const word = concat(quiet(2), sine(rate, 0.4, 0.3), quiet(2));
  assert.equal(globalThis.TalkToTypeAudio.analyzeFinalTail(word, rate, { minActiveMs: 100 }).hasSpeech, true);
}
