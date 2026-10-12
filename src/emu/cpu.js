// The Ricoh 2A03's CPU: a MOS 6502 without decimal mode (the D flag can be
// set, but ADC and SBC ignore it), plus the unofficial opcodes some games use.
//
// Timing is per bus cycle: every read and write, including the 6502's dummy
// reads, first advances the rest of the machine by one CPU cycle (bus.tick),
// so the picture and sound chips see each access on the cycle it happens.
//
// Interrupts: NMI is edge-triggered (the PPU at vertical blank); IRQ is a
// level (the APU's frame counter and DMC, and some mappers), taken while the
// I flag is clear. Both are polled at the end of an instruction; CLI, SEI and
// PLP change I one instruction late for this purpose, as on the real chip.

import { capture, apply } from './state.js';

const STATE = ['a', 'x', 'y', 'sp', 'pc', 'n', 'v', 'd', 'i', 'z', 'c', 'nmiPending', 'nmiAt', 'instrEnd', 'pollI', 'jammed', 'cycles'];

export class CPU {
  // bus: { read(a), write(a, v), tick(), irq() -> bool }
  constructor(bus) { this.bus = bus; this.cycles = 0; this.powerOn(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  powerOn() {
    this.a = this.x = this.y = 0; this.sp = 0xFD; this.pc = 0;
    this.n = this.v = this.d = this.z = this.c = 0; this.i = 1;
    this.nmiPending = false; this.nmiAt = 0; this.instrEnd = 0; this.pollI = 1; this.jammed = false;
  }

  // RESET: three dummy stack accesses, I set, then the vector at FFFC.
  reset() {
    this.sp = (this.sp - 3) & 0xFF;
    this.i = 1; this.pollI = 1; this.jammed = false;
    for (let k = 0; k < 5; k++) this.bus.tick();
    this.pc = this.rd(0xFFFC) | (this.rd(0xFFFD) << 8);
  }

  // The NMI line's edge, noted with the cycle it arrived on: one arriving
  // during an instruction's last cycle is seen only after the next instruction.
  nmi(late = 0) { this.nmiPending = true; this.nmiAt = this.cycles + late; }

  // ---------------------------------------------------------------- bus

  rd(a) { this.bus.tick(); this.cycles++; return this.bus.read(a & 0xFFFF); }
  wr(a, v) { this.bus.tick(); this.cycles++; this.bus.write(a & 0xFFFF, v & 0xFF); }
  fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  push(v) { this.wr(0x100 | this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
  pull() { this.sp = (this.sp + 1) & 0xFF; return this.rd(0x100 | this.sp); }

  getP(b) { return (this.n << 7) | (this.v << 6) | 0x20 | (b ? 0x10 : 0) | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c; }
  setP(p) {
    this.n = (p >> 7) & 1; this.v = (p >> 6) & 1; this.d = (p >> 3) & 1;
    this.i = (p >> 2) & 1; this.z = (p >> 1) & 1; this.c = p & 1;
  }
  nz(v) { this.n = (v >> 7) & 1; this.z = v ? 0 : 1; return v; }

  // ---------------------------------------------------------------- addressing

  // Each returns the effective address, doing the mode's bus cycles. `write`
  // modes always take the extra (dummy-read) cycle on indexed addressing.
  zp() { return this.fetch(); }
  zpi(r) { const b = this.fetch(); this.rd(b); return (b + r) & 0xFF; }
  abs() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  absi(r, write) {
    const lo = this.fetch(), hi = this.fetch(), a = ((hi << 8) | lo) + r;
    if (write || ((lo + r) & 0x100)) this.rd((hi << 8) | ((lo + r) & 0xFF));   // dummy read at the unfixed address
    return a & 0xFFFF;
  }
  izx() {
    const b = this.fetch(); this.rd(b);
    const p = (b + this.x) & 0xFF;
    return this.rd(p) | (this.rd((p + 1) & 0xFF) << 8);
  }
  izy(write) {
    const p = this.fetch(), lo = this.rd(p), hi = this.rd((p + 1) & 0xFF), a = ((hi << 8) | lo) + this.y;
    if (write || ((lo + this.y) & 0x100)) this.rd((hi << 8) | ((lo + this.y) & 0xFF));
    return a & 0xFFFF;
  }

  // Operand address for the common read/modify modes by the opcode's low bits.
  addr(op, write) {
    switch (op & 0x1F) {
      case 0x01: case 0x03: return this.izx();
      case 0x04: case 0x05: case 0x06: case 0x07: return this.zp();
      case 0x0C: case 0x0D: case 0x0E: case 0x0F: return this.abs();
      case 0x11: case 0x13: return this.izy(write);
      case 0x14: case 0x15: return this.zpi(this.x);
      case 0x16: case 0x17: return this.zpi((op & 0xC0) === 0x80 ? this.y : this.x);   // STX/LDX/SAX/LAX use Y
      case 0x19: case 0x1B: return this.absi(this.y, write);
      case 0x1C: case 0x1D: return this.absi(this.x, write);
      case 0x1E: case 0x1F: return this.absi((op & 0xC0) === 0x80 ? this.y : this.x, write);
    }
    return 0;
  }

  // ---------------------------------------------------------------- ALU

  adc(v) {
    const r = this.a + v + this.c;
    this.v = (~(this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0;
    this.c = r > 0xFF ? 1 : 0;
    this.a = this.nz(r & 0xFF);
  }
  sbc(v) { this.adc(v ^ 0xFF); }
  cmp(r, v) { const t = r - v; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xFF); }
  asl(v) { this.c = v >> 7; return this.nz((v << 1) & 0xFF); }
  lsr(v) { this.c = v & 1; return this.nz(v >> 1); }
  rol(v) { const c = this.c; this.c = v >> 7; return this.nz(((v << 1) | c) & 0xFF); }
  ror(v) { const c = this.c; this.c = v & 1; return this.nz((v >> 1) | (c << 7)); }

  // Read-modify-write at an address: read, write the old value back, write the new.
  rmw(a, f) {
    const v = this.rd(a);
    this.wr(a, v);
    const r = f(v);
    this.wr(a, r);
    return r;
  }

  branch(cond) {
    const off = this.fetch();
    if (!cond) return;
    this.rd(this.pc);
    const t = (this.pc + (off & 0x80 ? off - 256 : off)) & 0xFFFF;
    if ((t ^ this.pc) & 0xFF00) this.rd((this.pc & 0xFF00) | (t & 0xFF));
    this.pc = t;
  }

  // ---------------------------------------------------------------- interrupts

  // Push PC and P, set I, jump through the vector. BRK pushes B set.
  interrupt(vector, brk) {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xFF);
    // An NMI arriving during an IRQ/BRK sequence takes over its vector.
    if (!brk || vector !== 0xFFFA) { if (this.nmiPending && vector === 0xFFFE) { this.nmiPending = false; vector = 0xFFFA; } }
    this.push(this.getP(brk));
    this.i = 1;
    this.pc = this.rd(vector) | (this.rd(vector + 1) << 8);
  }

  // ---------------------------------------------------------------- execution

  step() {
    if (this.jammed) { this.rd(this.pc); return; }
    if (this.nmiPending && this.nmiAt < this.instrEnd - 1) {
      this.nmiPending = false;
      this.rd(this.pc); this.rd(this.pc);
      this.interrupt(0xFFFA, false);
      this.pollI = this.i;
      this.instrEnd = this.cycles;
      return;
    }
    if (!this.pollI && this.bus.irq()) {
      this.rd(this.pc); this.rd(this.pc);
      this.interrupt(0xFFFE, false);
      this.pollI = this.i;
      this.instrEnd = this.cycles;
      return;
    }
    const iBefore = this.i;
    const op = this.fetch();
    this.exec(op);
    // CLI, SEI and PLP: the change counts for interrupt polling one instruction later.
    this.pollI = op === 0x58 || op === 0x78 || op === 0x28 ? iBefore : this.i;
    this.instrEnd = this.cycles;
  }

  exec(op) {
    switch (op) {
      // ---- loads, stores, transfers
      case 0xA9: this.a = this.nz(this.fetch()); return;
      case 0xA2: this.x = this.nz(this.fetch()); return;
      case 0xA0: this.y = this.nz(this.fetch()); return;
      case 0xA5: case 0xB5: case 0xAD: case 0xBD: case 0xB9: case 0xA1: case 0xB1:
        this.a = this.nz(this.rd(this.addr(op === 0xB9 ? 0x19 : op))); return;
      case 0xA6: case 0xB6: case 0xAE: case 0xBE: this.x = this.nz(this.rd(this.addr(op))); return;
      case 0xA4: case 0xB4: case 0xAC: case 0xBC: this.y = this.nz(this.rd(this.addr(op === 0xBC ? 0x1D : op))); return;
      case 0x85: case 0x95: case 0x8D: case 0x9D: case 0x99: case 0x81: case 0x91:
        this.wr(this.addr(op === 0x99 ? 0x19 : op, true), this.a); return;
      case 0x86: case 0x96: case 0x8E: this.wr(this.addr(op, true), this.x); return;
      case 0x84: case 0x94: case 0x8C: this.wr(this.addr(op, true), this.y); return;
      case 0xAA: this.rd(this.pc); this.x = this.nz(this.a); return;
      case 0xA8: this.rd(this.pc); this.y = this.nz(this.a); return;
      case 0x8A: this.rd(this.pc); this.a = this.nz(this.x); return;
      case 0x98: this.rd(this.pc); this.a = this.nz(this.y); return;
      case 0xBA: this.rd(this.pc); this.x = this.nz(this.sp); return;
      case 0x9A: this.rd(this.pc); this.sp = this.x; return;

      // ---- stack
      case 0x48: this.rd(this.pc); this.push(this.a); return;
      case 0x08: this.rd(this.pc); this.push(this.getP(true)); return;
      case 0x68: this.rd(this.pc); this.rd(0x100 | this.sp); this.a = this.nz(this.pull()); return;
      case 0x28: this.rd(this.pc); this.rd(0x100 | this.sp); this.setP(this.pull()); return;

      // ---- ALU with memory or immediate
      case 0x69: this.adc(this.fetch()); return;
      case 0xE9: case 0xEB: this.sbc(this.fetch()); return;
      case 0x29: this.a = this.nz(this.a & this.fetch()); return;
      case 0x09: this.a = this.nz(this.a | this.fetch()); return;
      case 0x49: this.a = this.nz(this.a ^ this.fetch()); return;
      case 0xC9: this.cmp(this.a, this.fetch()); return;
      case 0xE0: this.cmp(this.x, this.fetch()); return;
      case 0xC0: this.cmp(this.y, this.fetch()); return;
      case 0xE4: case 0xEC: this.cmp(this.x, this.rd(this.addr(op))); return;
      case 0xC4: case 0xCC: this.cmp(this.y, this.rd(this.addr(op))); return;
      case 0x24: case 0x2C: {
        const v = this.rd(this.addr(op));
        this.z = (this.a & v) ? 0 : 1; this.n = (v >> 7) & 1; this.v = (v >> 6) & 1;
        return;
      }

      // ---- register shifts, increments
      case 0x0A: this.rd(this.pc); this.a = this.asl(this.a); return;
      case 0x4A: this.rd(this.pc); this.a = this.lsr(this.a); return;
      case 0x2A: this.rd(this.pc); this.a = this.rol(this.a); return;
      case 0x6A: this.rd(this.pc); this.a = this.ror(this.a); return;
      case 0xE8: this.rd(this.pc); this.x = this.nz((this.x + 1) & 0xFF); return;
      case 0xCA: this.rd(this.pc); this.x = this.nz((this.x - 1) & 0xFF); return;
      case 0xC8: this.rd(this.pc); this.y = this.nz((this.y + 1) & 0xFF); return;
      case 0x88: this.rd(this.pc); this.y = this.nz((this.y - 1) & 0xFF); return;

      // ---- flags
      case 0x18: this.rd(this.pc); this.c = 0; return;
      case 0x38: this.rd(this.pc); this.c = 1; return;
      case 0x58: this.rd(this.pc); this.i = 0; return;
      case 0x78: this.rd(this.pc); this.i = 1; return;
      case 0xB8: this.rd(this.pc); this.v = 0; return;
      case 0xD8: this.rd(this.pc); this.d = 0; return;
      case 0xF8: this.rd(this.pc); this.d = 1; return;

      // ---- jumps and calls
      case 0x4C: this.pc = this.abs(); return;
      case 0x6C: {
        const p = this.abs();
        const lo = this.rd(p), hi = this.rd((p & 0xFF00) | ((p + 1) & 0xFF));   // the page-wrap bug
        this.pc = lo | (hi << 8);
        return;
      }
      case 0x20: {
        const lo = this.fetch();
        this.rd(0x100 | this.sp);
        this.push(this.pc >> 8); this.push(this.pc & 0xFF);
        this.pc = lo | (this.fetch() << 8);
        return;
      }
      case 0x60: {
        this.rd(this.pc); this.rd(0x100 | this.sp);
        const lo = this.pull(), hi = this.pull();
        this.pc = (lo | (hi << 8)) + 1 & 0xFFFF;
        this.rd((this.pc - 1) & 0xFFFF);
        return;
      }
      case 0x40: {
        this.rd(this.pc); this.rd(0x100 | this.sp);
        this.setP(this.pull());
        this.pc = this.pull() | (this.pull() << 8);
        return;
      }
      case 0x00: this.fetch(); this.interrupt(0xFFFE, true); return;   // BRK (skips a padding byte)

      // ---- branches
      case 0x10: this.branch(!this.n); return;
      case 0x30: this.branch(this.n); return;
      case 0x50: this.branch(!this.v); return;
      case 0x70: this.branch(this.v); return;
      case 0x90: this.branch(!this.c); return;
      case 0xB0: this.branch(this.c); return;
      case 0xD0: this.branch(!this.z); return;
      case 0xF0: this.branch(this.z); return;

      // ---- NOPs (official and unofficial)
      case 0xEA: case 0x1A: case 0x3A: case 0x5A: case 0x7A: case 0xDA: case 0xFA: this.rd(this.pc); return;
      case 0x80: case 0x82: case 0x89: case 0xC2: case 0xE2: this.fetch(); return;
      case 0x04: case 0x44: case 0x64: case 0x0C: case 0x14: case 0x34: case 0x54: case 0x74: case 0xD4: case 0xF4:
      case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC:
        this.rd(this.addr(op)); return;

      // ---- unofficial immediates
      case 0x0B: case 0x2B: this.a = this.nz(this.a & this.fetch()); this.c = this.n; return;            // ANC
      case 0x4B: this.a = this.lsr(this.a & this.fetch()); return;                                       // ALR
      case 0x6B: {                                                                                      // ARR
        this.a = (this.a & this.fetch());
        this.a = this.nz((this.a >> 1) | (this.c << 7));
        this.c = (this.a >> 6) & 1; this.v = ((this.a >> 6) ^ (this.a >> 5)) & 1;
        return;
      }
      case 0xCB: { const t = (this.a & this.x) - this.fetch(); this.c = t >= 0 ? 1 : 0; this.x = this.nz(t & 0xFF); return; }   // AXS
      case 0xAB: this.a = this.x = this.nz(this.fetch()); return;                                       // LAX #imm (stable variant)
      case 0x8B: this.a = this.nz(this.x & this.fetch()); return;                                       // XAA (approximation)
      case 0x9C: case 0x9E: case 0x9F: case 0x93: case 0x9B: {                                          // SHY/SHX/SHA/TAS: high-byte AND stores
        const write = true;
        let a;
        if (op === 0x9C) a = this.absi(this.x, write); else if (op === 0x93) a = this.izy(write); else a = this.absi(this.y, write);
        const r = op === 0x9C ? this.y : op === 0x9E ? this.x : this.a & this.x;
        if (op === 0x9B) this.sp = this.a & this.x;
        // The value is ANDed with the base address's high byte plus one; when
        // indexing crossed a page, that value also replaces the high byte.
        const base = (a - (op === 0x9C ? this.x : this.y)) & 0xFFFF;
        const v = r & (((base >> 8) + 1) & 0xFF);
        const target = (base & 0xFF00) !== (a & 0xFF00) ? (v << 8) | (a & 0xFF) : a;
        this.wr(target, v);
        return;
      }
      case 0xBB: { const v = this.rd(this.absi(this.y)) & this.sp; this.a = this.x = this.sp = this.nz(v); return; }   // LAS
    }

    // ---- the regular groups: ALU (cc=01), read-modify-write (cc=10), unofficial (cc=11)
    const aaa = op >> 5, cc = op & 3;
    if (cc === 1) {
      const v = this.rd(this.addr(op));
      switch (aaa) {
        case 0: this.a = this.nz(this.a | v); return;
        case 1: this.a = this.nz(this.a & v); return;
        case 2: this.a = this.nz(this.a ^ v); return;
        case 3: this.adc(v); return;
        case 6: this.cmp(this.a, v); return;
        case 7: this.sbc(v); return;
      }
    }
    const mode = op & 0x1F;
    if (cc === 2 && (mode === 0x06 || mode === 0x0E || mode === 0x16 || mode === 0x1E) && aaa !== 4 && aaa !== 5) {   // ASL ROL LSR ROR DEC INC on memory
      const a = this.addr(op, true);
      switch (aaa) {
        case 0: this.rmw(a, (v) => this.asl(v)); return;
        case 1: this.rmw(a, (v) => this.rol(v)); return;
        case 2: this.rmw(a, (v) => this.lsr(v)); return;
        case 3: this.rmw(a, (v) => this.ror(v)); return;
        case 6: this.rmw(a, (v) => this.nz((v - 1) & 0xFF)); return;
        case 7: this.rmw(a, (v) => this.nz((v + 1) & 0xFF)); return;
      }
    }
    if (cc === 3) {
      if (aaa === 4) { this.wr(this.addr(op, true), this.a & this.x); return; }                  // SAX
      if (aaa === 5) { const v = this.rd(this.addr(op)); this.a = this.x = this.nz(v); return; }  // LAX
      const a = this.addr(op, true);
      switch (aaa) {
        case 0: { const r = this.rmw(a, (v) => this.asl(v)); this.a = this.nz(this.a | r); return; }    // SLO
        case 1: { const r = this.rmw(a, (v) => this.rol(v)); this.a = this.nz(this.a & r); return; }    // RLA
        case 2: { const r = this.rmw(a, (v) => this.lsr(v)); this.a = this.nz(this.a ^ r); return; }   // SRE
        case 3: { const r = this.rmw(a, (v) => this.ror(v)); this.adc(r); return; }                   // RRA
        case 6: { const r = this.rmw(a, (v) => (v - 1) & 0xFF); this.cmp(this.a, r); return; }        // DCP
        case 7: { const r = this.rmw(a, (v) => (v + 1) & 0xFF); this.sbc(r); return; }                // ISB
      }
    }
    // Anything else halts the CPU (the KIL/JAM opcodes).
    this.jammed = true;
  }
}
