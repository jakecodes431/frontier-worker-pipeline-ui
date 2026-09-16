#!/usr/bin/env node
// Claude Code's documented statusLine input supplies plan usage without credentials.
//
// Verified documented shape (https://code.claude.com/docs/en/statusline):
//   rate_limits.five_hour.used_percentage   number, 0..100
//   rate_limits.five_hour.resets_at         Unix epoch SECONDS
//   rate_limits.seven_day.used_percentage   number, 0..100
//   rate_limits.seven_day.resets_at         Unix epoch SECONDS
//
// Only those numbers are ever read from stdin and persisted. Session ids,
// transcript paths, tokens, credentials and every other stdin field are
// ignored: this script never reads ~/.claude, never touches credentials, and
// writes only <dataDir>/claude-usage.json (atomically: tmp file then rename).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT = 1048576; // 1 MiB: the documented payload is a few KB.
const WINDOWS = ['five_hour', 'seven_day'];
const dataDir = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

/** Normalize a reset time to Unix epoch seconds (documented unit). */
function normalizeResetTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value >= 1e11 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

/** One window, or null when `used_percentage` is missing / invalid. */
function normalizeWindow(row) {
  let used = null;
  for (const name of ['used_percentage', 'used_percent']) {
    const value = row?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) { used = value; break; }
  }
  if (used === null || used < 0 || used > 100) return null;
  const reset = row?.resets_at ?? row?.resetsAt ?? row?.reset;
  return { used_percentage: used, resets_at: normalizeResetTime(reset) };
}

function capture(payload) {
  const rate_limits = {};
  for (const key of WINDOWS) {
    const window = normalizeWindow(payload?.rate_limits?.[key]);
    if (window) rate_limits[key] = window;
  }
  return rate_limits;
}

// Drain stdin fully (a slow/early exit would break the caller's pipe) but stop
// accumulating past the cap so a huge payload cannot exhaust memory.
let input = '';
let oversized = false;
for await (const chunk of process.stdin) {
  if (oversized) continue;
  input += chunk;
  if (input.length > MAX_INPUT) { oversized = true; input = ''; }
}
if (oversized) { console.log('Claude usage skipped: input larger than 1 MiB'); process.exit(0); }
if (!input.trim()) { console.log('Claude plan usage not reported yet'); process.exit(0); }

let payload;
try { payload = JSON.parse(input); }
catch { console.log('Claude usage unavailable: unreadable statusLine input'); process.exit(0); }

const rate_limits = capture(payload);
if (!Object.keys(rate_limits).length) { console.log('Claude plan usage not reported yet'); process.exit(0); }

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = path.join(dataDir, `claude-usage.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ rate_limits, observedAt: new Date().toISOString() }));
  fs.renameSync(temporary, path.join(dataDir, 'claude-usage.json'));
} catch { console.log('Claude usage unavailable: could not record the observation'); process.exit(0); }

console.log(Object.entries(rate_limits).map(([key, row]) => `${key === 'five_hour' ? '5h' : '7d'} ${row.used_percentage}% used`).join(' · '));
