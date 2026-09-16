// In-page fake server for standalone UI checks: open index.html?mock=1
//
// Replaces window.fetch and window.WebSocket with implementations of the
// docs/API.md contract, backed by a CTO -> orchestrator -> workers tree
// (finished, running and blocked workers all present), a ticking PTY, and
// drifting usage numbers.
//
// `?mock=1&empty=1` serves the same contract with NO agents, which is how the
// first-run empty states are checked without touching a database.
//
// Every path in this file is invented; nothing here points at a real machine.
// This file is only imported when ?mock=1 is present (see app.js).

console.info('[mock] Control Room mock server active — no real backend is being contacted.');

const EMPTY = new URLSearchParams(location.search).has('empty');

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
    name: 'notes-app CTO',
    role: 'cto',
    runtime: 'claude',
    model: 'claude-fable-5-1',
    effort: 'high',
    status: 'running',
    task: 'Own the notes-app roadmap and delegate the tags feature to an orchestrator.',
    note: '',
    cwd: '~/projects/notes-app',
    worktree: null,
    controlledBy: 'parent',
    sessionId: '00000000-0000-4000-8000-000000000001',
    pid: 21440,
    createdAt: iso(46 * 60000), startedAt: iso(45 * 60000), endedAt: null,
    elapsedS: 2700,
    usage: usage(412_000, 3_950_000, 186_000, 61_400, 7.4123, 7.4123),
  };
  const orch = {
    id: 'a-20260915-151200-7c9d',
    parentId: cto.id,
    name: 'tags orchestrator',
    role: 'orchestrator',
    runtime: 'claude',
    model: 'claude-fable-5-1-mini',
    effort: 'medium',
    status: 'running',
    task: 'Ship tag support in notes-app: create, assign, and filter by tag.',
    note: '',
    cwd: '~/projects/notes-app/.worktrees/tags-0915',
    worktree: {
      repo: '~/projects/notes-app',
      branch: 'cr/tags-0915',
      path: '~/projects/notes-app/.worktrees/tags-0915',
    },
    controlledBy: 'parent',
    sessionId: '00000000-0000-4000-8000-000000000002',
    pid: 21988,
    createdAt: iso(33 * 60000), startedAt: iso(32 * 60000), endedAt: null,
    elapsedS: 1920,
    usage: usage(188_400, 1_240_000, 74_500, 28_900, 2.1044, 2.1044),
  };

  /** Every worker is one-shot, on DeepSeek, in its own worktree off the repo. */
  const mkWorker = (o) => ({
    parentId: orch.id,
    role: 'worker',
    runtime: 'deepseek',
    model: 'deepseek-v4.1-flash',
    effort: 'low',
    note: '',
    controlledBy: 'parent',
    cwd: `~/projects/notes-app/.worktrees/${o.slug}-0915`,
    worktree: {
      repo: '~/projects/notes-app',
      branch: `cr/${o.slug}-0915`,
      path: `~/projects/notes-app/.worktrees/${o.slug}-0915`,
    },
    ...o,
  });

  // Round 1, finished: the storage layer every other worker was waiting on.
  const storage = mkWorker({
    id: 'a-20260915-152000-3f40',
    slug: 'tags-storage',
    name: 'tags-storage worker',
    status: 'done',
    task: 'Add the tags migration and server/db/tags.js against the agreed signatures.',
    sessionId: '00000000-0000-4000-8000-000000000003',
    pid: 22104,
    createdAt: iso(26 * 60000), startedAt: iso(25 * 60000), endedAt: iso(17 * 60000),
    elapsedS: 480,
    usage: usage(71_900, 268_000, 9_400, 14_600, 0.0121, 0.9683),
  });

  // Round 2, blocked on a question only a human can settle.
  const apiWorker = mkWorker({
    id: 'a-20260915-152730-4e11',
    slug: 'tags-api',
    name: 'tags-api worker',
    status: 'blocked',
    task: 'Add the /api/tags routes and ?tag= filtering to GET /api/notes.',
    note: 'Blocked: the brief says POST rejects a tag name longer than 32 characters with 400, but server/db/tags.js silently truncates at 64. Validate in the route as the brief says, or match the storage layer? I recommend the brief.',
    controlledBy: 'human',
    sessionId: '00000000-0000-4000-8000-000000000004',
    pid: 22310,
    createdAt: iso(12 * 60000), startedAt: iso(11 * 60000), endedAt: null,
    elapsedS: 660,
    usage: usage(96_200, 410_000, 12_800, 18_300, 0.0187, 1.4962),
  });

  // Round 2, still going.
  const uiWorker = mkWorker({
    id: 'a-20260915-153100-9a05',
    slug: 'tags-ui',
    name: 'tags-ui worker',
    status: 'running',
    task: 'Build the tag filter control and wire it into the notes list.',
    sessionId: '00000000-0000-4000-8000-000000000005',
    pid: 22415,
    createdAt: iso(9 * 60000), startedAt: iso(8 * 60000), endedAt: null,
    elapsedS: 480,
    usage: usage(64_300, 231_000, 8_100, 11_200, 0.0104, 0.8319),
  });

  // Round 2, finished.
  const docsWorker = mkWorker({
    id: 'a-20260915-153400-6b72',
    slug: 'tags-docs',
    name: 'tags-docs worker',
    status: 'done',
    task: 'Document the new routes in docs/api.md and the tag model in docs/tags.md.',
    sessionId: '00000000-0000-4000-8000-000000000006',
    pid: 22488,
    createdAt: iso(8 * 60000), startedAt: iso(7 * 60000), endedAt: iso(4 * 60000),
    elapsedS: 180,
    usage: usage(38_700, 142_000, 5_200, 9_800, 0.0063, 0.5044),
  });

  const workers = [storage, apiWorker, uiWorker, docsWorker];
  // In ?empty=1 the cast is built but never registered, so every view renders
  // its first-run state against the same contract.
  for (const a of [cto, orch, ...workers]) { a.cwdExists = true; if (!EMPTY) agents.set(a.id, a); }
  return { cto, orch, storage, apiWorker, uiWorker, docsWorker, workers };
}

