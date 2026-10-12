#!/usr/bin/env node
// Save-state check: run each ROM, save the state, restore it into a fresh
// machine, and check both produce the same frames from there.
//
//   node tools/state-check.mjs <rom ...>

import fs from 'node:fs';
import { NES } from '../src/emu/nes.js';
import { encode, decode } from '../src/emu/state.js';

let failed = 0;
for (const path of process.argv.slice(2)) {
  const rom = new Uint8Array(fs.readFileSync(path));
  const a = new NES(); a.load(rom);
  for (let i = 0; i < 200; i++) { a.buttons = (i >> 4) & 0x09; a.runFrame(); }
  const text = encode(a.saveState());
  const b = new NES(); b.load(rom); b.loadState(decode(text));
  let same = true, at = -1;
  for (let i = 0; i < 300 && same; i++) {
    a.buttons = b.buttons = (i >> 3) & 0xF1;
    a.runFrame(); b.runFrame();
    same = a.frame.every((p, k) => p === b.frame[k]) && a.ram.every((v, k) => v === b.ram[k]);
    if (!same) at = i;
  }
  console.log(`${same ? 'ok  ' : 'FAIL'} ${path}: ${same ? 'identical for 300 frames after restore' : `diverged ${at} frames after restore`} (${(text.length / 1024).toFixed(1)} KB)`);
  if (!same) failed++;
}
process.exit(failed ? 1 : 0);
