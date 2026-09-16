// Focused tests for the hierarchy's right-click / keyboard Stop and Remove
// actions (problems: there was no discoverable way to stop an agent from the
// list, and no way to remove one from the board at all).
//
// The contracts in ui/lib/stop.js and ui/lib/remove.js are pure, so
// availability, confirmation, the optimistic "stopping" paint and — importantly
// — the API failure branch are asserted directly. The DOM menu is covered by
// its keyboard math plus source-level guarantees that it is a real ARIA menu
// wired to the existing lifecycle endpoints (POST .../action, DELETE
// /api/agents/:id).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stopAvailability, stopConfirmation, agentMenuItems, requestStop } from '../ui/lib/stop.js';
import { removeAvailability, removeConfirmation, requestRemove } from '../ui/lib/remove.js';
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
await check('the agent menu offers Stop beside the new Remove action', () => {
  const items = agentMenuItems(running);
  assert.deepEqual(items.map((i) => i.action), ['stop', 'remove']);
  assert.deepEqual([items[0].action, items[0].danger, items[0].disabled], ['stop', true, false]);
  assert.deepEqual([items[1].action, items[1].danger, items[1].disabled], ['remove', true, true], 'a live agent is not removable');
});
await check('the Stop item is disabled with a reason for an external session', () => {
  const item = agentMenuItems(external)[0];
  assert.equal(item.disabled, true);
  assert.match(item.reason, /external/i);
});
await check('the Remove item is enabled for an external session (no terminal to stop)', () => {
  const item = agentMenuItems(external)[1];
  assert.equal(item.action, 'remove');
  assert.equal(item.disabled, false);
  assert.equal(item.reason, null);
});
await check('the Remove item is enabled once the terminal is gone', () => {
  const item = agentMenuItems(stoppedWithoutProcess)[1];
  assert.equal(item.disabled, false);
});

// ---------------------------------------------------------------------------
// Remove availability: the server 409s only while a live terminal owns the
// record, so the menu must disable exactly those and explain the stop-first
// path in the server's own words.
// ---------------------------------------------------------------------------
await check('a finished agent with no process can be removed', () => {
  const a = removeAvailability(stoppedWithoutProcess);
  assert.equal(a.disabled, false);
  assert.equal(a.live, false);
});
await check('a live agent is not removable and is told to stop first', () => {
  const a = removeAvailability(running);
  assert.equal(a.disabled, true);
  assert.equal(a.live, true);
  assert.match(a.reason, /running worker/);
  assert.match(a.reason, /live terminal — stop it first, then remove it/);
});
await check('an external registration is removable because it has no terminal', () => {
  const a = removeAvailability(external);
  assert.equal(a.disabled, false);
});
await check('no agent means nothing to remove', () => {
  const a = removeAvailability(null);
  assert.equal(a.disabled, true);
  assert.match(a.reason, /No agent selected/);
});

