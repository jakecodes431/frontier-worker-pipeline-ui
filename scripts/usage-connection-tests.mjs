import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { costOf } from '../server/config.js';
import { normalizeClaudeLimits, normalizeResetTime, claudeStatuslineSettings } from '../server/claude-limits.js';
import { claudeUsageState, claudeStatuslineCommand } from '../ui/lib/limits.js';

/* --------------------------------------------- DeepSeek pricing (existing) --- */
const usage = { inputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 1000000, outputTokens: 1000000 };
assert.equal(costOf(usage, 'gpt-6-astra', 272000), 73.5);
assert.equal(costOf(usage, 'gpt-6-astra', 272001), 122);

/* ------------------- server normalization: the documented statusLine shape --- */
// https://code.claude.com/docs/en/statusline — five_hour / seven_day, each with
// used_percentage (0..100) and resets_at (Unix epoch seconds).
const documented = {
  five_hour: { used_percentage: 25, resets_at: 2000000000 },
  seven_day: { used_percentage: 55, resets_at: 2000600000 },
};
const normalized = normalizeClaudeLimits(documented, '2026-01-01T00:00:00.000Z');
assert.equal(normalized.observedAt, '2026-01-01T00:00:00.000Z');
assert.deepEqual(normalized.primary, { used_percent: 25, window_minutes: 300, resets_at: 2000000000 });
assert.deepEqual(normalized.secondary, { used_percent: 55, window_minutes: 10080, resets_at: 2000600000 });

/* missing window versus a genuine 0: zero must survive as zero, never null */
assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: 0 } }).primary.used_percent, 0);
assert.equal(normalizeClaudeLimits({ seven_day: { used_percentage: 0, resets_at: 1 } }).secondary.used_percent, 0);
assert.equal(normalizeClaudeLimits({ five_hour: { resets_at: 2000000000 } }), null);
assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: null, resets_at: 2000000000 } }), null);

/* out-of-range / non-finite / null / string rejected */
for (const bad of [null, undefined, NaN, Infinity, -Infinity, -1, 100.0001, 101, '25', true]) {
  assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: bad } }), null, `five_hour ${String(bad)} must be rejected`);
}
assert.equal(normalizeClaudeLimits({ seven_day: { used_percentage: 100 } }).secondary.used_percent, 100);

/* partial windows keep only what was reported */
const onlyFive = normalizeClaudeLimits({ five_hour: { used_percentage: 12 } });
assert.ok(onlyFive.primary && !onlyFive.secondary);
assert.equal(onlyFive.primary.window_minutes, 300);
const onlyWeek = normalizeClaudeLimits({ seven_day: { used_percentage: 12 } });
assert.ok(onlyWeek.secondary && !onlyWeek.primary);
assert.equal(onlyWeek.secondary.window_minutes, 10080);
assert.equal(normalizeClaudeLimits(undefined), null);
assert.equal(normalizeClaudeLimits({}), null);
assert.equal(normalizeClaudeLimits({ five_hour: null, seven_day: null }), null);

/* 5h -> primary (300), 7d -> secondary (10080) mapping is explicit */
assert.deepEqual(
  normalizeClaudeLimits({ seven_day: { used_percentage: 1 }, five_hour: { used_percentage: 2 } }).primary,
  { used_percent: 2, window_minutes: 300, resets_at: null });
assert.deepEqual(
  normalizeClaudeLimits({ seven_day: { used_percentage: 1 }, five_hour: { used_percentage: 2 } }).secondary,
  { used_percent: 1, window_minutes: 10080, resets_at: null });

/* reset-time normalization: seconds kept, ms and ISO converted, junk null */
assert.equal(normalizeResetTime(2000000000), 2000000000);
assert.equal(normalizeResetTime(2000000000000), 2000000000);
assert.equal(normalizeResetTime('2026-01-01T00:00:00.000Z'), Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000));
assert.equal(normalizeResetTime('not-a-date'), null);
assert.equal(normalizeResetTime(null), null);
assert.equal(normalizeResetTime(-5), null);
assert.equal(normalizeResetTime(Infinity), null);
assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: 5, resets_at: 2000000000000 } }).primary.resets_at, 2000000000);
assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: 5, resets_at: '2026-01-01T00:00:00.000Z' } }).primary.resets_at, Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000));
assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: 5, resets_at: null } }).primary.resets_at, null);

/* legacy field names still normalize (documented name wins when both exist) */
const legacy = normalizeClaudeLimits({ five_hour: { used_percent: 7, resetsAt: 2000000000000 } });
assert.equal(legacy.primary.used_percent, 7);
assert.equal(legacy.primary.resets_at, 2000000000);

/* an observation time is never invented when the file did not carry one */
assert.equal(normalizeClaudeLimits({ five_hour: { used_percentage: 5 } }).observedAt, null);

assert.match(claudeStatuslineSettings().statusLine.command, /claude-statusline\.mjs/);

