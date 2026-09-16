/** Offline runtime contracts. All transcripts are synthetic; no CLI login or model call. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-runtime-test-'));
process.env.CR_DATA_DIR = path.join(scratch, 'data');
delete process.env.CR_CONFIG_DIR;
let passed = 0, db;
function test(name, fn) { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import('../server/config.js');
  const { adapters } = await import('../server/adapters/index.js');
  const { readCodexTranscript, locateCodexSession } = await import('../server/codex-usage.js');
  const { readClaudeTranscript, readDshSession } = await import('../server/usage.js');
  db = (await import('../server/db.js')).default;
  const root = path.join(scratch, 'sessions'); fs.mkdirSync(root);
  config.runtimes.codex.transcriptRoot = root;
  const fixture = fs.readFileSync(path.join(scriptDir, 'fixtures/codex-rollout.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const id = '11111111-1111-4111-8111-111111111111';
  const cwd = path.join(scratch, 'project'); fs.mkdirSync(cwd);
  const file = path.join(root, `rollout-${id}.jsonl`);
  fixture[0].payload.cwd = cwd;
  const write = (f, rows) => fs.writeFileSync(f, rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  write(file, fixture);
  const agent = { id: 'fixture-agent', runtime: 'codex', cwd, startedAt: '2026-01-01T12:00:00.000Z', prompt: 'Read my brief', name: 'Fixture' };
  test('missing and malformed transcripts are tolerated', () => {
    assert.equal(readCodexTranscript(path.join(root, 'absent')).usage.totalTokens, 0);
    const bad = path.join(root, 'bad.jsonl'); fs.writeFileSync(bad, '{partial');
    assert.equal(readCodexTranscript(bad).usage.totalTokens, 0);
  });
  test('cumulative snapshots, cached input and reasoning are counted once', () => {
    const r = readCodexTranscript(file);
    assert.equal(r.usage.inputTokens, 900); assert.equal(r.usage.cacheReadTokens, 600);
    assert.equal(r.usage.outputTokens, 150); assert.equal(r.usage.totalTokens, 1650);
    assert.equal(r.byModel['gpt-fixture-a'].totalTokens, 1100);
    assert.equal(r.byModel['gpt-fixture-b'].totalTokens, 550);
    assert.equal(r.sessionId, id); assert.equal(r.model, 'gpt-fixture-b');
    assert.equal(r.usage.pricingKnown, false); assert.deepEqual(r.usage.unpricedModels, ['gpt-fixture-a', 'gpt-fixture-b']);
    assert.equal(r.usage.costUsd, 0); assert.equal(r.usage.limits.primary.used_percent, 25);
    assert.equal(r.usage.limitsObservedAt, '2026-01-01T12:00:05.000Z');
  });
  test('chat, final answer and end-turn status are exposed', () => {
    const r = readCodexTranscript(file, { withMessages: true });
    assert.equal(r.lastRole, 'assistant'); assert.equal(r.lastStop, 'end_turn');
    assert.ok(r.messages.some(m => m.role === 'tool' && m.text.includes('exec_command')));
    assert.equal(r.final, 'Feature verified');
    assert.equal(adapters.codex.result({ ...agent, sessionId: id }), 'Feature verified');
    assert.equal(adapters.external.usage({ ...agent, sessionId: id, runtime: 'external', transcriptRuntime: 'codex' }).usage.totalTokens, 1650);
  });
  test('new sessions require matching cwd, launch time, and their brief marker', () => {
    assert.equal(locateCodexSession(agent)?.id, id);
    assert.equal(locateCodexSession({ ...agent, cwd: scratch }), null);
    assert.equal(locateCodexSession({ ...agent, id: 'another-agent' }), null);
    assert.equal(locateCodexSession({ ...agent, startedAt: '2026-01-02T12:00:00Z' }), null);
    assert.equal(locateCodexSession({ ...agent, startedAt: null }), null);
    assert.equal(locateCodexSession({ ...agent, sessionId: 'missing-id' }), null);
  });
  test('explicit paths and IDs can recover old sessions', () => {
    assert.equal(locateCodexSession({ sessionId: file })?.file, file);
    assert.equal(locateCodexSession({ sessionId: id, startedAt: '2030-01-01' })?.id, id);
    assert.equal(locateCodexSession({ sessionId: root }), null);
  });
  test('ambiguous concurrent sessions stay unbound and subagents are excluded', () => {
    const second = structuredClone(fixture); second[0].payload.id = '22222222-2222-4222-8222-222222222222';
    const f2 = path.join(root, `rollout-${second[0].payload.id}.jsonl`); write(f2, second);
    assert.equal(locateCodexSession(agent), null);
    second[0].payload.source = { subagent: { spawn: { parent_thread_id: id } } }; write(f2, second);
    assert.equal(locateCodexSession(agent)?.id, id);
    fs.unlinkSync(f2);
  });
  test('append invalidates cache and a new user turn clears completion', () => {
    fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-01-01T12:01:00Z', type: 'event_msg', payload: { type: 'task_started' } }) + '\n{partial');
    const r = readCodexTranscript(file); assert.equal(r.lastStop, null); assert.equal(r.lastRole, 'user'); assert.equal(r.usage.totalTokens, 1650);
  });
  test('default launch uses interactive CLI and leaves model and effort to user config', () => {
    const b = adapters.codex.build(agent, 4800);
    assert.equal(b.command, 'codex'); assert.ok(b.args.includes('--no-alt-screen'));
    assert.ok(!b.args.includes('--model')); assert.ok(!b.args.some(a => a.startsWith('model_reasoning_effort='))); assert.ok(!b.args.includes('exec'));
    assert.ok(b.args.includes('features.current_time_reminder.enabled=false'));
    assert.deepEqual(b.args.slice(b.args.indexOf('--sandbox'), b.args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
    assert.ok(b.args.includes(agent.prompt));
  });
  test('resume selects the exact UUID and forwards explicit model/effort', () => {
    const b = adapters.codex.build({ ...agent, sessionId: id, model: 'gpt-fixture', effort: 'high', permissionMode: 'read-only' }, 4800, { resume: true });
    assert.deepEqual(b.args.slice(0, 2), ['resume', id]); assert.ok(b.args.includes('model_reasoning_effort="high"'));
    assert.ok(b.args.includes('gpt-fixture')); assert.ok(!b.args.includes(agent.prompt));
    assert.throws(() => adapters.codex.build(agent, 4800, { resume: true }), /session UUID/);
    assert.throws(() => adapters.codex.build({ ...agent, sessionId: '--last' }, 4800, { resume: true }), /session UUID/);
    assert.throws(() => adapters.codex.build({ ...agent, permissionMode: 'acceptEdits' }, 4800), /permissionMode/);
    assert.throws(() => adapters.codex.build({ ...agent, effort: 'evil"' }, 4800), /effort/);
  });
  test('every runtime honors env policy; nested-session markers never leak', () => {
    process.env.CODEX_THREAD_ID = 'inherited'; process.env.CODEX_SESSION_ID = 'inherited'; process.env.CLAUDECODE = '1';
    process.env.CODEX_APP_TOOLS_PIPE_PATH = 'parent-ipc'; process.env.CODEX_PERMISSION_PROFILE = 'parent-permissions';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'inherited'; process.env.FIXTURE_SECRET = 'do-not-forward'; process.env.FIXTURE_KEEP_TOKEN = 'allowed';
    for (const runtime of ['claude', 'codex', 'deepseek']) {
      const rt = config.runtimes[runtime]; rt.scrubEnvContaining = ['secret', 'token']; rt.keepEnv = ['fixture_keep_token']; rt.env = { FIXTURE_FLAG: 'configured' };
      if (runtime === 'deepseek') rt.args = [file, '{prompt}'];
      const env = adapters[runtime].build({ ...agent, runtime }, 4801).env;
      assert.equal(env.CODEX_THREAD_ID, undefined); assert.equal(env.CODEX_SESSION_ID, undefined); assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, undefined); assert.equal(env.CODEX_PERMISSION_PROFILE, undefined);
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined); assert.equal(env.FIXTURE_SECRET, undefined);
      assert.equal(env.FIXTURE_KEEP_TOKEN, 'allowed'); assert.equal(env.FIXTURE_FLAG, 'configured');
      assert.equal(env.CR_AGENT_ID, agent.id); assert.equal(env.CR_URL, 'http://127.0.0.1:4801');
      assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, runtime === 'claude' ? '1' : undefined);
    }
  });
  test('missing worker script fails before spawn', () => {
    config.runtimes.deepseek.args = [path.join(scratch, 'not-installed.js')];
    assert.throws(() => adapters.deepseek.build({ ...agent, runtime: 'deepseek' }, 4800), /worker CLI was not found/);
  });
  test('existing Claude and DeepSeek parsers flag unknown model pricing', () => {
    const cf = path.join(scratch, 'claude.jsonl'); write(cf, [{ type: 'assistant', message: { id: 'm1', model: 'unknown-fixture', usage: { input_tokens: 10, output_tokens: 2 } } }]);
    assert.equal(readClaudeTranscript(cf).usage.pricingKnown, false);
    const df = path.join(scratch, 'dsh.json'); fs.writeFileSync(df, JSON.stringify({ record: { rows: { tokenUsage: { val: { totals: { uncachedInputTokens: 10, outputTokens: 2 } } } } } }));
    assert.equal(readDshSession(df, 'unknown-fixture').usage.pricingKnown, false);
    assert.equal(readDshSession(df, 'deepseek-flash').usage.pricingKnown, true);
  });
} finally {
  db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`Runtime contracts: ${passed} checks passed`);
}
