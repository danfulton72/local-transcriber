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
