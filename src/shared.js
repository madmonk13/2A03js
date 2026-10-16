// ROM file reading, storage, loading modal and toast.

import { extractRom, isZip, isGzip } from './unzip.js';

const STORE = '2a03js:';

export const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(STORE + key)); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(STORE + key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(STORE + key); } catch { /* storage unavailable */ } },
  // Like set, but reports whether the write landed (false when full or blocked).
  trySet(key, v) {
    try { localStorage.setItem(STORE + key, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch { return false; }
  },
  getRaw(key) { try { return localStorage.getItem(STORE + key); } catch { return null; } },
};

// Read a user-picked file, unpacking .zip/.gz. Returns { bytes, name } with the
// ROM extension stripped from the name.
export async function readRomFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  if (isZip(bytes) || isGzip(bytes)) ({ bytes, name } = await extractRom(bytes, name));
  return { bytes, name: name.replace(/\.nes$/i, '') };
}

export async function fetchRom(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Show the loading modal (#loading / #loadingName) for the duration of
// `work`, and at least briefly so fast loads don't flicker.
export async function withLoading(label, work) {
  const el = document.getElementById('loading');
  document.getElementById('loadingName').textContent = label;
  el.classList.add('show');
  const started = performance.now();
  try {
    return await work();
  } finally {
    const wait = 450 - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el.classList.remove('show');
  }
}

let toastTimer = 0;
// Short message at the bottom of the screen; errors unless `info` is set.
// Errors show red, success green (success), and notes in the app's accent color (info).
export function toast(msg, { info = false, success = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('info', info);
  el.classList.toggle('success', success);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
