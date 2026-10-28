// deep-times.mjs — timecode → seconds conversion for scene JSON, shared by
// the render driver and the frame probe (single source of truth; the page
// works in seconds, scenes carry strict (HH:)MM:SS:FF timecodes).

export function tc2sec(tc) {
  if (typeof tc === 'number') return tc;
  const m = String(tc).match(/^(?:(\d+):)?(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`malformed timecode: ${tc}`);
  const [, hh, mm, ss, ff] = m;
  return ((Number(hh || 0) * 60 + Number(mm)) * 60 + Number(ss)) + Number(ff) / 24;
}

export function deepTimes(obj) {
  if (Array.isArray(obj)) return obj.map(deepTimes);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'window' && Array.isArray(v) && v.length === 2) out[k] = v.map(tc2sec);
      else if (k === 'at' && typeof v === 'string' && /^\d/.test(v)) out[k] = tc2sec(v);
      else if (k === 'grow-at' && typeof v === 'string' && /^\d/.test(v)) out[k] = tc2sec(v);
      else if (k === 'pulse-at' && typeof v === 'string' && /^\d/.test(v)) out[k] = tc2sec(v);
      else if (k === 'slideWindow' && Array.isArray(v) && v.length >= 1) out[k] = v.map(tc2sec);
      else out[k] = deepTimes(v);
    }
    return out;
  }
  return obj;
}