/* --------------------------- statusLine capture (isolated, temp data dir) --- */
const scriptPath = new URL('./claude-statusline.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Run the capture script against a throwaway data dir and report the result.
 *
 * stdin/stdout are real files behind file descriptors, not pipes: the same
 * statusLine contract (JSON on stdin, text on stdout) is exercised while the
 * test stays runnable under sandboxes that refuse named-pipe stdio.
 */
function captureJson(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-capture-'));
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-io-'));
  try {
    const stdinFile = path.join(io, 'stdin.json');
    const stdoutFile = path.join(io, 'stdout.txt');
    fs.writeFileSync(stdinFile, input);
    const stdinFd = fs.openSync(stdinFile, 'r');
    const stdoutFd = fs.openSync(stdoutFile, 'w');
    let run;
    try {
      run = spawnSync(process.execPath, [scriptPath, dir], { stdio: [stdinFd, stdoutFd, stdoutFd] });
    } finally {
      fs.closeSync(stdinFd);
      fs.closeSync(stdoutFd);
    }
    assert.equal(run.status, 0, `capture exit: ${run.error ? run.error.message : run.status}`);
    const file = path.join(dir, 'claude-usage.json');
    const exists = fs.existsSync(file);
    return {
      run, dir, exists,
      stdout: fs.readFileSync(stdoutFile, 'utf8'),
      raw: exists ? fs.readFileSync(file, 'utf8') : null,
      entries: fs.readdirSync(dir),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(io, { recursive: true, force: true });
  }
}

/* documented shape round-trips; zero survives; nothing private is persisted */
const good = captureJson(JSON.stringify({
  hook_event_name: 'Status',
  session_id: 'sess-secret',
  transcript_path: 'C:/secret/transcript.jsonl',
  cwd: 'C:/secret',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  cost: { total_cost_usd: 1.23 },
  context_window: { used_percentage: 42 },
  secret: 'must-not-be-stored',
  rate_limits: {
    five_hour: { used_percentage: 0, resets_at: 2000000000 },
    seven_day: { used_percentage: 55 },
  },
}));
assert.ok(good.exists, 'a documented payload must be captured');
assert.deepEqual(good.entries, ['claude-usage.json'], 'the atomic write leaves only the result file');
const goodRaw = JSON.parse(good.raw);
assert.equal(goodRaw.rate_limits.five_hour.used_percentage, 0, 'a real 0% must survive as 0');
assert.equal(goodRaw.rate_limits.five_hour.resets_at, 2000000000);
assert.equal(goodRaw.rate_limits.seven_day.used_percentage, 55);
assert.equal(goodRaw.rate_limits.seven_day.resets_at, null, 'an absent reset time stays null, not invented');
assert.match(good.stdout, /5h 0% used/);
assert.ok(typeof goodRaw.observedAt === 'string' && goodRaw.observedAt, 'the observation time is recorded');
for (const secret of ['session_id', 'sess-secret', 'transcript_path', 'cost', 'context_window', 'display_name', 'hook_event_name', 'secret', 'cwd']) {
  assert.ok(!good.raw.includes(secret), `capture must not persist ${secret}`);
}
for (const key of Object.keys(goodRaw.rate_limits)) {
  assert.deepEqual(Object.keys(goodRaw.rate_limits[key]).sort(), ['resets_at', 'used_percentage']);
}
assert.deepEqual(Object.keys(goodRaw).sort(), ['observedAt', 'rate_limits']);

/* partial windows: only five_hour, then only seven_day */
const fiveOnly = captureJson(JSON.stringify({ session_id: 'x', rate_limits: { five_hour: { used_percentage: 25, resets_at: 1 } } }));
assert.ok(fiveOnly.exists);
assert.ok(!('seven_day' in JSON.parse(fiveOnly.raw).rate_limits));
assert.match(fiveOnly.stdout, /5h 25% used/);
const sevenOnly = captureJson(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 55 } } }));
assert.ok(sevenOnly.exists);
assert.ok(!('five_hour' in JSON.parse(sevenOnly.raw).rate_limits));
assert.match(sevenOnly.stdout, /7d 55% used/);

/* legacy shape (used_percent + millisecond resetsAt) normalizes on capture too */
const legacyCapture = captureJson(JSON.stringify({ rate_limits: { five_hour: { used_percent: 12, resetsAt: 2000000000000 } } }));
assert.ok(legacyCapture.exists);
const legacyRaw = JSON.parse(legacyCapture.raw);
assert.equal(legacyRaw.rate_limits.five_hour.used_percentage, 12);
assert.equal(legacyRaw.rate_limits.five_hour.resets_at, 2000000000);

/* invalid windows are dropped, and an all-invalid payload writes nothing */
for (const bad of [null, 101, -1, '25', true]) {
  const invalid = captureJson(JSON.stringify({ rate_limits: { five_hour: { used_percentage: bad } } }));
  assert.equal(invalid.exists, false, `used_percentage ${String(bad)} must not be captured`);
  assert.match(invalid.stdout, /not reported yet/);
}
const emptyWindows = captureJson(JSON.stringify({ rate_limits: {} }));
assert.equal(emptyWindows.exists, false);
const missingWindows = captureJson(JSON.stringify({ session_id: 'x', model: { display_name: 'Opus' } }));
assert.equal(missingWindows.exists, false);

