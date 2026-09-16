#!/usr/bin/env node
/**
 * cr — the control room CLI that agents (and humans) use.
 *   node bin/cr.js spawn --name N --role worker --runtime deepseek --task "..." [--brief-file f] [--repo R] [--branch B] [--cwd D] [--model M] [--effort E] [--parent ID] [--wait]
 *   node bin/cr.js register --name N --role cto [--session ID] [--cwd D] [--task "..."]   (track a session the control room did not start)
 *   node bin/cr.js list | tree | inbox | wait <id...> [--timeout S] | result <id> | logs <id> [--tail N]
 *   node bin/cr.js send <id> "text" | report "text" | status done|blocked|failed [--note "..."] | stop <id> | restart <id> | agent <id>
 *   node bin/cr.js usage | health
 *   node bin/cr.js handoff <id> --runtime codex|claude [--model M] [--effort E] [--brief-file F] [--no-start]
 *   node bin/cr.js register --name CTO --provider codex|claude --session <id-or-transcript-path> --cwd <dir>
 * Identity comes from CR_AGENT_ID (set in every spawned terminal); the server URL from CR_URL,
 * falling back to the host/port in config/runtimes.json and then to http://127.0.0.1:4800.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Server URL from config/runtimes.json, so changing the port there is enough for this CLI too. */
function configuredBase() {
  try {
    const override = process.env.CR_CONFIG_DIR && path.join(process.env.CR_CONFIG_DIR, 'runtimes.json');
    const cfg = JSON.parse(fs.readFileSync(override && fs.existsSync(override) ? override : new URL('../config/runtimes.json', import.meta.url), 'utf8'));
    const host = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    return `http://${host}:${process.env.CR_PORT || cfg.port || 4800}`;
  } catch { return 'http://127.0.0.1:4800'; }
}

const URL_BASE = process.env.CR_URL || configuredBase();
const SELF = process.env.CR_AGENT_ID || null;
const argv = process.argv.slice(2);
const cmd = argv.shift();

function parse(args) {
  const opts = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) opts[k] = true; else { opts[k] = next; i++; }
    } else pos.push(a);
  }
  return { opts, pos };
}

async function call(method, p, body) {
  let r;
  try {
    r = await fetch(URL_BASE + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-sender': SELF ? `agent:${SELF}` : 'human' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // "fetch failed" tells nobody anything; name the address and the fix.
    const err = new Error(`cannot reach the control room at ${URL_BASE} — is it running? (npm start)`);
    err.cause = e;
    throw err;
  }
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error(j.error || `${r.status} ${p}`); e.body = j; e.status = r.status; throw e; }
  return j;
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);
const fmt$ = n => `$${(n || 0).toFixed(4)}`;
const fmtT = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));

function line(a) {
  return `${a.id}  ${a.status.padEnd(8)}  ${a.role.padEnd(12)} ${(a.runtime + '/' + (a.model || '')).padEnd(28)} ${fmtT(a.usage?.totalTokens)} tok  ${fmt$(a.usage?.costUsd)}  ${a.name}${a.note ? `  — ${a.note}` : ''}`;
}

