import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usageCost, tokens } from '../ui/lib/format.js';
import { runtimeNames, runtimeEfforts, runtimeModels, modelOptions, chosenModel, CUSTOM_MODEL, continuationProvider, handoffButtonState, agentIsLive, handoffSubmitState, handoffPayload, LIVE_HANDOFF_NOTICE } from '../ui/views/newagent.js';
import { handoffButtonState as panelHandoffButtonState } from '../ui/views/panel.js';
import { nextActiveIndex, typeaheadIndex, closeOpenDropdown } from '../ui/lib/dropdown.js';
import { ctoAgent } from '../ui/views/cto.js';
import { setState } from '../ui/lib/store.js';
import api, { ApiError } from '../ui/lib/api.js';

// Missing pricing must not look like free usage, while a measured zero stays zero.
assert.equal(usageCost({ costUsd: 0, pricingKnown: false }), 'Unpriced');
assert.equal(usageCost({ costUsd: 0, pricingKnown: true }), '$0.00');
assert.equal(usageCost({}), 'not available');
assert.equal(tokens(undefined), 'not available');
assert.equal(tokens(0), '0');

const config = { runtimes: { codex: { efforts: ['low', 'xhigh'], models: ['gpt-6-astra', 'gpt-reserve'] }, external: {} } };
assert.deepEqual(runtimeNames(config), ['codex', 'external']);
assert.deepEqual(runtimeEfforts(config, 'codex'), ['low', 'xhigh']);
assert.deepEqual(runtimeEfforts(config, 'external'), []);
assert.ok(runtimeNames().includes('codex'));

