// The NES (NTSC): the 2A03 (CPU and sound), the 2C02 picture processor, 2K
// of RAM, two controller ports and the cartridge.
//
//   0000-07FF RAM (mirrored to 1FFF)   2000-2007 PPU (mirrored to 3FFF)
//   4000-4017 sound, OAM DMA (4014), controllers (4016/4017)
//   4020-FFFF cartridge (6000-7FFF work/battery RAM, 8000-FFFF program ROM)
//
// Clock: three PPU dots and one sound tick per CPU cycle, 1.79 MHz, 60.1
// frames a second.

import { CPU } from './cpu.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { Cart } from './cart.js';
import { capture, apply } from './state.js';

export const FPS = 1789773 / 29780.5;

const STATE = ['cpu', 'ppu', 'apu', 'cart', 'ram', 'openBus', 'strobe', 'shift', 'stallPending'];

export class NES {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor() {
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.apu = new APU({ read: (a) => this.peek(a), stall: (n) => { this.stallPending += n; } });
    this.cart = null;
    this.buttons = 0;          // pressed: 01 A, 02 B, 04 select, 08 start, 10 up, 20 down, 40 left, 80 right
    this.ram = new Uint8Array(0x800);
    this.openBus = 0; this.strobe = 0; this.shift = new Uint8Array(2); this.stallPending = 0;
  }

  // ---------------------------------------------------------------- cartridge

  load(rom) {
    this.cart = new Cart(rom);
    this.cartClocked = this.cart.clocked;      // carts with a CPU-cycle counter (FME-7)
    this.powerOn();
    return this.cart;
  }

  powerOn() {
    this.ram.fill(0);
    this.ppu.reset();
    this.apu.reset();
    this.cart.reset();
    this.openBus = 0; this.strobe = 0; this.shift.fill(0); this.stallPending = 0;
    this.cpu.powerOn();
    this.cpu.reset();
  }

  // The console's reset button: CPU and sound restart; RAM and the cartridge keep their contents.
  softReset() {
    this.apu.write(0x4015, 0);
    this.ppu.ctrl = 0; this.ppu.mask = 0; this.ppu.w = 0;
    this.cpu.reset();
  }

  // ---------------------------------------------------------------- CPU bus

  // An NMI raised on a CPU cycle's first dot counts as raised during the cycle before.
  nmi() { this.cpu.nmi(this.phase === 0 ? -1 : 0); }
  cancelNmi() { this.cpu.nmiPending = false; }
  irq() { return this.apu.irq || this.cart.irq; }

  // A read without side effects on the PPU or controllers (for the DMC's sample fetches).
  peek(a) {
    if (a < 0x2000) return this.ram[a & 0x7FF];
    if (a >= 0x4020) { const v = this.cart.cpuRead(a); return v === null ? this.openBus : v; }
    return this.openBus;
  }

  read(a) {
    let v;
    if (a < 0x2000) v = this.ram[a & 0x7FF];
    else if (a < 0x4000) v = this.ppu.readReg(a);
    else if (a < 0x4020) {
      if (a === 0x4015) v = this.apu.readStatus() | (this.openBus & 0x20);
      else if (a === 0x4016 || a === 0x4017) v = this.readPad(a & 1) | (this.openBus & 0xE0);
      else v = this.openBus;
    } else {
      v = this.cart.cpuRead(a);
      if (v === null) v = this.openBus;
    }
    return (this.openBus = v);
  }

  write(a, v) {
    this.openBus = v;
    if (a < 0x2000) { this.ram[a & 0x7FF] = v; return; }
    if (a < 0x4000) { this.ppu.writeReg(a, v); return; }
    if (a < 0x4020) {
      if (a === 0x4014) this.oamDma(v);
      else if (a === 0x4016) { this.strobe = v & 1; if (this.strobe) this.latchPads(); }
      else if (a < 0x4018) this.apu.write(a, v);
      return;
    }
    this.cart.cpuWrite(a, v, this.cpu.cycles);
  }

  // ---------------------------------------------------------------- controllers

  latchPads() { this.shift[0] = this.buttons; this.shift[1] = 0; }
  // Serial read: A, B, Select, Start, Up, Down, Left, Right, then 1s.
  readPad(n) {
    if (this.strobe) this.latchPads();
    const bit = this.shift[n] & 1;
    this.shift[n] = (this.shift[n] >> 1) | 0x80;
    return bit;
  }

  // ---------------------------------------------------------------- DMA

  // 4014: copy a page into sprite memory through 2004; the CPU is held for 513
  // cycles (514 if it started on an odd cycle).
  oamDma(page) {
    const cpu = this.cpu;
    this.tick(); cpu.cycles++;
    if (cpu.cycles & 1) { this.tick(); cpu.cycles++; }
    for (let i = 0; i < 256; i++) {
      this.tick(); cpu.cycles++;
      const v = this.read((page << 8) | i);
      this.tick(); cpu.cycles++;
      this.ppu.writeReg(4, v);
    }
  }

  // ---------------------------------------------------------------- clock

  // One CPU cycle: three PPU dots and a sound tick (plus any cycles a DMC fetch stole).
  tick() {
    const ppu = this.ppu;
    this.phase = 0; ppu.tick(); this.phase = 1; ppu.tick(); this.phase = 2; ppu.tick();
    this.apu.tick();
    if (this.cartClocked) this.cart.cpuCycle();
    while (this.stallPending > 0) {
      this.stallPending--;
      ppu.tick(); ppu.tick(); ppu.tick();
      this.apu.tick();
      if (this.cartClocked) this.cart.cpuCycle();
      this.cpu.cycles++;
    }
  }

  // Run until the PPU reaches vertical blank.
  runFrame() {
    if (!this.cart) return;
    this.ppu.frameReady = false;
    const start = this.cpu.cycles;
    while (!this.ppu.frameReady && this.cpu.cycles - start < 40000) this.cpu.step();
  }

  get frame() { return this.ppu.frame; }
}
