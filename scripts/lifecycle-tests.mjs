// Real HTTP, WebSocket, SQLite and PTY coverage. The CLI fixture is an echo
// process, not a model: these checks spend no tokens and need no credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-lifecycle-'));
const repo = path.join(scratch, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
execFileSync('git', ['-C', repo, 'add', 'README.md']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'pipe' });
const fixture = path.join(scratch, 'echo.mjs');
fs.writeFileSync(fixture, `process.stdout.write('TERMINAL_READY\\r\\n'); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { process.stdout.write('RECEIVED:'+d+'\\r\\n'); if(d.includes('EXIT_FIXTURE')) process.exit(0); });`);
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/runtimes.json')));
for (const runtime of ['claude', 'codex']) cfg.runtimes[runtime] = { ...cfg.runtimes[runtime], command: process.execPath, args: [fixture], resumeArgs: [fixture], defaults: {} };
fs.writeFileSync(path.join(scratch, 'runtimes.json'), JSON.stringify(cfg));
let child, logs = '', count = 0;
const sockets = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = { ...process.env, CR_PORT: String(port), CR_DATA_DIR: path.join(scratch, 'data'), CR_CONFIG_DIR: scratch };
async function boot() {
  child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} if (child.exitCode !== null) throw new Error(logs); await sleep(100); }
  throw new Error('server boot timed out: ' + logs);
}
async function request(route, body, expected = 200, headers = {}) {
  const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); assert.equal(r.status, expected, `${route}: ${JSON.stringify(j)}`); return j;
}
function check(label, fn) { fn(); count++; console.log(`PASS ${label}`); }
async function until(fn) { for (let i = 0; i < 80; i++) { const x = await fn(); if (x) return x; await sleep(100); } throw new Error('condition timed out'); }
async function terminateServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited;
}

