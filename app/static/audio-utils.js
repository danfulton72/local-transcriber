(function (root) {
  function rms(samples, start = 0, end = samples.length) {
    if (!samples || end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const value = samples[i];
      sum += value * value;
    }
    return Math.sqrt(sum / (end - start));
  }

  // Does this audio contain speech? Used before sending audio to Whisper,
  // which invents text ("Thank you.") for silence. `minActiveMs` is how much
  // speech-like energy is needed; the default is deliberately lenient.
  function analyzeFinalTail(samples, sampleRate, options = {}) {
    const minActiveMs = options.minActiveMs ?? 60;
    const durationMs = samples.length / sampleRate * 1000;
    if (!samples.length || !sampleRate) {
      return { hasSpeech: false, durationMs: 0, activeMs: 0, overallRms: 0, peakFrameRms: 0 };
    }

    const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
    const frameLevels = [];
    for (let start = 0; start < samples.length; start += frameSamples) {
      frameLevels.push(rms(samples, start, Math.min(samples.length, start + frameSamples)));
    }

    const sorted = [...frameLevels].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor((sorted.length - 1) * 0.2)] || 0;
    const peakFrameRms = Math.max(0, ...frameLevels);

    // Only adapt to a measured noise floor when it is clearly below the signal.
    // If every frame contains speech, the lower percentile is not a noise floor
    // and must not be multiplied into an impossible threshold.
    const hasUsableNoiseFloor = noiseFloor > 0 && noiseFloor < peakFrameRms * 0.55;
    const speechThreshold = Math.max(
      0.0075,
      hasUsableNoiseFloor ? noiseFloor * 2.8 : 0,
    );
    const peakThreshold = Math.max(
      0.012,
      hasUsableNoiseFloor ? noiseFloor * 3.5 : 0,
    );
    const activeFrames = frameLevels.filter((level) => level >= speechThreshold).length;
    const activeMs = activeFrames * 20;
    const overallRms = rms(samples);

    // Be deliberately conservative: keep a tail if it has at least ~60 ms of
    // speech-like energy and a clear peak. The full recording is always saved;
    // this gate only decides whether the short tail is worth sending to Whisper.
    const hasSpeech =
      activeMs >= minActiveMs &&
      peakFrameRms >= peakThreshold &&
      overallRms >= 0.0035;

    return {
      hasSpeech,
      durationMs,
      activeMs,
      overallRms,
      peakFrameRms,
      noiseFloor,
      speechThreshold,
    };
  }

  // Streaming anti-aliased resampler. Speech models (Whisper, pyannote) work at
  // 16 kHz mono, so capturing at the browser's native 44.1/48 kHz only triples
  // upload size, disk use and memory. The filter is a Hamming-windowed sinc
  // low-pass followed by linear interpolation; the state carries across calls
  // so 128-sample AudioWorklet frames produce a seamless output stream.
  function createResampler(inputRate, outputRate, taps = 63) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('Invalid sample rate');
    const ratio = inputRate / outputRate;
    if (Math.abs(ratio - 1) < 1e-9) {
      return { inputRate, outputRate, ratio: 1, process: (input) => Float32Array.from(input) };
    }

    const size = taps % 2 ? taps : taps + 1;
    const half = (size - 1) / 2;
    // Cutoff in cycles per input sample: just below the output Nyquist.
    const cutoff = Math.min(0.5, 0.5 / ratio) * 0.9;
    const kernel = new Float32Array(size);
    let total = 0;
    for (let i = 0; i < size; i += 1) {
      const n = i - half;
      const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
      kernel[i] = sinc * window;
      total += kernel[i];
    }
    for (let i = 0; i < size; i += 1) kernel[i] /= total;

    let history = new Float32Array(size - 1);
    let position = 0;
    let lastFiltered = 0;

    function process(input) {
      const n = input.length;
      if (!n) return new Float32Array(0);

      const extended = new Float32Array(history.length + n);
      extended.set(history);
      extended.set(input, history.length);

      const filtered = new Float32Array(n);
      for (let k = 0; k < n; k += 1) {
        let acc = 0;
        for (let j = 0; j < size; j += 1) acc += kernel[j] * extended[k + j];
        filtered[k] = acc;
      }
      history = extended.slice(extended.length - (size - 1));

      const out = new Float32Array(Math.ceil((n + 1) / ratio) + 1);
      let count = 0;
      while (position < n - 1) {
        const index = Math.floor(position);
        const frac = position - index;
        const a = index < 0 ? lastFiltered : filtered[index];
        const b = filtered[index + 1];
        out[count] = a + (b - a) * frac;
        count += 1;
        position += ratio;
      }
      position -= n;
      lastFiltered = filtered[n - 1];
      return out.subarray(0, count);
    }

    return { inputRate, outputRate, ratio, process };
  }

  // Return the sample index at the centre of the quietest ~20 ms frame in
  // [start, end). Used to cut near-live chunks between words instead of at a
  // fixed time. Ties prefer the later frame so chunks stay close to target.
  function findQuietCut(samples, sampleRate, start, end, frameMs = 20) {
    const frame = Math.max(1, Math.round(sampleRate * frameMs / 1000));
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(samples.length, Math.floor(end));
    if (to - from < frame) return to;

    let bestIndex = to;
    let bestLevel = Infinity;
    for (let offset = from; offset + frame <= to; offset += Math.max(1, Math.floor(frame / 2))) {
      const level = rms(samples, offset, offset + frame);
      if (level <= bestLevel) {
        bestLevel = level;
        bestIndex = offset + Math.floor(frame / 2);
      }
    }
    return bestIndex;
  }

  // Trim long silence from both ends of a clip, keeping `padMs` around the
  // speech. Silence at the edges is where Whisper tends to add phantom
  // sign-offs. Returns [start, end) sample indices; the whole clip when it
  // has no clear speech or nothing worth trimming.
  function trimSilence(samples, sampleRate, { padMs = 300, minTrimMs = 700 } = {}) {
    const frame = Math.max(1, Math.round(sampleRate * 0.02));
    const levels = [];
    for (let start = 0; start < samples.length; start += frame) {
      levels.push(rms(samples, start, Math.min(samples.length, start + frame)));
    }
    if (!levels.length) return [0, samples.length];
    const sorted = [...levels].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor((sorted.length - 1) * 0.2)] || 0;
    const peak = sorted[sorted.length - 1];
    const usable = noiseFloor > 0 && noiseFloor < peak * 0.55;
    const threshold = Math.max(0.0075, usable ? noiseFloor * 2.8 : 0);
    const first = levels.findIndex((level) => level >= threshold);
    if (first < 0) return [0, samples.length];
    let last = levels.length - 1;
    while (last > first && levels[last] < threshold) last -= 1;

    const pad = Math.round(sampleRate * padMs / 1000);
    const minTrim = Math.round(sampleRate * minTrimMs / 1000);
    const speechStart = first * frame;
    const speechEnd = Math.min(samples.length, (last + 1) * frame);
    const start = speechStart >= minTrim ? Math.max(0, speechStart - pad) : 0;
    const end = samples.length - speechEnd >= minTrim ? Math.min(samples.length, speechEnd + pad) : samples.length;
    return [start, end];
  }

  root.TalkToTypeAudio = { analyzeFinalTail, createResampler, findQuietCut, rms, trimSilence };
})(typeof window !== 'undefined' ? window : globalThis);