const { cto, orch, storage, apiWorker, uiWorker, docsWorker, workers } = seed();
const allAgents = [cto, orch, ...workers];

const messages = new Map(allAgents.map((a) => [a.id, []]));

const chats = new Map();
chats.set(cto.id, [
  { role: 'user', text: 'Stand up the control room for notes-app and delegate the tags feature.', ts: iso(45 * 60000) },
  { role: 'assistant', text: 'Plan:\n1. Read the repo and run the gate\n2. Freeze the storage and route interfaces\n3. Spawn a tags orchestrator in its own worktree\n4. Review every branch before it lands.', ts: iso(44 * 60000) },
  { role: 'tool', name: 'Bash', text: 'npm run lint && npm test && npm run build — exit 0', ts: iso(43 * 60000) },
  { role: 'assistant', text: 'Gate is green on main, so the run has a baseline. Spawning the orchestrator against notes-app in its own worktree.', ts: iso(33 * 60000) },
  { role: 'tool', name: 'spawn', text: '{"agent":"tags orchestrator","worktree":"cr/tags-0915"}', ts: iso(33 * 60000) },
]);
chats.set(orch.id, [
  { role: 'user', text: 'Ship tag support in notes-app: create, assign, and filter by tag.', ts: iso(32 * 60000) },
  { role: 'assistant', text: 'Checkpoint before anything is spawned:\n\nDATA MODEL   tags(id, user_id, name) + note_tags(note_id, tag_id), migration 007_tags.sql\nINTERFACES   listTags(userId), addTagToNote(userId, noteId, name), removeTagFromNote(userId, noteId, tagId), listNotes(userId, { tag })\nWORKER SPLIT round 1 tags-storage; round 2 tags-api, tags-ui, tags-docs in parallel', ts: iso(31 * 60000) },
  { role: 'tool', name: 'Bash', text: 'git worktree add .worktrees/tags-storage-0915 -b cr/tags-storage-0915', ts: iso(26 * 60000) },
  { role: 'assistant', text: 'tags-storage is green and merged into my worktree. Fanning out round 2: api, ui and docs, file-disjoint.', ts: iso(12 * 60000) },
  { role: 'assistant', text: 'tags-docs is done and merged. tags-ui is still working. tags-api has stopped on a validation question — it is in my inbox and needs a human.', ts: iso(3 * 60000) },
]);
chats.set(storage.id, [
  { role: 'user', text: 'Add the tags migration and server/db/tags.js against the agreed signatures.', ts: iso(25 * 60000) },
  { role: 'assistant', text: 'Wrote server/db/migrations/007_tags.sql and server/db/tags.js with the four exported functions, plus server/db/tags.test.js.', ts: iso(19 * 60000) },
  { role: 'tool', name: 'Bash', text: 'npm run migrate && npm test — exit 0', ts: iso(18 * 60000) },
  { role: 'assistant', text: 'Gate green on cr/tags-storage-0915. 11 new tests. Nothing outside the file map changed.', ts: iso(17 * 60000) },
]);
chats.set(apiWorker.id, [
  { role: 'user', text: 'Add the /api/tags routes and ?tag= filtering to GET /api/notes.', ts: iso(11 * 60000) },
  { role: 'assistant', text: 'Reading server/routes/notes.js to copy its router factory and error handling.', ts: iso(10 * 60000) },
  { role: 'tool', name: 'Read', text: 'server/routes/notes.js — 214 lines', ts: iso(10 * 60000) },
  { role: 'assistant', text: 'GET /api/tags, POST and DELETE are written and the ?tag= pass-through is in. One conflict: the brief caps a tag name at 32 characters, the storage layer truncates at 64.', ts: iso(3 * 60000) },
  { role: 'user', text: 'Hold there, I want to look at it.', ts: iso(2 * 60000) },
  { role: 'assistant', text: 'Holding. Marked myself blocked with the question in the note field.', ts: iso(110000) },
]);
chats.set(uiWorker.id, [
  { role: 'user', text: 'Build the tag filter control and wire it into the notes list.', ts: iso(8 * 60000) },
  { role: 'assistant', text: 'TagFilter.jsx renders the tag list from GET /api/tags and pushes ?tag= into the router query. Writing the list integration now.', ts: iso(5 * 60000) },
  { role: 'tool', name: 'Write', text: 'ui/src/components/TagFilter.jsx (2.1 kB)', ts: iso(4 * 60000) },
]);
chats.set(docsWorker.id, [
  { role: 'user', text: 'Document the new routes in docs/api.md and the tag model in docs/tags.md.', ts: iso(7 * 60000) },
  { role: 'assistant', text: 'Both pages written from the interface block in the brief. docs/api.md gains the three routes and the ?tag= parameter; docs/tags.md explains implicit creation and per-user scope.', ts: iso(5 * 60000) },
  { role: 'assistant', text: 'Gate green on cr/tags-docs-0915. Docs only, no code touched.', ts: iso(4 * 60000) },
]);