async function main() {
  const { opts, pos } = parse(argv);
  switch (cmd) {
    case 'spawn': {
      if (!opts.name || !opts.task) throw new Error('--name and --task are required');
      const body = {
        parentId: opts.parent || SELF || null,
        name: opts.name, role: opts.role || 'worker', runtime: opts.runtime,
        model: opts.model, effort: opts.effort, permissionMode: opts['permission-mode'],
        task: opts.task, brief: opts['brief-file'] ? fs.readFileSync(opts['brief-file'], 'utf8') : (opts.brief || ''),
        cwd: opts.cwd, worktree: opts.repo ? { repo: opts.repo, branch: opts.branch, base: opts.base } : undefined,
        autoStart: !opts['no-start'],
      };
      const a = await call('POST', '/api/agents', body);
      console.log(a.id);
      console.error(`spawned ${a.name} (${a.id}) in ${a.cwd}${a.worktree ? ` on branch ${a.worktree.branch}` : ''}`);
      if (opts.wait) { await waitFor([a.id], Number(opts.timeout || 1800)); const r = await call('GET', `/api/agents/${a.id}/result`); console.log(r.result || '(no result)'); process.exit(r.status === 'done' ? 0 : 1); }
      return;
    }
    case 'register': {
      // Track a session the control room did not spawn (the one you are typing
      // in, typically). No process is started; usage and chat are read from the
      // CLI's own transcript when a session id is given.
      if (!opts.name) throw new Error('--name is required');
      const a = await call('POST', '/api/agents', {
        parentId: opts.parent || null,
        name: opts.name,
        role: opts.role || 'cto',
        runtime: 'external',
        transcriptRuntime: opts.provider || 'claude',
        task: opts.task || `${opts.role || 'cto'} session registered from the CLI`,
        cwd: path.resolve(opts.cwd || process.cwd()),
        sessionId: opts.session || opts.sessionId || null,
        model: opts.model,
        status: opts.status || 'running',
      });
      console.log(a.id);
      console.error(`registered ${a.name} (${a.id})${a.sessionId ? ` tracking session ${a.sessionId}` : ' — pass --session <id> to read its transcript'}`);
      return;
    }
    case 'handoff': {
      if (!pos[0] || !opts.runtime) throw new Error('handoff requires an agent id and --runtime codex|claude');
      const a = await call('POST', `/api/agents/${pos[0]}/handoff`, { runtime: opts.runtime, model: opts.model, effort: opts.effort, autoStart: !opts['no-start'], brief: opts['brief-file'] ? fs.readFileSync(opts['brief-file'], 'utf8') : undefined });
      console.log(a.id);
      console.error(`continued task as ${a.name} (${a.status}) in ${a.cwd}`);
      return;
    }
    case 'list': {
      const all = await call('GET', '/api/agents');
      const mine = opts.all || !SELF ? all : all.filter(a => a.parentId === SELF || a.id === SELF);
      for (const a of mine) console.log(line(a));
      return;
    }
    case 'tree': {
      const all = await call('GET', '/api/agents');
      const print = (pid, depth) => { for (const a of all.filter(x => (x.parentId || null) === pid)) { console.log('  '.repeat(depth) + line(a)); print(a.id, depth + 1); } };
      print(null, 0);
      return;
    }
    case 'agent': { console.log(JSON.stringify(await call('GET', `/api/agents/${pos[0]}`), null, 2)); return; }
    case 'wait': {
      if (!pos.length) throw new Error('give at least one id');
      const res = await waitFor(pos, Number(opts.timeout || 1800));
      for (const a of res) console.log(line(a));
      process.exit(res.every(a => a.status === 'done') ? 0 : res.some(a => !TERMINAL.has(a.status) && a.status !== 'blocked') ? 124 : 1);
    }
    // eslint-disable-next-line no-fallthrough
    case 'result': { const r = await call('GET', `/api/agents/${pos[0]}/result`); console.log(r.result || '(no result yet)'); console.error(`status: ${r.status}`); return; }
    case 'logs': { const r = await call('GET', `/api/agents/${pos[0]}/scrollback`); const n = Number(opts.tail || 4000); console.log(stripAnsi(r.data).slice(-n)); return; }
    case 'send': { const [id, ...rest] = pos; const text = rest.join(' ') || (opts.file ? fs.readFileSync(opts.file, 'utf8') : ''); await call('POST', `/api/agents/${id}/send`, { text }); console.log('sent'); return; }
    case 'report': { const id = opts.agent || SELF; if (!id) throw new Error('no CR_AGENT_ID; pass --agent'); await call('POST', `/api/agents/${id}/report`, { text: pos.join(' ') || (opts.file ? fs.readFileSync(opts.file, 'utf8') : '') }); console.log('reported'); return; }
    case 'inbox': { const id = opts.agent || SELF; const r = await call('GET', `/api/agents/${id}/inbox?ack=${opts.keep ? 0 : 1}`); if (!r.length) console.log('(inbox empty)'); for (const mm of r) console.log(`[${mm.createdAt}] from ${mm.fromAgentId || mm.sender}: ${mm.text}`); return; }
    case 'status': { const id = opts.agent || SELF; if (!id) throw new Error('no CR_AGENT_ID; pass --agent'); const a = await call('POST', `/api/agents/${id}/status`, { status: pos[0], note: opts.note }); console.log(line(a)); return; }
    case 'stop': { for (const id of pos) console.log(line(await call('POST', `/api/agents/${id}/action`, { action: 'stop' }))); return; }
    case 'restart': { for (const id of pos) console.log(line(await call('POST', `/api/agents/${id}/action`, { action: 'restart' }))); return; }
    case 'usage': { console.log(JSON.stringify(await call('GET', '/api/usage'), null, 2)); return; }
    case 'health': { console.log(JSON.stringify(await call('GET', '/api/health'))); return; }
    case 'help': case '--help': case '-h': case undefined:
      console.log(usageText());
      return;
    default:
      console.error(`cr: unknown command "${cmd}"\n`);
      console.error(usageText());
      process.exit(2);
  }
}

/** The header comment of this file is the help text; keep them one thing. */
function usageText() {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const body = src.split('\n').slice(1);
  const lines = body.slice(0, body.findIndex(l => l.trim().startsWith('*/')))
    .map(l => l.replace(/^\s*\*\s?/, ''))
    .filter(l => l.trim() && !l.trim().startsWith('/*'));
  return lines.join('\n') + `\n\nserver: ${URL_BASE}${SELF ? `\nagent:  ${SELF}` : ''}`;
}

async function waitFor(ids, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const all = await call('GET', '/api/agents');
    const sel = ids.map(id => {
      const matches = all.filter(a => a.id === id || a.name === id);
      if (matches.length !== 1) throw new Error(matches.length ? `ambiguous agent name: ${id}; use its id` : `agent not found: ${id}`);
      return matches[0];
    });
    if (sel.length && sel.every(a => TERMINAL.has(a.status) || a.status === 'blocked')) return sel;
    if (Date.now() > deadline) return sel;
    await new Promise(r => setTimeout(r, 5000));
  }
}

function stripAnsi(s) { return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, ''); }

main().catch(e => { console.error(`cr: ${e.message}`); if (e.body?.queued) console.error('(queued to inbox because a human holds control)'); process.exit(e.status === 409 ? 3 : 1); });
