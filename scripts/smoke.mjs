#!/usr/bin/env node
/**
 * Offline smoke: boots the server on a scratch port with a scratch data dir, exercises the API
 * contract with an external agent (no CLI spawned, no tokens spent), and checks the static UI serves.
 * Exits non-zero on the first failed assertion.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A fixed port makes the project's own gate fail for anyone already using it.
const PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-smoke-'));
// Scratch copy of the runtime config, so the run also exercises CR_CONFIG_DIR (files it
// does not contain - pricing.json, protocol.md - still fall back to the repo's config/).
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtimes.json'), 'utf8'));
cfg.dataDir = dataDir; cfg.port = PORT;
fs.writeFileSync(path.join(dataDir, 'runtimes.json'), JSON.stringify(cfg, null, 2));

const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, CR_PORT: String(PORT), CR_DATA_DIR: dataDir, CR_CONFIG_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function check(name, ok, extra = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; }

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ } }
  check('server boots', up, out.trim().split('\n').pop());
  if (!up) throw new Error('server did not come up');

  const html = await (await fetch(`${base}/`)).text();
  check('UI index served', /<title>/i.test(html));
  check('xterm vendor served', (await fetch(`${base}/vendor/xterm/xterm.js`)).ok);

  const mk = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ext', role: 'cto', runtime: 'external', task: 't', cwd: ROOT }) });
  const a = await mk.json();
  check('create external agent', mk.status === 201 && a.id, a.id);

  const bad = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', role: 'worker', runtime: 'deepseek', task: 't', cwd: path.join(ROOT, 'does-not-exist') }) });
  check('refuses missing cwd (failure path fires)', bad.status === 500 && /does not exist/.test((await bad.json()).error));

  const st = await fetch(`${base}/api/agents/${a.id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'blocked', note: 'q?' }) });
  check('status blocked', (await st.json()).status === 'blocked');

  const ctl = await fetch(`${base}/api/agents/${a.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ holder: 'human' }) });
  check('take control', (await ctl.json()).controlledBy === 'human');

  const send = await fetch(`${base}/api/agents/${a.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sender': 'agent:zzz' }, body: JSON.stringify({ text: 'hi' }) });
  check('parent send refused while human holds control', send.status === 409);

  const state = await (await fetch(`${base}/api/state`)).json();
  check('state has usage summary', state.usage && state.usage.counts.blocked === 1);
  check('config served (runtimes from CR_CONFIG_DIR, pricing from the repo fallback)', !!state.config?.runtimes?.claude && !!state.config?.pricing?.models);

  const diff = await (await fetch(`${base}/api/agents/${a.id}/diff`)).json();
  check('diff endpoint answers', typeof diff.diff === 'string');
  const files = await (await fetch(`${base}/api/agents/${a.id}/files`)).json();
  check('files endpoint lists tree', Array.isArray(files.tree) && files.tree.some(f => f.path === 'package.json'));
} catch (e) {
  check('smoke run', false, e.message);
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
process.exit(failed ? 1 : 0);
