// In-page fake server for standalone UI checks: open index.html?mock=1
//
// Replaces window.fetch and window.WebSocket with implementations of the
// docs/API.md contract, backed by three agents in a CTO -> orchestrator ->
// worker tree, a ticking PTY, and drifting usage numbers.
//
// This file is only imported when ?mock=1 is present (see app.js).

console.info('[mock] Control Room mock server active — no real backend is being contacted.');

const now = () => new Date().toISOString();
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ------------------------------------------------------------------ data

let seq = 0;
const nextId = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function usage(inTok, cr, cw, out, cost, fable) {
  return {
    inputTokens: inTok, cacheReadTokens: cr, cacheWriteTokens: cw, outputTokens: out,
    totalTokens: inTok + cr + cw + out, costUsd: cost, fableEquivalentUsd: fable,
  };
}

const agents = new Map();

function seed() {
  const cto = {
    id: 'a-20260915-150500-1a2b',
    parentId: null,
    name: 'control-room CTO',
    role: 'cto',
    runtime: 'claude',
    model: 'claude-fable-5-1',
    effort: 'high',
    status: 'running',
    task: 'Own the control room build and delegate the quartzi-site rebuild to an orchestrator.',
    note: '',
    cwd: '/home/dev/projects/control-room',
    worktree: null,
    controlledBy: 'parent',
    sessionId: '1b115b04-d427-44f9-a486-48bfc3604e2a',
    pid: 21440,
    createdAt: iso(46 * 60000), startedAt: iso(45 * 60000), endedAt: null,
    elapsedS: 2700,
    usage: usage(412_000, 3_950_000, 186_000, 61_400, 7.4123, 7.4123),
  };
  const orch = {
    id: 'a-20260915-151200-7c9d',
    parentId: cto.id,
    name: 'quartzi-site orchestrator',
    role: 'orchestrator',
    runtime: 'claude',
    model: 'claude-fable-5-1-mini',
    effort: 'medium',
    status: 'running',
    task: 'Rebuild the quartzi-site marketing pages against the new brand system.',
    note: '',
    cwd: '/home/dev/projects/example-site',
    worktree: {
      repo: '/home/dev/projects/example-site',
      branch: 'cr/quartzi-rebuild',
      path: '/home/dev/projects/example-site/.worktrees/quartzi-rebuild',
    },
    controlledBy: 'parent',
    sessionId: 'b7f2c1d0-3e41-4a9f-9c22-51ad0f7e6a18',
    pid: 21988,
    createdAt: iso(33 * 60000), startedAt: iso(32 * 60000), endedAt: null,
    elapsedS: 1920,
    usage: usage(188_400, 1_240_000, 74_500, 28_900, 2.1044, 2.1044),
  };
  const worker = {
    id: 'a-20260915-152730-4e11',
    parentId: orch.id,
    name: 'pricing page worker',
    role: 'worker',
    runtime: 'deepseek',
    model: 'deepseek-v4.1-flash',
    effort: 'low',
    status: 'blocked',
    task: 'Port the pricing table to the new token set and regenerate the comparison grid.',
    note: 'Blocked: the design tokens file references --brand-quartz-600 which is not defined anywhere in the repo. Should I add it, or fall back to --brand-quartz-500?',
    cwd: '/home/dev/projects/example-site/.worktrees/quartzi-rebuild',
    worktree: {
      repo: '/home/dev/projects/example-site',
      branch: 'cr/pricing-tokens',
      path: '/home/dev/projects/example-site/.worktrees/pricing-tokens',
    },
    controlledBy: 'human',
    sessionId: 'dsh-9f30a1',
    pid: 22310,
    createdAt: iso(12 * 60000), startedAt: iso(11 * 60000), endedAt: null,
    elapsedS: 660,
    usage: usage(96_200, 410_000, 12_800, 18_300, 0.0187, 1.4962),
  };
  for (const a of [cto, orch, worker]) agents.set(a.id, a);
  return { cto, orch, worker };
}

