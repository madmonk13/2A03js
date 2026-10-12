// The 2A03's sound (APU): two pulse channels with envelopes and frequency
// sweeps, a triangle with a linear counter, a noise channel from a 15-bit
// shift register, and the DMC, which plays 1-bit delta samples it reads from
// cartridge memory. A frame counter clocks the envelopes and linear counter
// (quarter frames) and the length counters and sweeps (half frames), and can
// raise an IRQ. The five channels mix nonlinearly, as the console's resistor
// network does.
//
// Registers 4000-4013, 4015 (enables / status), 4017 (frame counter). Ticked
// once per CPU cycle; output goes to a ring buffer at SAMPLE_RATE.

import { capture, apply } from './state.js';

export const SAMPLE_RATE = 48000;
const CPU_HZ = 1789773;

const LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DUTY = [0b01000000, 0b01100000, 0b01111000, 0b10011111];
const TRIANGLE = Uint8Array.from({ length: 32 }, (_, i) => (i < 16 ? 15 - i : i - 16));
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const DMC_RATES = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

// The mixer's two halves, precomputed: pulses (0-30 summed) and triangle/noise/DMC.
const PULSE_MIX = Float32Array.from({ length: 31 }, (_, n) => (n ? 95.52 / (8128 / n + 100) : 0));
const TND_MIX = Float32Array.from({ length: 203 }, (_, n) => (n ? 163.67 / (24329 / n + 100) : 0));

const pulse = () => ({ enabled: false, duty: 0, step: 0, timer: 0, period: 0, length: 0, halt: false,
  constVol: false, vol: 0, envStart: false, envDiv: 0, envDecay: 0,
  sweepOn: false, sweepPeriod: 0, sweepNeg: false, sweepShift: 0, sweepDiv: 0, sweepReload: false });

const STATE = ['p', 'tri', 'noise', 'dmc', 'frameMode', 'frameInhibit', 'frameIrq', 'frameClock', 'resetDelay', 'odd', 'acc', 'accN', 'sampleClock', 'dcIn', 'dcOut', 'lp'];

export class APU {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // sys: { read(addr) } for the DMC's sample fetches, and stall(cycles).
  constructor(sys) {
    this.sys = sys;
    this.buffer = new Float32Array(1 << 15);
    this.writePos = this.readPos = 0;
    this.reset();
  }

  reset() {
    this.p = [pulse(), pulse()];
    this.tri = { enabled: false, timer: 0, period: 0, step: 0, length: 0, control: false, linear: 0, linearReload: 0, linearFlag: false };
    this.noise = { enabled: false, timer: 0, period: 4, shift: 1, mode: false, length: 0, halt: false,
      constVol: false, vol: 0, envStart: false, envDiv: 0, envDecay: 0 };
    this.dmc = { enabled: false, irqOn: false, loop: false, rate: 428, timer: 428, level: 0, addr: 0xC000, len: 1,
      cur: 0xC000, remaining: 0, sample: -1, shift: 0, bits: 8, silent: true, irq: false };
    this.frameMode = 0; this.frameInhibit = false; this.frameIrq = false; this.frameClock = 0; this.resetDelay = 0;
    this.odd = false;
    this.acc = 0; this.accN = 0; this.sampleClock = 0;
    this.dcIn = this.dcOut = 0; this.lp = 0;
  }

  get irq() { return this.frameIrq || this.dmc.irq; }

  // ---------------------------------------------------------------- registers