/* empty / malformed / oversized stdin never write and never crash */
const empty = captureJson('');
assert.equal(empty.exists, false);
assert.match(empty.stdout, /not reported yet/);
const whitespace = captureJson('   \n\t ');
assert.equal(whitespace.exists, false);
const malformed = captureJson('{"rate_limits":');
assert.equal(malformed.exists, false);
assert.match(malformed.stdout, /unavailable/);
const oversized = captureJson(JSON.stringify({ pad: 'x'.repeat(1100000) }));
assert.equal(oversized.exists, false);
assert.match(oversized.stdout, /larger than 1 MiB/);

/* every capture above ran against a throwaway dir under the OS temp area */
assert.ok(path.resolve(good.dir).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()),
  'capture tests must never write into the worktree data directory');

/* --------------------------------- the pure connection-dialog state helper --- */
const dialogSettings = { statusLine: { type: 'command', command: 'node "C:/repo/scripts/claude-statusline.mjs" "C:/repo/data"' } };
const NOW = Date.parse('2026-01-01T12:00:00.000Z');

const staleServer = claudeUsageState({ ok: false, status: 404 }, { now: NOW });
assert.equal(staleServer.kind, 'stale-server');
assert.match(staleServer.message, /404/);
assert.match(staleServer.message, /older process/);
assert.match(staleServer.action, /Restart/);
assert.equal(staleServer.limits, null);

const network = claudeUsageState({ ok: false, status: 0, message: 'Failed to fetch' }, { now: NOW });
assert.equal(network.kind, 'network-error');
assert.match(network.message, /Failed to fetch/);
assert.match(network.message, /not 0% used/);

const serverError = claudeUsageState({ ok: false, status: 500 }, { now: NOW });
assert.equal(serverError.kind, 'server-error');
assert.match(serverError.title, /500/);

assert.equal(claudeUsageState(null, { now: NOW }).kind, 'invalid-payload');
assert.equal(claudeUsageState({ ok: true, data: null }, { now: NOW }).kind, 'invalid-payload');
assert.equal(claudeUsageState({ ok: true, data: { limits: null } }, { now: NOW }).kind, 'invalid-payload');

const notConnected = claudeUsageState({ ok: true, data: { limits: null, settings: dialogSettings, note: 'server note' } }, { now: NOW });
assert.equal(notConnected.kind, 'not-connected');
assert.equal(notConnected.limits, null);
assert.equal(notConnected.settings, dialogSettings);
assert.equal(notConnected.note, 'server note');
assert.match(notConnected.message, /not 0% used/);

const present = claudeUsageState({
  ok: true,
  data: { limits: { observedAt: '2026-01-01T11:59:00.000Z', primary: { used_percent: 25, window_minutes: 300, resets_at: null } }, settings: dialogSettings },
}, { now: NOW });
assert.equal(present.kind, 'present');
assert.equal(present.stale, false);
assert.equal(present.observedAt, '2026-01-01T11:59:00.000Z');

/* exactly at the staleness threshold is still current */
const boundary = claudeUsageState({
  ok: true,
  data: { limits: { observedAt: new Date(NOW - 30 * 60 * 1000).toISOString(), primary: { used_percent: 25 } }, settings: dialogSettings },
}, { now: NOW });
assert.equal(boundary.kind, 'present');

const staleObservation = claudeUsageState({
  ok: true,
  data: { limits: { observedAt: '2026-01-01T09:00:00.000Z', primary: { used_percent: 25, window_minutes: 300, resets_at: null } }, settings: dialogSettings },
}, { now: NOW });
assert.equal(staleObservation.kind, 'stale-observation');
assert.equal(staleObservation.stale, true);
assert.match(staleObservation.message, /may have changed since/);
assert.equal(staleObservation.settings, dialogSettings);

const unknownTime = claudeUsageState({
  ok: true,
  data: { limits: { primary: { used_percent: 10 } }, settings: dialogSettings },
}, { now: NOW });
assert.equal(unknownTime.kind, 'stale-observation');
assert.equal(unknownTime.observedAt, null);

/* fallback command block, only for the unreachable-endpoint path */
assert.deepEqual(
  claudeStatuslineCommand({ defaultCwd: 'C:/repo', dataDir: 'C:/repo/data' }),
  { statusLine: { type: 'command', command: 'node "C:/repo/scripts/claude-statusline.mjs" "C:/repo/data"' } });
assert.match(claudeStatuslineCommand({ crBin: 'C:/repo/bin/cr.js', dataDir: 'C:/repo/data' }).statusLine.command, /C:\/repo\/scripts\/claude-statusline\.mjs/);
assert.equal(claudeStatuslineCommand({}), null);

console.log('Usage connections passed: documented statusLine shape (0..100, epoch seconds), zero-vs-missing, invalid/partial windows, reset normalization, credential-free atomic capture (empty/malformed/oversized stdin), and pure dialog states for stale server, network error, not-connected, stale and present observations.');