const { cto, orch, worker } = seed();

const messages = new Map([
  [cto.id, []],
  [orch.id, []],
  [worker.id, []],
]);

const chats = new Map();
chats.set(cto.id, [
  { role: 'user', text: 'Stand up the control room: server, PTY manager, UI. Delegate the quartzi rebuild.', ts: iso(45 * 60000) },
  { role: 'assistant', text: 'Plan:\n1. API contract in docs/API.md\n2. Server + PTY manager\n3. Browser UI\n4. Spawn the quartzi orchestrator once the contract is frozen.', ts: iso(44 * 60000) },
  { role: 'tool', name: 'Write', text: 'docs/API.md (4636 bytes)', ts: iso(43 * 60000) },
  { role: 'assistant', text: 'Contract frozen. Spawning the orchestrator against the quartzi-site repo in its own worktree.', ts: iso(33 * 60000) },
  { role: 'tool', name: 'spawn', text: '{"agent":"quartzi-site orchestrator","worktree":"cr/quartzi-rebuild"}', ts: iso(33 * 60000) },
]);
chats.set(orch.id, [
  { role: 'user', text: 'Rebuild the quartzi-site marketing pages against the new brand system.', ts: iso(32 * 60000) },
  { role: 'assistant', text: 'Splitting into four workers: pricing, home hero, docs shell, footer/nav. Starting with pricing since it blocks the others on tokens.', ts: iso(31 * 60000) },
  { role: 'tool', name: 'Bash', text: 'git worktree add .worktrees/pricing-tokens -b cr/pricing-tokens', ts: iso(28 * 60000) },
  { role: 'assistant', text: 'Pricing worker is live on DeepSeek. Waiting on its first report before fanning out the rest.', ts: iso(12 * 60000) },
]);
chats.set(worker.id, [
  { role: 'user', text: 'Port the pricing table to the new token set and regenerate the comparison grid.', ts: iso(11 * 60000) },
  { role: 'assistant', text: 'Reading src/styles/tokens.css and src/pages/pricing.astro.', ts: iso(10 * 60000) },
  { role: 'tool', name: 'Read', text: 'src/styles/tokens.css — 118 lines', ts: iso(10 * 60000) },
  { role: 'assistant', text: 'Converted 14 of 17 declarations. Three of them reference --brand-quartz-600, which is undefined.', ts: iso(3 * 60000) },
  { role: 'user', text: 'Hold there, I want to look at it.', ts: iso(2 * 60000) },
  { role: 'assistant', text: 'Holding. Marked myself blocked with the question in the note field.', ts: iso(110000) },
]);

const inboxes = new Map();
inboxes.set(orch.id, [
  {
    id: nextId('m'), agentId: orch.id, direction: 'report', sender: 'agent:' + worker.id,
    text: 'Pricing worker: 14/17 token declarations ported. Blocked on an undefined --brand-quartz-600.',
    createdAt: iso(110000),
  },
]);
inboxes.set(cto.id, [
  {
    id: nextId('m'), agentId: cto.id, direction: 'report', sender: 'agent:' + orch.id,
    text: 'Orchestrator: worktree cr/quartzi-rebuild created, first worker dispatched, one blocker pending a human decision.',
    createdAt: iso(90000),
  },
]);
inboxes.set(worker.id, []);

