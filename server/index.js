/**
 * Control Room server: HTTP API + WebSocket + static UI. See docs/API.md.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config, ROOT, publicConfig, pricing, costOf } from './config.js';
import { agents, messages, events, usageSamples, emptyUsage } from './db.js';
import { PtyManager } from './pty.js';
import { adapters, stageBrief } from './adapters/index.js';
import * as git from './git.js';
import { execFileSync } from 'node:child_process';

/** Resolve a bare command name to an executable path (ConPTY wants a real file). */
function resolveCommand(cmd) {
  if (/[\\/]/.test(cmd) || path.isAbsolute(cmd)) return cmd;
  try {
    const out = process.platform === 'win32' ? execFileSync('where', [cmd], { encoding: 'utf8' }) : execFileSync('which', [cmd], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const first = lines.find(l => process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(l)) || lines[0];
    return first || cmd;
  } catch { return cmd; }
}

const PORT = Number(process.env.CR_PORT || config.port || 4800);
const HOST = process.env.CR_HOST || config.host || '127.0.0.1';
const TERMINAL = new Set(['done', 'failed', 'stopped']);

const ptys = new PtyManager();
const wss = new WebSocketServer({ noServer: true });
const attachments = new Map(); // ws -> Set(agentId)

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const newId = (role) => `a-${nowIso().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 8e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function broadcast(frame) {
  const s = JSON.stringify(frame);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

function log(agentId, kind, data) {
  const ev = events.add(agentId, kind, data);
  broadcast({ type: 'event', event: ev });
  return ev;
}

function pushAgent(id) {
  const a = agents.get(id);
  if (a) broadcast({ type: 'agent', agent: a });
  return a;
}

function pushState() {
  broadcast({ type: 'state', agents: agents.all(), usage: usageSummary() });
}

// ----------------------------------------------------------------------------
// spawning
// ----------------------------------------------------------------------------
function spawnAgent(agent, { resume = false } = {}) {
  const ad = adapters[agent.runtime];
  if (!ad) throw new Error(`unknown runtime ${agent.runtime}`);
  const { command, args, env } = ad.build(agent, PORT, { resume });
  if (!fs.existsSync(agent.cwd)) throw new Error(`cwd does not exist: ${agent.cwd}`);
  const { pid } = ptys.spawn(agent.id, { command: resolveCommand(command), args, cwd: agent.cwd, env });
  agents.update(agent.id, { pid, status: 'running', startedAt: agent.startedAt && resume ? agent.startedAt : nowIso(), endedAt: null, exitCode: null });
  log(agent.id, resume ? 'resumed' : 'spawned', { command, args: args.map(a => (a.length > 200 ? a.slice(0, 200) + '…' : a)), cwd: agent.cwd, pid });
  return pushAgent(agent.id);
}

async function createAgent(body) {
  const role = body.role || 'worker';
  const runtime = body.runtime || (role === 'worker' ? 'deepseek' : 'claude');
  const rt = config.runtimes[runtime];
  if (!rt) throw new Error(`unknown runtime ${runtime}`);
  if (!body.name) throw new Error('name is required');
  if (!body.task) throw new Error('task is required');
  if (body.parentId && !agents.get(body.parentId)) throw new Error(`parent ${body.parentId} not found`);

  const id = body.id || newId(role);
  let cwd = body.cwd ? path.resolve(body.cwd) : null;
  let worktree = null;
  if (body.worktree?.repo) {
    worktree = git.createWorktree(body.worktree.repo, body.name, body.worktree.branch, body.worktree.base);
    cwd = worktree.path;
  }
  if (!cwd) throw new Error('cwd or worktree.repo is required');
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

  const base = {
    id, parentId: body.parentId || null, name: body.name, role, runtime,
    model: body.model || rt.defaults?.model, effort: body.effort || rt.defaults?.effort,
    permissionMode: body.permissionMode || rt.defaults?.permissionMode,
    status: runtime === 'external' ? (body.status || 'running') : 'queued',
    task: body.task, note: body.note || null, cwd, worktree,
    sessionId: runtime === 'claude' ? crypto.randomUUID() : (body.sessionId || null),
  };
  let prompt = null, briefPath = null;
  if (runtime !== 'external') ({ prompt, briefPath } = stageBrief(base, body.brief));
  const agent = agents.create({ ...base, prompt, briefPath });
  log(id, 'created', { role, runtime, model: agent.model, parentId: agent.parentId, worktree });
  if (runtime !== 'external' && body.autoStart !== false) {
    try { spawnAgent(agent); }
    catch (e) { agents.update(id, { status: 'failed', note: `spawn failed: ${e.message}`, endedAt: nowIso() }); log(id, 'error', e.message); pushState(); throw e; }
  }
  if (runtime === 'external') agents.update(id, { startedAt: nowIso() });
  pushState();
  return agents.get(id);
}

ptys.on('data', (id, data) => {
  const s = JSON.stringify({ type: 'pty', id, data });
  for (const [ws, set] of attachments) if (set.has(id) && ws.readyState === 1) ws.send(s);
  const a = agents.get(id);
  if (a && a.status === 'idle') { agents.update(id, { status: 'running' }); pushAgent(id); }
});

ptys.on('exit', (id, { exitCode }) => {
  const a = agents.get(id);
  if (!a) return;
  const ad = adapters[a.runtime];
  let status;
  if (a.status === 'done' || a.status === 'failed') status = a.status;
  else if (ad?.oneShot) status = exitCode === 0 ? 'done' : 'failed';
  else status = a.status === 'stopping' ? 'stopped' : (exitCode === 0 ? 'done' : 'stopped');
  const result = ad?.result?.(a, ptys.scrollback(id)) || a.result;
  agents.update(id, { status, endedAt: nowIso(), exitCode, pid: null, result });
  log(id, 'exit', { exitCode, status });
  refreshUsage(id);
  if (a.parentId) {
    messages.add({ agentId: a.parentId, fromAgentId: id, direction: 'report', sender: 'system', text: `${a.name} (${id}) exited with code ${exitCode}; status ${status}.` });
  }
  pushState();
});

// ----------------------------------------------------------------------------
// usage / status refresh
// ----------------------------------------------------------------------------
function refreshUsage(id) {
  const a = agents.get(id);
  if (!a) return;
  const ad = adapters[a.runtime];
  let r = null;
  try { r = ad?.usage?.(a); } catch (e) { log(id, 'usage-error', String(e.message)); }
  if (!r) return;
  const patch = { usage: r.usage };
  if (r.sessionId && !a.sessionId) patch.sessionId = r.sessionId;
  // Claude idle detection: process alive, nothing on the pty for a while, last transcript entry is an assistant end_turn.
  if (a.runtime === 'claude' && ptys.has(id) && a.status === 'running') {
    const silence = Date.now() - (ptys.lastOutputAt(id) || 0);
    if (silence > (config.runtimes.claude.idleAfterSilenceMs || 20000) && r.lastRole === 'assistant' && r.lastStop === 'end_turn') patch.status = 'idle';
  }
  agents.update(id, patch);
  const day = (a.startedAt || a.createdAt || nowIso()).slice(0, 10);
  for (const [model, b] of Object.entries(r.byModel || {})) usageSamples.upsert(id, model, day, b, b.costUsd);
}

function refreshAll() {
  for (const a of agents.all()) {
    if (a.runtime === 'external' || !TERMINAL.has(a.status) || a.usage.totalTokens === 0) refreshUsage(a.id);
    // A process we think is running but which is gone (e.g. server restarted) gets marked stopped.
    if (a.pid && !ptys.has(a.id) && !TERMINAL.has(a.status) && !git.pidAlive(a.pid)) {
      agents.update(a.id, { status: 'stopped', endedAt: nowIso(), pid: null, note: a.note || 'process not running (control room restarted?) — use Restart to resume' });
      log(a.id, 'lost', 'process not found');
    }
  }
}

function usageSummary() {
  const all = agents.all();
  const tiers = { cto: emptyUsage(), orchestrator: emptyUsage(), deepseek: emptyUsage(), other: emptyUsage() };
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  const counts = { active: 0, idle: 0, done: 0, blocked: 0, failed: 0, stopped: 0, queued: 0 };
  let dsActual = 0, dsFable = 0, runCost = 0, runStart = null;
  for (const a of all) {
    const u = a.usage || emptyUsage();
    const tier = a.runtime === 'deepseek' ? 'deepseek' : a.role === 'cto' ? 'cto' : a.role === 'orchestrator' ? 'orchestrator' : 'other';
    for (const k of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'costUsd', 'fableEquivalentUsd']) tiers[tier][k] += u[k] || 0;
    tokens.input += u.inputTokens || 0; tokens.cacheRead += u.cacheReadTokens || 0; tokens.cacheWrite += u.cacheWriteTokens || 0; tokens.output += u.outputTokens || 0;
    if (a.runtime === 'deepseek') { dsActual += u.costUsd || 0; dsFable += u.fableEquivalentUsd || 0; }
    if (a.status === 'running') counts.active++;
    else if (counts[a.status] !== undefined) counts[a.status]++;
    if (!TERMINAL.has(a.status)) { runCost += u.costUsd || 0; if (a.startedAt && (!runStart || a.startedAt < runStart)) runStart = a.startedAt; }
  }
  tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  const d = new Date();
  const today = d.toISOString().slice(0, 10);
  const week = new Date(d.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const month = today.slice(0, 8) + '01';
  return {
    spend: { today: usageSamples.spendSince(today), week: usageSamples.spendSince(week), month: usageSamples.spendSince(month) },
    currentRun: { costUsd: runCost, startedAt: runStart },
    byTier: tiers,
    counts,
    tokens,
    limits: { claude: null, deepseek: null },
    savings: { deepseekActualUsd: dsActual, fableEquivalentUsd: dsFable, savedUsd: dsFable - dsActual, estimated: true, basis: `DeepSeek usage re-priced at ${pricing.fableEquivalentModel} (estimated price sheet in config/pricing.json)` },
    pricing,
  };
}

// ----------------------------------------------------------------------------
// static files
// ----------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json' };
const VENDOR = {
  '/vendor/xterm/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/xterm-addon-fit/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};

function serveStatic(req, res, urlPath) {
  let file;
  if (VENDOR[urlPath]) file = path.join(ROOT, VENDOR[urlPath]);
  else {
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    file = path.join(ROOT, 'ui', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'ui'))) { res.writeHead(403); return res.end(); }
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ----------------------------------------------------------------------------
// API routes
// ----------------------------------------------------------------------------
function senderOf(req) { return req.headers['x-sender'] || 'human'; }

function requireAgent(id) {
  const a = agents.get(id);
  if (!a) { const e = new Error(`agent ${id} not found`); e.code = 404; throw e; }
  return a;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (parts[1] === 'state' && m === 'GET') return json(res, 200, { agents: agents.all(), usage: usageSummary(), config: publicConfig() });
  if (parts[1] === 'usage' && m === 'GET') return json(res, 200, usageSummary());
  if (parts[1] === 'health') return json(res, 200, { ok: true, port: PORT, agents: agents.all().length });

  if (parts[1] === 'agents') {
    if (parts.length === 2 && m === 'GET') return json(res, 200, agents.all());
    if (parts.length === 2 && m === 'POST') return json(res, 201, await createAgent(await readBody(req)));

    const id = parts[2];
    const sub = parts[3];
    const a = requireAgent(id);

    if (!sub && m === 'GET') {
      refreshUsage(id);
      return json(res, 200, { agent: agents.get(id), messages: messages.list(id), events: events.list(id, 200), children: agents.children(id) });
    }
    if (!sub && m === 'DELETE') {
      if (ptys.has(id)) return json(res, 409, { error: 'agent is running; stop it first' });
      for (const c of agents.children(id)) agents.update(c.id, { parentId: a.parentId });
      agents.delete(id); pushState();
      return json(res, 200, { ok: true });
    }
    const body = m === 'POST' ? await readBody(req) : {};

    if (sub === 'send' && m === 'POST') {
      const sender = senderOf(req);
      if (a.controlledBy === 'human' && sender !== 'human') return json(res, 409, { error: 'a human holds control of this agent; message queued to its inbox instead', queued: true, message: messages.add({ agentId: id, fromAgentId: sender.replace(/^agent:/, ''), direction: 'in', sender, text: body.text }) });
      if (a.status === 'paused' && sender !== 'human') return json(res, 409, { error: 'agent is paused' });
      if (a.runtime === 'external') {
        // No terminal to type into: queue the message in the agent's inbox so the session picks it up on its next inbox check.
        const msg = messages.add({ agentId: id, fromAgentId: sender.startsWith('agent:') ? sender.slice(6) : null, direction: 'report', sender, text: String(body.text ?? '') });
        broadcast({ type: 'message', message: msg });
        log(id, 'send', { sender, chars: String(body.text ?? '').length, queued: true });
        return json(res, 200, { ok: true, queued: true, message: msg });
      }
      if (!ptys.has(id)) return json(res, 409, { error: 'agent has no live terminal' });
      const text = String(body.text ?? '');
      ptys.write(id, text);
      // Claude Code's prompt submits on Enter; give the TUI a beat to ingest a paste before submitting.
      setTimeout(() => { try { ptys.write(id, '\r'); } catch { /* exited */ } }, text.length > 200 ? 400 : 120);
      messages.add({ agentId: id, fromAgentId: sender.startsWith('agent:') ? sender.slice(6) : null, direction: 'in', sender, text });
      log(id, 'send', { sender, chars: text.length });
      if (a.status === 'idle') { agents.update(id, { status: 'running' }); pushAgent(id); }
      return json(res, 200, { ok: true });
    }
    if (sub === 'input' && m === 'POST') {
      if (!ptys.has(id)) return json(res, 409, { error: 'agent has no live terminal' });
      ptys.write(id, String(body.data ?? ''));
      return json(res, 200, { ok: true });
    }
    if (sub === 'control' && m === 'POST') {
      const holder = body.holder === 'human' ? 'human' : 'parent';
      agents.update(id, { controlledBy: holder });
      log(id, 'control', { holder });
      return json(res, 200, pushAgent(id));
    }
    if (sub === 'action' && m === 'POST') {
      const action = body.action;
      if (action === 'stop') {
        if (ptys.has(id)) { agents.update(id, { status: 'stopping' }); ptys.kill(id); await git.killTree(a.pid); }
        else agents.update(id, { status: 'stopped', endedAt: a.endedAt || nowIso(), pid: null });
        log(id, 'action', 'stop');
      } else if (action === 'restart') {
        if (ptys.has(id)) { ptys.kill(id); await git.killTree(a.pid); await new Promise(r => setTimeout(r, 500)); }
        const resume = a.runtime === 'claude' && !!a.sessionId;
        spawnAgent(agents.get(id), { resume });
      } else if (action === 'interrupt') {
        if (ptys.has(id)) ptys.write(id, '\x1b');
        log(id, 'action', 'interrupt');
      } else if (action === 'pause') {
        // Windows has no SIGSTOP; pause = interrupt the current turn and refuse parent input until resumed.
        if (ptys.has(id)) ptys.write(id, '\x1b');
        agents.update(id, { status: 'paused' });
        log(id, 'action', 'pause');
      } else if (action === 'resume') {
        if (a.status === 'paused') agents.update(id, { status: ptys.has(id) ? 'running' : 'stopped' });
        log(id, 'action', 'resume');
      } else return json(res, 400, { error: `unknown action ${action}` });
      pushState();
      return json(res, 200, agents.get(id));
    }
    if (sub === 'status' && m === 'POST') {
      const allowed = ['done', 'blocked', 'failed', 'running', 'idle'];
      if (!allowed.includes(body.status)) return json(res, 400, { error: `status must be one of ${allowed.join(', ')}` });
      agents.update(id, { status: body.status, note: body.note ?? a.note, endedAt: ['done', 'failed'].includes(body.status) && !ptys.has(id) ? nowIso() : a.endedAt });
      log(id, 'status', { status: body.status, note: body.note, by: senderOf(req) });
      if (a.parentId && body.status === 'blocked') messages.add({ agentId: a.parentId, fromAgentId: id, direction: 'report', sender: `agent:${id}`, text: `BLOCKED: ${body.note || '(no question given)'}` });
      pushState();
      return json(res, 200, agents.get(id));
    }
    if (sub === 'report' && m === 'POST') {
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'text required' });
      messages.add({ agentId: id, fromAgentId: null, direction: 'report', sender: `agent:${id}`, text });
      if (a.parentId) {
        const msg = messages.add({ agentId: a.parentId, fromAgentId: id, direction: 'report', sender: `agent:${id}`, text });
        broadcast({ type: 'message', message: msg });
      }
      log(id, 'report', { chars: text.length });
      return json(res, 200, { ok: true });
    }
    if (sub === 'inbox' && m === 'GET') return json(res, 200, messages.inbox(id, url.searchParams.get('ack') === '1'));
    if (sub === 'chat' && m === 'GET') {
      const ad = adapters[a.runtime];
      return json(res, 200, { messages: ad?.chat?.(a, ptys.scrollback(id)) || [] });
    }
    if (sub === 'result' && m === 'GET') return json(res, 200, { result: adapters[a.runtime]?.result?.(a, ptys.scrollback(id)) ?? a.result ?? null, status: a.status });
    if (sub === 'diff' && m === 'GET') return json(res, 200, { ...git.diff(a.cwd), log: git.commitLog(a.cwd) });
    if (sub === 'files' && m === 'GET') return json(res, 200, git.files(a.cwd));
    if (sub === 'file' && m === 'GET') return json(res, 200, git.readFile(a.cwd, url.searchParams.get('path') || ''));
    if (sub === 'logs' && m === 'GET') return json(res, 200, events.list(id, 1000));
    if (sub === 'scrollback' && m === 'GET') return json(res, 200, { data: ptys.scrollback(id), live: ptys.has(id) });
    if (sub === 'messages' && m === 'GET') return json(res, 200, messages.list(id));
  }
  json(res, 404, { error: `no route ${m} ${url.pathname}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    json(res, e.code === 404 ? 404 : 500, { error: e.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  attachments.set(ws, new Set());
  ws.send(JSON.stringify({ type: 'state', agents: agents.all(), usage: usageSummary() }));
  ws.on('message', raw => {
    let f; try { f = JSON.parse(raw); } catch { return; }
    const set = attachments.get(ws);
    if (f.type === 'attach' && f.id) {
      set.add(f.id);
      ws.send(JSON.stringify({ type: 'pty', id: f.id, data: ptys.scrollback(f.id), scrollback: true, live: ptys.has(f.id) }));
    } else if (f.type === 'detach') set.delete(f.id);
    else if (f.type === 'input' && f.id) { try { ptys.write(f.id, String(f.data ?? '')); } catch { /* no pty */ } }
    else if (f.type === 'resize' && f.id) ptys.resize(f.id, f.cols, f.rows);
  });
  ws.on('close', () => attachments.delete(ws));
});

setInterval(() => { try { refreshAll(); broadcast({ type: 'state', agents: agents.all(), usage: usageSummary() }); } catch (e) { console.error('refresh', e); } }, 5000);

server.listen(PORT, HOST, () => {
  refreshAll();
  console.log(`control room  http://${HOST}:${PORT}  (agents: ${agents.all().length})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('control room shutting down; agent processes are left running and will be re-attached as stopped'); process.exit(0); });
