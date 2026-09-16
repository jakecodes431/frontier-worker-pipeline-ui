import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

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
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, created_at);
`);

const now = () => new Date().toISOString();

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
    model: r.model,
    effort: r.effort,
    permissionMode: r.permission_mode,
    status: r.status,
    task: r.task,
    note: r.note,
    cwd: r.cwd,
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
  insertMessage: db.prepare('INSERT INTO messages (agent_id,from_agent_id,direction,sender,text,created_at) VALUES (?,?,?,?,?,?)'),
  messagesFor: db.prepare('SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?'),
  inboxFor: db.prepare("SELECT * FROM messages WHERE agent_id = ? AND direction = 'report' AND read = 0 ORDER BY id"),
  markRead: db.prepare("UPDATE messages SET read = 1 WHERE agent_id = ? AND direction = 'report'"),
  insertEvent: db.prepare('INSERT INTO events (agent_id,kind,data,created_at) VALUES (?,?,?,?)'),
  eventsFor: db.prepare('SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?'),
  upsertUsage: db.prepare(`INSERT INTO usage_samples (agent_id,model,day,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,model,day) DO UPDATE SET input_tokens=excluded.input_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cache_write_tokens=excluded.cache_write_tokens, output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, updated_at=excluded.updated_at`),
  usageSince: db.prepare('SELECT SUM(cost_usd) AS cost FROM usage_samples WHERE day >= ?'),
  usageByAgentDay: db.prepare('SELECT * FROM usage_samples WHERE agent_id = ?'),
};

export const agents = {
  create(a) {
    stmts.insertAgent.run(a.id, a.parentId ?? null, a.name, a.role, a.runtime, a.model ?? null, a.effort ?? null, a.permissionMode ?? null,
      a.status, a.task ?? null, a.note ?? null, a.cwd ?? null, a.worktree ? JSON.stringify(a.worktree) : null, a.controlledBy || 'parent',
      a.sessionId ?? null, a.briefPath ?? null, a.prompt ?? null, now(), JSON.stringify(emptyUsage()));
    return this.get(a.id);
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
  add({ agentId, fromAgentId = null, direction, sender, text }) {
    const r = stmts.insertMessage.run(agentId, fromAgentId, direction, sender, text, now());
    return { id: Number(r.lastInsertRowid), agentId, fromAgentId, direction, sender, text, createdAt: now() };
  },
  list(agentId, limit = 200) {
    return stmts.messagesFor.all(agentId, limit).reverse().map(m => ({ id: m.id, agentId: m.agent_id, fromAgentId: m.from_agent_id, direction: m.direction, sender: m.sender, text: m.text, read: !!m.read, createdAt: m.created_at }));
  },
  inbox(agentId, markRead = false) {
    const rows = stmts.inboxFor.all(agentId).map(m => ({ id: m.id, agentId: m.agent_id, fromAgentId: m.from_agent_id, direction: m.direction, sender: m.sender, text: m.text, createdAt: m.created_at }));
    if (markRead) stmts.markRead.run(agentId);
    return rows;
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

export const usageSamples = {
  upsert(agentId, model, day, u, cost) {
    stmts.upsertUsage.run(agentId, model || 'unknown', day, u.inputTokens || 0, u.cacheReadTokens || 0, u.cacheWriteTokens || 0, u.outputTokens || 0, cost, now());
  },
  spendSince(day) { return stmts.usageSince.get(day)?.cost || 0; },
};

export default db;
