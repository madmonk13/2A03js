#!/usr/bin/env node
// Run nestest.nes in its automated mode (PC = C000) and compare each
// instruction's registers and cycle count with the reference log.
//
//   node tools/nestest.mjs [roms/test/nestest.nes] [roms/test/nestest.log]

import fs from 'node:fs';
import { NES } from '../src/emu/nes.js';

const [romPath = 'roms/test/nestest.nes', logPath = 'roms/test/nestest.log'] = process.argv.slice(2);
const nes = new NES();
nes.load(new Uint8Array(fs.readFileSync(romPath)));
const cpu = nes.cpu;
cpu.pc = 0xC000; cpu.sp = 0xFD; cpu.setP(0x24); cpu.cycles = 7;
const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
let n = 0;
for (const line of lines) {
  const want = { pc: line.slice(0, 4), a: line.match(/A:(\w\w)/)[1], x: line.match(/X:(\w\w)/)[1], y: line.match(/Y:(\w\w)/)[1],
    p: line.match(/P:(\w\w)/)[1], sp: line.match(/SP:(\w\w)/)[1], cyc: line.match(/CYC:(\d+)/)[1] };
  const got = { pc: hex(cpu.pc, 4), a: hex(cpu.a), x: hex(cpu.x), y: hex(cpu.y), p: hex(cpu.getP(false)), sp: hex(cpu.sp), cyc: String(cpu.cycles) };
  const bad = Object.keys(want).filter((k) => want[k] !== got[k]);
  if (bad.length) {
    console.log(`mismatch at line ${n + 1}: ${bad.map((k) => `${k} want ${want[k]} got ${got[k]}`).join(', ')}`);
    console.log(`  log: ${line}`);
    process.exit(1);
  }
  cpu.step();
  n++;
}
console.log(`nestest: all ${n} instructions match the log (registers and cycles); result codes 02/03 = ${hex(nes.ram[2])} ${hex(nes.ram[3])}`);