// ---------------------------------------------------------------------------
// Remove confirmation: it names the agent and is explicit that the children
// are re-parented, NOT removed, and that disk artefacts stay put.
// ---------------------------------------------------------------------------
await check('the removal confirmation names the agent and the record', () => {
  const text = removeConfirmation(stoppedWithoutProcess);
  assert.match(text, /finished worker/);
  assert.match(text, /deletes the agent record and its message history/);
});
await check('the removal confirmation says the children are re-parented, not removed', () => {
  const text = removeConfirmation(stoppedWithoutProcess);
  assert.match(text, /children are re-parented/);
  assert.match(text, /not removed/);
  assert.match(text, /stay on the board/);
  assert.match(text, /worktree, branch and CLI transcript are left on disk/);
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
// The remove state machine: disabled / cancelled / success / refusal.
// ---------------------------------------------------------------------------
await check('a disabled removal never touches the API', async () => {
  let calls = 0;
  const settled = [];
  const result = await requestRemove(running, {
    action: async () => { calls += 1; },
    confirm: () => true,
    onSettled: (a, err) => settled.push([a, err]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.disabled, true);
  assert.match(result.reason, /stop it first/);
  assert.equal(calls, 0, 'a live agent must not reach the DELETE endpoint from the menu');
  assert.equal(settled.length, 0);
});
await check('declining the removal confirmation never touches the API', async () => {
  let calls = 0;
  const settled = [];
  const result = await requestRemove(stoppedWithoutProcess, {
    action: async () => { calls += 1; },
    confirm: () => false,
    onSettled: (a, err) => settled.push([a, err]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls, 0);
  assert.equal(settled.length, 0, 'a cancelled removal must not drop the row');
});
await check('a confirmed removal calls DELETE once and reports success', async () => {
  const calls = [];
  const settled = [];
  const result = await requestRemove(stoppedWithoutProcess, {
    action: async (id) => { calls.push(id); return { ok: true }; },
    confirm: (message) => { assert.match(message, /children are re-parented/); return true; },
    onSettled: (a, err) => settled.push([a, err]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['a-done']);
  assert.equal(settled.length, 1);
  assert.equal(settled[0][0], stoppedWithoutProcess);
  assert.equal(settled[0][1], null);
});
await check('a 409 refusal surfaces the server message and never reports success', async () => {
  const calls = [];
  const settled = [];
  const result = await requestRemove(stoppedWithoutProcess, {
    action: async (id) => {
      calls.push(id);
      const err = new Error('"finished worker" still has a live terminal — stop it first, then remove it');
      err.status = 409;
      throw err;
    },
    confirm: () => true,
    onSettled: (a, err) => settled.push([a, err]),
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.match(result.error, /still has a live terminal/);
  assert.equal(settled[0][0], stoppedWithoutProcess, 'the refused record must come back untouched');
  assert.ok(settled[0][1] instanceof Error);
  assert.equal(settled[0][1].status, 409);
});
await check('a removal without a confirm hook still calls the API', async () => {
  let calls = 0;
  const result = await requestRemove(stoppedWithoutProcess, { action: async () => { calls += 1; return { ok: true }; } });
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
await check('arrow keys reach the Remove item and Home/End still select the ends', () => {
  // Two items: Stop (0) then Remove (1). Down from Stop lands on Remove; Up and
  // End reach it from either side; Enter/Space activation is the menu's shared
  // click path, covered by the source-level checks below.
  assert.equal(nextMenuIndex(2, 0, 'ArrowDown'), 1);
  assert.equal(nextMenuIndex(2, 1, 'ArrowUp'), 0);
  assert.equal(nextMenuIndex(2, 0, 'End'), 1);
  assert.equal(nextMenuIndex(2, 1, 'Home'), 0);
  assert.equal(nextMenuIndex(2, -1, 'ArrowUp'), 1, 'Up from nothing lands on Remove');
});

// ---------------------------------------------------------------------------
// Source-level guarantees that cannot run without a browser.
// ---------------------------------------------------------------------------
const hierarchySrc = source('../ui/views/hierarchy.js');
const menuSrc = source('../ui/lib/contextmenu.js');
const stopSrc = source('../ui/lib/stop.js');
const removeSrc = source('../ui/lib/remove.js');
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
await check('the hierarchy removal goes through the existing DELETE endpoint', () => {
  assert.match(hierarchySrc, /requestRemove\(/);
  assert.match(hierarchySrc, /api\.deleteAgent\(/);
  assert.doesNotMatch(hierarchySrc, /fetch\(/);
});
await check('a successful removal drops the row and clears selection/focus on it', () => {
  assert.match(hierarchySrc, /forgetAgent\(target\.id\)/);
  assert.match(hierarchySrc, /removeAgent\(id\)/);
  assert.match(hierarchySrc, /if \(wasSelected\) select\(null\)/);
  assert.match(hierarchySrc, /focusItem\(list\[/);
});
await check('the removal refusal path reports the server message and does not drop the row', () => {
  const removeHandler = hierarchySrc.slice(hierarchySrc.indexOf('async function runRemove'), hierarchySrc.indexOf('function forgetAgent'));
  assert.ok(removeHandler.length > 200, 'the removal handler must be found in hierarchy.js');
  assert.match(removeHandler, /toast\(`Remove failed: \$\{err\.message\}`/);
  assert.match(removeHandler, /if \(err\) \{/);
  assert.doesNotMatch(removeHandler, /removeAgent\(|select\(null\)/, 'nothing may be dropped before the server confirms');
});
await check('the menu is a real ARIA menu with full keyboard support', () => {
  for (const needle of ["role: 'menu'", "'menuitem'", "'Escape'", "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Tab'", 'aria-label', 'focus()', 'getBoundingClientRect']) {
    assert.ok(menuSrc.includes(needle), `contextmenu.js must implement ${needle}`);
  }
});
await check('the menu renders every item with its label, danger tone and disabled reason', () => {
  assert.match(menuSrc, /item\.action/);
  assert.match(menuSrc, /item\.danger/);
  assert.match(menuSrc, /item\.disabled/);
  assert.match(menuSrc, /title: item\.reason \|\| null/);
  assert.match(menuSrc, /onSelect\(item\.action, agent\)/);
});
await check('the stop contract targets the lifecycle stop action', () => {
  assert.match(stopSrc, /action: 'stop'/);
  assert.match(stopSrc, /\/api\/agents\/:id\/action/);
});
await check('the remove contract targets the lifecycle DELETE endpoint', () => {
  assert.match(removeSrc, /DELETE \/api\/agents\/:id/);
  assert.match(removeSrc, /await action\(agent\.id\)/);
  assert.doesNotMatch(removeSrc, /fetch\(/);
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

console.log(`Agent stop/remove tests passed: ${checks} checks (availability, confirmation, menu items, API success/refusal, keyboard math, wiring).`);
