// The NES picture processor (Ricoh 2C02), stepped one dot at a time: 341
// dots a line, 262 lines a frame (240 drawn, then vertical blank). Three dots
// pass per CPU cycle.
//
// Background: each 8 dots it fetches a nametable byte, an attribute byte and
// the tile's two pattern bytes into shift registers, which feed one pixel a
// dot; scrolling lives in the "loopy" registers v and t (coarse X/Y, the
// nametable, fine Y) plus fine X. Sprites: at the end of each line the next
// line's first eight sprites are picked from OAM and their patterns fetched;
// sprite 0 overlapping an opaque background pixel sets the "sprite 0 hit"
// flag that games use to split the screen.
//
// Registers: 2000 control, 2001 mask, 2002 status, 2003/2004 OAM address/data,
// 2005 scroll, 2006 address, 2007 data.

import { capture, apply } from './state.js';

export const WIDTH = 256, HEIGHT = 240;

// ---------------------------------------------------------------- palette

// The 2C02 makes color as an NTSC signal: each of its 64 colors is a square
// wave between two voltage levels, its phase (hue 1-12) against the color
// burst. Decoding that wave the way a TV does gives the RGB colors. Levels are
// the chip's measured output, normalized so black is 0 and white 1.
function makePalette() {
  const low = [0.350, 0.518, 0.962, 1.550], high = [1.094, 1.506, 1.962, 1.962];
  const black = 0.518, white = 1.962;
  const out = [];
  for (let c = 0; c < 64; c++) {
    const hue = c & 15, lum = c >> 4;
    let y = 0, i = 0, q = 0;
    for (let p = 0; p < 12; p++) {
      // The wave is high for 6 of 12 phases, starting at the hue's phase.
      const on = hue === 0 ? true : hue >= 13 ? false : ((p + hue + 9) % 12) < 6;
      let v = hue >= 14 ? black : on ? high[lum] : low[lum];
      v = (v - black) / (white - black);
      const ang = (Math.PI * (p + 1)) / 6;
      y += v; i += v * Math.cos(ang); q += v * Math.sin(ang);
    }
    y /= 12; i /= 12; q /= 12;
    const sat = 1.3;
    let r = y + 0.956 * i * sat + 0.621 * q * sat;
    let g = y - 0.272 * i * sat - 0.647 * q * sat;
    let b = y - 1.106 * i * sat + 1.703 * q * sat;
    const gamma = (x) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, x)), 1 / 1.1));
    out.push([gamma(r), gamma(g), gamma(b)]);
  }
  return out;
}