  write(a, v) {
    const r = a & 0x1F;
    if (r < 8) {
      const c = this.p[r >> 2];
      switch (r & 3) {
        case 0: c.duty = v >> 6; c.halt = !!(v & 0x20); c.constVol = !!(v & 0x10); c.vol = v & 15; break;
        case 1: c.sweepOn = !!(v & 0x80); c.sweepPeriod = (v >> 4) & 7; c.sweepNeg = !!(v & 8); c.sweepShift = v & 7; c.sweepReload = true; break;
        case 2: c.period = (c.period & 0x700) | v; break;
        case 3:
          c.period = (c.period & 0xFF) | ((v & 7) << 8);
          if (c.enabled) c.length = LENGTHS[v >> 3];
          c.step = 0; c.envStart = true;
          break;
      }
      return;
    }
    const t = this.tri, n = this.noise, d = this.dmc;
    switch (r) {
      case 0x08: t.control = !!(v & 0x80); t.linearReload = v & 0x7F; break;
      case 0x0A: t.period = (t.period & 0x700) | v; break;
      case 0x0B: t.period = (t.period & 0xFF) | ((v & 7) << 8); if (t.enabled) t.length = LENGTHS[v >> 3]; t.linearFlag = true; break;
      case 0x0C: n.halt = !!(v & 0x20); n.constVol = !!(v & 0x10); n.vol = v & 15; break;
      case 0x0E: n.mode = !!(v & 0x80); n.period = NOISE_PERIODS[v & 15]; break;
      case 0x0F: if (n.enabled) n.length = LENGTHS[v >> 3]; n.envStart = true; break;
      case 0x10: d.irqOn = !!(v & 0x80); d.loop = !!(v & 0x40); d.rate = DMC_RATES[v & 15]; if (!d.irqOn) d.irq = false; break;
      case 0x11: d.level = v & 0x7F; break;
      case 0x12: d.addr = 0xC000 | (v << 6); break;
      case 0x13: d.len = (v << 4) + 1; break;
      case 0x15:
        this.p[0].enabled = !!(v & 1); if (!(v & 1)) this.p[0].length = 0;
        this.p[1].enabled = !!(v & 2); if (!(v & 2)) this.p[1].length = 0;
        t.enabled = !!(v & 4); if (!(v & 4)) t.length = 0;
        n.enabled = !!(v & 8); if (!(v & 8)) n.length = 0;
        d.irq = false;
        if (!(v & 0x10)) d.remaining = 0;
        else if (!d.remaining) { d.cur = d.addr; d.remaining = d.len; this.dmcFetch(); }
        break;
      case 0x17:
        this.frameMode = v >> 7;
        this.frameInhibit = !!(v & 0x40);
        if (this.frameInhibit) this.frameIrq = false;
        // The sequencer restarts 3 or 4 cycles later; in 5-step mode that also clocks everything at once.
        this.resetDelay = this.odd ? 3 : 4;
        break;
    }
  }

  // 4015: length counters running, DMC active, the IRQ flags. Reading clears the frame IRQ.
  readStatus() {
    const v = (this.p[0].length ? 1 : 0) | (this.p[1].length ? 2 : 0) | (this.tri.length ? 4 : 0) | (this.noise.length ? 8 : 0)
      | (this.dmc.remaining ? 0x10 : 0) | (this.frameIrq ? 0x40 : 0) | (this.dmc.irq ? 0x80 : 0);
    this.frameIrq = false;
    return v;
  }

  // ---------------------------------------------------------------- frame counter

  quarter() {
    for (const c of [this.p[0], this.p[1], this.noise]) {
      if (c.envStart) { c.envStart = false; c.envDecay = 15; c.envDiv = c.vol; }
      else if (c.envDiv === 0) { c.envDiv = c.vol; if (c.envDecay) c.envDecay--; else if (c.halt) c.envDecay = 15; }
      else c.envDiv--;
    }
    const t = this.tri;
    if (t.linearFlag) t.linear = t.linearReload; else if (t.linear) t.linear--;
    if (!t.control) t.linearFlag = false;
  }

  half() {
    for (const c of [this.p[0], this.p[1], this.noise]) if (!c.halt && c.length) c.length--;
    if (!this.tri.control && this.tri.length) this.tri.length--;
    for (let k = 0; k < 2; k++) {
      const c = this.p[k];
      const target = this.sweepTarget(c, k);
      if (c.sweepDiv === 0 && c.sweepOn && c.sweepShift && c.period >= 8 && target <= 0x7FF) c.period = target;
      if (c.sweepDiv === 0 || c.sweepReload) { c.sweepDiv = c.sweepPeriod; c.sweepReload = false; } else c.sweepDiv--;
    }
  }

  // Pulse 1 negates with one's complement (one less than pulse 2).
  sweepTarget(c, k) {
    const delta = c.period >> c.sweepShift;
    return c.sweepNeg ? c.period - delta - (k === 0 ? 1 : 0) : c.period + delta;
  }

  // ---------------------------------------------------------------- DMC

  dmcFetch() {
    const d = this.dmc;
    if (d.sample >= 0 || !d.remaining) return;
    this.sys.stall(4);                                  // the fetch steals CPU cycles
    d.sample = this.sys.read(d.cur);
    d.cur = d.cur === 0xFFFF ? 0x8000 : d.cur + 1;
    if (--d.remaining === 0) {
      if (d.loop) { d.cur = d.addr; d.remaining = d.len; } else if (d.irqOn) d.irq = true;
    }
  }