const events = new Map();
function ev(agentId, kind, data, msAgo) {
  return { id: nextId('e'), agentId, kind, data, createdAt: iso(msAgo) };
}
events.set(cto.id, [
  ev(cto.id, 'spawned', { pid: 21440, runtime: 'claude' }, 45 * 60000),
  ev(cto.id, 'status', { from: 'queued', to: 'running' }, 45 * 60000 - 500),
  ev(cto.id, 'action', { action: 'note', text: 'contract frozen' }, 33 * 60000),
]);
events.set(orch.id, [
  ev(orch.id, 'spawned', { pid: 21988, runtime: 'claude', worktree: 'cr/quartzi-rebuild' }, 32 * 60000),
  ev(orch.id, 'status', { from: 'queued', to: 'running' }, 32 * 60000 - 400),
  ev(orch.id, 'spawned', { child: worker.id }, 12 * 60000),
]);
events.set(worker.id, [
  ev(worker.id, 'spawned', { pid: 22310, runtime: 'deepseek' }, 11 * 60000),
  ev(worker.id, 'status', { from: 'queued', to: 'running' }, 11 * 60000 - 300),
  ev(worker.id, 'error', { message: 'css var --brand-quartz-600 is not defined', file: 'src/styles/tokens.css' }, 3 * 60000),
  ev(worker.id, 'control', { holder: 'human' }, 2 * 60000),
  ev(worker.id, 'status', { from: 'running', to: 'blocked', note: 'awaiting token decision' }, 110000),
]);

const DIFF = `diff --git a/src/styles/tokens.css b/src/styles/tokens.css
index 3f1a9c2..b7d40e1 100644
--- a/src/styles/tokens.css
+++ b/src/styles/tokens.css
@@ -12,9 +12,12 @@
 :root {
-  --price-card-bg: #ffffff;
-  --price-card-border: #e5e7eb;
-  --price-accent: #7c5cff;
+  --price-card-bg: var(--brand-surface-1);
+  --price-card-border: var(--brand-line-2);
+  --price-accent: var(--brand-quartz-500);
+  /* TODO: three declarations below still want --brand-quartz-600 */
+  --price-accent-strong: var(--brand-quartz-600);
+  --price-ring: var(--brand-quartz-600);
 }
diff --git a/src/pages/pricing.astro b/src/pages/pricing.astro
index 91c2b0a..2ee61f4 100644
--- a/src/pages/pricing.astro
+++ b/src/pages/pricing.astro
@@ -40,7 +40,7 @@ const tiers = await getTiers();
-      <table class="legacy-compare">
+      <table class="compare-grid" data-cols={tiers.length}>
         <thead>
-          <tr><th>Feature</th>{tiers.map(t => <th>{t.name}</th>)}</tr>
+          <tr><th scope="col">Feature</th>{tiers.map(t => <th scope="col">{t.name}</th>)}</tr>
         </thead>
`;

const STAT = ` src/pages/pricing.astro  |  8 ++++----
 src/styles/tokens.css    | 11 +++++++----
 2 files changed, 12 insertions(+), 7 deletions(-)`;

const FILES = {
  changed: [
    { path: 'src/styles/tokens.css', status: 'modified' },
    { path: 'src/pages/pricing.astro', status: 'modified' },
    { path: 'src/components/CompareGrid.astro', status: 'added' },
    { path: 'src/components/LegacyTable.astro', status: 'deleted' },
  ],
  tree: [
    { path: 'src/pages/index.astro', size: 4821 },
    { path: 'src/pages/pricing.astro', size: 7314 },
    { path: 'src/styles/tokens.css', size: 3180 },
    { path: 'src/components/CompareGrid.astro', size: 2044 },
    { path: 'package.json', size: 916 },
    { path: 'README.md', size: 1422 },
  ],
};

const FILE_CONTENT = {
  'src/styles/tokens.css': `:root {\n  --brand-quartz-500: #7c5cff;\n  --brand-surface-1: #ffffff;\n  --brand-line-2: #e5e7eb;\n\n  --price-card-bg: var(--brand-surface-1);\n  --price-card-border: var(--brand-line-2);\n  --price-accent: var(--brand-quartz-500);\n  --price-accent-strong: var(--brand-quartz-600); /* undefined! */\n  --price-ring: var(--brand-quartz-600);          /* undefined! */\n}\n`,
  'src/pages/pricing.astro': `---\nimport CompareGrid from '../components/CompareGrid.astro';\nconst tiers = await getTiers();\n---\n<section class="pricing">\n  <CompareGrid tiers={tiers} />\n</section>\n`,
};

