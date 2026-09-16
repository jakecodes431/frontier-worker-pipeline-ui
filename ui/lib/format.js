// Formatting helpers. Everything here is pure and safe on null/undefined.

const NA = 'not available';

export function isNil(v) {
  return v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
}

/** $0.0123 for small amounts, $12.34 for larger ones. */
export function usd(v) {
  if (isNil(v)) return NA;
  const n = Number(v);
  if (!Number.isFinite(n)) return NA;
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
  if (isNil(v)) return NA;
  const n = Number(v);
  if (!Number.isFinite(n)) return NA;
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
  if (isNil(v)) return NA;
  return Number(v).toLocaleString('en-US');
}

/** 1h 04m 12s / 4m 12s / 12s */
export function duration(seconds) {
  if (isNil(seconds)) return '—';
  let s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function pad(n) { return String(n).padStart(2, '0'); }

export function bytes(n) {
  if (isNil(n)) return '—';
  const v = Number(n);
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
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Seconds elapsed since an ISO timestamp (floored, never negative). */
export function elapsedSince(iso) {
  const d = toDate(iso);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export function truncate(text, max = 120) {
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
