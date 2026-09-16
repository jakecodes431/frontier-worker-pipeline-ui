/**
 * Control Room server: HTTP API + WebSocket + static UI. See docs/API.md.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config, ROOT, publicConfig, pricing, localDay } from './config.js';
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

/** First meaningful line of a multi-line tool error, for a one-line API message. */
function firstLine(text, max = 300) {
  const s = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || 'unknown error';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A user-fixable input problem: answered as 400 with the message, never a stack. */
function badRequest(message) {
  const e = new Error(message);
  e.code = 400;
  return e;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const BODY_MAX = 8e6;

/**
 * Read a JSON body.
 *
 * Chunks are kept as Buffers and decoded once: concatenating them as strings
 * corrupts any multi-byte character that happens to straddle a chunk boundary,
 * which is exactly what a long brief full of em dashes does.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > BODY_MAX) { reject(badRequest(`request body is too large (over ${Math.round(BODY_MAX / 1e6)}MB)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(badRequest(`request body is not valid JSON: ${e.message}`)); }
    });
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
  if (!agent.cwd || !fs.existsSync(agent.cwd)) throw badRequest(`working directory no longer exists: ${agent.cwd || '(none)'}`);
  const { command, args, env } = ad.build(agent, PORT, { resume });
  const { pid } = ptys.spawn(agent.id, { command: resolveCommand(command), args, cwd: agent.cwd, env });
  agents.update(agent.id, { pid, status: 'running', startedAt: agent.startedAt && resume ? agent.startedAt : nowIso(), endedAt: null, exitCode: null });
  log(agent.id, resume ? 'resumed' : 'spawned', { command, args: args.map(a => (a.length > 200 ? a.slice(0, 200) + '…' : a)), cwd: agent.cwd, pid });
  return pushAgent(agent.id);
}

const ROLES = ['cto', 'orchestrator', 'worker'];
const NAME_MAX = 200;
const TASK_MAX = 2000;

async function createAgent(body) {
  const role = body.role || 'worker';
  const runtime = body.runtime || (role === 'worker' ? 'deepseek' : 'claude');
  const rt = config.runtimes[runtime];
  if (!rt) throw badRequest(`unknown runtime "${runtime}" — one of ${Object.keys(config.runtimes).join(', ')}`);
  if (!ROLES.includes(role)) throw badRequest(`unknown role "${role}" — one of ${ROLES.join(', ')}`);
  const name = String(body.name ?? '').trim();
  const task = String(body.task ?? '').trim();
  if (!name) throw badRequest('name is required');
  if (name.length > NAME_MAX) throw badRequest(`name is too long (${name.length} characters; the maximum is ${NAME_MAX})`);
  if (!task) throw badRequest('task is required');
  if (task.length > TASK_MAX) throw badRequest(`task is too long (${task.length} characters; the maximum is ${TASK_MAX}) — put the detail in the brief`);
  if (body.parentId && !agents.get(body.parentId)) throw badRequest(`parent ${body.parentId} not found`);

  const id = body.id || newId(role);
  let cwd = body.cwd ? path.resolve(body.cwd) : null;
  let worktree = null;
  if (body.worktree?.repo) {
    if (!fs.existsSync(path.resolve(body.worktree.repo))) throw badRequest(`repo does not exist: ${body.worktree.repo}`);
    try {
      worktree = git.createWorktree(body.worktree.repo, name, body.worktree.branch, body.worktree.base);
    } catch (e) {
      throw badRequest(`could not create a worktree in ${body.worktree.repo}: ${firstLine(e.stderr || e.message)}`);
    }
    cwd = worktree.path;
  }
  if (!cwd) throw badRequest('cwd or worktree.repo is required');
  if (!fs.existsSync(cwd)) throw badRequest(`cwd does not exist: ${cwd}`);

  const base = {
    id, parentId: body.parentId || null, name, role, runtime,
    model: body.model || rt.defaults?.model, effort: body.effort || rt.defaults?.effort,
    permissionMode: body.permissionMode || rt.defaults?.permissionMode,
    status: runtime === 'external' ? (body.status || 'running') : 'queued',
    task, note: body.note || null, cwd, worktree,
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
  // Spend is banked on the day it is OBSERVED, in local time, as an increment
  // over the last reading — see usageSamples.record.
  const day = localDay();
  for (const [model, b] of Object.entries(r.byModel || {})) usageSamples.record(id, model, day, b, b.costUsd);
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

/**
 * Which usage tier an agent belongs to. Every agent lands in exactly one, so
 * the tier totals always add up to the fleet totals: DeepSeek is decided by
 * runtime (it is the only metered-money tier), the Claude tiers by role, and
 * anything else — an unknown role, a Claude worker, an external session that is
 * neither CTO nor orchestrator — falls into `other` rather than disappearing.
 */
function tierOf(agent) {
  if (agent.runtime === 'deepseek') return 'deepseek';
  if (agent.role === 'cto') return 'cto';
  if (agent.role === 'orchestrator') return 'orchestrator';
  return 'other';
}

const USAGE_KEYS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'costUsd', 'fableEquivalentUsd'];

function usageSummary() {
  const all = agents.all();
  const tiers = { cto: emptyUsage(), orchestrator: emptyUsage(), deepseek: emptyUsage(), other: emptyUsage() };
  const tierAgents = { cto: 0, orchestrator: 0, deepseek: 0, other: 0 };
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  // Every status an agent can hold gets a bucket, so the counts always sum to
  // `total`; `active` is the running subset and is NOT a separate bucket.
  const counts = { total: all.length, active: 0, running: 0, queued: 0, idle: 0, paused: 0, stopping: 0, blocked: 0, done: 0, failed: 0, stopped: 0, unknown: 0 };
  let dsActual = 0, dsFable = 0, runCost = 0, runStart = null;
  for (const a of all) {
    const u = a.usage || emptyUsage();
    const tier = tierOf(a);
    tierAgents[tier] += 1;
    for (const k of USAGE_KEYS) tiers[tier][k] += Number(u[k]) || 0;
    tokens.input += u.inputTokens || 0; tokens.cacheRead += u.cacheReadTokens || 0; tokens.cacheWrite += u.cacheWriteTokens || 0; tokens.output += u.outputTokens || 0;
    if (tier === 'deepseek') { dsActual += u.costUsd || 0; dsFable += u.fableEquivalentUsd || 0; }
    const status = String(a.status || 'unknown');
    if (counts[status] === undefined) counts.unknown += 1; else counts[status] += 1;
    if (status === 'running') counts.active += 1;
    if (!TERMINAL.has(status)) { runCost += u.costUsd || 0; if (a.startedAt && (!runStart || a.startedAt < runStart)) runStart = a.startedAt; }
  }
  tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  const now = new Date();
  const today = localDay(now);
  const week = localDay(new Date(now.getTime() - 6 * 864e5));
  const month = today.slice(0, 8) + '01';
  return {
    spend: { today: usageSamples.spendSince(today), week: usageSamples.spendSince(week), month: usageSamples.spendSince(month) },
    spendWindows: { today, weekFrom: week, monthFrom: month, basis: 'local calendar days; today is the increment banked since midnight local time' },
    currentRun: { costUsd: runCost, startedAt: runStart, basis: 'total cost of every agent that has not reached a terminal status' },
    byTier: tiers,
    byTierAgents: tierAgents,
    counts,
    tokens,
    limits: { claude: null, deepseek: null },
    savings: {
      deepseekActualUsd: dsActual,
      fableEquivalentUsd: dsFable,
      savedUsd: dsFable - dsActual,
      estimated: true,
      basis: `DeepSeek token usage re-priced at ${pricing.fableEquivalentModel} (estimated price sheet in config/pricing.json). The DeepSeek side is metered API spend; the avoided side is an estimate of work that was never run.`,
    },
    pricing,
    generatedAt: nowIso(),
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
  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!st || st.isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  // `no-cache` on its own, with no validator, lets a browser reuse a stale
  // module forever — which looks exactly like "my edit did nothing". The mtime
  // and size give it something to revalidate against.
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'last-modified': new Date(st.mtimeMs).toUTCString(),
    etag,
  });
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
  if (parts[1] === 'health') return json(res, 200, { ok: true, port: PORT, agents: agents.all().length, node: process.version, version: publicConfig().version });
  if (parts[1] === 'config' && m === 'GET') return json(res, 200, publicConfig());

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
      if (ptys.has(id)) return json(res, 409, { error: `"${a.name}" still has a live terminal — stop it first, then remove it` });
      for (const c of agents.children(id)) agents.update(c.id, { parentId: a.parentId });
      agents.delete(id); pushState();
      return json(res, 200, { ok: true });
    }
    const body = m === 'POST' ? await readBody(req) : {};

    if (sub === 'send' && m === 'POST') {
      const sender = senderOf(req);
      if (!String(body.text ?? '').trim()) return json(res, 400, { error: 'text is required' });
      if (a.controlledBy === 'human' && sender !== 'human') return json(res, 409, { error: 'a human holds control of this agent; message queued to its inbox instead', queued: true, message: messages.add({ agentId: id, fromAgentId: sender.replace(/^agent:/, ''), direction: 'in', sender, text: body.text }) });
      if (a.status === 'paused' && sender !== 'human') return json(res, 409, { error: 'agent is paused' });
      if (a.runtime === 'external') {
        // No terminal to type into: queue the message in the agent's inbox so the session picks it up on its next inbox check.
        const msg = messages.add({ agentId: id, fromAgentId: sender.startsWith('agent:') ? sender.slice(6) : null, direction: 'report', sender, text: String(body.text ?? '') });
        broadcast({ type: 'message', message: msg });
        log(id, 'send', { sender, chars: String(body.text ?? '').length, queued: true });
        return json(res, 200, { ok: true, queued: true, message: msg });
      }
      if (!ptys.has(id)) return json(res, 409, { error: `"${a.name}" has no live terminal (status: ${a.status}). Restart it to send it anything.` });
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
      if (!ptys.has(id)) return json(res, 409, { error: `"${a.name}" has no live terminal (status: ${a.status})` });
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
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'malformed request url' });
  }
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    // The client gets the message only — never a stack. The stack goes to the
    // server console, where the operator can see it.
    const code = Number.isInteger(e.code) && e.code >= 400 && e.code <= 499 ? e.code : 500;
    if (code === 500) console.error(`[api] ${req.method} ${url.pathname}`, e);
    if (res.headersSent) { try { res.end(); } catch { /* already gone */ } return; }
    json(res, code, { error: firstLine(e.message), path: url.pathname });
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

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — another control room (or another app) is on it.\n` +
      `  • Open http://${HOST}:${PORT} to see whether your control room is already running.\n` +
      '  • Or start this one somewhere else:  CR_PORT=4801 npm start\n' +
      '  • See docs/TROUBLESHOOTING.md for how to find the process holding the port.\n');
  } else {
    console.error(`\nThe control room server could not start: ${e.message}\n`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => console.error('[control-room] unhandled rejection:', reason));

server.listen(PORT, HOST, () => {
  refreshAll();
  console.log(`control room  http://${HOST}:${PORT}  (agents: ${agents.all().length})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('control room shutting down; agent processes are left running and will be re-attached as stopped'); process.exit(0); });
