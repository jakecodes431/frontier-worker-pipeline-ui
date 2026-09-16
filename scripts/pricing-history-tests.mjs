/**
 * Spend-window history contracts.
 *
 * The defect these gates pin down, measured live on 2026-09-16: `usage_samples`
 * used to bank a COST delta, so a price row landing late dumped a whole history
 * into the current day, and the `restarted` path re-banked a cumulative. A spend
 * window must instead be a READ-TIME function of the stored TOKEN deltas priced
 * against the model's CURRENT rate (`server/db.js` priceTokenRows).
 *
 * Six gates:
 *   1. a new price row reprices history in place; today's window does not jump
 *   2. a refresh/restart does not move any window total by a cent
 *   3. a rate change moves every affected day proportionally, and only that model
 *   4. an unpriced real model contributes 0 and still blocks pricingComplete
 *   5. a deliberate marker contributes 0 and does NOT block pricingComplete
 *   6. the token-decrease (`restarted`) path never double-counts a day's tokens
 *
 * Planted faults: run with CR_PRICING_TEST_FAULT=<mode> to inject the exact
 * defect a gate is meant to catch; every mode must make its gate FAIL. Modes:
 *   stored-cost         window = SUM(cost_usd)                 -> gates 1, 3
 *   always-restart      every refresh re-banks the cumulative   -> gate 2
 *   cost-delta-rebanks  a falling cost delta re-banks tokens    -> gate 6
 *   price-unknown       the unpriced fixture gets a price row   -> gate 4
 *   drop-marker         the <synthetic> marker is removed       -> gate 5
 *
 * Offline and self-contained: a scratch CR_DATA_DIR and synthetic transcripts
 * only. It never opens the live database and never spawns a CLI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pricing-history-'));
process.env.CR_DATA_DIR = path.join(scratch, 'data');
delete process.env.CR_CONFIG_DIR;
// The reader resolves Claude transcripts under this root; nothing here touches
// the real ~/.claude.
const claudeHome = path.join(scratch, 'claude-home');
fs.mkdirSync(claudeHome, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const FAULT = process.env.CR_PRICING_TEST_FAULT || '';

const { costOf, pricing, localDay } = await import('../server/config.js');
const dbmod = await import('../server/db.js');
const { usageSamples, agents } = dbmod;
const db = dbmod.default;
const { readClaudeTranscript } = await import('../server/usage.js');

let failed = 0;
let passed = 0;
function gate(n, name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok ${passed} - gate ${n}: ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL gate ${n}: ${name}\n    ${error && error.message ? error.message : error}`);
  }
}

function shift(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

const TODAY = localDay();
const nextDay = (day) => shift(day, 1);

/* -------------------------------------------------------------------------- */
/* Planted-fault harness                                                      */
/* -------------------------------------------------------------------------- */

const TOKEN_FIELDS = [
  ['inputTokens', 'input_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'],
  ['cacheWriteTokens', 'cache_write_tokens'],
  ['outputTokens', 'output_tokens'],
];

/**
 * A byte-for-byte copy of the ORIGINAL record() kernel, kept here so a planted
 * fault can exercise a real path (SQL included) instead of a stub. `alwaysRestart`
 * makes every reading a restart; `costDeltaRebanks` restores the old
 * `restarted || deltaCost < 0` branch that re-banked a day's tokens whenever the
 * dollar delta fell.
 */