const inboxes = new Map(allAgents.map((a) => [a.id, []]));
inboxes.get(orch.id).push(
  {
    id: nextId('m'), agentId: orch.id, direction: 'report', sender: 'agent:' + storage.id,
    text: 'tags-storage: migration 007_tags.sql and server/db/tags.js landed on cr/tags-storage-0915, 11 tests, gate exit 0.',
    createdAt: iso(17 * 60000),
  },
  {
    id: nextId('m'), agentId: orch.id, direction: 'report', sender: 'agent:' + docsWorker.id,
    text: 'tags-docs: docs/api.md and docs/tags.md written on cr/tags-docs-0915, gate exit 0, no code touched.',
    createdAt: iso(4 * 60000),
  },
  {
    id: nextId('m'), agentId: orch.id, direction: 'report', sender: 'agent:' + apiWorker.id,
    text: 'tags-api: routes written, blocked on the 32 vs 64 character tag-name conflict between the brief and the storage layer.',
    createdAt: iso(110000),
  },
);
inboxes.get(cto.id).push({
  id: nextId('m'), agentId: cto.id, direction: 'report', sender: 'agent:' + orch.id,
  text: 'Orchestrator: round 1 integrated and green, round 2 fanned out. Two of three workers finished; one blocker is waiting on a human decision.',
  createdAt: iso(90000),
});

