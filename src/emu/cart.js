// NES cartridges: the iNES / NES 2.0 header, and the mappers that page PRG
// (program) ROM into the CPU's 8000-FFFF and CHR (graphics) ROM or RAM into
// the PPU's 0000-1FFF, and pick the nametable mirroring.
//
// Header (16 bytes): "NES" 1A, PRG size in 16K units, CHR size in 8K units
// (0 = 8K of CHR RAM), flags 6 (mirroring, battery, trainer, four-screen,
// mapper low nibble), flags 7 (mapper high nibble, NES 2.0 marker).
//
//   0  NROM     no banking
//   1  MMC1     serial-loaded registers: 16K/32K PRG and 4K/8K CHR banks, mirroring
//   2  UxROM    16K PRG bank at 8000, last bank fixed
//   3  CNROM    8K CHR bank
//   4  MMC3     8K PRG / 1-2K CHR banks and a scanline counter IRQ
//   7  AxROM    32K PRG bank, one-screen mirroring
//   9  MMC2     Punch-Out!!: CHR banks that switch when the PPU reads tiles FD / FE
//  11  Color Dreams, 66 GxROM: 32K PRG and 8K CHR banks
//  69  Sunsoft FME-7: 8K PRG / 1K CHR banks, ROM or RAM at 6000, and a CPU-cycle IRQ counter
//      (Batman: Return of the Joker, Gimmick!'s board without its 5B sound)
//  71  Camerica: 16K PRG bank (Micro Machines, Fire Hawk)

import { capture, apply } from './state.js';

// Mirroring: which physical nametable (0 or 1, of the console's 2K) each of
// the four logical ones maps to; four-screen carts bring 2K more (2, 3).
export const MIRROR = {
  horizontal: [0, 0, 1, 1], vertical: [0, 1, 0, 1], single0: [0, 0, 0, 0], single1: [1, 1, 1, 1], four: [0, 1, 2, 3],
};

const NAMES = { 0: 'NROM', 1: 'MMC1', 2: 'UxROM', 3: 'CNROM', 4: 'MMC3', 7: 'AxROM', 9: 'MMC2', 11: 'Color Dreams', 66: 'GxROM', 69: 'FME-7', 71: 'Camerica' };

export function readHeader(rom) {
  if (rom.length < 16 || rom[0] !== 0x4E || rom[1] !== 0x45 || rom[2] !== 0x53 || rom[3] !== 0x1A) {
    throw new Error('not an NES ROM (no iNES header)');
  }
  const nes2 = (rom[7] & 0x0C) === 0x08;
  let mapper = (rom[6] >> 4) | (rom[7] & 0xF0);
  // Old dumps sometimes have junk in bytes 7-15 ("DiskDude!"): ignore the high nibble then.
  if (!nes2 && rom[12] | rom[13] | rom[14] | rom[15]) mapper &= 0x0F;
  const prgUnits = rom[4] | (nes2 ? (rom[9] & 0x0F) << 8 : 0), chrUnits = rom[5] | (nes2 ? (rom[9] & 0xF0) << 4 : 0);
  return {
    mapper,
    prgSize: prgUnits * 0x4000,
    chrSize: chrUnits * 0x2000,
    mirroring: rom[6] & 0x08 ? 'four' : rom[6] & 1 ? 'vertical' : 'horizontal',
    battery: !!(rom[6] & 2),
    trainer: !!(rom[6] & 4),
  };
}

const STATE = ['prgRam', 'chrRam', 'regs', 'mirror', 'irqLatch', 'irqCounter', 'irqReload', 'irqEnabled', 'irqLine', 'shift', 'shiftCount', 'latch0', 'latch1', 'command'];

