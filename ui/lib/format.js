// Formatting helpers. Everything here is pure and safe on null/undefined.

const NA = 'not available';

/**
 * True for anything that cannot be shown as a number.
 *
 * Servers and transcripts hand this layer whatever they have: null, an empty
 * string, an object, NaN from a bad division. Every one of those used to reach
 * `toFixed` and paint "$NaN" or "NaNs" into the UI, so the test is finiteness
 * AFTER coercion, not just `typeof`.
 */
export function isNil(v) {
  if (v === null || v === undefined || v === '') return true;
  if (typeof v === 'boolean') return true;
  return !Number.isFinite(typeof v === 'number' ? v : Number(v));
}

/** Coerce to a finite number, or null. */
function num(v) {
  if (isNil(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** $0.0123 for small amounts, $12.34 for larger ones. */
export function usd(v) {
  const n = num(v);
  if (n === null) return NA;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs === 0) return '$0.00';
  if (abs < 0.0001) return sign + '$' + abs.toExponential(2);
  if (abs < 1) return sign + '$' + abs.toFixed(4);
  if (abs < 1000) return sign + '$' + abs.toFixed(2);
  return sign + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/** 1.2M / 12.3k / 845 */
export function tokens(v) {
  const n = num(v);
  if (n === null) return NA;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + trim(abs / 1e9) + 'B';
  if (abs >= 1e6) return sign + trim(abs / 1e6) + 'M';
  if (abs >= 1e4) return sign + trim(abs / 1e3) + 'k';
  if (abs >= 1e3) return sign + trim(abs / 1e3) + 'k';
  return sign + String(Math.round(abs));
}

function trim(n) {
  const s = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function count(v) {
  const n = num(v);
  if (n === null) return NA;
  return n.toLocaleString('en-US');
}

/** 1h 04m 12s / 4m 12s / 12s */
export function duration(seconds) {
  const n = num(seconds);
  if (n === null) return '—';
  let s = Math.max(0, Math.floor(n));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function pad(n) { return String(n).padStart(2, '0'); }

export function bytes(n) {
  const v = num(n);
  if (v === null) return '—';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1048576).toFixed(1) + ' MB';
}

/** Local wall-clock time, e.g. 15:04:05 */
export function clock(iso) {
  const d = toDate(iso);
  if (!d) return '—';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function dateTime(iso) {
  const d = toDate(iso);
  if (!d) return NA;
  return d.toLocaleString('en-GB', { hour12: false });
}

export function toDate(iso) {
  if (!iso) return null;
  // `new Date({})` and `new Date([])` are Invalid Date and 1970 respectively;
  // only strings, numbers and Dates are meaningful here.
  if (typeof iso !== 'string' && typeof iso !== 'number' && !(iso instanceof Date)) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Seconds elapsed since an ISO timestamp (floored, never negative). */
export function elapsedSince(iso) {
  const d = toDate(iso);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export function truncate(text, max = 120) {
  // A non-finite number is not text: it must never be painted as "NaN".
  if (typeof text === 'number' && !Number.isFinite(text)) return '';
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

export function naText() { return NA; }

/** Renders arbitrary JSON-ish event data compactly for the log view. */
export function compactJson(value, max = 300) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value, max);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return String(value);
  }
}