const BASE = makePalette();
// One table per combination of the mask's three color-emphasis bits: the
// emphasized channels keep their level, the others dim.
const PALETTES = Array.from({ length: 8 }, (_, e) => Uint32Array.from(BASE, ([r, g, b]) => {
  if (e) {
    const k = 0.78;
    if (!(e & 1)) r *= k;
    if (!(e & 2)) g *= k;
    if (!(e & 4)) b *= k;
  }
  return (0xFF000000 | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
}));

const STATE = ['vram', 'palette', 'oam', 'ctrl', 'mask', 'status', 'oamAddr', 'v', 't', 'x', 'w', 'buffer', 'openBus',
  'line', 'dot', 'odd', 'nt', 'at', 'lo', 'hi', 'patLo', 'patHi', 'attLo', 'attHi',
  'sprCount', 'nextCount', 'sprLo', 'sprHi', 'sprX', 'sprAttr', 'sprZeroNext', 'sprZeroLine', 'skipDot', 'suppressVbl'];

export class PPU {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // sys: { nmi(), cart } - the NMI line, and the cartridge for CHR, mirroring and MMC3 clocks.
  constructor(sys) {
    this.sys = sys;
    this.frame = new Uint32Array(WIDTH * HEIGHT);
    this.reset();
  }

  reset() {
    this.vram = new Uint8Array(0x800);
    this.palette = new Uint8Array(32);
    this.oam = new Uint8Array(256);
    this.ctrl = 0; this.mask = 0; this.status = 0; this.oamAddr = 0;
    this.v = 0; this.t = 0; this.x = 0; this.w = 0;
    this.buffer = 0; this.openBus = 0;
    this.line = 0; this.dot = 0; this.odd = false;
    this.nt = 0; this.at = 0; this.lo = 0; this.hi = 0;
    this.patLo = 0; this.patHi = 0; this.attLo = 0; this.attHi = 0;
    // The current line's sprites (up to 8): pattern bytes, X, attributes.
    this.sprCount = 0;
    this.sprLo = new Uint8Array(8); this.sprHi = new Uint8Array(8);
    this.sprX = new Uint8Array(8); this.sprAttr = new Uint8Array(8);
    this.sprZeroNext = false; this.sprZeroLine = false; this.nextCount = 0;
    this.skipDot = false; this.suppressVbl = false;
    this.frameReady = false;
  }

  // ---------------------------------------------------------------- memory (PPU bus)

  read(a) {
    a &= 0x3FFF;
    if (a < 0x2000) return this.sys.cart.chrRead(a);
    if (a < 0x3F00) return this.readNt(a);
    return this.palette[palIndex(a)];
  }
  write(a, v) {
    a &= 0x3FFF;
    if (a < 0x2000) this.sys.cart.chrWrite(a, v);
    else if (a < 0x3F00) this.writeNt(a, v);
    else this.palette[palIndex(a)] = v & 0x3F;
  }
  readNt(a) {
    const cart = this.sys.cart, i = cart.ntIndex(a);
    return i < 0x800 ? this.vram[i] : cart.vram4[i - 0x800];
  }
  writeNt(a, v) {
    const cart = this.sys.cart, i = cart.ntIndex(a);
    if (i < 0x800) this.vram[i] = v; else cart.vram4[i - 0x800] = v;
  }

  // ---------------------------------------------------------------- CPU registers

  readReg(r) {
    switch (r & 7) {
      case 2: {
        // Racing vertical blank: a read just before the flag sets sees it
        // clear and stops it setting this frame; one on or just after the set
        // sees it but cancels the NMI.
        if (this.line === 241 && this.dot === 1) this.suppressVbl = true;
        if (this.line === 241 && (this.dot === 2 || this.dot === 3)) this.sys.cancelNmi();
        const v = (this.status & 0xE0) | (this.openBus & 0x1F);
        this.status &= 0x7F;
        this.w = 0;
        return (this.openBus = v);
      }
      case 4: return (this.openBus = this.oam[this.oamAddr]);
      case 7: {
        const a = this.v & 0x3FFF;
        let v;
        if (a < 0x3F00) { v = this.buffer; this.buffer = this.read(a); }
        else { v = (this.palette[palIndex(a)] & (this.mask & 1 ? 0x30 : 0x3F)) | (this.openBus & 0xC0); this.buffer = this.readNt(a - 0x1000); }
        this.v = (this.v + (this.ctrl & 4 ? 32 : 1)) & 0x7FFF;
        return (this.openBus = v);
      }
    }
    return this.openBus;
  }

  writeReg(r, v) {
    this.openBus = v;
    switch (r & 7) {
      case 0: {
        const was = this.ctrl;
        this.ctrl = v;
        this.t = (this.t & 0xF3FF) | ((v & 3) << 10);
        // Turning NMI on during vertical blank fires one at once (unless the
        // flag is about to clear on the very next dot).
        if (!(was & 0x80) && (v & 0x80) && (this.status & 0x80) && !(this.line === 261 && this.dot === 1)) this.sys.nmi();
        // Turning it off right as vertical blank starts cancels the one just raised.
        if ((was & 0x80) && !(v & 0x80) && this.line === 241 && this.dot <= 3) this.sys.cancelNmi();
        return;
      }
      case 1: this.mask = v; return;
      case 3: this.oamAddr = v; return;
      case 4: this.oam[this.oamAddr] = v; this.oamAddr = (this.oamAddr + 1) & 0xFF; return;
      case 5:
        if (!this.w) { this.t = (this.t & 0x7FE0) | (v >> 3); this.x = v & 7; }
        else this.t = (this.t & 0x0C1F) | ((v & 7) << 12) | ((v & 0xF8) << 2);
        this.w ^= 1;
        return;
      case 6:
        if (!this.w) this.t = (this.t & 0x00FF) | ((v & 0x3F) << 8);
        else { this.t = (this.t & 0x7F00) | v; this.v = this.t; }
        this.w ^= 1;
        return;
      case 7:
        this.write(this.v, v);
        this.v = (this.v + (this.ctrl & 4 ? 32 : 1)) & 0x7FFF;
        return;
    }
  }

  // ---------------------------------------------------------------- scrolling

  incX() {
    if ((this.v & 0x1F) === 31) { this.v &= ~0x1F; this.v ^= 0x400; } else this.v++;
  }
  incY() {
    if ((this.v & 0x7000) !== 0x7000) { this.v += 0x1000; return; }
    this.v &= ~0x7000;
    let y = (this.v >> 5) & 31;
    if (y === 29) { y = 0; this.v ^= 0x800; } else if (y === 31) y = 0; else y++;
    this.v = (this.v & ~0x3E0) | (y << 5);
  }

  // Load the next tile into the low byte of the shifters.
  reload() {
    this.patLo = (this.patLo & 0xFF00) | this.lo;
    this.patHi = (this.patHi & 0xFF00) | this.hi;
    this.attLo = (this.attLo & 0xFF00) | (this.at & 1 ? 0xFF : 0);
    this.attHi = (this.attHi & 0xFF00) | (this.at & 2 ? 0xFF : 0);
  }

  // ---------------------------------------------------------------- sprites

  // Pick the next line's sprites (the first eight in OAM that cover it) and fetch their patterns.
  evalSprites() {
    const h = this.ctrl & 0x20 ? 16 : 8, line = this.line, oam = this.oam;
    let n = 0;
    this.sprZeroNext = false;
    for (let i = 0; i < 64; i++) {
      const row = line - oam[i * 4];
      if (row < 0 || row >= h) continue;
      if (n === 8) { this.status |= 0x20; break; }    // overflow (without the hardware's buggy scan)
      if (i === 0) this.sprZeroNext = true;
      const tile = oam[i * 4 + 1], attr = oam[i * 4 + 2];
      const r = attr & 0x80 ? h - 1 - row : row;
      let addr;
      if (h === 16) addr = ((tile & 1) << 12) | ((tile & 0xFE) << 4) | (r & 8 ? 16 : 0) | (r & 7);
      else addr = ((this.ctrl & 8) << 9) | (tile << 4) | r;
      let lo = this.read(addr), hi = this.read(addr + 8);
      if (attr & 0x40) { lo = flip(lo); hi = flip(hi); }
      this.sprLo[n] = lo; this.sprHi[n] = hi; this.sprX[n] = oam[i * 4 + 3]; this.sprAttr[n] = attr;
      n++;
    }
    this.nextCount = n;
  }

  // ---------------------------------------------------------------- dots

  tick() {
    const line = this.line, dot = this.dot, rendering = this.mask & 0x18;
    const pre = line === 261, visible = line < 240;

    if ((visible || pre) && rendering) {
      if ((dot >= 2 && dot <= 257) || (dot >= 322 && dot <= 337)) {
        this.patLo = (this.patLo << 1) & 0xFFFF; this.patHi = (this.patHi << 1) & 0xFFFF;
        this.attLo = (this.attLo << 1) & 0xFFFF; this.attHi = (this.attHi << 1) & 0xFFFF;
        switch ((dot - 1) & 7) {
          case 0: this.reload(); this.nt = this.readNt(0x2000 | (this.v & 0x0FFF)); break;
          case 2: {
            const v = this.v, b = this.readNt(0x23C0 | (v & 0x0C00) | ((v >> 4) & 0x38) | ((v >> 2) & 7));
            this.at = (b >> (((v >> 4) & 4) | (v & 2))) & 3;
            break;
          }
          case 4: this.lo = this.read(((this.ctrl & 0x10) << 8) | (this.nt << 4) | ((this.v >> 12) & 7)); break;
          case 6: this.hi = this.read(((this.ctrl & 0x10) << 8) | (this.nt << 4) | ((this.v >> 12) & 7) | 8); break;
          case 7: this.incX(); break;
        }
      }
      if (dot === 256) this.incY();
      if (dot === 257) {
        this.reload();
        this.v = (this.v & ~0x041F) | (this.t & 0x041F);           // horizontal position from t
        if (visible) this.evalSprites(); else this.nextCount = 0;
      }
      if (pre && dot >= 280 && dot <= 304) this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0);   // vertical position from t
      // The MMC3 counts A12 rising: on sprite fetches when sprites use 1000,
      // else on the next line's background fetches when the background does.
      const sprHigh = (this.ctrl & 0x20) || (this.ctrl & 8);
      if ((dot === 260 && sprHigh && !(this.ctrl & 0x10)) || (dot === 324 && (this.ctrl & 0x10) && !sprHigh)) this.sys.cart.scanline();
      if (dot === 340) { this.sprCount = this.nextCount; this.sprZeroLine = this.sprZeroNext; }
    }

    // The pixel comes after this dot's shift.
    if (visible && dot >= 1 && dot <= 256) this.pixel(dot - 1, line);

    if (line === 241 && dot === 1) {
      if (!this.suppressVbl) {
        this.status |= 0x80;
        if (this.ctrl & 0x80) this.sys.nmi();
      }
      this.suppressVbl = false;
      this.frameReady = true;
    }
    if (pre && dot === 1) { this.status &= 0x1F; this.sprCount = 0; }

    // Advance; the pre-render line is a dot short on odd frames while
    // rendering (as it stood at dot 338).
    if (pre && dot === 338) this.skipDot = !!rendering;
    this.dot++;
    if (pre && this.dot === 340 && this.odd && this.skipDot) this.dot = 341;
    if (this.dot > 340) {
      this.dot = 0;
      this.line++;
      if (this.line > 261) { this.line = 0; this.odd = !this.odd; }
    }
  }

  pixel(x, y) {
    const mask = this.mask;
    let bg = 0;
    if ((mask & 0x08) && (x >= 8 || (mask & 0x02))) {
      const bit = 0x8000 >> this.x;
      bg = ((this.patLo & bit) ? 1 : 0) | ((this.patHi & bit) ? 2 : 0);
      if (bg) bg |= (((this.attLo & bit) ? 1 : 0) | ((this.attHi & bit) ? 2 : 0)) << 2;
    }
    let spr = 0, front = false;
    if ((mask & 0x10) && (x >= 8 || (mask & 0x04))) {
      for (let i = 0; i < this.sprCount; i++) {
        const dx = x - this.sprX[i];
        if (dx < 0 || dx > 7) continue;
        const sh = 7 - dx, c = ((this.sprLo[i] >> sh) & 1) | (((this.sprHi[i] >> sh) & 1) << 1);
        if (!c) continue;
        if (i === 0 && this.sprZeroLine && bg && x !== 255) this.status |= 0x40;   // sprite 0 hit
        spr = 0x10 | ((this.sprAttr[i] & 3) << 2) | c;
        front = !(this.sprAttr[i] & 0x20);
        break;
      }
    }
    const idx = spr && (front || !bg) ? spr : bg;
    // With rendering off and v pointing into palette RAM, that color shows ("background palette hack").
    let color = this.palette[idx ? idx : 0];
    if (!(mask & 0x18) && (this.v & 0x3F00) === 0x3F00) color = this.palette[this.v & 0x1F];
    if (mask & 1) color &= 0x30;
    this.frame[y * WIDTH + x] = PALETTES[mask >> 5][color & 0x3F];
  }
}

// Palette RAM: 3F10/14/18/1C mirror 3F00/04/08/0C.
function palIndex(a) {
  let i = a & 0x1F;
  if ((i & 0x13) === 0x10) i &= 0x0F;
  return i;
}

function flip(b) {
  b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
  b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
  return ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
}