export class Cart {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.update(); }

  constructor(rom) {
    const h = this.header = readHeader(rom);
    if (!(h.mapper in NAMES)) throw new Error(`this cartridge's mapper (${h.mapper}) isn't supported yet`);
    this.mapper = h.mapper;
    this.name = NAMES[h.mapper];
    this.battery = h.battery;
    const start = 16 + (h.trainer ? 512 : 0);
    this.prg = rom.slice(start, start + h.prgSize);
    if (this.prg.length < 0x4000) throw new Error('the ROM is shorter than its header says');
    this.chrRom = h.chrSize ? rom.slice(start + h.prgSize, start + h.prgSize + h.chrSize) : null;
    this.chrRam = this.chrRom ? new Uint8Array(0) : new Uint8Array(0x2000);
    this.chr = this.chrRom || this.chrRam;
    this.prgRam = new Uint8Array(0x2000);
    if (h.trainer) this.prgRam.set(rom.subarray(16, 16 + 512), 0x1000);
    this.vram4 = h.mirroring === 'four' ? new Uint8Array(0x800) : null;
    this.prgBanks8 = this.prg.length >> 13;
    this.chrBanks1 = Math.max(1, this.chr.length >> 10);
    this.prgMap = new Int32Array(4);    // byte offsets of the four 8K CPU windows at 8000-FFFF
    this.chrMap = new Int32Array(8);    // byte offsets of the eight 1K PPU windows at 0000-1FFF
    this.reset();
  }

  reset() {
    this.regs = new Uint8Array(16);       // mapper registers (MMC3: 0 bank select, 8-15 its eight bank values)
    this.mirror = this.header.mirroring;
    this.irqLatch = 0; this.irqCounter = 0; this.irqReload = false; this.irqEnabled = false; this.irqLine = false;
    this.shift = 0; this.shiftCount = 0;
    this.latch0 = 0xFE; this.latch1 = 0xFE;
    this.command = 0;                     // FME-7: the register the next parameter write goes to
    if (this.mapper === 1) this.regs[0] = 0x0C;           // MMC1 powers up with the last bank fixed at C000
    if (this.mapper === 4) this.regs[6] = 0;
    this.update();
  }

  // ---------------------------------------------------------------- bank maps

  setPrg8(slot, bank) { this.prgMap[slot] = (((bank % this.prgBanks8) + this.prgBanks8) % this.prgBanks8) << 13; }
  setPrg16(slot, bank) { this.setPrg8(slot * 2, bank * 2); this.setPrg8(slot * 2 + 1, bank * 2 + 1); }
  setPrg32(bank) { for (let k = 0; k < 4; k++) this.setPrg8(k, bank * 4 + k); }
  setChr1(slot, bank) { this.chrMap[slot] = (((bank % this.chrBanks1) + this.chrBanks1) % this.chrBanks1) << 10; }
  setChr4(slot, bank) { for (let k = 0; k < 4; k++) this.setChr1(slot * 4 + k, bank * 4 + k); }
  setChr8(bank) { for (let k = 0; k < 8; k++) this.setChr1(k, bank * 8 + k); }

  // Recompute the bank windows from the mapper's registers.
  update() {
    const r = this.regs, last = this.prgBanks8 / 2 - 1;
    switch (this.mapper) {
      case 0: this.setPrg16(0, 0); this.setPrg16(1, last); this.setChr8(0); break;
      case 1: {
        const ctrl = r[0], prgMode = (ctrl >> 2) & 3, prg = r[3] & 0x0F;
        // 512K boards use CHR register bit 4 as the PRG ROM's upper half.
        const outer = this.prg.length > 0x40000 ? (r[1] & 0x10) : 0;
        if (prgMode < 2) { this.setPrg16(0, (outer | prg) & ~1); this.setPrg16(1, (outer | prg) | 1); }
        else if (prgMode === 2) { this.setPrg16(0, outer); this.setPrg16(1, outer | prg); }
        else { this.setPrg16(0, outer | prg); this.setPrg16(1, outer | 0x0F); }
        if (ctrl & 0x10) { this.setChr4(0, r[1]); this.setChr4(1, r[2]); } else this.setChr8(r[1] >> 1);
        this.mirror = ['single0', 'single1', 'vertical', 'horizontal'][ctrl & 3];
        break;
      }
      case 2: this.setPrg16(0, r[0]); this.setPrg16(1, last); this.setChr8(0); break;
      case 3: this.setPrg16(0, 0); this.setPrg16(1, last); this.setChr8(r[0]); break;
      case 4: {
        const b = r.subarray(8), mode = r[0];
        const second = this.prgBanks8 - 2;
        if (mode & 0x40) { this.setPrg8(0, second); this.setPrg8(2, b[6]); } else { this.setPrg8(0, b[6]); this.setPrg8(2, second); }
        this.setPrg8(1, b[7]); this.setPrg8(3, this.prgBanks8 - 1);
        const inv = mode & 0x80 ? 4 : 0;
        this.setChr1(inv ^ 0, b[0] & 0xFE); this.setChr1(inv ^ 1, b[0] | 1);
        this.setChr1(inv ^ 2, b[1] & 0xFE); this.setChr1(inv ^ 3, b[1] | 1);
        for (let k = 0; k < 4; k++) this.setChr1((inv ^ 4) + k, b[2 + k]);
        break;
      }
      case 7: this.setPrg32(r[0] & 0x0F); this.setChr8(0); this.mirror = r[0] & 0x10 ? 'single1' : 'single0'; break;
      case 9:
        this.setPrg8(0, r[0]); this.setPrg8(1, this.prgBanks8 - 3); this.setPrg8(2, this.prgBanks8 - 2); this.setPrg8(3, this.prgBanks8 - 1);
        this.setChr4(0, this.latch0 === 0xFD ? r[1] : r[2]);
        this.setChr4(1, this.latch1 === 0xFD ? r[3] : r[4]);
        break;
      case 11: this.setPrg32(r[0] & 3); this.setChr8(r[0] >> 4); break;
      case 66: this.setPrg32((r[0] >> 4) & 3); this.setChr8(r[0] & 3); break;
      case 71: this.setPrg16(0, r[0]); this.setPrg16(1, last); this.setChr8(0); break;
      case 69:
        for (let k = 0; k < 8; k++) this.setChr1(k, r[k]);
        this.setPrg8(0, r[9] & 0x3F); this.setPrg8(1, r[10] & 0x3F); this.setPrg8(2, r[11] & 0x3F); this.setPrg8(3, this.prgBanks8 - 1);
        this.mirror = ['vertical', 'horizontal', 'single0', 'single1'][r[12] & 3];
        break;
    }
    this.mirrorMap = MIRROR[this.mirror];
  }

  // ---------------------------------------------------------------- CPU side (4020-FFFF)

  cpuRead(a) {
    if (a >= 0x8000) return this.prg[this.prgMap[(a >> 13) & 3] | (a & 0x1FFF)];
    if (this.mapper === 69 && a >= 0x6000) {
      // FME-7 register 8: bit 6 RAM (else a PRG ROM bank) at 6000, bit 7 RAM enabled.
      const r8 = this.regs[8];
      if (!(r8 & 0x40)) return this.prg[(((r8 & 0x3F) % this.prgBanks8) << 13) | (a & 0x1FFF)];
      return r8 & 0x80 ? this.prgRam[a & 0x1FFF] : null;
    }
    if (a >= 0x6000) return this.prgRam[a & 0x1FFF];
    return null;                                          // open bus
  }

  cpuWrite(a, v, cycle) {
    if (a < 0x6000) return;
    if (this.mapper === 69) { this.fme7Write(a, v); return; }
    if (a < 0x8000) { this.prgRam[a & 0x1FFF] = v; this.dirty = true; return; }
    const r = this.regs;
    switch (this.mapper) {
      case 1: {
        // Serial port: five writes of bit 0 load a register (picked by the
        // last write's address); bit 7 resets. Writes on back-to-back cycles
        // (read-modify-write instructions) only count once.
        if (cycle === this.lastWriteCycle + 1) { this.lastWriteCycle = cycle; return; }
        this.lastWriteCycle = cycle;
        if (v & 0x80) { this.shift = 0; this.shiftCount = 0; r[0] |= 0x0C; this.update(); return; }
        this.shift |= (v & 1) << this.shiftCount;
        if (++this.shiftCount < 5) return;
        r[(a >> 13) & 3] = this.shift;
        this.shift = 0; this.shiftCount = 0;
        break;
      }
      case 2: case 3: case 7: case 11: case 66: r[0] = v; break;
      case 71: if (a >= 0xC000) r[0] = v; else if (a >= 0x9000 && a < 0xA000) { this.mirror = v & 0x10 ? 'single1' : 'single0'; this.mirrorMap = MIRROR[this.mirror]; return; } else return; break;
      case 9:
        if (a >= 0xA000 && a < 0xB000) r[0] = v & 0x0F;
        else if (a >= 0xB000 && a < 0xF000) r[((a - 0xB000) >> 12) + 1] = v & 0x1F;
        else if (a >= 0xF000) { this.mirror = v & 1 ? 'horizontal' : 'vertical'; }
        break;
      case 4: {
        const b = r.subarray(8), even = !(a & 1);
        if (a < 0xA000) { if (even) r[0] = v; else b[r[0] & 7] = v; }
        else if (a < 0xC000) { if (even && !this.vram4) this.mirror = v & 1 ? 'horizontal' : 'vertical'; }
        else if (a < 0xE000) { if (even) this.irqLatch = v; else { this.irqCounter = 0; this.irqReload = true; } }
        else if (even) { this.irqEnabled = false; this.irqLine = false; }
        else this.irqEnabled = true;
        break;
      }
    }
    this.update();
  }

  // FME-7: 8000-9FFF picks a register, A000-BFFF writes it. 0-7 CHR banks, 8 the 6000 window,
  // 9-B PRG banks, C mirroring, D IRQ control (bit 0 IRQ on, bit 7 counting; writing it acknowledges), E-F the counter.
  fme7Write(a, v) {
    const r = this.regs;
    if (a < 0x8000) { if ((r[8] & 0xC0) === 0xC0) { this.prgRam[a & 0x1FFF] = v; this.dirty = true; } return; }
    if (a < 0xA000) { this.command = v & 0x0F; return; }
    if (a >= 0xC000) return;                              // (the 5B sound chip's ports, not on these boards)
    const c = this.command;
    if (c === 0x0D) { r[13] = v; this.irqLine = false; return; }
    if (c === 0x0E) { this.irqCounter = (this.irqCounter & 0xFF00) | v; return; }
    if (c === 0x0F) { this.irqCounter = (this.irqCounter & 0x00FF) | (v << 8); return; }
    r[c] = v;
    this.update();
  }

  // Once per CPU cycle, for mappers with a cycle counter (FME-7): count down; wrapping past 0 raises the IRQ.
  get clocked() { return this.mapper === 69; }
  cpuCycle() {
    const r13 = this.regs[13];
    if (!(r13 & 0x80)) return;
    this.irqCounter = (this.irqCounter - 1) & 0xFFFF;
    if (this.irqCounter === 0xFFFF && (r13 & 1)) this.irqLine = true;
  }

  // ---------------------------------------------------------------- PPU side (0000-1FFF)

  chrRead(a) {
    const v = this.chr[this.chrMap[a >> 10] | (a & 0x3FF)];
    if (this.mapper === 9) {
      // MMC2: reading tile FD or FE's pattern switches that half's CHR bank (after the read).
      if (a === 0x0FD8) { this.latch0 = 0xFD; this.update(); }
      else if (a === 0x0FE8) { this.latch0 = 0xFE; this.update(); }
      else if (a >= 0x1FD8 && a <= 0x1FDF) { this.latch1 = 0xFD; this.update(); }
      else if (a >= 0x1FE8 && a <= 0x1FEF) { this.latch1 = 0xFE; this.update(); }
    }
    return v;
  }
  chrWrite(a, v) { if (!this.chrRom) this.chrRam[this.chrMap[a >> 10] | (a & 0x3FF)] = v; }

  // Nametable address (2000-2FFF) -> index into the console's 2K of VRAM (or the cart's 4K).
  ntIndex(a) { return (this.mirrorMap[(a >> 10) & 3] << 10) | (a & 0x3FF); }

  // ---------------------------------------------------------------- MMC3 scanline counter

  // Called once per rendered scanline (the rising edge of PPU address line A12).
  scanline() {
    if (this.mapper !== 4) return;
    if (this.irqCounter === 0 || this.irqReload) { this.irqCounter = this.irqLatch; this.irqReload = false; }
    else this.irqCounter--;
    if (this.irqCounter === 0 && this.irqEnabled) this.irqLine = true;
  }
  get irq() { return this.irqLine; }

  // ---------------------------------------------------------------- battery

  batteryData() { return this.battery ? this.prgRam.slice() : null; }
  loadBattery(d) { if (d && d.length === this.prgRam.length) this.prgRam.set(d); }
}
