#!/usr/bin/env node
// Generate the favicon and home-screen icons: "2A03" in a bold, blocky 6x7
// pixel font on a purple square.
import fs from 'node:fs';
import zlib from 'node:zlib';

const GLYPHS = {
  2: ['011110', '110011', '000011', '001110', '011000', '110000', '111111'],
  A: ['011110', '110011', '110011', '111111', '110011', '110011', '110011'],
  0: ['011110', '110011', '110011', '110011', '110011', '110011', '011110'],
  3: ['111110', '000011', '000011', '011110', '000011', '000011', '111110'],
};
const TEXT = '2A03';
const RED = [91, 63, 168], SHADOW = [40, 24, 92], WHITE = [255, 255, 255];   // background, shadow, letters

// The text as a grid of on/off cells, one blank column between digits.
const GW = 6, COLS = TEXT.length * (GW + 1) - 1, ROWS = 7;
const on = (cx, cy) => {
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || cx % (GW + 1) === GW) return false;
  return GLYPHS[TEXT[Math.floor(cx / (GW + 1))]][cy][cx % (GW + 1)] === '1';
};

// Text spans ~76% of the width, which keeps it inside the maskable-icon safe zone.
function geometry(size) {
  const cell = Math.max(1, Math.floor((size * 0.76) / COLS));
  const ox = Math.floor((size - cell * COLS) / 2), oy = Math.floor((size - cell * ROWS) / 2);
  const shadow = cell >= 3 ? Math.round(cell * 0.3) : 0; // drop shadow only where it reads
  return { cell, ox, oy, shadow };
}

function pixel(size, g, x, y) {
  const cell = (px, py) => on(Math.floor((px - g.ox) / g.cell), Math.floor((py - g.oy) / g.cell))
    && px >= g.ox && py >= g.oy;
  if (cell(x, y)) return WHITE;
  if (g.shadow && cell(x - g.shadow, y - g.shadow)) return SHADOW;
  return RED;
}

function png(size) {
  const g = geometry(size);
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(pixel(size, g, x, y), y * stride + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Vector favicon on the same grid, so it stays crisp at any tab size.
function svg() {
  const size = 32, g = geometry(size);
  const rgb = (c) => `rgb(${c.join(',')})`;
  let cells = '';
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) if (on(cx, cy)) cells += `M${cx} ${cy}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" rx="4" fill="${rgb(RED)}"/>` +
    `<path transform="translate(${g.ox} ${g.oy})" fill="${rgb(WHITE)}" d="${cells}"/></svg>\n`;
}

const out = [];
for (const size of [180, 192, 512]) { fs.writeFileSync(`icon-${size}.png`, png(size)); out.push(`icon-${size}.png`); }
fs.writeFileSync('favicon-32.png', png(32)); out.push('favicon-32.png');
fs.writeFileSync('favicon.svg', svg()); out.push('favicon.svg');
console.log(`wrote ${out.join(', ')}`);
