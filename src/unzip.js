// Minimal ROM extraction from .zip and .gz files using the browser's built-in
// DecompressionStream (no dependencies). Picks the most ROM-like entry.

const ROM_EXT = /\.nes$/i;
const MAX_ROM = 4 * 1024 * 1024;

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04; }
export function isGzip(b) { return b.length > 2 && b[0] === 0x1F && b[1] === 0x8B; }

function listZip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xFFFF); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014B50) throw new Error('Corrupt zip directory');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({ name, flags, method, compSize, size, local });
  }
  return { entries, dv };
}

// Returns { bytes, name } for the ROM inside the archive.
export async function extractRom(bytes, fileName) {
  if (isGzip(bytes)) {
    return { bytes: await inflate(bytes, 'gzip'), name: fileName.replace(/\.gz$/i, '') };
  }
  const { entries, dv } = listZip(bytes);
  const base = (n) => n.split('/').pop();
  const candidates = entries.filter(e => !base(e.name).startsWith('.') && e.size > 0 && e.size <= MAX_ROM);
  const entry = candidates.find(e => ROM_EXT.test(e.name)) || candidates[0];
  if (!entry) throw new Error('No ROM found in zip');
  if (entry.flags & 1) throw new Error('Encrypted zip entries are not supported');
  const lp = entry.local;
  if (dv.getUint32(lp, true) !== 0x04034B50) throw new Error('Corrupt zip entry');
  const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
  const raw = bytes.subarray(start, start + entry.compSize);
  let out;
  if (entry.method === 0) out = raw.slice();
  else if (entry.method === 8) out = await inflate(raw, 'deflate-raw');
  else throw new Error(`Unsupported zip compression (method ${entry.method})`);
  return { bytes: out, name: base(entry.name) };
}