const events = new Map();
function ev(agentId, kind, data, msAgo) {
  return { id: nextId('e'), agentId, kind, data, createdAt: iso(msAgo) };
}
events.set(cto.id, [
  ev(cto.id, 'spawned', { pid: 21440, runtime: 'claude' }, 45 * 60000),
  ev(cto.id, 'status', { from: 'queued', to: 'running' }, 45 * 60000 - 500),
  ev(cto.id, 'action', { action: 'note', text: 'interfaces frozen' }, 33 * 60000),
]);
events.set(orch.id, [
  ev(orch.id, 'spawned', { pid: 21988, runtime: 'claude', worktree: 'cr/tags-0915' }, 32 * 60000),
  ev(orch.id, 'status', { from: 'queued', to: 'running' }, 32 * 60000 - 400),
  ev(orch.id, 'spawned', { child: storage.id }, 25 * 60000),
  ev(orch.id, 'spawned', { child: apiWorker.id }, 12 * 60000),
  ev(orch.id, 'spawned', { child: uiWorker.id }, 8 * 60000),
  ev(orch.id, 'spawned', { child: docsWorker.id }, 7 * 60000),
]);
events.set(storage.id, [
  ev(storage.id, 'spawned', { pid: 22104, runtime: 'deepseek' }, 25 * 60000),
  ev(storage.id, 'status', { from: 'queued', to: 'running' }, 25 * 60000 - 300),
  ev(storage.id, 'exit', { code: 0 }, 17 * 60000),
  ev(storage.id, 'status', { from: 'running', to: 'done' }, 17 * 60000 - 200),
]);
events.set(apiWorker.id, [
  ev(apiWorker.id, 'spawned', { pid: 22310, runtime: 'deepseek' }, 11 * 60000),
  ev(apiWorker.id, 'status', { from: 'queued', to: 'running' }, 11 * 60000 - 300),
  ev(apiWorker.id, 'error', { message: 'tag name length rule disagrees with server/db/tags.js', file: 'server/routes/tags.js' }, 3 * 60000),
  ev(apiWorker.id, 'control', { holder: 'human' }, 2 * 60000),
  ev(apiWorker.id, 'status', { from: 'running', to: 'blocked', note: 'awaiting validation decision' }, 110000),
]);
events.set(uiWorker.id, [
  ev(uiWorker.id, 'spawned', { pid: 22415, runtime: 'deepseek' }, 8 * 60000),
  ev(uiWorker.id, 'status', { from: 'queued', to: 'running' }, 8 * 60000 - 300),
]);
events.set(docsWorker.id, [
  ev(docsWorker.id, 'spawned', { pid: 22488, runtime: 'deepseek' }, 7 * 60000),
  ev(docsWorker.id, 'status', { from: 'queued', to: 'running' }, 7 * 60000 - 300),
  ev(docsWorker.id, 'exit', { code: 0 }, 4 * 60000),
  ev(docsWorker.id, 'status', { from: 'running', to: 'done' }, 4 * 60000 - 200),
]);

const DIFF = `diff --git a/server/routes/tags.js b/server/routes/tags.js
new file mode 100644
index 0000000..b7d40e1
--- /dev/null
+++ b/server/routes/tags.js
@@ -0,0 +1,18 @@
+const { Router } = require('express');
+const { asyncHandler } = require('../lib/asyncHandler');
+const { listTags, addTagToNote } = require('../db/tags');
+
+module.exports = function tagsRouter() {
+  const router = Router();
+  router.get('/tags', asyncHandler(async (req, res) => {
+    res.json({ tags: listTags(req.user.id) });
+  }));
+  router.post('/notes/:noteId/tags', asyncHandler(async (req, res) => {
+    const name = String(req.body.name || '').trim();
+    // TODO: the brief caps this at 32; server/db/tags.js truncates at 64.
+    if (!name || name.length > 32) return res.status(400).json({ error: 'invalid tag name' });
+    res.status(201).json({ tag: addTagToNote(req.user.id, req.params.noteId, name) });
+  }));
+  return router;
+};
diff --git a/server/routes/notes.js b/server/routes/notes.js
index 91c2b0a..2ee61f4 100644
--- a/server/routes/notes.js
+++ b/server/routes/notes.js
@@ -40,7 +40,7 @@ router.get('/notes', asyncHandler(async (req, res) => {
-  const notes = listNotes(req.user.id);
+  const notes = listNotes(req.user.id, { tag: req.query.tag });
   res.json({ notes });
 }));
`;

const STAT = ` server/routes/index.js     |  3 ++-
 server/routes/notes.js     |  2 +-
 server/routes/tags.js      | 18 ++++++++++++++++++
 server/routes/tags.test.js | 64 ++++++++++++++++++++++++++++++++++++++++++
 4 files changed, 86 insertions(+), 1 deletion(-)`;