function recordWithKernel(agentId, model, day, cumulative, cumulativeCost, { alwaysRestart = false, costDeltaRebanks = false } = {}) {
  const key = model || 'unknown';
  const prev = db.prepare('SELECT * FROM usage_cursors WHERE agent_id = ? AND model = ?').get(agentId, key);
  const cost = Number(cumulativeCost) || 0;
  const delta = {};
  let restarted = alwaysRestart;
  for (const [camel, col] of TOKEN_FIELDS) {
    const next = Number(cumulative[camel]) || 0;
    const was = prev ? Number(prev[col]) || 0 : 0;
    if (next < was) restarted = true;
    delta[camel] = next - was;
  }
  let deltaCost = cost - (prev ? Number(prev.cost_usd) || 0 : 0);
  if (restarted || (costDeltaRebanks && deltaCost < 0)) {
    for (const [camel] of TOKEN_FIELDS) delta[camel] = Number(cumulative[camel]) || 0;
    deltaCost = cost;
  }
  const moved = TOKEN_FIELDS.some(([camel]) => delta[camel] !== 0) || deltaCost !== 0;
  if (!moved) return false;
  db.prepare(`INSERT INTO usage_samples (agent_id,model,day,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,model,day) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens, output_tokens=output_tokens+excluded.output_tokens,
      cost_usd=cost_usd+excluded.cost_usd, updated_at=excluded.updated_at`)
    .run(agentId, key, day, delta.inputTokens, delta.cacheReadTokens, delta.cacheWriteTokens, delta.outputTokens, deltaCost, new Date().toISOString());
  db.prepare(`INSERT INTO usage_cursors (agent_id,model,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,model) DO UPDATE SET input_tokens=excluded.input_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cache_write_tokens=excluded.cache_write_tokens, output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, updated_at=excluded.updated_at`)
    .run(agentId, key, Number(cumulative.inputTokens) || 0, Number(cumulative.cacheReadTokens) || 0,
      Number(cumulative.cacheWriteTokens) || 0, Number(cumulative.outputTokens) || 0, cost, new Date().toISOString());
  return true;
}

const oldSpendSince = (day) => db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage_samples WHERE day >= ?').get(day).c;
const oldSpendRuntimeSince = (runtime, day) => db.prepare('SELECT COALESCE(SUM(u.cost_usd),0) AS c FROM usage_samples u JOIN agents a ON a.id=u.agent_id WHERE a.runtime=? AND u.day>=?').get(runtime, day).c;

const record = (agentId, model, day, cumulative, cumulativeCost) => {
  if (FAULT === 'always-restart') return recordWithKernel(agentId, model, day, cumulative, cumulativeCost, { alwaysRestart: true });
  if (FAULT === 'cost-delta-rebanks') return recordWithKernel(agentId, model, day, cumulative, cumulativeCost, { costDeltaRebanks: true });
  return usageSamples.record(agentId, model, day, cumulative, cumulativeCost);
};
const spendSince = (day) => (FAULT === 'stored-cost' ? oldSpendSince(day) : usageSamples.spendSince(day));
const spendRuntimeSince = (runtime, day) => (FAULT === 'stored-cost' ? oldSpendRuntimeSince(runtime, day) : usageSamples.spendRuntimeSince(runtime, day));
/** Just one calendar day's window: `spendSince(day)` is a >= window. */
const spendOn = (day) => spendSince(day) - spendSince(nextDay(day));

