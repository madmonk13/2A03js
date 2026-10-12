// Save states: capture a component's working state as plain data and put it
// back later. Each component lists its state fields; a field holding another
// component (anything with saveState/loadState, or an array of them) is saved
// through that component. ROM data and anything derived from it isn't saved.

export function capture(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = captureValue(obj[f]);
  return out;
}

function captureValue(v) {
  if (v && typeof v.saveState === 'function') return v.saveState();
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(captureValue);
  if (v && typeof v === 'object') return structuredClone(v);
  return v;
}

export function apply(obj, fields, data) {
  for (const f of fields) {
    if (!(f in data)) continue;
    const cur = obj[f], v = data[f];
    if (cur && typeof cur.loadState === 'function') cur.loadState(v);
    else if (ArrayBuffer.isView(cur)) cur.set(v);
    else if (Array.isArray(cur) && cur.length && typeof cur[0]?.loadState === 'function') cur.forEach((c, i) => c.loadState(v[i]));
    else obj[f] = v && typeof v === 'object' ? structuredClone(v) : v;
  }
}

// JSON that keeps typed arrays (as base64) and non-finite numbers.
const TYPES = { Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array };

export function encode(state) {
  return JSON.stringify(state, (key, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $n: String(v) };
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { $t: v.constructor.name, b: btoa(bin) };
    }
    return v;
  });
}

export function decode(text) {
  return JSON.parse(text, (key, v) => {
    if (v && typeof v === 'object' && '$n' in v) return Number(v.$n);
    if (v && typeof v === 'object' && '$t' in v) {
      const bin = atob(v.b), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TYPES[v.$t](bytes.buffer);
    }
    return v;
  });
}