const FILES = {
  changed: [
    { path: 'server/routes/tags.js', status: 'added' },
    { path: 'server/routes/tags.test.js', status: 'added' },
    { path: 'server/routes/notes.js', status: 'modified' },
    { path: 'server/routes/index.js', status: 'modified' },
  ],
  tree: [
    { path: 'server/routes/index.js', size: 1204 },
    { path: 'server/routes/notes.js', size: 6218 },
    { path: 'server/routes/tags.js', size: 1877 },
    { path: 'server/db/tags.js', size: 3180 },
    { path: 'ui/src/components/TagFilter.jsx', size: 2044 },
    { path: 'package.json', size: 916 },
    { path: 'README.md', size: 1422 },
  ],
};

const FILE_CONTENT = {
  'server/db/tags.js': `const { NotFoundError } = require('./errors');\n\n/** -> [{ id, name, noteCount }], name ascending */\nfunction listTags(userId) { /* ... */ }\n\n/** creates the tag if new; idempotent */\nfunction addTagToNote(userId, noteId, name) {\n  const clean = String(name).trim().toLowerCase().slice(0, 64); // truncates at 64\n  /* ... */\n}\n\nmodule.exports = { listTags, addTagToNote, removeTagFromNote };\n`,
  'server/routes/notes.js': `const { Router } = require('express');\nconst { listNotes } = require('../db/notes');\n\nrouter.get('/notes', asyncHandler(async (req, res) => {\n  const notes = listNotes(req.user.id, { tag: req.query.tag });\n  res.json({ notes });\n}));\n`,
};

/**
 * Sum the DeepSeek workers into the one tier the dashboard reports. In
 * ?empty=1 no worker is registered, so this correctly sums nothing.
 */
function deepseekTier() {
  const t = usage(0, 0, 0, 0, 0, 0);
  for (const w of workers) {
    const live = agents.get(w.id);
    if (!live) continue;
    const u = live.usage;
    t.inputTokens += u.inputTokens;
    t.cacheReadTokens += u.cacheReadTokens;
    t.cacheWriteTokens += u.cacheWriteTokens;
    t.outputTokens += u.outputTokens;
    t.totalTokens += u.totalTokens;
    t.costUsd = Number((t.costUsd + u.costUsd).toFixed(6));
    t.fableEquivalentUsd = Number((t.fableEquivalentUsd + u.fableEquivalentUsd).toFixed(6));
  }
  return t;
}

const todayDate = new Date();
/** Local calendar day, the same key the server banks spend under. */
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

let usageSummary = {
  spend: EMPTY ? { today: 0, week: 0, month: 0 } : { today: 9.5354, week: 41.2087, month: 128.4413 },
  spendWindows: {
    today: dayKey(todayDate),
    weekFrom: dayKey(new Date(Date.now() - 6 * 864e5)),
    monthFrom: dayKey(todayDate).slice(0, 8) + '01',
    basis: 'local calendar days',
  },
  currentRun: {
    costUsd: EMPTY ? 0 : 0.4318,
    startedAt: EMPTY ? null : iso(46 * 60000),
    basis: 'every agent that has not reached a terminal status',
  },
  byTier: {
    cto: EMPTY ? usage(0, 0, 0, 0, 0, 0) : cto.usage,
    orchestrator: EMPTY ? usage(0, 0, 0, 0, 0, 0) : orch.usage,
    deepseek: deepseekTier(),
    other: usage(0, 0, 0, 0, 0, 0),
  },
  byTierAgents: EMPTY ? { cto: 0, orchestrator: 0, deepseek: 0, other: 0 } : { cto: 1, orchestrator: 1, deepseek: 4, other: 0 },
  counts: EMPTY
    ? { total: 0, active: 0, running: 0, queued: 0, idle: 0, paused: 0, stopping: 0, blocked: 0, done: 0, failed: 0, stopped: 0, unknown: 0 }
    : { total: 6, active: 3, running: 3, queued: 0, idle: 0, paused: 0, stopping: 0, blocked: 1, done: 2, failed: 0, stopped: 0, unknown: 0 },
  tokens: EMPTY
    ? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
    : { input: 871_500, cacheRead: 6_241_000, cacheWrite: 296_000, output: 144_200, total: 7_552_700 },
  limits: {
    claude: EMPTY ? null : { note: 'weekly limit resets Sun 00:00 UTC', used: '38%', resetsAt: iso(-3 * 3600 * 1000) },
    deepseek: null,
  },
  savings: {
    deepseekActualUsd: EMPTY ? 0 : 0.0475,
    fableEquivalentUsd: EMPTY ? 0 : 3.8008,
    savedUsd: EMPTY ? 0 : 3.7533,
    estimated: true,
    basis: 'DeepSeek token usage re-priced at the frontier price sheet (mock numbers).',
  },
  pricing: { source: 'config/pricing.json', estimated: true },
};

