// Audio-thread side of AudioOut: receives sound samples from the main thread
// after each emulated frame, resamples them to the output rate, and keeps the
// queue short so sound stays close to the picture.

class SoundOutput extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    const rate = processorOptions.rate;
    this.step = rate / sampleRate;
    this.buf = new Float32Array(1 << 14);
    this.mask = this.buf.length - 1;
    this.w = 0; this.r = 0; this.frac = 0; this.last = 0;
    // Enough queued to ride out frame-timing jitter on the main thread, and a
    // ceiling past which we skip ahead instead of letting latency build up.
    this.target = Math.round(rate * 0.035);
    this.ceiling = Math.round(rate * 0.075);
    this.beat = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.r = this.w; return; }
      const s = e.data, buf = this.buf, mask = this.mask;
      for (let i = 0; i < s.length; i++) {
        buf[this.w] = s[i];
        this.w = (this.w + 1) & mask;
        if (this.w === this.r) this.r = (this.r + 1) & mask;
      }
    };
  }

  available() { return (this.w - this.r) & this.mask; }

  process(_, outputs) {
    const out = outputs[0][0], buf = this.buf, mask = this.mask;
    if (this.available() > this.ceiling) this.r = (this.w - this.target) & mask;
    let pos = this.frac, last = this.last;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.r], s1 = buf[(this.r + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += this.step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.r = (this.r + 1) & mask; }
    }
    this.frac = pos; this.last = last;
    // Heartbeat about four times a second so the main thread can spot a stall.
    if ((this.beat += out.length) >= sampleRate / 4) { this.beat = 0; this.port.postMessage(0); }
    return true;
  }
}

registerProcessor('sound-output', SoundOutput);