let usageSummary = {
  spend: { today: 9.5354, week: 41.2087, month: 128.4413 },
  currentRun: { costUsd: 0.4318, startedAt: iso(46 * 60000) },
  byTier: {
    cto: usage(412_000, 3_950_000, 186_000, 61_400, 7.4123, 7.4123),
    orchestrator: usage(188_400, 1_240_000, 74_500, 28_900, 2.1044, 2.1044),
    deepseek: usage(96_200, 410_000, 12_800, 18_300, 0.0187, 1.4962),
  },
  counts: { active: 2, done: 5, blocked: 1, failed: 0 },
  tokens: { input: 696_600, cacheRead: 5_600_000, cacheWrite: 273_300, output: 108_600, total: 6_678_500 },
  limits: {
    claude: { note: 'weekly limit resets Sun 00:00 UTC', used: '38%', resetsAt: iso(-3 * 3600 * 1000) },
    deepseek: null,
  },
  savings: { deepseekActualUsd: 0.0187, fableEquivalentUsd: 1.4962, savedUsd: 1.4775, estimated: true },
  pricing: { source: 'config/pricing.json', estimated: true },
};

const config = {
  defaultModel: 'claude-fable-5-1',
  defaultCwd: '/home/dev/projects',
  port: 4800,
  mock: true,
};

// ------------------------------------------------------------------ sockets

const sockets = new Set();

function broadcast(frame) {
  const payload = JSON.stringify(frame);
  for (const s of sockets) s._deliver(payload);
}

function stateFrame() {
  return { type: 'state', agents: Array.from(agents.values()), usage: usageSummary, config };
}

function touch(agent) {
  agents.set(agent.id, agent);
  broadcast({ type: 'agent', agent });
}

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this._attached = new Set();
    this._listeners = new Map();
    sockets.add(this);
    setTimeout(() => {
      this.readyState = 1;
      this._fire('open', { type: 'open' });
      this._deliver(JSON.stringify(stateFrame()));
    }, 120);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const s = this._listeners.get(type);
    if (s) s.delete(fn);
  }
  _fire(type, event) {
    const handler = this['on' + type];
    if (typeof handler === 'function') { try { handler.call(this, event); } catch (e) { console.error(e); } }
    const set = this._listeners.get(type);
    if (set) for (const fn of set) { try { fn.call(this, event); } catch (e) { console.error(e); } }
  }
  _deliver(data) {
    if (this.readyState !== 1) return;
    this._fire('message', { type: 'message', data });
  }

  send(raw) {
    if (this.readyState !== 1) return;
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.type === 'attach') {
      this._attached.add(frame.id);
      this._deliver(JSON.stringify({
        type: 'pty', id: frame.id,
        data: scrollbackFor(frame.id),
        scrollback: true,
        live: mockLive(frame.id),
      }));
    } else if (frame.type === 'detach') {
      this._attached.delete(frame.id);
    } else if (frame.type === 'input') {
      // Echo what the operator typed, like a real PTY would.
      this._deliver(JSON.stringify({ type: 'pty', id: frame.id, data: frame.data }));
      if (frame.data === '\r') {
        this._deliver(JSON.stringify({ type: 'pty', id: frame.id, data: '\r\n\x1b[90m(mock pty: input accepted)\x1b[0m\r\n' }));
      }
    } else if (frame.type === 'resize') {
      console.debug('[mock] resize', frame.id, frame.cols + 'x' + frame.rows);
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    this._fire('close', { type: 'close', code: 1000, wasClean: true });
  }
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

/** The mock's stand-in for `ptys.has(id)`: only unfinished agents have a PTY. */
function mockLive(id) {
  const a = agents.get(id);
  return Boolean(a) && !['done', 'failed', 'stopped'].includes(a.status);
}