// Models mirror efforts: the config list wins, a runtime with no config entry
// falls back to MODELS_BY_RUNTIME, and external has none.
assert.deepEqual(runtimeModels(config, 'codex'), ['gpt-6-astra', 'gpt-reserve']);
assert.deepEqual(runtimeModels(config, 'external'), []);
assert.deepEqual(runtimeModels({}, 'claude'), ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
assert.deepEqual(runtimeModels({}, 'deepseek'), ['deepseek-flash']);
assert.deepEqual(runtimeModels({}, 'codex'), ['gpt-6-astra', 'gpt-reserve']);
assert.deepEqual(runtimeModels({ runtimes: { codex: { models: [] } } }, 'codex'), [], 'an explicit empty list means no named models');

// The dropdown's order: default (''), the listed models, then Custom… — and
// the default option is labelled with the runtime default when there is one.
const codexModels = modelOptions(config, 'codex');
assert.equal(codexModels[0].value, '', 'the default option carries the empty value');
assert.deepEqual(codexModels.map((o) => o.value), ['', 'gpt-6-astra', 'gpt-reserve', CUSTOM_MODEL]);
assert.equal(codexModels.at(-1).label, 'Custom…');
assert.equal(modelOptions({}, 'claude')[0].label, 'CLI default');
assert.equal(modelOptions({ runtimes: { deepseek: { defaults: { model: 'deepseek-flash' } } } }, 'deepseek')[0].label, 'Default (deepseek-flash)');
assert.equal(modelOptions(config, 'external').length, 2, 'external still offers Default + Custom…');

// Custom… maps to the typed value; anything else submits the selected value,
// and an empty choice stays empty so no `model` key is sent.
assert.equal(chosenModel('', 'ignored'), '');
assert.equal(chosenModel('gpt-6-astra', 'ignored'), 'gpt-6-astra');
assert.equal(chosenModel(CUSTOM_MODEL, '  my-model-v9  '), 'my-model-v9');
assert.equal(chosenModel(CUSTOM_MODEL, '   '), '', 'a blank Custom value sends no model');
const noModel = handoffPayload({ runtime: 'codex', model: chosenModel('', ''), effort: '', autoStart: false });
assert.deepEqual(noModel, { runtime: 'codex', autoStart: false });

assert.equal(continuationProvider({ runtime: 'codex', transcriptRuntime: 'claude' }, ['claude', 'codex']), 'claude');
assert.equal(continuationProvider({ runtime: 'external', transcriptRuntime: 'codex' }, ['claude', 'codex']), 'claude');
assert.equal(continuationProvider({ runtime: 'claude' }, ['claude', 'codex']), 'codex');

// A running managed session must open the "Choose LLM" chooser. The stop is the
// operator's action: the button state only explains the server's refusal.
assert.equal(panelHandoffButtonState, handoffButtonState);
const managedRunning = handoffButtonState({ id: 'ds', role: 'cto', runtime: 'deepseek', status: 'running' }, { live: true });
assert.equal(managedRunning.hidden, false);
assert.equal(managedRunning.disabled, false);
assert.equal(managedRunning.openable, true);
assert.equal(managedRunning.live, true);
assert.match(managedRunning.title, /stop/i);
assert.ok(managedRunning.warning && /stop/i.test(managedRunning.warning), 'active session must explain stop-before-switch');

// Every active managed status is openable, for both handoff roles.
for (const role of ['cto', 'orchestrator']) {
  for (const status of ['running', 'idle', 'paused', 'queued']) {
    const s = handoffButtonState({ id: 'x', role, runtime: 'deepseek', status }, { live: status !== 'queued' });
    assert.equal(s.hidden, false, `${role}/${status} must stay visible`);
    assert.equal(s.disabled, false, `${role}/${status} must not be disabled`);
    assert.equal(s.openable, true, `${role}/${status} must open the chooser`);
  }
}

// Terminal statuses keep working, with no stop warning.
for (const status of ['stopped', 'blocked', 'done', 'failed']) {
  const s = handoffButtonState({ id: 'x', role: 'orchestrator', runtime: 'deepseek', status });
  assert.equal(s.disabled, false, `${status} must not be disabled`);
  assert.equal(s.openable, true, `${status} must open the chooser`);
  assert.equal(s.warning, null, `${status} needs no stop warning`);
}

// Workers cannot hand off at all.
const asWorker = handoffButtonState({ id: 'w', role: 'worker', runtime: 'deepseek', status: 'running' }, { live: true });
assert.equal(asWorker.hidden, true);
assert.equal(asWorker.openable, false);

// An existing continuation is explained, not ignored.
const continued = handoffButtonState({ id: 'x', role: 'cto', runtime: 'deepseek', status: 'stopped', successorId: 'next-cto' });
assert.equal(continued.disabled, true);
assert.equal(continued.openable, false);
assert.match(continued.title, /next-cto/);
assert.ok(continued.warning && /next-cto/.test(continued.warning));

// `live` defaults to the record; external sessions never have a local terminal.
assert.equal(agentIsLive({ runtime: 'deepseek', status: 'running' }), true);
assert.equal(agentIsLive({ runtime: 'deepseek', status: 'stopped' }), false);
assert.equal(agentIsLive({ runtime: 'external', status: 'running' }), false);
assert.equal(handoffButtonState({ role: 'cto', runtime: 'deepseek', status: 'running' }).live, true);
assert.equal(handoffButtonState({ role: 'cto', runtime: 'external', status: 'running' }).live, false);

// ---------------------------------------------------------------------------
// Choose LLM modal: the live source is openable but NOT submittable, and the
// inline copy says exactly what to do and where. Nothing stops anything here.
// ---------------------------------------------------------------------------
const liveRecord = { id: 'x', role: 'cto', runtime: 'codex', status: 'running' };
const liveModal = handoffSubmitState(liveRecord);
assert.equal(handoffButtonState(liveRecord).openable, true, 'a live source must still open the chooser');
assert.equal(liveModal.disabled, true, 'a live source must not be submittable');
assert.equal(liveModal.live, true);
assert.equal(liveModal.notice, LIVE_HANDOFF_NOTICE);
assert.match(liveModal.notice, /live terminal/i, 'the copy names the condition');
assert.match(liveModal.notice, /panel/i, 'the copy says where to go');
assert.match(liveModal.notice, /Stop control/i, 'the copy names the exact control');
assert.match(liveModal.notice, /nothing is stopped for you/i, 'the client never stops the source');
assert.match(liveModal.title, /stop/i, 'the disabled button explains itself');

// An explicit live override wins over the record, exactly as panel.js passes it.
assert.equal(handoffSubmitState({ role: 'cto', runtime: 'codex', status: 'stopped' }, { live: true }).disabled, true);

// A non-live source submits normally.
for (const record of [
  { role: 'cto', runtime: 'codex', status: 'stopped' },
  { role: 'orchestrator', runtime: 'claude', status: 'done' },
  { role: 'cto', runtime: 'external', status: 'running' },
]) {
  const s = handoffSubmitState(record);
  assert.equal(s.disabled, false, `${record.runtime}/${record.status} must be submittable`);
  assert.equal(s.live, false);
}

// ---------------------------------------------------------------------------
// The submitted payload is exactly the server's handoff contract.
// ---------------------------------------------------------------------------
const minimal = handoffPayload({ runtime: 'codex', model: '', effort: '', autoStart: false });
assert.deepEqual(minimal, { runtime: 'codex', autoStart: false });
assert.ok(!('model' in minimal) && !('effort' in minimal), 'model/effort are only sent when chosen');
const maximal = handoffPayload({ runtime: 'claude', model: 'opus', effort: 'high', autoStart: true });
assert.deepEqual(maximal, { runtime: 'claude', autoStart: true, model: 'opus', effort: 'high' });
for (const key of Object.keys(maximal)) {
  assert.ok(['runtime', 'model', 'effort', 'autoStart', 'brief'].includes(key), `${key} is not in the handoff contract`);
}

// ---------------------------------------------------------------------------
// The listbox popup's keyboard contract, as pure logic.
// ---------------------------------------------------------------------------
assert.equal(closeOpenDropdown(), false, 'closing with nothing open is a safe no-op');
assert.equal(nextActiveIndex(3, -1, 'ArrowDown'), 0, 'Down from nothing picks the first');
assert.equal(nextActiveIndex(3, -1, 'ArrowUp'), 2, 'Up from nothing picks the last');
assert.equal(nextActiveIndex(3, 2, 'ArrowDown'), 0, 'Down wraps');
assert.equal(nextActiveIndex(3, 0, 'ArrowUp'), 2, 'Up wraps');
assert.equal(nextActiveIndex(3, 1, 'Home'), 0);
assert.equal(nextActiveIndex(3, 1, 'End'), 2);
assert.equal(nextActiveIndex(3, 1, 'Enter'), 1, 'Enter keeps the active row');
assert.equal(nextActiveIndex(0, 0, 'ArrowDown'), -1, 'an empty list has no active row');

const labels = ['Claude', 'Codex', 'DeepSeek'];
assert.equal(typeaheadIndex(labels, 'c', 0), 0, 'prefix match stays on the matching row');
assert.equal(typeaheadIndex(labels, 'co', 0), 1, 'a longer prefix narrows the match');
assert.equal(typeaheadIndex(labels, 'cc', 0), 1, 'a repeated character cycles to the next match');
assert.equal(typeaheadIndex(labels, 'd', -1), 2, 'typeahead works before anything is active');
assert.equal(typeaheadIndex(labels, 'zz', 1), 1, 'no match keeps the current row');
assert.equal(typeaheadIndex([], 'x', 0), -1, 'an empty list has no match');

// ---------------------------------------------------------------------------
// Source-level guarantees that cannot be exercised without a browser.
// ---------------------------------------------------------------------------
const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const newagentSrc = source('../ui/views/newagent.js');
const panelSrc = source('../ui/views/panel.js');
const dropdownSrc = source('../ui/lib/dropdown.js');
const handoffCss = source('../ui/handoff.css');

// The handoff path never stops, kills or restarts the source itself: the
// server marks it stopped after creating the successor.
const handoffSrc = newagentSrc.slice(newagentSrc.indexOf('export function openHandoff'));
assert.ok(handoffSrc.length > 400, 'the handoff path must be found in newagent.js');
assert.doesNotMatch(handoffSrc, /api\.(action|stop|kill|restart)\s*\(/i, 'the handoff path must not call an action endpoint');
assert.doesNotMatch(handoffSrc, /\b(stopAgent|killTree|restartAgent)\s*\(/i, 'the handoff path must not stop/kill/restart anything');
assert.match(handoffSrc, /handoffSubmitState\(/, 'the modal must consult the live-submit rule');
assert.match(handoffSrc, /submit\.disabled = true/, 'the live modal must visibly disable submit');
assert.match(handoffSrc, /handoffPayload\(/, 'the modal must build the contract payload');
assert.match(handoffSrc, /setText\(error, err && err\.message/, 'the server 409 must be surfaced verbatim');
assert.match(handoffSrc, /modelOptions\(/, 'the continuation form must rebuild its model list per runtime');
assert.match(handoffSrc, /chosenModel\(/, 'the continuation form must resolve Default/Custom through the pure rule');

// Both forms must go through the same model rule, and the no-model-key rule is
// that an empty choice is simply not added to the payload.
assert.match(newagentSrc, /modelOptions\(/, 'the New agent form must offer the per-runtime model list');
assert.match(newagentSrc, /chosenModel\(modelSelect\.value, modelCustom\.value\)/, 'the New agent form must resolve Default/Custom through the pure rule');
assert.match(newagentSrc, /if \(!model\.el\.hidden && modelId\) payload\.model = modelId/, 'an empty/Default choice must send no model key');

// The panel's Choose LLM wiring is equally action-free; the Stop control lives
// in the Extra tab and is a separate code path.
const panelHeadSrc = panelSrc.slice(panelSrc.indexOf('function buildHead'), panelSrc.indexOf('function createExtraTab'));
assert.match(panelHeadSrc, /openHandoff\(/, 'the panel button must open the chooser');
assert.match(panelHeadSrc, /handoffButtonState\(/, 'the panel button must use the pure state rule');
assert.doesNotMatch(panelHeadSrc, /api\.(action|stop|kill|restart)\s*\(/i, 'the handoff trigger must not call an action endpoint');
assert.match(panelSrc, /\{ action: 'stop'/, 'the Extra tab keeps its own Stop control');

// The square close button: real glyph, named, titled, 32x32 in both dialogs.
assert.match(newagentSrc, /'aria-label': 'Close this dialog \(Escape\)'/);
assert.match(newagentSrc, /title: 'Close \(Escape\)'/);
assert.match(newagentSrc, /'✕'/);
assert.match(newagentSrc, /width: '32px', height: '32px'/);
assert.ok(!/'Esc'\s*\)/.test(newagentSrc), 'the close control must not be the text "Esc"');

// The dropdown carries the full ARIA/keyboard bar.
for (const needle of [
  "role: 'listbox'", "'aria-selected'", "'aria-activedescendant'", "'aria-expanded'", "'aria-haspopup'",
  "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Enter'", "'Escape'", "'Tab'",
  "'pointerdown'", "'focusout'",
]) {
  assert.ok(dropdownSrc.includes(needle), `the dropdown must implement ${needle}`);
}
assert.match(handoffCss, /\.dd-trigger:focus-visible/, 'the popup needs a visible focus ring');
assert.match(handoffCss, /\.dd-list\s*\{/, 'the popup must be styled by the scoped sheet');
assert.match(handoffCss, /\.handoff-check/, 'the checkbox row must be styled by the scoped sheet');

// Keeping old CTO history must not leave its successor hidden in the CTO view.
setState({ agents: [
  { id: 'old', role: 'cto', successorId: 'next', createdAt: '2026-09-16T09:00:00Z' },
  { id: 'worker', role: 'worker', createdAt: '2026-09-16T11:00:00Z' },
  { id: 'next', role: 'cto', createdAt: '2026-09-16T10:00:00Z' },
] });
assert.equal(ctoAgent().id, 'next');
setState({ agents: [] });
assert.equal(ctoAgent(), null);

const originalFetch = globalThis.fetch;
try {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: 'successor', runtime: 'codex' }), { status: 201 });
  };
  const payload = { runtime: 'codex', autoStart: false, effort: 'xhigh' };
  assert.equal((await api.handoff('old/id', payload)).id, 'successor');
  assert.equal(request.url, '/api/agents/old%2Fid/handoff');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), payload);
  // The modal's own payload builder goes over the wire unchanged.
  await api.handoff('a1', handoffPayload({ runtime: 'claude', model: 'opus', effort: 'high', autoStart: true }));
  assert.deepEqual(JSON.parse(request.init.body), { runtime: 'claude', autoStart: true, model: 'opus', effort: 'high' });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Stop the live terminal first' }), { status: 409 });
  await assert.rejects(api.handoff('old', payload), (err) => err instanceof ApiError && err.status === 409 && err.message === 'Stop the live terminal first');
} finally { globalThis.fetch = originalFetch; }

console.log('UI contract tests passed: unknown pricing, config choices, CTO successor, handoff payload and refusal, live-submit state, listbox keyboard logic, close button and no-stop guarantee.');
