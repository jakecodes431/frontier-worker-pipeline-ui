import assert from 'node:assert/strict';
import { limitObservation, limitWindowLabel, limitTime, limitPercent, comparisonModelLabel, claudeUsageState } from '../ui/lib/limits.js';
const time = { locale: 'en-US', timeZone: 'UTC' };
const raw = { primary: { used_percent: 96, window_minutes: 10080, resets_at: 1767276000 }, secondary: { used_percent: 0, window_minutes: 300, resets_at: null }, observedAt: '2026-01-01T12:00:00Z' };
const read = limitObservation(raw, time);
assert.equal(read.windows.length, 2);
assert.deepEqual(read.windows.map(w => [w.label, w.used, w.remaining]), [['Weekly window', 96, 4], ['5-hour window', 0, 100]]);
assert.equal(read.windows[0].resetsAt, 'Jan 1, 2:00 PM UTC');
assert.equal(read.windows[1].resetsAt, null);
assert.equal(read.observedAt, 'Jan 1, 12:00 PM UTC');
assert.deepEqual(limitObservation(null).windows, []);
assert.deepEqual(limitObservation({ primary: null, secondary: null }).windows, []);
for (const value of [null, undefined, '', '0', NaN, Infinity, -1, 101]) {
  const w = limitObservation({ primary: { used_percent: value, window_minutes: 300 } }).windows[0];
  assert.equal(w.used, null); assert.equal(w.remaining, null);
}
assert.equal(limitObservation({ primary: { used_percent: 100 } }).windows[0].remaining, 0);
assert.equal(limitObservation({ secondary: { usedPercent: 12.5, windowDurationMins: 60 } }).windows[0].label, '1-hour window');
assert.equal(limitPercent(12.55), '12.6%'); assert.equal(limitPercent(null), 'not reported');
assert.equal(limitWindowLabel(90), '90-minute window'); assert.equal(limitWindowLabel(1440), 'Daily window');
assert.equal(limitWindowLabel(null, 'Secondary window'), 'Secondary window');
assert.equal(limitTime('invalid', time), null); assert.equal(limitTime(null, time), null); assert.equal(limitTime(0, time), 'Jan 1, 12:00 AM UTC');
assert.equal(comparisonModelLabel({ pricing: { fableEquivalentModel: 'configured-test-model' } }), 'configured-test-model');
assert.equal(comparisonModelLabel({}), 'configured comparison model');

/* Claude connection dialog states (pure helper; full coverage in usage-connection-tests.mjs) */
const dialogNow = Date.parse('2026-02-01T00:00:00.000Z');
const dialogSettings = { statusLine: { type: 'command', command: 'node "s" "d"' } };
assert.equal(claudeUsageState({ ok: false, status: 404 }, { now: dialogNow }).kind, 'stale-server');
assert.equal(claudeUsageState({ ok: false, status: 0 }, { now: dialogNow }).kind, 'network-error');
assert.equal(claudeUsageState({ ok: false, status: 503 }, { now: dialogNow }).kind, 'server-error');
assert.equal(claudeUsageState({ ok: true, data: { limits: null, settings: dialogSettings } }, { now: dialogNow }).kind, 'not-connected');
assert.equal(claudeUsageState({ ok: true, data: { limits: { observedAt: '2026-01-31T23:45:00.000Z', primary: { used_percent: 5 } }, settings: dialogSettings } }, { now: dialogNow }).kind, 'present');
assert.equal(claudeUsageState({ ok: true, data: { limits: { observedAt: '2026-01-31T10:00:00.000Z', primary: { used_percent: 5 } }, settings: dialogSettings } }, { now: dialogNow }).kind, 'stale-observation');
console.log('Limit formatting tests passed: observed usage, both windows, resets, missing versus zero, configured savings model, and Claude connection dialog states.');
