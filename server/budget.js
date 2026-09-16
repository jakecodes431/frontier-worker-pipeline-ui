/**
 * Daily DeepSeek budget: one operator-set number, persisted next to the other
 * control-room state.
 *
 * This is a TRACKING aid, not enforcement. Nothing here pauses, kills or
 * refuses an agent when the day's measured spend passes the number; it only
 * lets the dashboard show "$4.10 of $10.00 today (41%, $5.90 left)". That is
 * deliberate — the control room does not meter or hard-stop provider spend, and
 * saying otherwise would be a lie an operator could act on.
 *
 * The file is `data/budget.json` (DATA_DIR from config, so CR_DATA_DIR moves
 * it). Shape:
 *
 *   { "dailyUsd": 10, "updatedAt": "2026-09-16T12:00:00.000Z" }
 *
 * `dailyUsd: null` means unset. An absent file, unreadable file, malformed
 * JSON, or a value outside the accepted range all read as unset: a corrupted
 * budget must not invent a limit the operator never set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, localDay } from './config.js';

/** Largest budget the API accepts, so a typo cannot become a five-figure limit. */
export const MAX_DAILY_USD = 1000000;

const FILE = path.join(DATA_DIR, 'budget.json');

/** Sentinel for "leave the stored budget alone" — distinct from null, which unsets it. */
export const UNCHANGED = Symbol('budget.unchanged');

/**
 * The value that may be stored: null (unset) or a finite number in
 * (0, MAX_DAILY_USD]. Everything else is a programming error, not an input
 * problem — HTTP input is normalized and rejected by the route before it gets
 * here, and this guard exists so a bad caller cannot write a broken file.
 */
function assertValue(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('dailyUsd must be a finite number or null');
  }
  if (value <= 0 || value > MAX_DAILY_USD) {
    throw new RangeError(`dailyUsd must be > 0 and <= ${MAX_DAILY_USD} (or null to unset)`);
  }
  return value;
}

/**
 * The persisted daily budget in USD, or null when unset.
 * Reads from disk every call: the file is tiny and an operator editing it by
 * hand should be picked up without a server restart.
 */
export function readBudget() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const value = parsed && typeof parsed === 'object' ? parsed.dailyUsd : null;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DAILY_USD ? value : null;
}

/**
 * Persist a budget value (or null to unset it) and return what was stored.
 * Written to a temp file and renamed so a crash mid-write cannot leave a
 * half-written budget.json behind.
 */
export function saveBudget(value) {
  const next = assertValue(value);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ dailyUsd: next, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

/**
 * The GET /api/budget payload from the stored budget and the day's measured
 * DeepSeek spend.
 *
 * @param {number} spentUsd Spend measured for the day (never invented here).
 * @param {string} [day]    'YYYY-MM-DD'; defaults to the operator's local day.
 * @returns {{dailyUsd: number|null, day: string, spentUsd: number, remainingUsd: number|null, percentUsed: number|null}}
 */
export function summarizeBudget(spentUsd, day) {
  const budget = readBudget();
  const spent = Number.isFinite(Number(spentUsd)) ? Number(spentUsd) : 0;
  const onDay = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay();
  if (budget === null) {
    return { dailyUsd: null, day: onDay, spentUsd: spent, remainingUsd: null, percentUsed: null };
  }
  return {
    dailyUsd: budget,
    day: onDay,
    spentUsd: spent,
    remainingUsd: budget - spent,
    percentUsed: (spent / budget) * 100,
  };
}
