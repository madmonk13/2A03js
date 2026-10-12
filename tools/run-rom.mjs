#!/usr/bin/env node
// Headless check: run a ROM, report a Blargg-style test result (status byte
// at 6000, signature DE B0 61 at 6001, text from 6004), and save the screen.
//
//   node tools/run-rom.mjs <rom> [frames=600] [out.png]
//   Optional env: PRESS=frame:buttons,... (e.g. PRESS=200:start) to press buttons.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { NES } from '../src/emu/nes.js';

const [romPath, framesArg = '600', outPath] = process.argv.slice(2);
if (!romPath) { console.error('usage: run-rom.mjs <rom> [frames] [out.png]'); process.exit(1); }
const BITS = { a: 1, b: 2, select: 4, start: 8, up: 0x10, down: 0x20, left: 0x40, right: 0x80 };
const presses = (process.env.PRESS || '').split(',').filter(Boolean).map((p) => {
  const [f, names] = p.split(':');
  return { f: +f, bits: names.split('+').reduce((m, n) => m | BITS[n], 0) };
});

const nes = new NES();
const cart = nes.load(new Uint8Array(fs.readFileSync(romPath)));
const frames = +framesArg;
const t0 = performance.now();
let result = null;
const blargg = () => nes.cart.prgRam[1] === 0xDE && nes.cart.prgRam[2] === 0xB0 && nes.cart.prgRam[3] === 0x61;
for (let i = 0; i < frames; i++) {
  nes.buttons = presses.filter((p) => i >= p.f && i < p.f + 6).reduce((m, p) => m | p.bits, 0);
  nes.runFrame();
  // Status 80 = still running, 81 = wants a reset, else the final code (0 = passed).
  if (blargg()) {
    const st = nes.cart.prgRam[0];
    if (st === 0x81) { for (let k = 0; k < 6; k++) nes.runFrame(); nes.softReset(); }
    else if (st < 0x80) { result = st; break; }
  }
}
const ms = performance.now() - t0;
let text = '';
if (blargg()) for (let i = 4; i < 0x2000 && nes.cart.prgRam[i]; i++) text += String.fromCharCode(nes.cart.prgRam[i]);
console.log(`${romPath} [${cart.name}]: ${(ms / Math.max(1, frames)).toFixed(2)} ms/frame${result !== null ? `, result ${result}${result === 0 ? ' (passed)' : ''}` : ''}`);
if (text.trim()) console.log(text.trim().split('\n').map((l) => '  ' + l).join('\n'));

if (outPath) {
  const W = 256, H = 240, S = 2, f = nes.frame;
  const raw = Buffer.alloc((W * S * 3 + 1) * H * S);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const p = f[((y / S) | 0) * W + ((x / S) | 0)], o = y * (W * S * 3 + 1) + 1 + x * 3;
    raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF;
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W * S, 0); ihdr.writeUInt32BE(H * S, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(outPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`wrote ${outPath}`);
}