function makeAgent(id, runtime = 'deepseek') {
  return agents.create({ id, name: id, role: 'worker', runtime, status: 'done' });
}
function writeTranscript(name, entries) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const tokens = (n) => ({ inputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

/* -------------------------------------------------------------------------- */
/* Gate 1                                                                     */
/* -------------------------------------------------------------------------- */

gate(1, 'adding a price row reprices history in place and does not jump today', () => {
  const FIXTURE = 'gpt-fixture-hist';
  const day = shift(TODAY, -5);
  const a = makeAgent('fixture-hist-1');
  delete pricing.models[FIXTURE];
  record(a.id, FIXTURE, day, tokens(1_000_000), 0);
  const pastBefore = spendOn(day);
  const todayBefore = spendSince(TODAY);

  // The price row lands later, exactly like gpt-6-astra's 11:04 commit.
  pricing.models[FIXTURE] = { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50, tier: 'fixture', estimated: true };
  const pastAfter = spendOn(day);
  const todayAfter = spendSince(TODAY);

  assert.equal(pastBefore, 0, `an unpriced model contributes 0 (got ${pastBefore})`);
  assert.ok(Math.abs(pastAfter - 10) < 1e-9, `the day the tokens were recorded absorbs the cost (got ${pastAfter})`);
  assert.equal(todayAfter, todayBefore, `today's window must not jump when a past day reprices (before ${todayBefore}, after ${todayAfter})`);
});

/* -------------------------------------------------------------------------- */
/* Gate 2                                                                     */
/* -------------------------------------------------------------------------- */

gate(2, 'feeding the same cursors twice does not move any window by a cent', () => {
  const a = makeAgent('fixture-refresh-1');
  const cumulative = { inputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100_000 };
  const cost = costOf(cumulative, 'deepseek-flash');
  record(a.id, 'deepseek-flash', TODAY, cumulative, cost);

  const weekFrom = shift(TODAY, -6);
  const monthFrom = TODAY.slice(0, 8) + '01';
  const windowTotals = () => ({
    today: spendSince(TODAY),
    week: spendSince(weekFrom),
    month: spendSince(monthFrom),
    runtime: spendRuntimeSince('deepseek', TODAY),
  });
  const before = windowTotals();

  // A server restart re-reads the same transcript and feeds the same cumulative.
  record(a.id, 'deepseek-flash', TODAY, cumulative, cost);

  const after = windowTotals();
  assert.ok(before.today > 0, 'the refresh fixture must actually spend money');
  for (const key of ['today', 'week', 'month', 'runtime']) {
    assert.ok(Math.abs(after[key] - before[key]) < 1e-9, `${key} moved by ${after[key] - before[key]}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Gate 3                                                                     */
/* -------------------------------------------------------------------------- */

gate(3, 'a rate change moves every affected day proportionally, and only that model', () => {
  const FIXTURE = 'claude-fixture-rate';
  pricing.models[FIXTURE] = { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20, tier: 'fixture', estimated: true };
  const d1 = shift(TODAY, -3), d2 = shift(TODAY, -2), d3 = shift(TODAY, -1);
  const fixtureAgent = makeAgent('fixture-rate-1');
  const controlAgent = makeAgent('fixture-rate-control');
  record(fixtureAgent.id, FIXTURE, d1, tokens(1_000_000), 0);
  record(fixtureAgent.id, FIXTURE, d2, tokens(2_000_000), 0);
  record(controlAgent.id, 'deepseek-flash', d3, tokens(1_000_000), 0);

  const before = { d1: spendOn(d1), d2: spendOn(d2), d3: spendOn(d3) };
  assert.ok(Math.abs(before.d1 - 4) < 1e-9, `fixture day 1 at $4/M (got ${before.d1})`);
  assert.ok(Math.abs(before.d2 - 4) < 1e-9, `fixture day 2 at $4/M (got ${before.d2})`);
  assert.ok(Math.abs(before.d3 - 0.15) < 1e-9, `control day at $0.15/M (got ${before.d3})`);

  pricing.models[FIXTURE].input = 8; // the rate doubles

  const after = { d1: spendOn(d1), d2: spendOn(d2), d3: spendOn(d3) };
  assert.ok(Math.abs(after.d1 - 2 * before.d1) < 1e-9, `affected day 1 must double (before ${before.d1}, after ${after.d1})`);
  assert.ok(Math.abs(after.d2 - 2 * before.d2) < 1e-9, `affected day 2 must double (before ${before.d2}, after ${after.d2})`);
  assert.ok(Math.abs(after.d3 - before.d3) < 1e-9, `the other model's day must not move (before ${before.d3}, after ${after.d3})`);
});

/* -------------------------------------------------------------------------- */
/* Gate 4                                                                     */
/* -------------------------------------------------------------------------- */

gate(4, 'an unpriced real model contributes 0 and still blocks pricingComplete', () => {
  const UNKNOWN = 'gpt-fixture-unpriced';
  delete pricing.models[UNKNOWN];
  // Planted fault: a stray/default price row for a model nobody priced.
  if (FAULT === 'price-unknown') pricing.models[UNKNOWN] = { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, tier: 'fixture' };

  const file = writeTranscript('unknown-model.jsonl', [
    { type: 'assistant', message: { id: 'u1', model: UNKNOWN, usage: { input_tokens: 5_000_000, output_tokens: 1_000_000 } } },
  ]);
  const r = readClaudeTranscript(file);
  assert.equal(r.usage.pricingKnown, false, 'a real unpriced model must make pricing look incomplete');
  assert.deepEqual(r.usage.unpricedModels, [UNKNOWN]);
  assert.deepEqual(r.usage.unpricedMarkers, []);
  assert.equal(r.usage.costUsd, 0, `an unpriced model contributes 0 (got ${r.usage.costUsd})`);

  // And the same model banked into a window still contributes 0 to the window.
  const a = makeAgent('fixture-unpriced-1');
  const day = shift(TODAY, -4);
  const before = spendOn(day);
  record(a.id, UNKNOWN, day, tokens(5_000_000), 0);
  const after = spendOn(day);
  assert.equal(after, before, `banking unpriced tokens must not move the window (before ${before}, after ${after})`);
});

/* -------------------------------------------------------------------------- */
/* Gate 5                                                                     */
/* -------------------------------------------------------------------------- */

gate(5, 'a deliberate marker contributes 0 and does not block pricingComplete', () => {
  if (FAULT === 'drop-marker') delete pricing.markers['<synthetic>'];
  const file = writeTranscript('marker-model.jsonl', [
    { type: 'assistant', message: { id: 'm1', model: 'claude-fable-5-1', usage: { input_tokens: 1_000, output_tokens: 100 } } },
    // A marker that somehow moved tokens is still not money: it has no price.
    { type: 'assistant', message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 42, output_tokens: 7 } }, isApiErrorMessage: true, error: 'rate_limit' },
  ]);
  const r = readClaudeTranscript(file);
  assert.equal(r.usage.pricingKnown, true, 'a marker must not make pricing look incomplete');
  assert.deepEqual(r.usage.unpricedModels, [], `markers must stay out of unpricedModels: ${JSON.stringify(r.usage.unpricedModels)}`);
  assert.deepEqual(r.usage.unpricedMarkers.map((m) => m.id), ['<synthetic>']);
  assert.equal(r.byModel['<synthetic>'].costUsd, 0, 'a marker must never be priced');
  assert.ok(r.usage.costUsd > 0, 'the real model beside the marker is still priced');
});

/* -------------------------------------------------------------------------- */
/* Gate 6                                                                     */
/* -------------------------------------------------------------------------- */

gate(6, 'the restarted path never double-counts a day\'s tokens', () => {
  // 6a: a genuine session replacement banks the new cumulative exactly once.
  const a = makeAgent('fixture-restart-1');
  record(a.id, 'deepseek-flash', TODAY, tokens(1_000_000), 0);
  record(a.id, 'deepseek-flash', TODAY, tokens(400_000), 0); // decrease -> session replaced
  const once = spendSince(TODAY);
  record(a.id, 'deepseek-flash', TODAY, tokens(400_000), 0); // repeat read of the new session
  const twice = spendSince(TODAY);
  const rowA = db.prepare("SELECT SUM(input_tokens) AS n FROM usage_samples WHERE agent_id=? AND model='deepseek-flash'").get(a.id).n;
  assert.equal(rowA, 1_400_000, `each session's work is banked once (got ${rowA})`);
  assert.equal(twice, once, 're-reading the replaced session must not add tokens');

  // 6b: a falling DOLLAR delta with growing tokens must not re-bank tokens.
  const FIXTURE = 'claude-fixture-drop';
  pricing.models[FIXTURE] = { input: 10, cacheRead: 0, cacheWrite: 0, output: 0, tier: 'fixture', estimated: true };
  const b = makeAgent('fixture-drop-1');
  const first = tokens(1_000_000);
  record(b.id, FIXTURE, TODAY, first, costOf(first, FIXTURE)); // $10
  pricing.models[FIXTURE].input = 1; // sheet gets cheaper
  const second = tokens(2_000_000);
  record(b.id, FIXTURE, TODAY, second, costOf(second, FIXTURE)); // $2, tokens up
  const rowB = db.prepare('SELECT SUM(input_tokens) AS n FROM usage_samples WHERE agent_id=? AND model=?').get(b.id, FIXTURE).n;
  assert.equal(rowB, 2_000_000, `a cheaper sheet must bank only the token increment (got ${rowB})`);
  const fixtureCost = usageSamples.rows(b.id).filter((r) => r.model === FIXTURE)
    .reduce((n, r) => n + costOf(tokens(r.input_tokens), FIXTURE), 0);
  assert.ok(Math.abs(fixtureCost - 2) < 1e-9, `the stored 2M tokens reprice to $2 (got ${fixtureCost})`);
});

/* -------------------------------------------------------------------------- */

try {
  db.close();
} catch { /* already closed */ }
if (failed) {
  console.log(`Pricing history: ${passed} passed, ${failed} failed${FAULT ? ` (planted fault: ${FAULT})` : ''}`);
  process.exitCode = 1;
} else {
  console.log(`Pricing history: ${passed} gates passed${FAULT ? ` (planted fault: ${FAULT} did not break its gate)` : ''}`);
}
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows file locks */ }
