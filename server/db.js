import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// node:sqlite landed in Node 22. Importing it on an older runtime throws
// ERR_UNKNOWN_BUILTIN_MODULE with no hint at all, so say what is wrong.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  console.error(
    `\nControl Room could not load node:sqlite (running Node ${process.versions.node}).\n` +
    'node:sqlite ships with Node 22 and later. Install Node 22+ and run `npm start` again.\n' +
    `Original error: ${err && err.message ? err.message : err}\n`,
  );
  process.exit(1);
}

const db = new DatabaseSync(path.join(DATA_DIR, 'control-room.sqlite'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  permission_mode TEXT,
  status TEXT NOT NULL,
  task TEXT,
  note TEXT,
  cwd TEXT,
  worktree_json TEXT,
  controlled_by TEXT NOT NULL DEFAULT 'parent',
  session_id TEXT,
  brief_path TEXT,
  prompt TEXT,
  pid INTEGER,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  usage_json TEXT,
  result TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  from_agent_id TEXT,
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  deliver INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_samples (
  agent_id TEXT NOT NULL,
  model TEXT,
  day TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, model, day)
);
CREATE TABLE IF NOT EXISTS usage_cursors (
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, model)
);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_samples(day);
`);

// Additive migration: existing fleets keep their original ids, history and costs.
const agentColumns = new Set(db.prepare('PRAGMA table_info(agents)').all().map(c => c.name));
for (const column of ['transcript_runtime', 'continued_from_id', 'successor_id']) {
  if (!agentColumns.has(column)) db.exec(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
}

// `deliver` marks queued operator/parent input that a managed local run must
// consume (see messages.pendingDelivery). Existing rows default to 0, so an old
// database is never retroactively dispatched.
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
if (!messageColumns.has('deliver')) db.exec('ALTER TABLE messages ADD COLUMN deliver INTEGER NOT NULL DEFAULT 0');

// One-time migration for databases written before usage_samples held per-day
// DELTAS: seed each cursor from what was already recorded so the next refresh
// adds only new usage instead of re-counting the whole session.
if (!db.prepare('SELECT 1 FROM usage_cursors LIMIT 1').get() && db.prepare('SELECT 1 FROM usage_samples LIMIT 1').get()) {
  db.exec(`INSERT INTO usage_cursors (agent_id, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, updated_at)
    SELECT agent_id, model, SUM(input_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(output_tokens), SUM(cost_usd), datetime('now')
    FROM usage_samples GROUP BY agent_id, model`);
}

const now = () => new Date().toISOString();

// fs.existsSync on every agent of every state frame is wasteful; 5s of staleness
// is plenty for "this agent's folder was deleted under it".
const existsCache = new Map(); // path -> { at, exists }
function dirExists(p) {
  if (!p) return false;
  const hit = existsCache.get(p);
  if (hit && Date.now() - hit.at < 5000) return hit.exists;
  let exists = false;
  try { exists = fs.existsSync(p); } catch { exists = false; }
  existsCache.set(p, { at: Date.now(), exists });
  if (existsCache.size > 500) existsCache.clear();
  return exists;
}

function rowToAgent(r) {
  if (!r) return null;
  const usage = r.usage_json ? JSON.parse(r.usage_json) : emptyUsage();
  const started = r.started_at ? Date.parse(r.started_at) : null;
  const ended = r.ended_at ? Date.parse(r.ended_at) : null;
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    role: r.role,
    runtime: r.runtime,
    transcriptRuntime: r.transcript_runtime || 'claude',
    continuedFromId: r.continued_from_id || null,
    successorId: r.successor_id || null,
    model: r.model,
    effort: r.effort,
    permissionMode: r.permission_mode,
    status: r.status,
    task: r.task,
    note: r.note,
    cwd: r.cwd,
    cwdExists: r.cwd ? dirExists(r.cwd) : false,
    worktree: r.worktree_json ? JSON.parse(r.worktree_json) : null,
    controlledBy: r.controlled_by,
    sessionId: r.session_id,
    briefPath: r.brief_path,
    prompt: r.prompt,
    pid: r.pid,
    exitCode: r.exit_code,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    elapsedS: started ? Math.round(((ended || Date.now()) - started) / 1000) : 0,
    usage,
    result: r.result,
  };
}

export function emptyUsage() {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, fableEquivalentUsd: 0 };
}

const stmts = {
  insertAgent: db.prepare(`INSERT INTO agents (id,parent_id,name,role,runtime,model,effort,permission_mode,status,task,note,cwd,worktree_json,controlled_by,session_id,brief_path,prompt,created_at,usage_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  allAgents: db.prepare('SELECT * FROM agents ORDER BY created_at'),
  children: db.prepare('SELECT * FROM agents WHERE parent_id = ? ORDER BY created_at'),
  deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
  insertMessage: db.prepare('INSERT INTO messages (agent_id,from_agent_id,direction,sender,text,deliver,created_at) VALUES (?,?,?,?,?,?,?)'),
  messagesFor: db.prepare('SELECT * FROM messages WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
  inboxFor: db.prepare("SELECT * FROM messages WHERE agent_id = ? AND direction = 'report' AND read = 0 ORDER BY id"),
  pendingDelivery: db.prepare("SELECT * FROM messages WHERE agent_id = ? AND direction = 'report' AND read = 0 AND deliver = 1 ORDER BY id"),
  markRead: db.prepare("UPDATE messages SET read = 1 WHERE agent_id = ? AND direction = 'report'"),
  insertEvent: db.prepare('INSERT INTO events (agent_id,kind,data,created_at) VALUES (?,?,?,?)'),
  eventsFor: db.prepare('SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?'),
  addUsage: db.prepare(`INSERT INTO usage_samples (agent_id,model,day,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,model,day) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens, output_tokens=output_tokens+excluded.output_tokens,
      cost_usd=cost_usd+excluded.cost_usd, updated_at=excluded.updated_at`),
  getCursor: db.prepare('SELECT * FROM usage_cursors WHERE agent_id = ? AND model = ?'),
  setCursor: db.prepare(`INSERT INTO usage_cursors (agent_id,model,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,model) DO UPDATE SET input_tokens=excluded.input_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cache_write_tokens=excluded.cache_write_tokens, output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, updated_at=excluded.updated_at`),
  dropCursors: db.prepare('DELETE FROM usage_cursors WHERE agent_id = ?'),
  dropSamples: db.prepare('DELETE FROM usage_samples WHERE agent_id = ?'),
  usageSince: db.prepare('SELECT SUM(cost_usd) AS cost FROM usage_samples WHERE day >= ?'),
  usageByAgentDay: db.prepare('SELECT * FROM usage_samples WHERE agent_id = ?'),
};

export const agents = {
  create(a) {
    stmts.insertAgent.run(a.id, a.parentId ?? null, a.name, a.role, a.runtime, a.model ?? null, a.effort ?? null, a.permissionMode ?? null,
      a.status, a.task ?? null, a.note ?? null, a.cwd ?? null, a.worktree ? JSON.stringify(a.worktree) : null, a.controlledBy || 'parent',
      a.sessionId ?? null, a.briefPath ?? null, a.prompt ?? null, now(), JSON.stringify(emptyUsage()));
    return this.update(a.id, { transcriptRuntime: a.transcriptRuntime || 'claude', continuedFromId: a.continuedFromId || null });
  },
  get(id) { return rowToAgent(stmts.getAgent.get(id)); },
  raw(id) { return stmts.getAgent.get(id); },
  all() { return stmts.allAgents.all().map(rowToAgent); },
  children(id) { return stmts.children.all(id).map(rowToAgent); },
  delete(id) { stmts.deleteAgent.run(id); },
  /** Patch a subset of columns (camelCase keys). */
  update(id, patch) {
    const map = {
      parentId: 'parent_id', name: 'name', role: 'role', model: 'model', effort: 'effort', status: 'status', task: 'task', note: 'note',
      cwd: 'cwd', controlledBy: 'controlled_by', sessionId: 'session_id', pid: 'pid', exitCode: 'exit_code', startedAt: 'started_at',
      endedAt: 'ended_at', result: 'result', briefPath: 'brief_path', prompt: 'prompt', permissionMode: 'permission_mode',
      transcriptRuntime: 'transcript_runtime', continuedFromId: 'continued_from_id', successorId: 'successor_id',
    };
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'usage') { sets.push('usage_json = ?'); vals.push(JSON.stringify(v)); continue; }
      if (k === 'worktree') { sets.push('worktree_json = ?'); vals.push(v ? JSON.stringify(v) : null); continue; }
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`); vals.push(v ?? null);
    }
    if (!sets.length) return this.get(id);
    vals.push(id);
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.get(id);
  },
};

export const messages = {
  add({ agentId, fromAgentId = null, direction, sender, text, deliver = false }) {
    const at = now();
    const r = stmts.insertMessage.run(agentId, fromAgentId, direction, sender, text, deliver ? 1 : 0, at);
    return { id: Number(r.lastInsertRowid), agentId, fromAgentId, direction, sender, text, deliver: Boolean(deliver), createdAt: at };
  },
  list(agentId, limit = 200) {
    return stmts.messagesFor.all(agentId, limit).reverse().map(m => ({ id: m.id, agentId: m.agent_id, fromAgentId: m.from_agent_id, direction: m.direction, sender: m.sender, text: m.text, read: !!m.read, deliver: !!m.deliver, createdAt: m.created_at }));
  },
  inbox(agentId, markRead = false) {
    const rows = stmts.inboxFor.all(agentId).map(m => ({ id: m.id, agentId: m.agent_id, fromAgentId: m.from_agent_id, direction: m.direction, sender: m.sender, text: m.text, deliver: !!m.deliver, createdAt: m.created_at }));
    if (markRead) stmts.markRead.run(agentId);
    return rows;
  },
  /**
   * Unread queued input a managed local run still has to consume, oldest first.
   * Reports from children are deliberately excluded: only `send` sets `deliver`.
   */
  pendingDelivery(agentId) {
    return stmts.pendingDelivery.all(agentId).map(m => ({ id: m.id, agentId: m.agent_id, fromAgentId: m.from_agent_id, direction: m.direction, sender: m.sender, text: m.text, createdAt: m.created_at }));
  },
  /** Mark exactly these messages read (delivery ack); returns how many changed. */
  ackIds(ids) {
    const list = (ids || []).filter((n) => Number.isInteger(n));
    if (!list.length) return 0;
    const sql = `UPDATE messages SET read = 1 WHERE id IN (${list.map(() => '?').join(',')})`;
    return Number(db.prepare(sql).run(...list).changes) || 0;
  },
};

export const events = {
  add(agentId, kind, data) {
    const r = stmts.insertEvent.run(agentId, kind, data == null ? null : (typeof data === 'string' ? data : JSON.stringify(data)), now());
    return { id: Number(r.lastInsertRowid), agentId, kind, data, createdAt: now() };
  },
  list(agentId, limit = 500) {
    return stmts.eventsFor.all(agentId, limit).reverse().map(e => ({ id: e.id, agentId: e.agent_id, kind: e.kind, data: e.data, createdAt: e.created_at }));
  },
};

const FIELDS = [
  ['inputTokens', 'input_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'],
  ['cacheWriteTokens', 'cache_write_tokens'],
  ['outputTokens', 'output_tokens'],
];

export const usageSamples = {
  /**
   * Record an agent's CUMULATIVE usage for one model and bank the increment
   * against `day`.
   *
   * Transcripts are cumulative, so the daily spend windows must be fed the
   * DELTA since the last reading, not the running total. Keying a running
   * total by the agent's start day (what this used to do) both mis-dated spend
   * — a session that started yesterday reported nothing "today" — and
   * double-counted every restart, because a restart moved startedAt and opened
   * a second row holding the whole session again.
   *
   * A cumulative figure that goes DOWN means the underlying session was
   * replaced (a DeepSeek worker restarted into a fresh session file), so the
   * new reading is banked whole and becomes the new baseline.
   */
  record(agentId, model, day, cumulative, cumulativeCost) {
    const key = model || 'unknown';
    const prev = stmts.getCursor.get(agentId, key);
    const cost = Number(cumulativeCost) || 0;
    const delta = {};
    let restarted = false;
    for (const [camel, col] of FIELDS) {
      const next = Number(cumulative[camel]) || 0;
      const was = prev ? Number(prev[col]) || 0 : 0;
      if (next < was) restarted = true;
      delta[camel] = next - was;
    }
    let deltaCost = cost - (prev ? Number(prev.cost_usd) || 0 : 0);
    if (restarted || deltaCost < 0) {
      for (const [camel] of FIELDS) delta[camel] = Number(cumulative[camel]) || 0;
      deltaCost = cost;
    }
    const moved = deltaCost !== 0 || FIELDS.some(([camel]) => delta[camel] !== 0);
    if (!moved) return false;
    stmts.addUsage.run(agentId, key, day, delta.inputTokens, delta.cacheReadTokens, delta.cacheWriteTokens, delta.outputTokens, deltaCost, now());
    stmts.setCursor.run(agentId, key, Number(cumulative.inputTokens) || 0, Number(cumulative.cacheReadTokens) || 0,
      Number(cumulative.cacheWriteTokens) || 0, Number(cumulative.outputTokens) || 0, cost, now());
    return true;
  },
  /** Deleting an agent does not rewrite history; this is for tests and resets. */
  forget(agentId) { stmts.dropCursors.run(agentId); stmts.dropSamples.run(agentId); },
  spendSince(day) { return stmts.usageSince.get(day)?.cost || 0; },
  spendRuntimeSince(runtime, day) { return db.prepare('SELECT COALESCE(SUM(u.cost_usd),0) AS cost FROM usage_samples u JOIN agents a ON a.id=u.agent_id WHERE a.runtime=? AND u.day>=?').get(runtime, day).cost; },
  rows(agentId) { return stmts.usageByAgentDay.all(agentId); },
};

export default db;