function scrollbackFor(id) {
  const a = agents.get(id);
  const name = a ? a.name : id;
  return [
    '\x1b[2J\x1b[H',
    `\x1b[38;5;75m● control-room mock pty\x1b[0m — \x1b[1m${name}\x1b[0m\r\n`,
    `\x1b[90m${id}\x1b[0m\r\n\r\n`,
    '\x1b[90m$\x1b[0m npm run build\r\n',
    '\x1b[32m✔\x1b[0m tokens.css compiled\r\n',
    '\x1b[33m!\x1b[0m warning: --brand-quartz-600 is not defined\r\n',
    '\x1b[90m$\x1b[0m \x1b[5m▌\x1b[0m\r\n',
  ].join('');
}

// PTY heartbeat: one line per second to every attached socket.
let ptyTick = 0;
setInterval(() => {
  ptyTick += 1;
  for (const s of sockets) {
    for (const id of s._attached) {
      if (!mockLive(id)) continue;   // an exited process emits nothing
      const line = `\x1b[90m[${new Date().toLocaleTimeString('en-GB', { hour12: false })}]\x1b[0m tick ${ptyTick} · ` +
        `\x1b[38;5;75m${(Math.random() * 100).toFixed(1)}%\x1b[0m cpu · scanning ${['src/pages', 'src/styles', 'src/components'][ptyTick % 3]}\r\n`;
      s._deliver(JSON.stringify({ type: 'pty', id, data: line }));
    }
  }
}, 1000);

// Usage drift + agent usage growth.
setInterval(() => {
  const bump = (u, f) => {
    u.inputTokens += Math.round(300 * f);
    u.cacheReadTokens += Math.round(5200 * f);
    u.cacheWriteTokens += Math.round(180 * f);
    u.outputTokens += Math.round(140 * f);
    u.totalTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
    u.costUsd = Number((u.costUsd + 0.0031 * f).toFixed(6));
    u.fableEquivalentUsd = Number((u.fableEquivalentUsd + 0.0031 * f * (f > 5 ? 1 : 1)).toFixed(6));
  };
  for (const a of agents.values()) {
    if (a.status !== 'running') continue;
    const f = a.runtime === 'deepseek' ? 1 : 2;
    bump(a.usage, f);
    if (a.runtime === 'deepseek') a.usage.fableEquivalentUsd = Number((a.usage.costUsd * 80).toFixed(6));
    a.elapsedS = Math.floor((Date.now() - new Date(a.startedAt).getTime()) / 1000);
  }
  usageSummary.byTier.cto = agents.get(cto.id).usage;
  usageSummary.byTier.orchestrator = agents.get(orch.id).usage;
  usageSummary.byTier.deepseek = agents.get(worker.id).usage;

  const tk = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  let today = 0;
  for (const a of agents.values()) {
    tk.input += a.usage.inputTokens;
    tk.cacheRead += a.usage.cacheReadTokens;
    tk.cacheWrite += a.usage.cacheWriteTokens;
    tk.output += a.usage.outputTokens;
    tk.total += a.usage.totalTokens;
    today += a.usage.costUsd;
  }
  usageSummary.tokens = tk;
  usageSummary.spend = {
    today: Number(today.toFixed(4)),
    week: Number((today + 31.67).toFixed(4)),
    month: Number((today + 118.9).toFixed(4)),
  };
  usageSummary.currentRun.costUsd = Number((usageSummary.currentRun.costUsd + 0.004).toFixed(6));
  const ds = agents.get(worker.id).usage;
  usageSummary.savings = {
    deepseekActualUsd: ds.costUsd,
    fableEquivalentUsd: ds.fableEquivalentUsd,
    savedUsd: Number((ds.fableEquivalentUsd - ds.costUsd).toFixed(6)),
    estimated: true,
  };
  usageSummary.counts = countStatuses();
  broadcast({ type: 'usage', usage: usageSummary });
}, 3000);

function countStatuses() {
  let active = 0, done = 0, blocked = 0, failed = 0;
  for (const a of agents.values()) {
    if (a.status === 'running' || a.status === 'queued') active += 1;
    else if (a.status === 'done') done += 1;
    else if (a.status === 'blocked') blocked += 1;
    else if (a.status === 'failed') failed += 1;
  }
  return { active, done: done + 5, blocked, failed };
}

