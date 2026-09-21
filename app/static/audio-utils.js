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

  function analyzeFinalTail(samples, sampleRate) {
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
    const speechThreshold = Math.max(0.0075, noiseFloor * 2.8);
    const activeFrames = frameLevels.filter((level) => level >= speechThreshold).length;
    const activeMs = activeFrames * 20;
    const overallRms = rms(samples);
    const peakFrameRms = Math.max(0, ...frameLevels);

    // Be deliberately conservative: keep a tail if it has at least ~60 ms of
    // speech-like energy and a clear peak. The full recording is always saved;
    // this gate only decides whether the short tail is worth sending to Whisper.
    const hasSpeech =
      activeMs >= 60 &&
      peakFrameRms >= Math.max(0.012, noiseFloor * 3.5) &&
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

  root.TalkToTypeAudio = { analyzeFinalTail };
})(typeof window !== 'undefined' ? window : globalThis);