  // ---------------------------------------------------------------- running

  // One CPU cycle.
  tick() {
    this.odd = !this.odd;
    // Frame counter (counted in CPU cycles).
    if (this.resetDelay && --this.resetDelay === 0) {
      this.frameClock = -1;                       // counting starts on the next cycle
      if (this.frameMode) { this.quarter(); this.half(); }
    }
    const fc = ++this.frameClock;
    if (fc === 7457) this.quarter();
    else if (fc === 14913) { this.quarter(); this.half(); }
    else if (fc === 22371) this.quarter();
    else if (this.frameMode === 0 && fc >= 29828 && fc <= 29830) {
      if (fc === 29829) { this.quarter(); this.half(); }
      if (!this.frameInhibit) this.frameIrq = true;
      if (fc === 29830) this.frameClock = 0;
    } else if (this.frameMode === 1 && fc === 37281) { this.quarter(); this.half(); }
    else if (this.frameMode === 1 && fc >= 37282) this.frameClock = 0;

    // Pulses step every other CPU cycle.
    if (this.odd) {
      for (const c of this.p) {
        if (c.timer === 0) { c.timer = c.period; c.step = (c.step + 1) & 7; } else c.timer--;
      }
    }
    // Triangle: every cycle, only while both counters run.
    const t = this.tri;
    if (t.timer === 0) {
      t.timer = t.period;
      if (t.length && t.linear) t.step = (t.step + 1) & 31;
    } else t.timer--;
    // Noise.
    const n = this.noise;
    if (n.timer === 0) {
      n.timer = n.period - 1;
      const fb = (n.shift ^ (n.shift >> (n.mode ? 6 : 1))) & 1;
      n.shift = (n.shift >> 1) | (fb << 14);
    } else n.timer--;
    // DMC: one bit of the sample each rate period.
    const d = this.dmc;
    if (--d.timer <= 0) {
      d.timer = d.rate;
      if (!d.silent) {
        if (d.shift & 1) { if (d.level <= 125) d.level += 2; } else if (d.level >= 2) d.level -= 2;
      }
      d.shift >>= 1;
      if (--d.bits === 0) {
        d.bits = 8;
        if (d.sample < 0) d.silent = true;
        else { d.silent = false; d.shift = d.sample; d.sample = -1; this.dmcFetch(); }
      }
    }

    // Mix and average down to the output rate.
    this.acc += this.mix();
    this.accN++;
    this.sampleClock += SAMPLE_RATE;
    if (this.sampleClock >= CPU_HZ) { this.sampleClock -= CPU_HZ; this.output(this.acc / this.accN); this.acc = 0; this.accN = 0; }
  }

  pulseOut(c, k) {
    if (!c.length || c.period < 8 || this.sweepTarget(c, k) > 0x7FF) return 0;
    if (!((DUTY[c.duty] << c.step) & 0x80)) return 0;
    return c.constVol ? c.vol : c.envDecay;
  }

  mix() {
    const p1 = this.pulseOut(this.p[0], 0), p2 = this.pulseOut(this.p[1], 1);
    const t = this.tri, n = this.noise;
    const tv = t.period < 2 ? 7 : TRIANGLE[t.step];            // ultrasonic periods hold mid-level instead of whining
    const nv = n.length && !(n.shift & 1) ? (n.constVol ? n.vol : n.envDecay) : 0;
    return PULSE_MIX[p1 + p2] + TND_MIX[3 * tv + 2 * nv + this.dmc.level];
  }

  output(s) {
    // The console's output filters: a high-pass (DC removal) and a gentle low-pass.
    const hp = s - this.dcIn + 0.996 * this.dcOut;
    this.dcIn = s; this.dcOut = hp;
    this.lp += (hp - this.lp) * 0.6;
    const buf = this.buffer, mask = buf.length - 1;
    buf[this.writePos] = this.lp * 1.4;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }

  // Fallback output path (ScriptProcessor): resample into `out` at `outRate`.
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = SAMPLE_RATE / outRate;
    if (this.available() > SAMPLE_RATE * 0.075) this.readPos = (this.writePos - Math.floor(SAMPLE_RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}