// Occasional full state frame, as a real server would emit on change.
setInterval(() => broadcast(stateFrame()), 15000);

// Occasional assistant message so the Chat tab visibly refreshes.
setInterval(() => {
  const list = chats.get(orch.id);
  list.push({
    role: 'assistant',
    text: `Progress ping ${new Date().toLocaleTimeString('en-GB', { hour12: false })}: still waiting on the pricing worker's token decision.`,
    ts: now(),
  });
  if (list.length > 40) list.splice(0, list.length - 40);
  touch(agents.get(orch.id));
}, 20000);

// ------------------------------------------------------------------ fetch

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const realFetch = window.fetch ? window.fetch.bind(window) : null;

window.fetch = async function mockFetch(input, init = {}) {
  const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
  let pathname = raw, search = '';
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) { pathname = raw.slice(0, qIdx); search = raw.slice(qIdx + 1); }
  // Normalise absolute URLs down to their path.
  const m = /^[a-z]+:\/\/[^/]*(\/.*)$/i.exec(pathname);
  if (m) pathname = m[1];
  if (!pathname.startsWith('/api/')) {
    if (realFetch) return realFetch(input, init);
    return new Response('not found', { status: 404 });
  }

  const method = (init.method || 'GET').toUpperCase();
  let body = null;
  if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }
  const params = new URLSearchParams(search);

  await new Promise((r) => setTimeout(r, 40 + Math.random() * 90)); // plausible latency

  if (pathname === '/api/state') return json({ agents: Array.from(agents.values()), usage: usageSummary, config });
  if (pathname === '/api/usage') return json(usageSummary);

  if (pathname === '/api/agents' && method === 'POST') {
    if (!body || !body.name || !body.task || !body.cwd) return json({ error: 'name, task and cwd are required' }, 400);
    const id = `a-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15)}-${Math.random().toString(16).slice(2, 6)}`;
    const agent = {
      id,
      parentId: body.parentId || null,
      name: body.name,
      role: body.role || 'worker',
      runtime: body.runtime || 'claude',
      model: body.model || config.defaultModel,
      effort: body.effort || 'medium',
      status: body.runtime === 'external' ? 'queued' : (body.autoStart === false ? 'queued' : 'running'),
      task: body.task,
      note: '',
      cwd: body.cwd,
      worktree: body.worktree
        ? { repo: body.worktree.repo, branch: body.worktree.branch || 'cr/' + id, path: body.worktree.repo + '/.worktrees/' + id }
        : null,
      controlledBy: 'parent',
      sessionId: body.runtime === 'external' ? null : nextId('sess'),
      pid: body.runtime === 'external' ? null : 20000 + Math.floor(Math.random() * 9000),
      createdAt: now(),
      startedAt: body.runtime === 'external' ? null : now(),
      endedAt: null,
      elapsedS: 0,
      usage: usage(0, 0, 0, 0, 0, 0),
    };
    agents.set(id, agent);
    chats.set(id, [{ role: 'user', text: body.brief || body.task, ts: now() }]);
    events.set(id, [ev(id, 'spawned', { pid: agent.pid, runtime: agent.runtime }, 0)]);
    inboxes.set(id, []);
    messages.set(id, []);
    broadcast(stateFrame());
    return json(agent);
  }

  const parts = pathname.split('/').filter(Boolean); // ['api','agents',id, sub?]
  if (parts[0] !== 'api' || parts[1] !== 'agents') return json({ error: 'not found' }, 404);

  const id = decodeURIComponent(parts[2] || '');
  const sub = parts[3] || '';
  const agent = agents.get(id);
  if (!agent) return json({ error: 'unknown agent ' + id }, 404);

  if (!sub && method === 'GET') {
    return json({
      agent,
      messages: messages.get(id) || [],
      events: events.get(id) || [],
      children: Array.from(agents.values()).filter((a) => a.parentId === id),
    });
  }

  if (!sub && method === 'DELETE') {
    if (agent.status === 'running') return json({ error: 'cannot remove a running agent' }, 409);
    agents.delete(id);
    broadcast(stateFrame());
    return json({ ok: true });
  }

  switch (sub) {
    case 'send': {
      const sender = (init.headers && (init.headers['X-Sender'] || init.headers['x-sender'])) || 'unknown';
      if (agent.controlledBy === 'human' && sender !== 'human') {
        return json({ error: 'a human holds control of this agent' }, 409);
      }
      const list = chats.get(id) || [];
      list.push({ role: 'user', text: String(body && body.text), ts: now() });
      setTimeout(() => {
        list.push({ role: 'assistant', text: `Acknowledged: "${String(body && body.text).slice(0, 80)}". (mock reply)`, ts: now() });
        touch(agent);
      }, 900);
      chats.set(id, list);
      touch(agent);
      return json({ ok: true });
    }
    case 'input':
      return json({ ok: true });

    case 'control': {
      const holder = body && body.holder === 'human' ? 'human' : 'parent';
      agent.controlledBy = holder;
      (events.get(id) || []).push(ev(id, 'control', { holder }, 0));
      touch(agent);
      return json(agent);
    }

    case 'action': {
      const action = body && body.action;
      const valid = ['stop', 'restart', 'interrupt', 'pause', 'resume'];
      if (!valid.includes(action)) return json({ error: 'unknown action ' + action }, 400);
      if (action === 'stop') { agent.status = 'stopped'; agent.endedAt = now(); }
      else if (action === 'restart') { agent.status = 'running'; agent.startedAt = now(); agent.endedAt = null; agent.note = ''; }
      else if (action === 'pause') { agent.status = 'idle'; }
      else if (action === 'resume') { agent.status = 'running'; if (!agent.startedAt) agent.startedAt = now(); agent.endedAt = null; }
      (events.get(id) || []).push(ev(id, 'action', { action }, 0));
      touch(agent);
      broadcast({ type: 'usage', usage: { ...usageSummary, counts: countStatuses() } });
      return json(agent);
    }

    case 'status': {
      const status = body && body.status;
      if (!['done', 'blocked', 'failed', 'running', 'idle', 'queued', 'stopped'].includes(status)) {
        return json({ error: 'unknown status ' + status }, 400);
      }
      agent.status = status;
      if (body && body.note !== undefined) agent.note = body.note;
      if (['done', 'failed', 'stopped'].includes(status)) agent.endedAt = now();
      (events.get(id) || []).push(ev(id, 'status', { to: status, note: agent.note }, 0));
      usageSummary.counts = countStatuses();
      touch(agent);
      broadcast({ type: 'usage', usage: usageSummary });
      return json(agent);
    }

    case 'report': {
      const parentId = agent.parentId;
      if (parentId && inboxes.has(parentId)) {
        const m = { id: nextId('m'), agentId: parentId, direction: 'report', sender: 'agent:' + id, text: String(body && body.text), createdAt: now() };
        inboxes.get(parentId).push(m);
        broadcast({ type: 'message', message: m });
      }
      return json({ ok: true });
    }

    case 'inbox':
      return json(inboxes.get(id) || []);

    case 'chat':
      return json({ messages: chats.get(id) || [] });

    case 'diff':
      return agent.role === 'cto'
        ? json({ diff: '', stat: '' })
        : json({ diff: DIFF, stat: STAT });

    case 'files':
      return json(agent.role === 'cto' ? { changed: [], tree: FILES.tree } : FILES);

    case 'file': {
      const p = params.get('path') || '';
      const content = FILE_CONTENT[p];
      if (content === undefined) {
        return json({ path: p, content: `// mock server has no stored content for:\n// ${p}\n` });
      }
      return json({ path: p, content });
    }

    case 'logs':
      return json(events.get(id) || []);

    case 'scrollback':
      return json({ data: scrollbackFor(id) });

    default:
      return json({ error: 'not found: ' + pathname }, 404);
  }
};

window.WebSocket = MockWebSocket;

export default { mock: true };
