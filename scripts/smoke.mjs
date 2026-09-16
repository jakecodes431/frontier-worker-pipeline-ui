#!/usr/bin/env node
/**
 * Offline smoke test — what `npm run check` actually checks.
 *
 * Boots a server on a scratch port with a scratch data dir, exercises the API
 * contract with external agents (no CLI is spawned, no tokens are spent), pokes
 * the failure paths on purpose, checks the usage arithmetic adds up, and runs
 * the pure UI modules (format/store/thread merging) in Node.
 *
 * Exits non-zero on the first failed assertion. Anything this file asserts is a
 * promise the code has to keep.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A fixed port makes the project's own gate fail for anyone already using it,
// so take a free one from the OS unless the operator pinned one.
const PORT = Number(process.env.CR_SMOKE_PORT) || await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-smoke-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-work-'));

// Scratch copy of the runtime config, so the run also exercises CR_CONFIG_DIR
// (files it does not contain - pricing.json, protocol.md - must still fall back
// to the repo's config/).
const scratchCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtimes.json'), 'utf8'));
scratchCfg.dataDir = dataDir;
scratchCfg.port = PORT;
fs.writeFileSync(path.join(dataDir, 'runtimes.json'), JSON.stringify(scratchCfg, null, 2));

// Set BEFORE anything imports server/config.js: this process must never open
// the real database, only the scratch one it just made.
process.env.CR_DATA_DIR = dataDir;
process.env.CR_CONFIG_DIR = dataDir;

let failed = 0;
let checks = 0;
function check(name, ok, extra = '') {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// 1. Static analysis: every shipped JS file parses, and none of them hard-code
//    someone's home directory (this repo is meant to run on other machines).
// ---------------------------------------------------------------------------
const SOURCE_DIRS = ['server', 'ui', 'bin', 'scripts', 'config', 'docs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.worktrees', '.claude']);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const sourceFiles = SOURCE_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
  .concat([path.join(ROOT, 'package.json')])
  .filter((file) => fs.existsSync(file));

// Docs are allowed to SHOW a path in an example; code is not allowed to depend
// on one. `~/…` is fine anywhere — it is expanded at runtime.
const HOME_PATH = /(?:[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+)|(?:\/home\/[A-Za-z0-9._-]+)|(?:\/Users\/[A-Za-z0-9._-]+)/;
const offenders = [];
for (const file of sourceFiles) {
  if (!/\.(js|mjs|css|json|html)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (HOME_PATH.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
  });
}
check('no hard-coded home directories in shipped source', offenders.length === 0, offenders.slice(0, 5).join(' '));

// `npm run check` runs `node --check` over the two entry points; this covers
// every other shipped script, including the UI modules.
const { execFileSync } = await import('node:child_process');
const parseFailures = [];
for (const file of sourceFiles.filter((x) => /\.(js|mjs)$/.test(x))) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (e) { parseFailures.push(`${path.relative(ROOT, file)}: ${String(e.stderr || e.message).split('\n')[1] || ''}`); }
}
check('every shipped .js/.mjs file parses', parseFailures.length === 0, parseFailures.slice(0, 3).join(' | '));

// ---------------------------------------------------------------------------
// 2. Pure UI modules run in Node: formatting never produces NaN/undefined/
//    Invalid Date, and the tree/thread helpers survive hostile input.
// ---------------------------------------------------------------------------
const uiUrl = (rel) => pathToFileURL(path.join(ROOT, 'ui', rel)).href;
const f = await import(uiUrl('lib/format.js'));
const store = await import(uiUrl('lib/store.js'));
const cto = await import(uiUrl('views/cto.js')).catch((e) => ({ __error: e }));

const junk = [undefined, null, NaN, Infinity, -Infinity, '', 'abc', {}, []];
const formatted = [];
for (const v of junk) {
  formatted.push(f.usd(v), f.tokens(v), f.count(v), f.duration(v), f.bytes(v), f.clock(v), f.dateTime(v), f.truncate(v), f.compactJson(v));
}
const bad = formatted.filter((s) => /NaN|undefined|Invalid Date|\$NaN/.test(String(s)));
check('formatters never emit NaN / undefined / Invalid Date', bad.length === 0, bad.slice(0, 3).join(' | '));
check('usd formats real money', f.usd(0) === '$0.00' && f.usd(1234.5) === '$1,234.50' && f.usd(0.0004) === '$0.0004');
check('tokens formats magnitudes', f.tokens(0) === '0' && f.tokens(1500) === '1.5k' && f.tokens(52_005_330) === '52M');
check('duration formats magnitudes', f.duration(0) === '0s' && f.duration(61) === '1m 01s' && f.duration(3661) === '1h 01m 01s');

// ---------------------------------------------------------------------------
// 2b. Portability: config values are written with ${VAR} / ${VAR:-fallback} /
//     ~ so the checkout runs on someone else's machine, and an unset default
//     drops its flag instead of emitting a dangling one.
// ---------------------------------------------------------------------------
const cfgMod = await import(pathToFileURL(path.join(ROOT, 'server', 'config.js')).href);
check('${VAR} expands from the environment', cfgMod.expandEnv('x/${CR_SMOKE_VAR}/y', { CR_SMOKE_VAR: 'here' }) === 'x/here/y');
check('${VAR:-fallback} uses the fallback when unset', cfgMod.expandEnv('${CR_SMOKE_UNSET:-plan-b}', {}) === 'plan-b');
check('${VAR} falls back to ENV_DEFAULTS', cfgMod.expandEnv('${DSH_HOME}', {}) === cfgMod.ENV_DEFAULTS.DSH_HOME);
check('a leading ~ expands to the home directory', cfgMod.expandHome('~/x') === path.join(os.homedir(), '/x'));
check('config is expanded recursively, not just at the top level',
  !JSON.stringify(cfgMod.config.runtimes).includes('${'), JSON.stringify(cfgMod.config.runtimes.deepseek.env));
check('comment keys starting with _ are left unexpanded',
  Array.isArray(cfgMod.config._readme) || typeof cfgMod.config.runtimes.claude._note === 'string');
check('the scratch CR_CONFIG_DIR copy is what was loaded', cfgMod.config.port === PORT, String(cfgMod.config.port));
check('pricing falls back to the repo config when CR_CONFIG_DIR lacks it', Boolean(cfgMod.pricing && cfgMod.pricing.models));

const { adapters } = await import(pathToFileURL(path.join(ROOT, 'server', 'adapters', 'index.js')).href);
const bare = { id: 'a-smoke', name: 'smoke', role: 'worker', prompt: 'hi', cwd: ROOT, parentId: null };
const builtArgs = adapters.claude.build(bare, PORT).args;
check('an unset model drops its --model flag rather than dangling',
  !builtArgs.includes('--model') && !builtArgs.includes('--effort') && !builtArgs.some((a) => /^\{.*\}$/.test(a)),
  builtArgs.join(' '));
check('a filled placeholder still reaches argv', builtArgs.includes('hi'), builtArgs.join(' '));

// treeOrder: cycles, orphans and self-parents must not hang or drop nodes.
const nasty = [
  { id: 'a', parentId: 'b', role: 'worker', createdAt: '2' },
  { id: 'b', parentId: 'a', role: 'worker', createdAt: '1' },
  { id: 'c', parentId: 'c', role: 'cto', createdAt: '0' },
  { id: 'd', parentId: 'ghost', role: 'orchestrator', createdAt: '3' },
];
const ordered = store.treeOrder(nasty);
check('treeOrder keeps every node exactly once (cycles, orphans, self-parents)',
  ordered.length === nasty.length && new Set(ordered.map((e) => e.agent.id)).size === nasty.length);

if (cto.__error) check('views/cto.js imports in Node', false, cto.__error.message);
else {
  const merged = cto.mergeThread(
    [{ role: 'assistant', text: 'hi', ts: '2026-09-15T10:00:00.000Z' }, { role: 'tool', name: 'Read', text: 'x', ts: null }],
    [{ id: 1, sender: 'human', text: 'yo', createdAt: '2026-09-15T10:00:01.000Z', direction: 'in' }],
  );
  check('mergeThread merges transcript + messages in order', merged.length === 3 && merged[merged.length - 1].text === 'yo');
  check('mergeThread tolerates null input', cto.mergeThread(null, null).length === 0);
  check('toolSummary never returns empty', Boolean(cto.toolSummary({ text: '', name: '' })));
}

// ---------------------------------------------------------------------------
// 3. The server: boot it on a scratch port with a scratch database.
// ---------------------------------------------------------------------------
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, CR_PORT: String(PORT), CR_DATA_DIR: dataDir, CR_CONFIG_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let childExit = null;
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
child.on('exit', (code) => { childExit = code; });

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (p) => (await fetch(base + p)).json();
const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

try {
  let up = false;
  for (let i = 0; i < 40 && !up && childExit === null; i++) {
    await sleep(250);
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
  }
  // If our server died (port already taken, most likely) we must not go on to
  // test whatever else is answering on that port and call it a pass.
  if (childExit !== null) {
    check('server boots on a scratch database', false, `the smoke server exited with code ${childExit} — is port ${PORT} free? (CR_SMOKE_PORT overrides it)`);
    throw new Error(`smoke server exited (${childExit})`);
  }
  check('server boots on a scratch database', up, out.trim().split('\n').pop());
  if (!up) throw new Error('server did not come up');

  // -- static UI ------------------------------------------------------------
  const html = await (await fetch(`${base}/`)).text();
  check('UI index served', /<title>Control Room<\/title>/i.test(html));
  check('UI ships the offline banner and skip link', html.includes('id="netbar"') && html.includes('skip-link'));
  check('xterm vendor served', (await fetch(`${base}/vendor/xterm/xterm.js`)).ok);
  const assets = ['app.js', 'styles.css', 'mock.js', 'lib/api.js', 'lib/dom.js', 'lib/format.js', 'lib/store.js', 'lib/ws.js',
    'views/dashboard.js', 'views/hierarchy.js', 'views/panel.js', 'views/newagent.js', 'views/cto.js',
    'views/tabs/chat.js', 'views/tabs/terminal.js', 'views/tabs/diff.js', 'views/tabs/files.js', 'views/tabs/logs.js'];
  const missingAssets = [];
  for (const asset of assets) {
    const r = await fetch(`${base}/${asset}`);
    if (!r.ok) missingAssets.push(`${asset} (${r.status})`);
  }
  check('every UI module the page imports is served', missingAssets.length === 0, missingAssets.join(' '));
  check('static traversal refused', (await fetch(`${base}/../package.json`)).status !== 200);
  const cached = await fetch(`${base}/app.js`);
  const tag = cached.headers.get('etag');
  const revalidated = await fetch(`${base}/app.js`, { headers: { 'if-none-match': tag || '' } });
  check('static files carry a validator so an edit is never served stale', Boolean(tag) && revalidated.status === 304);

  // -- first run ------------------------------------------------------------
  const empty = await getJson('/api/state');
  check('empty database reports an empty fleet', Array.isArray(empty.agents) && empty.agents.length === 0);
  check('empty database still reports a usage summary', Boolean(empty.usage && empty.usage.counts && empty.usage.spend));
  check('config exposes a default cwd for the New agent form', Boolean(empty.config && empty.config.defaultCwd));

  // -- validation: every bad input is a 400 with a human message -------------
  const badCases = [
    ['no name', { task: 't', cwd: ROOT }, /name is required/],
    ['no task', { name: 'n', cwd: ROOT }, /task is required/],
    ['no cwd', { name: 'n', task: 't' }, /cwd or worktree\.repo is required/],
    ['missing cwd', { name: 'n', task: 't', cwd: path.join(ROOT, 'does-not-exist') }, /does not exist/],
    ['unknown runtime', { name: 'n', task: 't', cwd: ROOT, runtime: 'nope' }, /unknown runtime/],
    ['unknown role', { name: 'n', task: 't', cwd: ROOT, role: 'ceo' }, /unknown role/],
    ['name too long', { name: 'x'.repeat(500), task: 't', cwd: ROOT }, /too long/],
    ['unknown parent', { name: 'n', task: 't', cwd: ROOT, parentId: 'a-nope' }, /not found/],
  ];
  for (const [label, body, re] of badCases) {
    const r = await post('/api/agents', body);
    const j = await r.json();
    check(`rejects ${label} with 400 + message`, r.status === 400 && re.test(j.error || ''), `${r.status} ${j.error}`);
  }
  const malformed = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  check('malformed JSON body is a 400, not a stack trace', malformed.status === 400 && /valid JSON/.test((await malformed.json()).error));

  // -- create ---------------------------------------------------------------
  const mk = await post('/api/agents', { name: 'ext cto', role: 'cto', runtime: 'external', task: 'own it', cwd: ROOT });
  const a = await mk.json();
  check('create external agent', mk.status === 201 && Boolean(a.id), a.id);
  check('agent record reports whether its cwd exists', a.cwdExists === true);

  const kid = await (await post('/api/agents', {
    name: 'child in a folder that will vanish', role: 'worker', runtime: 'external',
    parentId: a.id, task: 'vanish', cwd: workDir,
  })).json();
  check('create child agent under a parent', kid.parentId === a.id);

  // -- a node whose cwd no longer exists ------------------------------------
  fs.rmSync(workDir, { recursive: true, force: true });
  await sleep(5200); // let the refresh loop and the existence cache turn over
  const gone = (await getJson('/api/agents')).find((x) => x.id === kid.id);
  check('a deleted working directory is reported as missing', gone.cwdExists === false);
  const goneFiles = await getJson(`/api/agents/${kid.id}/files`);
  check('files endpoint explains a missing directory', goneFiles.missing === true && /no longer exists/.test(goneFiles.message || ''));
  const goneDiff = await getJson(`/api/agents/${kid.id}/diff`);
  check('diff endpoint explains a missing directory', goneDiff.missing === true && typeof goneDiff.diff === 'string');
  const goneFile = await fetch(`${base}/api/agents/${kid.id}/file?path=README.md`);
  check('file read in a missing directory is 404 with a message', goneFile.status === 404 && /no longer exists/.test((await goneFile.json()).error));

  // -- an agent with no transcript -----------------------------------------
  const chat = await getJson(`/api/agents/${kid.id}/chat`);
  check('an agent with no transcript returns an empty thread, not an error', Array.isArray(chat.messages) && chat.messages.length === 0);
  const scroll = await getJson(`/api/agents/${kid.id}/scrollback`);
  check('scrollback for an agent that never ran is empty and not live', scroll.data === '' && scroll.live === false);
  const logs = await getJson(`/api/agents/${kid.id}/logs`);
  check('logs endpoint returns the event list', Array.isArray(logs) && logs.length > 0);

  // -- lifecycle ------------------------------------------------------------
  const st = await (await post(`/api/agents/${a.id}/status`, { status: 'blocked', note: 'which branch?' })).json();
  check('status blocked', st.status === 'blocked' && st.note === 'which branch?');
  const badStatus = await post(`/api/agents/${a.id}/status`, { status: 'confused' });
  check('unknown status refused with the allowed list', badStatus.status === 400 && /one of/.test((await badStatus.json()).error));

  const ctl = await (await post(`/api/agents/${a.id}/control`, { holder: 'human' })).json();
  check('take control', ctl.controlledBy === 'human');
  const send = await post(`/api/agents/${a.id}/send`, { text: 'hi' }, { 'x-sender': 'agent:zzz' });
  check('parent send refused while a human holds control', send.status === 409);
  const emptySend = await post(`/api/agents/${a.id}/send`, { text: '   ' });
  check('empty message refused with 400', emptySend.status === 400);
  const queued = await (await post(`/api/agents/${a.id}/send`, { text: 'from the operator' })).json();
  check('external agent send is queued to its inbox', queued.queued === true && Boolean(queued.message));
  const msgs = await getJson(`/api/agents/${a.id}/messages`);
  check('messages endpoint returns what was queued', Array.isArray(msgs) && msgs.some((m) => m.text === 'from the operator'));

  const noTerm = await post(`/api/agents/${kid.id}/input`, { data: 'x' });
  check('typing into an agent with no terminal is 409 with a reason', noTerm.status === 409 && /no live terminal/.test((await noTerm.json()).error));
  const badAction = await post(`/api/agents/${a.id}/action`, { action: 'explode' });
  check('unknown action refused', badAction.status === 400);
  const missing404 = await fetch(`${base}/api/agents/a-does-not-exist`);
  check('unknown agent is 404 with a message', missing404.status === 404 && /not found/.test((await missing404.json()).error));

  // -- usage arithmetic -----------------------------------------------------
  const state = await getJson('/api/state');
  const u = state.usage;
  const sum = (key) => state.agents.reduce((n, x) => n + ((x.usage && x.usage[key]) || 0), 0);
  const tierOf = (x) => (x.runtime === 'deepseek' ? 'deepseek' : x.role === 'cto' ? 'cto' : x.role === 'orchestrator' ? 'orchestrator' : 'other');

  check('counts add up to the number of agents',
    ['running', 'queued', 'idle', 'paused', 'stopping', 'blocked', 'done', 'failed', 'stopped', 'unknown']
      .reduce((n, k) => n + (u.counts[k] || 0), 0) === state.agents.length && u.counts.total === state.agents.length,
    JSON.stringify(u.counts));

  const tierTokens = {};
  const tierCounts = {};
  for (const x of state.agents) {
    const t = tierOf(x);
    tierTokens[t] = (tierTokens[t] || 0) + ((x.usage && x.usage.totalTokens) || 0);
    tierCounts[t] = (tierCounts[t] || 0) + 1;
  }
  const tiersMatch = Object.keys(u.byTier).every((k) => (u.byTier[k].totalTokens || 0) === (tierTokens[k] || 0));
  check('per-tier tokens equal the sum of that tier\'s agents', tiersMatch, JSON.stringify(tierTokens));
  check('per-tier agent counts equal the number of agents in each tier',
    Object.keys(u.byTierAgents).every((k) => (u.byTierAgents[k] || 0) === (tierCounts[k] || 0)) &&
    Object.values(u.byTierAgents).reduce((n, v) => n + v, 0) === state.agents.length,
    JSON.stringify(u.byTierAgents));
  check('tier totals equal the fleet token total',
    Object.values(u.byTier).reduce((n, t) => n + (t.totalTokens || 0), 0) === u.tokens.total &&
    u.tokens.total === sum('totalTokens'));
  check('an agent with an unusual role lands in a tier rather than vanishing',
    Object.keys(u.byTier).includes('other') && u.byTierAgents.other >= 0);
  check('savings state their basis and their estimate flag',
    u.savings.estimated === true && typeof u.savings.basis === 'string' && u.savings.basis.length > 20);
  check('savings are the difference between the two sides',
    Math.abs((u.savings.fableEquivalentUsd - u.savings.deepseekActualUsd) - u.savings.savedUsd) < 1e-9);
  check('spend windows name the local days they cover',
    /^\d{4}-\d{2}-\d{2}$/.test(u.spendWindows.today) && u.spendWindows.monthFrom.endsWith('-01'));
  check('current run states what it sums', typeof u.currentRun.basis === 'string' && u.currentRun.basis.length > 10);

  // Spend is banked on the day it is observed, as a delta, and does not
  // double-count when the same cumulative figure is recorded twice.
  const { usageSamples } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')).href)
    .catch(() => ({ usageSamples: null }));
  if (usageSamples) {
    const day = new Date();
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const id = 'smoke-usage';
    usageSamples.forget(id);
    const before = usageSamples.spendSince(key);
    usageSamples.record(id, 'm', key, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }, 1.0);
    usageSamples.record(id, 'm', key, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }, 1.0);
    const once = usageSamples.spendSince(key) - before;
    usageSamples.record(id, 'm', key, { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 }, 2.5);
    const grown = usageSamples.spendSince(key) - before;
    usageSamples.record(id, 'm', key, { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, 0.25);
    const afterRestart = usageSamples.spendSince(key) - before;
    usageSamples.forget(id);
    check('recording the same cumulative usage twice does not double-count', Math.abs(once - 1.0) < 1e-9, String(once));
    check('growing cumulative usage banks only the increment', Math.abs(grown - 2.5) < 1e-9, String(grown));
    check('a restarted session (usage resets) banks its new usage', Math.abs(afterRestart - 2.75) < 1e-9, String(afterRestart));
  } else {
    check('usage sample arithmetic is testable', false, 'could not import server/db.js');
  }

  // -- worktree / git helpers ----------------------------------------------
  const diff = await getJson(`/api/agents/${a.id}/diff`);
  check('diff endpoint answers for a real repo', typeof diff.diff === 'string' && typeof diff.stat === 'string');
  const files = await getJson(`/api/agents/${a.id}/files`);
  check('files endpoint lists the tree', Array.isArray(files.tree) && files.tree.some((x) => x.path === 'package.json'));
  const escape = await fetch(`${base}/api/agents/${a.id}/file?path=${encodeURIComponent('../../../../etc/passwd')}`);
  check('file read cannot escape the agent directory', escape.status === 400 || escape.status === 404);

  // -- deletion -------------------------------------------------------------
  const grandchild = await (await post('/api/agents', {
    name: 'grandchild', role: 'worker', runtime: 'external', parentId: kid.id, task: 'be re-parented', cwd: ROOT,
  })).json();
  const del = await fetch(`${base}/api/agents/${kid.id}`, { method: 'DELETE' });
  check('delete an agent that has no live terminal', del.status === 200);
  const after = await getJson('/api/state');
  check('deleted agent leaves the fleet', !after.agents.some((x) => x.id === kid.id));
  const moved = after.agents.find((x) => x.id === grandchild.id);
  check('children of a deleted agent are re-parented, not orphaned', Boolean(moved) && moved.parentId === a.id, moved && moved.parentId);
  check('the fleet is exactly what was created', after.agents.length === 2, String(after.agents.length));

  // -- websocket ------------------------------------------------------------
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no state frame in 4s')), 4000);
    ws.on('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw)); });
    ws.on('error', reject);
  }).catch((e) => ({ __error: e.message }));
  check('websocket sends a state frame on connect', frame && frame.type === 'state' && Array.isArray(frame.agents), frame && frame.__error);
  const ptyFrame = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    ws.on('message', (raw) => {
      const fr = JSON.parse(raw);
      if (fr.type === 'pty') { clearTimeout(timer); resolve(fr); }
    });
    ws.send(JSON.stringify({ type: 'attach', id: a.id }));
  });
  check('attaching to an agent with no pty answers with live:false', Boolean(ptyFrame) && ptyFrame.live === false);
  ws.close();

  check('server logged no unexpected errors', !/Error:|TypeError|ReferenceError/.test(out), out.slice(-200));
} catch (e) {
  check('smoke run', false, e.message);
} finally {
  child.kill();
  await sleep(300);
  for (const d of [dataDir, workDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
}

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
