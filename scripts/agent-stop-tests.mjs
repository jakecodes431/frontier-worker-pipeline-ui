// Focused tests for the hierarchy's right-click / keyboard Stop action
// (problem: there was no discoverable way to stop an agent from the list).
//
// The stop contract in ui/lib/stop.js is pure, so availability, confirmation,
// the optimistic "stopping" paint and — importantly — the API failure branch
// are asserted directly. The DOM menu is covered by its keyboard math plus
// source-level guarantees that it is a real ARIA menu wired to the existing
// POST /api/agents/:id/action endpoint.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stopAvailability, stopConfirmation, agentMenuItems, requestStop } from '../ui/lib/stop.js';
import { nextMenuIndex } from '../ui/lib/contextmenu.js';

let checks = 0;
async function check(label, fn) { await fn(); checks += 1; console.log(`PASS ${label}`); }
const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const running = { id: 'a-run', name: 'running worker', role: 'worker', runtime: 'deepseek', status: 'running', pid: 4242 };
const stoppedWithoutProcess = { id: 'a-done', name: 'finished worker', runtime: 'deepseek', status: 'done', pid: null };
const stoppedWithSurvivor = { id: 'a-survivor', name: 'crashed worker', runtime: 'deepseek', status: 'stopped', pid: 777 };
const external = { id: 'a-ext', name: 'registered cto', runtime: 'external', status: 'running' };
const successor = { id: 'a-old', name: 'old cto', runtime: 'deepseek', status: 'stopped', successorId: 'a-next' };

// ---------------------------------------------------------------------------
// Availability: what may be stopped, and the honest reason when it may not.
// ---------------------------------------------------------------------------
await check('a running managed agent can be stopped', () => {
  const a = stopAvailability(running);
  assert.equal(a.disabled, false);
  assert.equal(a.live, true);
});
await check('an external registration can never be stopped here', () => {
  const a = stopAvailability(external);
  assert.equal(a.disabled, true);
  assert.match(a.reason, /external/i);
});
await check('a finished agent with no process has nothing to stop', () => {
  const a = stopAvailability(stoppedWithoutProcess);
  assert.equal(a.disabled, true);
  assert.match(a.reason, /Nothing is running/);
});
await check('a finished agent with a surviving process can still be stopped', () => {
  assert.equal(stopAvailability(stoppedWithSurvivor).disabled, false);
});
await check('a continued task points at its successor instead', () => {
  const a = stopAvailability(successor);
  assert.equal(a.disabled, true);
  assert.match(a.reason, /a-next/);
});

// ---------------------------------------------------------------------------
// Confirmation: a live agent gets the explicit kill warning; smaller records
// get smaller copy, and the name is always carried.
// ---------------------------------------------------------------------------
await check('the live confirmation names the agent and the kill', () => {
  const text = stopConfirmation(running);
  assert.match(text, /running worker/);
  assert.match(text, /kills its live terminal and process tree/);
});
await check('a surviving process is described as such, not as a live terminal', () => {
  const text = stopConfirmation(stoppedWithSurvivor);
  assert.doesNotMatch(text, /live terminal/);
  assert.match(text, /surviving process tree/);
});
await check('an idle record gets the small confirmation', () => {
  const text = stopConfirmation({ id: 'q', name: 'queued one', runtime: 'deepseek', status: 'queued' });
  assert.match(text, /queued one/);
  assert.match(text, /marked stopped/);
});

// ---------------------------------------------------------------------------
// Menu items.
// ---------------------------------------------------------------------------
await check('the agent menu offers exactly the Stop action', () => {
  const items = agentMenuItems(running);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].action, items[0].danger, items[0].disabled], ['stop', true, false]);
});
await check('the Stop item is disabled with a reason for an external session', () => {
  const item = agentMenuItems(external)[0];
  assert.equal(item.disabled, true);
  assert.match(item.reason, /external/i);
});

