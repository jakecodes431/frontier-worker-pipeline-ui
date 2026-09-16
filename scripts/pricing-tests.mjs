/**
 * Focused pricing-resolution contracts for the ids that showed up as "Unpriced"
 * in the hub: real models must resolve to a price row, and a CLI's deliberate
 * non-model placeholder must be reported apart from unpriced real models.
 *
 * Offline: synthetic transcripts and a scratch server/data dir only. It never
 * opens the live database and never spawns a CLI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-pricing-test-'));
process.env.CR_DATA_DIR = path.join(scratch, 'data');
delete process.env.CR_CONFIG_DIR;
// Both this process and the scratch server resolve Claude transcripts under
// this root, so nothing is ever read from or written to the real ~/.claude.
const claudeHome = path.join(scratch, 'claude-home');
fs.mkdirSync(claudeHome, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptDir, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${passed} - ${name}`); }

let db;
try {
  const { priceFor, markerFor, costOf, resolveModel, pricing } = await import('../server/config.js');
  const { readClaudeTranscript, claudeTranscriptPath } = await import('../server/usage.js');
  const { readCodexTranscript } = await import('../server/codex-usage.js');
  db = (await import('../server/db.js')).default;

  /* --------------------------- resolution per id --------------------------- */

  test('gpt-6-astra resolves to the existing priced row', () => {
    assert.equal(resolveModel('gpt-6-astra'), 'gpt-6-astra');
    assert.ok(priceFor('gpt-6-astra'));
    assert.equal(costOf({ inputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 }, 'gpt-6-astra', 272000), 73.5);
  });

  test('gpt-reserve resolves to a clearly-marked Luna-class estimate', () => {
    assert.equal(resolveModel('gpt-reserve'), 'gpt-reserve');
    const p = priceFor('gpt-reserve');
    assert.ok(p, 'gpt-reserve must have a price row');
    assert.equal(p.estimated, true);
    assert.equal(p.input, 0.2); assert.equal(p.cacheRead, 0.02);
    assert.equal(p.cacheWrite, 0.25); assert.equal(p.output, 1.2);
    assert.match(String(p.source), /^https:\/\//);
    assert.match(String(p.verifiedOn), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(p.basis), /inferred/i);
    const usage = { inputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 };
    assert.equal(costOf(usage, 'gpt-reserve'), 1.67);
    assert.equal(costOf(usage, 'gpt-reserve', 272001), 2.74);
    assert.equal(markerFor('gpt-reserve'), null, 'a real model is not a marker');
  });

  test('<synthetic> is a deliberate marker and is never priced', () => {
    assert.equal(priceFor('<synthetic>'), null, 'a marker must never carry a price');
    const m = markerFor('<synthetic>');
    assert.ok(m, '<synthetic> must be declared in config/pricing.json markers');
    assert.equal(m.id, '<synthetic>');
    assert.ok(m.reason && m.reason.length > 20);
    assert.match(String(m.source), /Claude Code/);
    assert.match(String(m.verifiedOn), /^\d{4}-\d{2}-\d{2}$/);
    for (const [id, entry] of Object.entries(pricing.markers || {})) {
      assert.ok(entry.reason && entry.verifiedOn, `marker ${id} must explain itself`);
    }
  });

  /* ------------------------ deliberate-marker case ------------------------ */

  test('Claude API-error placeholder is a marker, not an unpriced model', () => {
    const file = path.join(scratch, 'claude-marker.jsonl');
    fs.writeFileSync(file, [
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: 'assistant', message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }, isApiErrorMessage: true, error: 'rate_limit' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = readClaudeTranscript(file);
    assert.deepEqual(r.usage.unpricedModels, []);
    assert.deepEqual(r.usage.unpricedMarkers.map((m) => m.id), ['<synthetic>']);
    assert.equal(r.usage.pricingKnown, true, 'a marker must not make pricing look incomplete');
    assert.equal(r.byModel['<synthetic>'].deliberateMarker, true);
    assert.equal(r.usage.costUsd > 0, true, 'real usage is still priced');
  });

  test('Codex reader keeps markers out of unpricedModels too', () => {
    const file = path.join(scratch, 'codex-marker.jsonl');
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { id: '22222222-2222-4222-8222-222222222222', cwd: scratch } },
      { type: 'turn_context', payload: { model: '<synthetic>' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } } } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = readCodexTranscript(file);
    assert.deepEqual(r.usage.unpricedModels, []);
    assert.deepEqual(r.usage.unpricedMarkers.map((m) => m.id), ['<synthetic>']);
    assert.equal(r.usage.pricingKnown, true);
  });

  test('Codex gpt-reserve and gpt-6-astra turns now carry a cost', () => {
    const file = path.join(scratch, 'codex-reserve.jsonl');
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { id: '33333333-3333-4333-8333-333333333333', cwd: scratch } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } } },
      { type: 'turn_context', payload: { model: 'gpt-reserve' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 201000, cached_input_tokens: 0, output_tokens: 200 } } } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = readCodexTranscript(file);
    assert.deepEqual(r.usage.unpricedModels, []);
    assert.equal(r.usage.pricingKnown, true);
    assert.equal(r.byModel['gpt-6-astra'].pricingKnown, true);
    assert.equal(r.byModel['gpt-reserve'].pricingKnown, true);
    assert.equal(r.byModel['gpt-reserve'].costUsd > 0, true);
  });

  test('a real unknown model is still unpriced and still blocks pricingComplete', () => {
    const file = path.join(scratch, 'claude-unknown.jsonl');
    fs.writeFileSync(file, [{ type: 'assistant', message: { id: 'u1', model: 'gpt-fixture-unknown', usage: { input_tokens: 10, output_tokens: 2 } } }]
      .map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = readClaudeTranscript(file);
    assert.deepEqual(r.usage.unpricedModels, ['gpt-fixture-unknown']);
    assert.deepEqual(r.usage.unpricedMarkers, []);
    assert.equal(r.usage.pricingKnown, false);
  });

  /* ---------------------------- population case ---------------------------- */

  const PORT = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const dataDir = path.join(scratch, 'server-data');
  const cfgDir = path.join(scratch, 'server-cfg');
  for (const d of [dataDir, cfgDir]) fs.mkdirSync(d, { recursive: true });
  // pricing.json is deliberately NOT copied: the server must fall back to the
  // repo copy under test (same mechanism smoke.mjs uses).
  const runtimeCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtimes.json'), 'utf8'));
  runtimeCfg.dataDir = dataDir; runtimeCfg.port = PORT;
  fs.writeFileSync(path.join(cfgDir, 'runtimes.json'), JSON.stringify(runtimeCfg, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, CR_DATA_DIR: dataDir, CR_CONFIG_DIR: cfgDir, CR_PORT: String(PORT), CR_HOST: '127.0.0.1', CLAUDE_CONFIG_DIR: claudeHome },
    // No pipes: this test only needs the child's HTTP surface, and piping stdio
    // is refused outright by some sandboxes (see the runtime notes in the repo).
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${PORT}`;
  const getJson = async (p) => (await fetch(base + p)).json();
  const mkExternal = async (name, cwd, sessionId) => (await fetch(`${base}/api/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role: 'cto', runtime: 'external', task: 'pricing fixture', cwd, sessionId }),
  })).json();

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ } }
    assert.ok(up, 'scratch server did not boot on the scratch port');

    // Agent 1: real models that used to read as Unpriced, plus the marker.
    const cwd1 = path.join(scratch, 'project-1'); fs.mkdirSync(cwd1);
    const sid1 = 'sess-marker-fixture';
    const t1 = claudeTranscriptPath(cwd1, sid1);
    fs.mkdirSync(path.dirname(t1), { recursive: true });
    fs.writeFileSync(t1, [
      { type: 'assistant', message: { id: 'm1', model: 'gpt-6-astra', usage: { input_tokens: 10000, output_tokens: 100 } } },
      { type: 'assistant', message: { id: 'm2', model: 'gpt-reserve', usage: { input_tokens: 1000000, cache_read_input_tokens: 500000, output_tokens: 100000 } } },
      { type: 'assistant', message: { id: 'm3', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }, isApiErrorMessage: true, error: 'rate_limit' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const a1 = await mkExternal('pricing marker fixture', cwd1, sid1);
    assert.ok(a1.id, JSON.stringify(a1));
    await getJson(`/api/agents/${a1.id}`); // forces a usage refresh now, no 5s wait

    const usage = await getJson('/api/usage');
    assert.deepEqual(usage.unpricedModels, [], `still unpriced: ${JSON.stringify(usage.unpricedModels)}`);
    assert.equal(usage.pricingComplete, true);
    assert.deepEqual(usage.unpricedMarkers.map((m) => m.id), ['<synthetic>']);
    const marker = usage.unpricedMarkers[0];
    assert.ok(marker.reason && marker.reason.length > 20, 'marker carries its own explicit reason');
    assert.equal(marker.totalTokens, 0);
    assert.equal(usage.byTier.cto.pricingKnown, true, 'a marker must not mark a tier partial');
    assert.ok(usage.byTier.cto.costUsd > 0, 'gpt-reserve and gpt-6-astra tokens now cost money');
    passed++; console.log(`ok ${passed} - /api/usage reports pricingComplete true with only a marker left`);

    // Agent 2: a genuinely unknown real model still makes the panel say partial.
    const cwd2 = path.join(scratch, 'project-2'); fs.mkdirSync(cwd2);
    const sid2 = 'sess-unknown-fixture';
    const t2 = claudeTranscriptPath(cwd2, sid2);
    fs.mkdirSync(path.dirname(t2), { recursive: true });
    fs.writeFileSync(t2, [{ type: 'assistant', message: { id: 'u1', model: 'gpt-fixture-unknown', usage: { input_tokens: 10, output_tokens: 2 } } }]
      .map((e) => JSON.stringify(e)).join('\n') + '\n');
    const a2 = await mkExternal('pricing unknown fixture', cwd2, sid2);
    await getJson(`/api/agents/${a2.id}`);

    const partial = await getJson('/api/usage');
    assert.equal(partial.pricingComplete, false);
    assert.deepEqual(partial.unpricedModels, ['gpt-fixture-unknown']);
    assert.deepEqual(partial.unpricedMarkers.map((m) => m.id), ['<synthetic>'], 'marker stays separate from the real gap');
    passed++; console.log(`ok ${passed} - /api/usage reports pricingComplete false for a real unpriced model`);
  } finally {
    child.kill();
    await sleep(300);
  }

  console.log(`Pricing contracts: ${passed} checks passed`);
} finally {
  db?.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
