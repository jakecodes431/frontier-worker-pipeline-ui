import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';

export const claudeUsageFile = path.join(DATA_DIR, 'claude-usage.json');

/**
 * Claude Code's documented statusLine plan-usage shape, verified against
 * https://code.claude.com/docs/en/statusline ("Available data" / "Rate limit usage"):
 *
 *   rate_limits.five_hour.used_percentage   number, 0..100
 *   rate_limits.five_hour.resets_at         Unix epoch SECONDS
 *   rate_limits.seven_day.used_percentage   number, 0..100
 *   rate_limits.seven_day.resets_at         Unix epoch SECONDS
 *
 * `rate_limits` is present only for claude.ai Pro/Max subscribers (or behind a
 * gateway spend limit) and only after the session's first API response. The
 * documented units are seconds; we still accept legacy millisecond/ISO reset
 * values because older captures may hold them.
 */
const CLAUDE_WINDOWS = [['five_hour', 'primary', 300], ['seven_day', 'secondary', 10080]];

/** First finite number among `names`, or null. Strings are not coerced. */
function firstNumber(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Normalize a reset time to Unix epoch seconds.
 *
 * Documented input is epoch seconds. A magnitude at or above 1e11 is a
 * millisecond timestamp (1973 and later), and an ISO-8601 string is parsed.
 * Anything that is not a real, positive timestamp stays null — no value is
 * invented.
 */
export function normalizeResetTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value >= 1e11 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

/**
 * Normalize one statusLine window row to the dashboard's canonical shape.
 *
 * Returns null when `used_percentage` is missing, non-finite or outside 0..100.
 * A genuine `0` is kept as `0`: it is a measurement, not "missing".
 */
export function normalizeClaudeWindow(row, minutes) {
  const used = firstNumber(row, ['used_percentage', 'used_percent']);
  if (used === null || used < 0 || used > 100) return null;
  const reset = row?.resets_at ?? row?.resetsAt ?? row?.reset;
  return { used_percent: used, window_minutes: minutes, resets_at: normalizeResetTime(reset) };
}

/**
 * Map the statusLine `rate_limits` object onto primary (5h / 300 min) and
 * secondary (7d / 10080 min) windows. Returns null when neither window is
 * usable, so "no window" is distinct from a window measured at 0%.
 */
export function normalizeClaudeLimits(value, observedAt = null) {
  const result = { observedAt: typeof observedAt === 'string' && observedAt.trim() ? observedAt : null };
  for (const [source, target, minutes] of CLAUDE_WINDOWS) {
    const window = normalizeClaudeWindow(value?.[source], minutes);
    if (window) result[target] = window;
  }
  return result.primary || result.secondary ? result : null;
}

/** Read the last observation the statusLine capture persisted, or null. */
export function readClaudeLimits() {
  try {
    const value = JSON.parse(fs.readFileSync(claudeUsageFile, 'utf8'));
    return normalizeClaudeLimits(value.rate_limits, value.observedAt);
  } catch { return null; }
}

export function claudeStatuslineSettings() {
  // JSON is passed as one CLI argument, never interpolated into a shell command.
  const script = path.join(ROOT, 'scripts', 'claude-statusline.mjs').replace(/\\/g, '/');
  const data = DATA_DIR.replace(/\\/g, '/');
  return { statusLine: { type: 'command', command: `node "${script}" "${data}"` } };
}