// ---------------------------------------------------------------------------
// The request state machine: disabled / cancelled / success / failure.
// ---------------------------------------------------------------------------
await check('a disabled stop never touches the API', async () => {
  let calls = 0;
  const result = await requestStop(external, { action: async () => { calls += 1; } });
  assert.equal(result.ok, false);
  assert.equal(result.disabled, true);
  assert.equal(calls, 0);
});
await check('declining the confirmation never touches the API', async () => {
  let calls = 0;
  const optimistic = [];
  const result = await requestStop(running, {
    action: async () => { calls += 1; },
    confirm: () => false,
    onOptimistic: (a) => optimistic.push(a),
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls, 0);
  assert.equal(optimistic.length, 0);
});
await check('a confirmed stop paints stopping, then stops, via the lifecycle API', async () => {
  const calls = [];
  const optimistic = [];
  const settled = [];
  const serverAgent = { ...running, status: 'stopped', pid: null, endedAt: '2026-09-16T12:00:00.000Z' };
  const result = await requestStop(running, {
    action: async (id, action) => { calls.push([id, action]); return serverAgent; },
    confirm: (message) => { assert.match(message, /kills its live terminal/); return true; },
    onOptimistic: (a) => optimistic.push(a),
    onSettled: (a, err) => settled.push([a, err]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['a-run', 'stop']]);
  assert.equal(optimistic[0].status, 'stopping');
  assert.equal(settled[0][0], serverAgent);
  assert.equal(settled[0][1], null);
});
await check('a refused stop reports the error and restores the previous state', async () => {
  const optimistic = [];
  const settled = [];
  const result = await requestStop(running, {
    action: async () => { throw new Error('Earlier process is still running; could not stop it'); },
    confirm: () => true,
    onOptimistic: (a) => optimistic.push(a),
    onSettled: (a, err) => settled.push([a, err]),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not stop it/);
  assert.equal(optimistic[0].status, 'stopping');
  assert.equal(settled[0][0], running, 'the original record must come back on failure');
  assert.ok(settled[0][1] instanceof Error);
});
await check('a stop without a confirm hook still calls the API', async () => {
  let calls = 0;
  const result = await requestStop(running, { action: async () => { calls += 1; return { ...running, status: 'stopped' }; } });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// The menu's keyboard contract, as pure math.
// ---------------------------------------------------------------------------
await check('menu keyboard movement wraps and honours Home/End', () => {
  assert.equal(nextMenuIndex(3, -1, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(3, -1, 'ArrowUp'), 2);
  assert.equal(nextMenuIndex(3, 2, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(3, 0, 'ArrowUp'), 2);
  assert.equal(nextMenuIndex(3, 1, 'Home'), 0);
  assert.equal(nextMenuIndex(3, 1, 'End'), 2);
  assert.equal(nextMenuIndex(0, 0, 'ArrowDown'), -1);
});

// ---------------------------------------------------------------------------
// Source-level guarantees that cannot run without a browser.
// ---------------------------------------------------------------------------
const hierarchySrc = source('../ui/views/hierarchy.js');
const menuSrc = source('../ui/lib/contextmenu.js');
const stopSrc = source('../ui/lib/stop.js');
const panelSrc = source('../ui/views/panel.js');
const css = source('../ui/styles.css');

await check('hierarchy rows and cards open the menu on right-click', () => {
  assert.match(hierarchySrc, /oncontextmenu/);
  assert.match(hierarchySrc, /openAgentMenu\(/);
});
await check('the keyboard opens the same menu (ContextMenu / Shift+F10)', () => {
  assert.match(hierarchySrc, /'ContextMenu'/);
  assert.match(hierarchySrc, /F10/);
});
await check('the hierarchy stop goes through the existing action endpoint', () => {
  assert.match(hierarchySrc, /requestStop\(/);
  assert.match(hierarchySrc, /api\.action\(/);
  assert.doesNotMatch(hierarchySrc, /fetch\(/);
});
await check('the menu is a real ARIA menu with full keyboard support', () => {
  for (const needle of ["role: 'menu'", "'menuitem'", "'Escape'", "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Tab'", 'aria-label', 'focus()', 'getBoundingClientRect']) {
    assert.ok(menuSrc.includes(needle), `contextmenu.js must implement ${needle}`);
  }
});
await check('the stop contract targets the lifecycle stop action', () => {
  assert.match(stopSrc, /action: 'stop'/);
  assert.match(stopSrc, /\/api\/agents\/:id\/action/);
});
await check('the menu is styled by the app theme', () => {
  assert.match(css, /\.agent-menu\s*\{/);
  assert.match(css, /\.agent-menu-item\s*\{/);
  assert.match(css, /\.agent-menu-item\.is-danger/);
});
await check('the existing close/X and panel Stop control are untouched', () => {
  assert.match(panelSrc, /panel-close/);
  assert.match(panelSrc, /\{ action: 'stop'/);
});

console.log(`Agent stop tests passed: ${checks} checks (availability, confirmation, menu items, API success/refusal, keyboard math, wiring).`);
