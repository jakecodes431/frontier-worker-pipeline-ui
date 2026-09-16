#!/usr/bin/env node
/**
 * Launch an orchestrator agent through the control room API. Run with --help for
 * the full option list (that text is the USAGE constant below).
 *
 * With no --parent the new agent is attached to the single active CTO agent when
 * there is exactly one, and is otherwise created as a root agent.
 * The control room must already be running (`npm start`).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Server URL: CR_URL, else the host/port from config/runtimes.json, else the built-in default. */
function configuredBase() {
  try {
    const cfg = JSON.parse(fs.readFileSync(new URL('../config/runtimes.json', import.meta.url), 'utf8'));
    const host = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    return `http://${host}:${cfg.port || 4800}`;
  } catch { return 'http://127.0.0.1:4800'; }
}

const URL_BASE = (process.env.CR_URL || configuredBase()).replace(/\/+$/, '');
const TERMINAL = new Set(['done', 'failed', 'stopped']);

const USAGE = `Launch an orchestrator agent through the control room API.

  node scripts/launch-orchestrator.mjs --name "<name>" --task "<one line>" \\
    [--brief-file <path>] [--repo <git repo>] [--branch <name>] [--base <ref>] \\
    [--cwd <dir>] [--model <model>] [--effort <level>] [--permission-mode <mode>] \\
    [--runtime claude|deepseek] [--role orchestrator|cto|worker] [--parent <agentId>] \\
    [--no-auto-start] [--force]

--repo puts the agent in a fresh git worktree of that repository (recommended);
--cwd runs it in an existing directory instead. One of the two is required.
The control room must be running; its URL comes from CR_URL (default ${URL_BASE}).`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}" (every option is --name value)`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function api(method, p, body) {
  let r;
  try {
    r = await fetch(URL_BASE + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach the control room at ${URL_BASE} (${e.message}).\nStart it with "npm start", or set CR_URL if it listens somewhere else.`);
  }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) die(`${method} ${p} failed (${r.status}): ${j.error || text}`);
  return j;
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); }
catch (e) { die(`${e.message}\n\n${USAGE}`); }

if (opts.help || opts.h || process.argv.length === 2) {
  console.log(USAGE);
  process.exit(0);
}

const name = typeof opts.name === 'string' ? opts.name : null;
if (!name) die('--name "<name>" is required.');

const briefFile = typeof opts['brief-file'] === 'string' ? path.resolve(opts['brief-file']) : null;
if (briefFile && !fs.existsSync(briefFile)) die(`--brief-file not found: ${briefFile}`);
const brief = briefFile ? fs.readFileSync(briefFile, 'utf8') : (typeof opts.brief === 'string' ? opts.brief : '');

const task = typeof opts.task === 'string' ? opts.task : null;
if (!task) die('--task "<one line>" is required (the full instructions go in --brief-file).');

const repo = typeof opts.repo === 'string' ? path.resolve(opts.repo) : null;
const cwd = typeof opts.cwd === 'string' ? path.resolve(opts.cwd) : null;
if (!repo && !cwd) die('one of --repo <git repo> (new worktree) or --cwd <dir> (existing directory) is required.');
if (repo && !fs.existsSync(repo)) die(`--repo not found: ${repo}`);
if (cwd && !fs.existsSync(cwd)) die(`--cwd not found: ${cwd}`);

const agents = await api('GET', '/api/agents');

const clash = agents.find(a => a.name === name && !TERMINAL.has(a.status));
if (clash && !opts.force) {
  console.error(`An agent named "${name}" is already active: ${clash.id} (${clash.status}).`);
  console.error(`Send it more work with:  node bin/cr.js send ${clash.id} "..."`);
  console.error('Stop it, rename this one, or pass --force to launch a second agent with the same name.');
  process.exit(1);
}

let parentId = typeof opts.parent === 'string' ? opts.parent : null;
if (!parentId) {
  const ctos = agents.filter(a => a.role === 'cto' && !TERMINAL.has(a.status));
  if (ctos.length === 1) parentId = ctos[0].id;
  else if (ctos.length > 1) die(`several CTO agents are active; pick one with --parent <agentId>:\n${ctos.map(a => `  ${a.id}  ${a.name}`).join('\n')}`);
}

const body = {
  parentId,
  name,
  role: typeof opts.role === 'string' ? opts.role : 'orchestrator',
  runtime: typeof opts.runtime === 'string' ? opts.runtime : 'claude',
  task,
  brief,
  autoStart: opts['no-auto-start'] !== true,
};
for (const [key, field] of [['model', 'model'], ['effort', 'effort'], ['permission-mode', 'permissionMode'], ['note', 'note']]) {
  if (typeof opts[key] === 'string') body[field] = opts[key];
}
if (repo) body.worktree = { repo, branch: typeof opts.branch === 'string' ? opts.branch : undefined, base: typeof opts.base === 'string' ? opts.base : undefined };
else body.cwd = cwd;

const a = await api('POST', '/api/agents', body);

console.log(`spawned ${a.name}`);
console.log(`  id:        ${a.id}`);
console.log(`  role:      ${a.role} (${a.runtime}${a.model ? `/${a.model}` : ''})`);
console.log(`  parent:    ${a.parentId || 'none (root agent)'}`);
console.log(`  cwd:       ${a.cwd}`);
if (a.worktree?.branch) console.log(`  branch:    ${a.worktree.branch}`);
if (a.briefPath) console.log(`  brief:     ${a.briefPath}`);
console.log(`\nOpen ${URL_BASE} > Hierarchy > ${a.name} > Terminal to watch it.`);
if (body.runtime === 'claude') console.log('The first launch in a new folder asks Claude Code\'s folder-trust question; answer it in that Terminal tab.');