try {
  await boot();
  await request('/api/agents', { name: 'external', role: 'cto', runtime: 'external', cwd: repo, task: 'recover', transcriptRuntime: 'unknown' }, 400);
  check('invalid external transcript provider refused', () => {});
  const old = await request('/api/agents', { name: 'Original CTO', role: 'cto', runtime: 'external', cwd: repo, task: 'recover the project', transcriptRuntime: 'codex', sessionId: 'fixture-session' }, 201);
  check('Codex external provider persisted', () => assert.equal(old.transcriptRuntime, 'codex'));
  await request(`/api/agents/${old.id}/action`, { action: 'restart' }, 400);
  await request(`/api/agents/${old.id}/action`, { action: 'pause' }, 409);
  check('external lifecycle does not pretend to control a process', () => {});
  const worker = await request('/api/agents', { name: 'Reporter', role: 'worker', runtime: 'external', cwd: repo, task: 'report', parentId: old.id }, 201);
  await request(`/api/agents/${worker.id}/report`, { text: 'Checkpoint: one file remains' });
  const successor = await request(`/api/agents/${old.id}/handoff`, { runtime: 'claude', autoStart: false }, 201);
  check('handoff keeps cwd, task and role', () => { assert.equal(successor.cwd, old.cwd); assert.equal(successor.task, old.task); assert.equal(successor.role, 'cto'); });
  check('handoff links both records', () => assert.equal(successor.continuedFromId, old.id));
  const prev = (await request(`/api/agents/${old.id}`)).agent;
  check('original history links successor', () => assert.equal(prev.successorId, successor.id));
  check('brief carries checkpoint', () => assert.match(fs.readFileSync(successor.briefPath, 'utf8'), /one file remains/));
  check('child ownership transfers', () => {});
  assert.equal((await request(`/api/agents/${worker.id}`)).agent.parentId, successor.id);
  await request(`/api/agents/${worker.id}/report`, { text: 'New checkpoint' });
  const inbox = await request(`/api/agents/${successor.id}/inbox`);
  check('future reports reach successor', () => assert(inbox.some(m => m.text === 'New checkpoint')));
  await request(`/api/agents/${old.id}/handoff`, { runtime: 'claude', autoStart: false }, 409);
  check('duplicate handoff refused', () => {});

  // A DeepSeek source is created stopped (autoStart:false), so no real DeepSeek
  // CLI is launched: only the echo fixture backs the claude/codex successors.
  const ds = await request('/api/agents', { name: 'DeepSeek CTO', role: 'cto', runtime: 'deepseek', cwd: repo, task: 'continue from deepseek', autoStart: false }, 201);
  check('deepseek source queued without a process', () => { assert.equal(ds.status, 'queued'); assert.ok(!ds.pid); });
  const dsClaude = await request(`/api/agents/${ds.id}/handoff`, { runtime: 'claude', autoStart: false }, 201);
  const dsAfter = (await request(`/api/agents/${ds.id}`)).agent;
  check('DeepSeek to Claude handoff keeps cwd, task and role', () => {
    assert.equal(dsClaude.cwd, ds.cwd);
    assert.equal(dsClaude.task, ds.task);
    assert.equal(dsClaude.role, 'cto');
    assert.equal(dsClaude.runtime, 'claude');
  });
  check('DeepSeek to Claude links both records and does not launch', () => {
    assert.equal(dsClaude.continuedFromId, ds.id);
    assert.equal(dsClaude.status, 'queued');
    assert.ok(!dsClaude.pid);
    assert.equal(dsAfter.successorId, dsClaude.id);
    assert.equal(dsAfter.status, 'stopped');
  });
  await request(`/api/agents/${ds.id}/handoff`, { runtime: 'codex', autoStart: false }, 409);
  const dsStill = (await request(`/api/agents/${ds.id}`)).agent;
  check('duplicate handoff on DeepSeek source refused and source untouched', () => {
    assert.equal(dsStill.successorId, dsClaude.id);
    assert.equal(dsStill.status, 'stopped');
  });

  const ds2 = await request('/api/agents', { name: 'DeepSeek orchestrator', role: 'orchestrator', runtime: 'deepseek', cwd: repo, task: 'second deepseek source', autoStart: false }, 201);
  const dsCodex = await request(`/api/agents/${ds2.id}/handoff`, { runtime: 'codex', autoStart: false }, 201);
  check('DeepSeek to Codex handoff succeeds with the same contract', () => {
    assert.equal(dsCodex.runtime, 'codex');
    assert.equal(dsCodex.continuedFromId, ds2.id);
    assert.equal(dsCodex.role, 'orchestrator');
    assert.equal(dsCodex.cwd, ds2.cwd);
    assert.equal(dsCodex.task, ds2.task);
    assert.equal(dsCodex.status, 'queued');
    assert.ok(!dsCodex.pid);
  });

  const started = await request(`/api/agents/${successor.id}/action`, { action: 'restart' });
  check('queued successor starts a real PTY', () => assert(started.pid > 0));
  await until(async () => (await request(`/api/agents/${successor.id}/scrollback`)).data.includes('TERMINAL_READY'));
  const liveBefore = (await request(`/api/agents/${successor.id}`)).agent;
  const liveRefusal = await request(`/api/agents/${successor.id}/handoff`, { runtime: 'codex', autoStart: false }, 409);
  const liveAfter = (await request(`/api/agents/${successor.id}`)).agent;
  check('live handoff refused with stop-before-switch message', () =>
    assert.match(liveRefusal.error, /Stop the current agent before continuing with another provider/));
  check('refused live handoff leaves the source untouched', () => {
    assert.equal(liveAfter.status, liveBefore.status);
    assert.equal(liveAfter.successorId ?? null, liveBefore.successorId ?? null);
    assert.equal(liveAfter.endedAt ?? null, liveBefore.endedAt ?? null);
    assert.equal(liveAfter.pid, liveBefore.pid);
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base }); sockets.push(ws);
  const frames = []; ws.on('message', b => frames.push(JSON.parse(b)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'attach', id: successor.id }));
  await until(() => frames.find(f => f.type === 'pty' && f.scrollback));
  check('WebSocket attaches to live terminal with scrollback', () => assert(frames.some(f => f.type === 'pty' && f.live && f.data.includes('TERMINAL_READY'))));
  ws.send(JSON.stringify({ type: 'input', id: successor.id, data: 'WS_PROOF\r' }));
  await until(() => frames.find(f => f.type === 'pty' && f.data.includes('WS_PROOF')));
  check('WebSocket input reaches real process', () => {});
  ws.send(JSON.stringify({ type: 'resize', id: successor.id, cols: 95, rows: 28 }));
  await request(`/api/agents/${successor.id}/control`, { holder: 'human' });
  await request(`/api/agents/${successor.id}/send`, { text: 'PARENT_TEXT' }, 409, { 'x-sender': `agent:${old.id}` });
  await request(`/api/agents/${successor.id}/control`, { holder: 'parent' });
  await request(`/api/agents/${successor.id}/action`, { action: 'pause' });
  await request(`/api/agents/${successor.id}/send`, { text: 'PAUSED_PARENT_TEXT' }, 409, { 'x-sender': `agent:${old.id}` });
  const resumed = await request(`/api/agents/${successor.id}/action`, { action: 'resume' });
  check('control and pause/resume govern live input', () => assert.equal(resumed.status, 'running'));
  await request(`/api/agents/${successor.id}/send`, { text: 'HTTP_PROOF' });
  await until(async () => (await request(`/api/agents/${successor.id}/scrollback`)).data.includes('HTTP_PROOF'));
  check('chat send reaches managed terminal', () => {});
  await request(`/api/agents/${successor.id}/action`, { action: 'interrupt' });
  await request(`/api/agents/${successor.id}/action`, { action: 'stop' });
  check('stop completes before restart', () => {});
  assert.equal((await request(`/api/agents/${successor.id}/scrollback`)).live, false);
  const next = await request(`/api/agents/${successor.id}/handoff`, { runtime: 'codex', autoStart: false }, 201);
  check('reverse handoff to Codex preserves chain', () => assert.equal(next.continuedFromId, successor.id));

  const outside = path.join(scratch, 'repo-sibling'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.txt'), 'not in repo');
  await request(`/api/agents/${old.id}/file?path=${encodeURIComponent('../repo-sibling/private.txt')}`, undefined, 400);
  check('same-prefix sibling path cannot escape Files', () => {});
  fs.symlinkSync(outside, path.join(repo, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await request(`/api/agents/${old.id}/file?path=escape-link/private.txt`, undefined, 400);
  check('symlink escape refused', () => {});
  fs.unlinkSync(path.join(repo, 'escape-link'));
  await request('/api/agents', { name: 'Injected', task: 'no', cwd: repo }, 403, { origin: 'https://unrelated.example' });
  check('cross-origin process launch refused', () => {});
  const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://unrelated.example' });
  const denied = await new Promise(resolve => { evil.once('unexpected-response', (_, r) => { r.resume(); resolve(r.statusCode); }); evil.once('error', () => resolve('error')); evil.once('open', () => { evil.close(); resolve('opened'); }); });
  check('cross-origin WebSocket refused', () => assert.equal(denied, 403));
  const cli = spawn(process.execPath, [path.join(root, 'bin/cr.js'), 'wait', old.id, 'missing-agent', '--timeout', '1'], { env: { ...env, CR_URL: base }, stdio: 'pipe', windowsHide: true });
  const code = await new Promise(resolve => cli.on('exit', resolve));
  check('CLI wait refuses partially missing target set', () => assert.equal(code, 1));
  const w1 = await request('/api/agents', { name: 'Same name', task: 'work', role: 'worker', runtime: 'claude', worktree: { repo }, autoStart: false }, 201);
  const w2 = await request('/api/agents', { name: 'Same name', task: 'work', role: 'worker', runtime: 'claude', worktree: { repo }, autoStart: false }, 201);
  check('simultaneous worktree names remain unique', () => assert.notEqual(w1.cwd, w2.cwd));
  for (const socket of sockets) socket.close();
  await terminateServer(); await boot();
  const restored = (await request(`/api/agents/${next.id}`)).agent;
  check('restart persists hierarchy and recovery links', () => assert.equal(restored.continuedFromId, successor.id));
  check('restart persists reports', () => {});
  assert((await request(`/api/agents/${successor.id}/messages`)).some(m => m.text === 'New checkpoint'));
  console.log(`${count} lifecycle checks passed`);
} finally {
  for (const socket of sockets) socket.terminate();
  await terminateServer();
  // scratch is allocated above; never remove anything outside this directory.
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