const config = {
  defaultModel: 'claude-fable-5-1',
  defaultCwd: '~/projects',
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
    '\x1b[90m$\x1b[0m npm test\r\n',
    '\x1b[32m✔\x1b[0m server/db/tags.test.js — 11 passing\r\n',
    '\x1b[33m!\x1b[0m server/routes/tags.test.js — 2 pending\r\n',
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
        `\x1b[38;5;75m${(Math.random() * 100).toFixed(1)}%\x1b[0m cpu · scanning ${['server/routes', 'server/db', 'ui/src/components'][ptyTick % 3]}\r\n`;
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
  // In ?empty=1 the seeded agents were never registered; the drift loop still
  // runs (the frames must keep flowing) but has nothing to add up.
  if (agents.has(cto.id)) usageSummary.byTier.cto = agents.get(cto.id).usage;
  if (agents.has(orch.id)) usageSummary.byTier.orchestrator = agents.get(orch.id).usage;
  usageSummary.byTier.deepseek = deepseekTier();

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
  usageSummary.currentRun.costUsd = Number((usageSummary.currentRun.costUsd + (agents.size ? 0.004 : 0)).toFixed(6));
  const ds = usageSummary.byTier.deepseek;
  usageSummary.savings = {
    deepseekActualUsd: ds.costUsd,
    fableEquivalentUsd: ds.fableEquivalentUsd,
    savedUsd: Number((ds.fableEquivalentUsd - ds.costUsd).toFixed(6)),
    estimated: true,
  };
  usageSummary.counts = countStatuses();
  usageSummary.byTierAgents = countTiers();
  broadcast({ type: 'usage', usage: usageSummary });
}, 3000);

/** Same shape the real server sends: one bucket per status, plus `active`. */
function countStatuses() {
  const c = { total: agents.size, active: 0, running: 0, queued: 0, idle: 0, paused: 0, stopping: 0, blocked: 0, done: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const a of agents.values()) {
    if (c[a.status] === undefined) c.unknown += 1; else c[a.status] += 1;
    if (a.status === 'running') c.active += 1;
  }
  return c;
}

/** Agents per tier — a role nobody planned for lands in `other`, not nowhere. */
function countTiers() {
  const t = { cto: 0, orchestrator: 0, deepseek: 0, other: 0 };
  for (const a of agents.values()) {
    const key = a.runtime === 'deepseek' ? 'deepseek' : a.role === 'cto' ? 'cto' : a.role === 'orchestrator' ? 'orchestrator' : 'other';
    t[key] += 1;
  }
  return t;
}

// Occasional full state frame, as a real server would emit on change.
setInterval(() => broadcast(stateFrame()), 15000);

// Occasional assistant message so the Chat tab visibly refreshes.
setInterval(() => {
  const list = chats.get(orch.id);
  if (!list || !agents.has(orch.id)) return;
  list.push({
    role: 'assistant',
    text: `Progress ping ${new Date().toLocaleTimeString('en-GB', { hour12: false })}: still waiting on the tags-api worker's validation decision.`,
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
    // Same validation order and 400s as the real server, so the form's error
    // handling can be exercised offline.
    if (!body || !String(body.name || '').trim()) return json({ error: 'name is required' }, 400);
    if (!String(body.task || '').trim()) return json({ error: 'task is required' }, 400);
    if (!String(body.cwd || '').trim() && !(body.worktree && body.worktree.repo)) return json({ error: 'cwd or worktree.repo is required' }, 400);
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
      cwdExists: true,
      usage: usage(0, 0, 0, 0, 0, 0),
    };
    agents.set(id, agent);
    chats.set(id, [{ role: 'user', text: body.brief || body.task, ts: now() }]);
    events.set(id, [ev(id, 'spawned', { pid: agent.pid, runtime: agent.runtime }, 0)]);
    inboxes.set(id, []);
    messages.set(id, []);
    broadcast(stateFrame());
    return json(agent, 201);
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

    case 'messages':
      return json(messages.get(id) || []);

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
