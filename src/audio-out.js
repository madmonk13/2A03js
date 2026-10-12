// Browser audio sink for the sound chip's sample ring buffer. Must be started
// from a user gesture.
//
// Output goes through an AudioWorklet where available: it runs on the audio
// thread, so it can keep a short queue without dropping out when the main
// thread is busy emulating. Older browsers and insecure (plain http) pages fall
// back to a ScriptProcessor, which pulls straight from the ring buffer.
//
// Mobile browsers (iOS especially) can leave the context 'suspended' or
// 'interrupted' after backgrounding, a call or another app taking audio, and
// sometimes leave it 'running' while output has quietly stopped. start() is
// called on every user gesture and repairs whichever of these it finds.

import { SAMPLE_RATE } from './emu/apu.js';

const STALL_MS = 1000;   // no sign of output for this long while running = stalled
const WORKLET_URL = new URL('./audio-worklet.js', import.meta.url);

export class AudioOut {
  constructor(source) {
    this.source = source;
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.worklet = false;   // true once the AudioWorklet path is live
    this.muted = false;
    this.volume = 0.7;      // 0..1, as set by the player
    this.lastProcess = 0;
  }

  start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (this.ctx && this.ctx.state === 'running' && this.stalled()) this.rebuild();
    if (!this.ctx || this.ctx.state === 'closed') this.create(Ctx);
    this.resume();
    this.kick();
  }

  // Resume a suspended or interrupted context. Safe outside a gesture: it just
  // fails quietly and the next gesture tries again.
  resume() {
    if (!this.ctx || this.ctx.state === 'running' || this.ctx.state === 'closed') return;
    this.lastProcess = performance.now(); // don't mistake the restart for a stall
    this.ctx.resume().catch(() => {});
  }

  create(Ctx) {
    const ctx = this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.gain = ctx.createGain();
    this.gain.gain.value = this.level();
    this.gain.connect(ctx.destination);
    this.lastProcess = performance.now();
    if (!ctx.audioWorklet) { this.useScriptProcessor(); return; }
    ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
      if (this.ctx !== ctx) return; // rebuilt while loading
      const node = new AudioWorkletNode(ctx, 'sound-output', {
        numberOfInputs: 0, outputChannelCount: [1], processorOptions: { rate: SAMPLE_RATE },
      });
      node.port.onmessage = () => { this.lastProcess = performance.now(); };
      node.connect(this.gain);
      this.node = node;
      this.worklet = true;
      this.source.readPos = this.source.writePos;
    }).catch(() => { if (this.ctx === ctx) this.useScriptProcessor(); });
  }

  useScriptProcessor() {
    const node = this.ctx.createScriptProcessor(512, 0, 1);
    node.onaudioprocess = (e) => {
      this.lastProcess = performance.now();
      const out = e.outputBuffer.getChannelData(0);
      if (this.muted) { out.fill(0); this.source.readPos = this.source.writePos; return; }
      this.source.pull(out, this.ctx.sampleRate);
    };
    node.connect(this.gain);
    this.node = node;
    this.worklet = false;
  }

  // Hand the samples emulated since the last call to the worklet. Called after
  // each batch of frames; a no-op on the ScriptProcessor path, which pulls.
  flush() {
    if (!this.worklet) return;
    const src = this.source, n = src.available();
    if (!n) return;
    if (this.muted || this.ctx.state !== 'running') { src.readPos = src.writePos; return; }
    const buf = src.buffer, mask = buf.length - 1, out = new Float32Array(n);
    for (let i = 0, r = src.readPos; i < n; i++, r = (r + 1) & mask) out[i] = buf[r];
    src.readPos = src.writePos;
    this.node.port.postMessage(out, [out.buffer]);
  }

  rebuild() {
    try { this.node && this.node.disconnect(); } catch { /* already gone */ }
    this.ctx.close().catch(() => {});
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.worklet = false;
  }

  stalled() {
    return !document.hidden && performance.now() - this.lastProcess > STALL_MS;
  }

  // Play one silent sample inside the gesture: iOS only fully unlocks output
  // once a source has actually started from a user action.
  kick() {
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.ctx.destination);
      src.start(0);
    } catch { /* not ready yet; the next gesture tries again */ }
  }

  // Loudness follows the square of the slider, which sounds more even than a
  // straight line; the default 70% matches the original fixed level.
  level() { return this.volume * this.volume; }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.gain) this.gain.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.02);
  }

  // A short beep at the current volume, so the slider can be heard while the
  // game is paused.
  preview() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const osc = this.ctx.createOscillator(), env = this.ctx.createGain(), t = this.ctx.currentTime;
    osc.type = 'square';
    osc.frequency.value = 440;
    env.gain.setValueAtTime(0.3, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(env).connect(this.gain);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  setMuted(m) {
    // Drop anything queued while muted so sound resumes in sync with the game.
    if (this.muted && !m) {
      this.source.readPos = this.source.writePos;
      if (this.worklet) this.node.port.postMessage('flush');
    }
    this.muted = m;
  }
}
