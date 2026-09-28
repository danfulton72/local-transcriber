// AudioWorklet capture processor.
//
// Runs on the audio rendering thread, so capture no longer depends on the main
// thread keeping up (the deprecated ScriptProcessorNode dropped audio whenever
// the page was busy re-rendering). Loaded after /audio-utils.js, which defines
// globalThis.TalkToTypeAudio inside the same AudioWorkletGlobalScope.
//
// Posts { samples: Float32Array (targetRate, mono), level: RMS } roughly every
// 100 ms of output audio.

class TalkToTypeCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = Number(options?.processorOptions?.targetRate) || 16000;
    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.resampler = globalThis.TalkToTypeAudio.createResampler(sampleRate, targetRate);
    this.batchSize = Math.round(targetRate / 10);
    this.batch = new Float32Array(this.batchSize);
    this.batchCount = 0;
    this.levelSum = 0;
    this.levelCount = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') this.flush();
      if (event.data?.type === 'stop') {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.batchCount) return;
    const samples = this.batch.slice(0, this.batchCount);
    const level = this.levelCount ? Math.sqrt(this.levelSum / this.levelCount) : 0;
    this.port.postMessage({ samples, level }, [samples.buffer]);
    this.batchCount = 0;
    this.levelSum = 0;
    this.levelCount = 0;
  }

  process(inputs) {
    if (!this.active) return false;
    const channel = inputs[0]?.[0];
    if (!channel || !channel.length) return true;

    for (let i = 0; i < channel.length; i += 1) this.levelSum += channel[i] * channel[i];
    this.levelCount += channel.length;

    const resampled = this.resampler.process(channel);
    let offset = 0;
    while (offset < resampled.length) {
      const take = Math.min(resampled.length - offset, this.batchSize - this.batchCount);
      this.batch.set(resampled.subarray(offset, offset + take), this.batchCount);
      this.batchCount += take;
      offset += take;
      if (this.batchCount >= this.batchSize) this.flush();
    }
    return true;
  }
}

registerProcessor('talk-to-type-capture', TalkToTypeCaptureProcessor);
