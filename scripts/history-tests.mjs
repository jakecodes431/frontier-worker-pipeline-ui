#!/usr/bin/env node
// Proof for scripts/import-history.mjs: additive history recovery that never
// rewrites the destination and never mutates the source.
//
// Every scenario drives the real CLI in a child process against throwaway
// SQLite fixtures under os.tmpdir(); no real control-room database is touched.
//
// The child's stdout/stderr are redirected into files instead of piped: the
// harness sandbox denies named-pipe stdio (spawnSync with the default 'pipe'
// fails EPERM), and file redirection keeps the CLI contract identical while
// working both inside and outside the sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const importer = path.join(scriptDir, 'import-history.mjs');

// ---------------------------------------------------------------------------
// Counted assertions. Every helper bumps `checks` so the closing line can
// report how much of the contract this run actually exercised.
// ---------------------------------------------------------------------------
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const neq = (actual, expected, message) => { assert.notStrictEqual(actual, expected, message); checks += 1; };
const deq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };
const includes = (haystack, needle, message) => { assert.ok(String(haystack).includes(needle), message); checks += 1; };

const firstLine = (text) => String(text).split(/\r?\n/).find((line) => line.trim()) || '';
// Node prints a source frame first, then the actual "Error: ..." line.
const errorSummary = (text) => {
  const lines = String(text).split(/\r?\n/);
  const error = lines.find((line) => /^Error\b/.test(line.trim())) || lines.find((line) => /must differ/.test(line));
  return (error || firstLine(text)).trim();
};

// ---------------------------------------------------------------------------
// Schema mirrors server/db.js so the fixtures are representative, not toys.
// ---------------------------------------------------------------------------
const SCHEMA = `
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
`;

const TABLES = ['agents', 'messages', 'events', 'usage_samples', 'usage_cursors'];
const RECOVERY_NOTE = 'Recovered history; previous process is not attached.';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function createFixtureDb(dir, populate) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'control-room.sqlite'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    populate(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function withDb(dir, fn, options = {}) {
  const db = new DatabaseSync(path.join(dir, 'control-room.sqlite'), options.readOnly ? { readOnly: true } : {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function snapshotFile(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const table of TABLES) {
      out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }));
    }
    return out;
  } finally {
    db.close();
  }
}

const snapshotDir = (dir) => snapshotFile(path.join(dir, 'control-room.sqlite'));

function backupFiles(dir) {
  return fs.readdirSync(dir).filter((name) => /^before-history-import-\d+\.sqlite$/.test(name)).sort();
}

// Every row already present before an import must still be there, byte for byte.
function assertRowsPreserved(label, before, after) {
  for (const table of TABLES) {
    for (const row of before[table]) {
      const kept = after[table].some((candidate) => JSON.stringify(candidate) === JSON.stringify(row));
      ok(kept, `${label}: ${table} row preserved: ${JSON.stringify(row)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Row inserters
// ---------------------------------------------------------------------------
function insertAgent(db, a) {
  db.prepare(`INSERT INTO agents (id,parent_id,name,role,runtime,model,effort,permission_mode,status,task,note,cwd,
      worktree_json,controlled_by,session_id,brief_path,prompt,pid,exit_code,created_at,started_at,ended_at,usage_json,result)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    a.id, a.parentId ?? null, a.name, a.role, a.runtime, a.model ?? null, a.effort ?? null, a.permissionMode ?? null,
    a.status, a.task ?? null, a.note ?? null, a.cwd ?? null, a.worktreeJson ?? null, a.controlledBy ?? 'parent',
    a.sessionId ?? null, a.briefPath ?? null, a.prompt ?? null, a.pid ?? null, a.exitCode ?? null,
    a.createdAt, a.startedAt ?? null, a.endedAt ?? null, a.usageJson ?? null, a.result ?? null);
}

function insertMessage(db, m) {
  db.prepare(`INSERT INTO messages (id,agent_id,from_agent_id,direction,sender,text,read,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    m.id ?? null, m.agentId, m.fromAgentId ?? null, m.direction, m.sender, m.text, m.read ?? 0, m.createdAt);
}

function insertEvent(db, e) {
  db.prepare(`INSERT INTO events (id,agent_id,kind,data,created_at) VALUES (?,?,?,?,?)`).run(
    e.id ?? null, e.agentId ?? null, e.kind, e.data ?? null, e.createdAt);
}

function insertUsageSample(db, s) {
  db.prepare(`INSERT INTO usage_samples (agent_id,model,day,input_tokens,cache_read_tokens,cache_write_tokens,
      output_tokens,cost_usd,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    s.agentId, s.model, s.day, s.input, s.cacheRead, s.cacheWrite, s.output, s.cost, s.updatedAt);
}

function insertUsageCursor(db, c) {
  db.prepare(`INSERT INTO usage_cursors (agent_id,model,input_tokens,cache_read_tokens,cache_write_tokens,
      output_tokens,cost_usd,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    c.agentId, c.model, c.input, c.cacheRead, c.cacheWrite, c.output, c.cost, c.updatedAt);
}

// ---------------------------------------------------------------------------
// Temp fixture root
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-tests-'));
const sourceDir = path.join(root, 'source');
const destDir = path.join(root, 'dest');
const cliIoDir = path.join(root, 'cli-io');
fs.mkdirSync(cliIoDir, { recursive: true });

let cliRuns = 0;
function runImporter(source, destination) {
  const outPath = path.join(cliIoDir, `stdout-${cliRuns}.json`);
  const errPath = path.join(cliIoDir, `stderr-${cliRuns}.txt`);
  cliRuns += 1;
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [importer, source, destination], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: result.status,
    signal: result.signal,
    spawnError: result.error ? `${result.error.code}: ${result.error.message}` : null,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

const parseReport = (run) => JSON.parse(run.stdout);
const historyImportCount = (dir) => withDb(dir, (db) => db.prepare('SELECT COUNT(*) AS n FROM history_imports').get().n, { readOnly: true });

const observations = [];

// ---------------------------------------------------------------------------
// Source rows: "shared-agent" already exists in the destination, so its row is
// an additive conflict; the other agents exist only upstream.
// ---------------------------------------------------------------------------
function populateSource(db) {
  insertAgent(db, {
    id: 'shared-agent', name: 'Shared Agent', role: 'worker', runtime: 'deepseek', model: 'deepseek-chat',
    status: 'running', pid: 555, note: 'source note', worktreeJson: '{"path":"C:/source"}',
    usageJson: '{"inputTokens":1}', createdAt: '2026-09-02T00:00:00.000Z',
  });
  insertAgent(db, {
    id: 'run-now', name: 'Running Now', role: 'worker', runtime: 'deepseek', model: 'deepseek-chat',
    status: 'running', pid: 4242, note: 'working hard', cwd: 'C:/run', worktreeJson: '{"path":"C:/run"}',
    sessionId: 'sess-run', usageJson: '{"inputTokens":123}', createdAt: '2026-09-16T10:00:00.000Z',
    startedAt: '2026-09-16T10:00:01.000Z',
  });
  insertAgent(db, {
    id: 'idle-now', name: 'Idle Now', role: 'worker', runtime: 'deepseek', status: 'idle', pid: 5151,
    note: 'waiting for work', createdAt: '2026-09-16T10:01:00.000Z',
  });
  insertAgent(db, {
    id: 'done-now', name: 'Done Now', role: 'worker', runtime: 'deepseek', status: 'done', pid: null,
    note: 'finished', result: 'all good', exitCode: 0, createdAt: '2026-09-16T10:02:00.000Z',
  });
  insertAgent(db, {
    id: 'failed-now', name: 'Failed Now', role: 'worker', runtime: 'deepseek', status: 'failed', pid: 111,
    note: 'crashed', exitCode: 2, createdAt: '2026-09-16T10:03:00.000Z',
  });
  insertAgent(db, {
    id: 'weird-now', name: 'Weird Now', role: 'worker', runtime: 'deepseek', status: 'blocked', pid: 222,
    note: 'needs a human', createdAt: '2026-09-16T10:04:00.000Z',
  });

  // Source ids are deliberately far from the destination's to prove they remap.
  insertMessage(db, { id: 500, agentId: 'run-now', fromAgentId: 'done-now', direction: 'report', sender: 'worker', text: 'source message alpha', read: 1, createdAt: '2026-09-16T10:10:00.000Z' });
  insertMessage(db, { id: 501, agentId: 'idle-now', direction: 'chat', sender: 'human', text: 'source message beta', read: 0, createdAt: '2026-09-16T10:11:00.000Z' });

  insertEvent(db, { id: 900, agentId: 'run-now', kind: 'state', data: '{"source":1}', createdAt: '2026-09-16T10:12:00.000Z' });
  insertEvent(db, { id: 901, agentId: 'run-now', kind: 'log', data: null, createdAt: '2026-09-16T10:13:00.000Z' });

  insertUsageSample(db, { agentId: 'run-now', model: 'deepseek-chat', day: '2026-09-16', input: 100, cacheRead: 10, cacheWrite: 5, output: 20, cost: 0.5, updatedAt: '2026-09-16T10:05:00.000Z' });
  insertUsageSample(db, { agentId: 'run-now', model: 'deepseek-chat', day: '2026-09-17', input: 7, cacheRead: 0, cacheWrite: 0, output: 3, cost: 0.05, updatedAt: '2026-09-17T10:05:00.000Z' });
  insertUsageSample(db, { agentId: 'shared-agent', model: 'deepseek-chat', day: '2026-09-11', input: 999, cacheRead: 888, cacheWrite: 777, output: 666, cost: 9.99, updatedAt: '2026-09-11T10:05:00.000Z' });

  insertUsageCursor(db, { agentId: 'run-now', model: 'deepseek-chat', input: 107, cacheRead: 10, cacheWrite: 5, output: 23, cost: 0.55, updatedAt: '2026-09-16T10:06:00.000Z' });
  insertUsageCursor(db, { agentId: 'shared-agent', model: 'deepseek-chat', input: 111, cacheRead: 222, cacheWrite: 333, output: 444, cost: 4.44, updatedAt: '2026-09-11T10:06:00.000Z' });
}

function populateDestination(db) {
  insertAgent(db, {
    id: 'dest-only', name: 'Dest Only', role: 'worker', runtime: 'deepseek', model: 'deepseek-chat',
    status: 'running', task: 'dest task', note: 'keep me', cwd: 'C:/dest', worktreeJson: '{"path":"C:/dest"}',
    controlledBy: 'human', sessionId: 'dest-sess', pid: 777, createdAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:01.000Z', usageJson: '{"inputTokens":7}', result: 'dest result',
  });
  insertAgent(db, {
    id: 'shared-agent', name: 'Shared Agent', role: 'worker', runtime: 'deepseek', model: 'deepseek-chat',
    status: 'running', note: 'dest note', worktreeJson: '{"path":"C:/shared"}', pid: 999,
    usageJson: '{"inputTokens":9}', createdAt: '2026-09-02T00:00:00.000Z',
  });

  insertMessage(db, { id: 1, agentId: 'dest-only', direction: 'chat', sender: 'human', text: 'dest old message one', read: 0, createdAt: '2026-09-01T00:00:02.000Z' });
  insertMessage(db, { id: 2, agentId: 'shared-agent', fromAgentId: 'dest-only', direction: 'report', sender: 'worker', text: 'dest old report two', read: 1, createdAt: '2026-09-01T00:00:03.000Z' });
  insertMessage(db, { id: 3, agentId: 'dest-only', direction: 'chat', sender: 'human', text: 'dest old message three', read: 0, createdAt: '2026-09-01T00:00:04.000Z' });

  insertEvent(db, { id: 1, agentId: 'dest-only', kind: 'state', data: '{"dest":1}', createdAt: '2026-09-01T00:00:05.000Z' });
  insertEvent(db, { id: 2, agentId: null, kind: 'log', data: 'dest old event two', createdAt: '2026-09-01T00:00:06.000Z' });

  insertUsageSample(db, { agentId: 'dest-only', model: 'deepseek-chat', day: '2026-09-10', input: 1, cacheRead: 2, cacheWrite: 3, output: 4, cost: 0.11, updatedAt: '2026-09-10T00:00:00.000Z' });
  insertUsageSample(db, { agentId: 'shared-agent', model: 'deepseek-chat', day: '2026-09-11', input: 5, cacheRead: 6, cacheWrite: 7, output: 8, cost: 0.22, updatedAt: '2026-09-11T00:00:00.000Z' });

  insertUsageCursor(db, { agentId: 'dest-only', model: 'deepseek-chat', input: 10, cacheRead: 20, cacheWrite: 30, output: 40, cost: 0.5, updatedAt: '2026-09-10T00:00:00.000Z' });
  insertUsageCursor(db, { agentId: 'shared-agent', model: 'deepseek-chat', input: 50, cacheRead: 60, cacheWrite: 70, output: 80, cost: 0.6, updatedAt: '2026-09-11T00:00:00.000Z' });
}

function seedFiles(source, dest) {
  fs.mkdirSync(path.join(source, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(source, 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(source, 'scrollback', 'from-source.txt'), 'source scrollback');
  fs.writeFileSync(path.join(source, 'scrollback', 'shared.txt'), 'source shared scrollback');
  fs.writeFileSync(path.join(source, 'briefs', 'from-source.md'), 'source brief');
  fs.writeFileSync(path.join(source, 'briefs', 'shared.md'), 'source shared brief');

  fs.mkdirSync(path.join(dest, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'scrollback', 'shared.txt'), 'dest shared scrollback');
  fs.writeFileSync(path.join(dest, 'briefs', 'shared.md'), 'dest shared brief');
  fs.writeFileSync(path.join(dest, 'briefs', 'dest-only.md'), 'dest only brief');
}

function addLateSourceRows() {
  const db = new DatabaseSync(path.join(sourceDir, 'control-room.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=10000');
    insertAgent(db, { id: 'late-agent', name: 'Late Agent', role: 'worker', runtime: 'deepseek', status: 'running', pid: 333, note: 'late arrival', createdAt: '2026-09-16T12:00:00.000Z' });
    insertMessage(db, { id: 600, agentId: 'late-agent', direction: 'report', sender: 'worker', text: 'source message gamma', read: 0, createdAt: '2026-09-16T12:01:00.000Z' });
    insertEvent(db, { id: 950, agentId: 'late-agent', kind: 'state', data: '{"late":1}', createdAt: '2026-09-16T12:02:00.000Z' });
    insertUsageSample(db, { agentId: 'late-agent', model: 'deepseek-chat', day: '2026-09-18', input: 1, cacheRead: 1, cacheWrite: 1, output: 1, cost: 0.01, updatedAt: '2026-09-16T12:03:00.000Z' });
    insertUsageCursor(db, { agentId: 'late-agent', model: 'deepseek-chat', input: 1, cacheRead: 1, cacheWrite: 1, output: 1, cost: 0.01, updatedAt: '2026-09-16T12:03:00.000Z' });
    // An edit to an already-imported source row must NOT be replayed: the
    // importer keys on source rowid, so recovery stays strictly additive.
    db.prepare("UPDATE agents SET note='changed after import' WHERE id='run-now'").run();
    // A file that appears upstream between runs must propagate on the next run.
    fs.writeFileSync(path.join(sourceDir, 'scrollback', 'late.txt'), 'late scrollback');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

// ===========================================================================
// Test body
// ===========================================================================
try {
  createFixtureDb(sourceDir, populateSource);
  createFixtureDb(destDir, populateDestination);
  seedFiles(sourceDir, destDir);

  const before = { source: snapshotDir(sourceDir), dest: snapshotDir(destDir) };
  eq(backupFiles(destDir).length, 0, 'destination starts with no import backup');
  eq(withDb(destDir, (db) => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='history_imports'").get().n, { readOnly: true }),
    0, 'destination starts with no history_imports table');

  // -------------------------------------------------------------------------
  // First import
  // -------------------------------------------------------------------------
  const run1 = runImporter(sourceDir, destDir);
  eq(run1.spawnError, null, `importer spawns cleanly (${run1.spawnError})`);
  eq(run1.status, 0, `first import exits 0 (stderr: ${errorSummary(run1.stderr)})`);
  const report1 = parseReport(run1);
  deq(report1.imported, { agents: 5, messages: 2, events: 2, usage_samples: 2, usage_cursors: 1 },
    'first import counts only rows the destination did not already have');
  ok(fs.existsSync(report1.backup), 'reported backup path exists on disk');
  includes(report1.backup, path.join(destDir, 'before-history-import-'), 'backup is written inside the destination');
  const backups1 = backupFiles(destDir);
  eq(backups1.length, 1, 'exactly one backup after the first import');

  const dest1 = snapshotDir(destDir);
  assertRowsPreserved('first import preserves existing destination rows', before.dest, dest1);

  const agents1 = Object.fromEntries(dest1.agents.map((a) => [a.id, a]));
  // Existing destination agents win: status, pid and JSON are untouched even
  // though the incoming shared-agent row is "running".
  eq(agents1['shared-agent'].status, 'running', 'existing destination agent status is preserved');
  eq(agents1['shared-agent'].pid, 999, 'existing destination agent pid is preserved');
  eq(agents1['shared-agent'].note, 'dest note', 'existing destination agent note is preserved');
  eq(agents1['shared-agent'].worktree_json, '{"path":"C:/shared"}', 'existing destination agent worktree JSON is preserved');
  eq(agents1['shared-agent'].usage_json, '{"inputTokens":9}', 'existing destination agent usage JSON is preserved');
  eq(agents1['dest-only'].status, 'running', 'unrelated destination agent is untouched');
  eq(agents1['dest-only'].pid, 777, 'unrelated destination agent pid is untouched');
  eq(agents1['dest-only'].usage_json, '{"inputTokens":7}', 'unrelated destination agent JSON is untouched');

  // New source agents: a persisted running/idle flag is not a live process.
  eq(agents1['run-now'].status, 'stopped', 'running source agent is recovered as stopped');
  eq(agents1['run-now'].pid, null, 'recovered running agent pid is cleared');
  eq(agents1['run-now'].note, `working hard ${RECOVERY_NOTE}`, 'recovery note is appended for a running agent');
  eq(agents1['idle-now'].status, 'stopped', 'idle source agent is recovered as stopped');
  eq(agents1['idle-now'].pid, null, 'recovered idle agent pid is cleared');
  eq(agents1['idle-now'].note, `waiting for work ${RECOVERY_NOTE}`, 'recovery note is appended for an idle agent');
  eq(agents1['weird-now'].status, 'stopped', 'unknown source status is recovered as stopped');
  eq(agents1['done-now'].status, 'done', 'done source agent stays done');
  eq(agents1['done-now'].result, 'all good', 'done source agent result is imported');
  eq(agents1['failed-now'].status, 'failed', 'failed source agent stays failed');
  eq(agents1['failed-now'].exit_code, 2, 'failed source agent exit code is imported');

  // Existing destination message/event ids and payloads survive.
  const messages1 = Object.fromEntries(dest1.messages.map((m) => [m.id, m]));
  eq(messages1[1].text, 'dest old message one', 'old destination message id 1 keeps its text');
  eq(messages1[2].text, 'dest old report two', 'old destination message id 2 keeps its text');
  eq(messages1[3].text, 'dest old message three', 'old destination message id 3 keeps its text');
  const events1 = Object.fromEntries(dest1.events.map((e) => [e.id, e]));
  eq(events1[1].data, '{"dest":1}', 'old destination event id 1 keeps its payload');
  eq(events1[2].data, 'dest old event two', 'old destination event id 2 keeps its payload');

  // Imported messages get fresh ids but keep every payload column.
  const alpha = dest1.messages.find((m) => m.text === 'source message alpha');
  ok(alpha, 'imported source message alpha is present');
  neq(alpha.id, 500, 'imported message id is remapped away from the source id');
  eq(alpha.agent_id, 'run-now', 'imported message agent id preserved');
  eq(alpha.from_agent_id, 'done-now', 'imported message sender agent preserved');
  eq(alpha.direction, 'report', 'imported message direction preserved');
  eq(alpha.sender, 'worker', 'imported message sender preserved');
  eq(alpha.read, 1, 'imported message read flag preserved');
  eq(alpha.created_at, '2026-09-16T10:10:00.000Z', 'imported message timestamp preserved');
  const beta = dest1.messages.find((m) => m.text === 'source message beta');
  ok(beta, 'imported source message beta is present');
  neq(beta.id, 501, 'imported second message id is remapped');
  eq(beta.agent_id, 'idle-now', 'imported second message agent id preserved');
  eq(beta.from_agent_id, null, 'imported second message null sender preserved');

  const stateEvent = dest1.events.find((e) => e.agent_id === 'run-now' && e.kind === 'state');
  ok(stateEvent, 'imported state event is present');
  neq(stateEvent.id, 900, 'imported event id is remapped away from the source id');
  eq(stateEvent.data, '{"source":1}', 'imported event payload preserved');
  eq(stateEvent.created_at, '2026-09-16T10:12:00.000Z', 'imported event timestamp preserved');
  const nullEvent = dest1.events.find((e) => e.agent_id === 'run-now' && e.kind === 'log');
  ok(nullEvent, 'imported null-payload event is present');
  neq(nullEvent.id, 901, 'imported null-payload event id is remapped');
  eq(nullEvent.data, null, 'imported null event payload preserved as null');

  // Usage rows are additive too: conflicting destination keys keep their values.
  const sample1 = dest1.usage_samples.find((s) => s.agent_id === 'run-now' && s.day === '2026-09-16');
  ok(sample1, 'imported usage sample is present');
  eq(sample1.input_tokens, 100, 'imported usage sample input tokens preserved');
  eq(sample1.cache_read_tokens, 10, 'imported usage sample cache-read tokens preserved');
  eq(sample1.cache_write_tokens, 5, 'imported usage sample cache-write tokens preserved');
  eq(sample1.output_tokens, 20, 'imported usage sample output tokens preserved');
  eq(sample1.cost_usd, 0.5, 'imported usage sample cost preserved');
  eq(sample1.updated_at, '2026-09-16T10:05:00.000Z', 'imported usage sample timestamp preserved');
  ok(dest1.usage_samples.some((s) => s.agent_id === 'run-now' && s.day === '2026-09-17'), 'second imported usage sample is present');
  const sharedSample = dest1.usage_samples.find((s) => s.agent_id === 'shared-agent');
  eq(sharedSample.input_tokens, 5, 'conflicting destination usage sample is not overwritten');
  eq(sharedSample.cost_usd, 0.22, 'conflicting destination usage sample cost is not overwritten');
  const cursor1 = dest1.usage_cursors.find((c) => c.agent_id === 'run-now');
  ok(cursor1, 'imported usage cursor is present');
  eq(cursor1.input_tokens, 107, 'imported usage cursor input tokens preserved');
  eq(cursor1.cost_usd, 0.55, 'imported usage cursor cost preserved');
  const sharedCursor = dest1.usage_cursors.find((c) => c.agent_id === 'shared-agent');
  eq(sharedCursor.input_tokens, 50, 'conflicting destination usage cursor is not overwritten');
  eq(sharedCursor.cost_usd, 0.6, 'conflicting destination usage cursor cost is not overwritten');

  eq(historyImportCount(destDir), 15, 'history_imports records one key per source row (including conflicts)');

  deq(snapshotFile(report1.backup), before.dest, 'the backup holds the original destination records');
  deq(snapshotDir(sourceDir), before.source, 'first import leaves every source table logically unchanged');

  // -------------------------------------------------------------------------
  // Copy of raw scrollback / briefs: missing files only, existing files win
  // -------------------------------------------------------------------------
  const read = (dir, ...parts) => fs.readFileSync(path.join(dir, ...parts), 'utf8');
  eq(read(destDir, 'scrollback', 'from-source.txt'), 'source scrollback', 'missing scrollback file is copied');
  eq(read(destDir, 'scrollback', 'shared.txt'), 'dest shared scrollback', 'existing destination scrollback is not overwritten');
  eq(read(destDir, 'briefs', 'from-source.md'), 'source brief', 'missing brief file is copied');
  eq(read(destDir, 'briefs', 'shared.md'), 'dest shared brief', 'existing destination brief is not overwritten');
  eq(read(destDir, 'briefs', 'dest-only.md'), 'dest only brief', 'destination-only brief survives');
  eq(read(sourceDir, 'scrollback', 'shared.txt'), 'source shared scrollback', 'source scrollback file is untouched');
  eq(read(sourceDir, 'briefs', 'shared.md'), 'source shared brief', 'source brief file is untouched');

  // -------------------------------------------------------------------------
  // Second import: a true no-op
  // -------------------------------------------------------------------------
  const after1 = snapshotDir(destDir);
  const run2 = runImporter(sourceDir, destDir);
  eq(run2.status, 0, `second import exits 0 (stderr: ${errorSummary(run2.stderr)})`);
  deq(parseReport(run2).imported, { agents: 0, messages: 0, events: 0, usage_samples: 0, usage_cursors: 0 },
    'second import imports nothing');
  deq(snapshotDir(destDir), after1, 'second import changes no destination row');
  eq(historyImportCount(destDir), 15, 'second import adds no history_imports keys');
  eq(backupFiles(destDir).length, 2, 'a fresh backup is taken on every import');
  deq(snapshotDir(sourceDir), before.source, 'second import leaves the source unchanged');

  // -------------------------------------------------------------------------
  // Third import: additions only
  // -------------------------------------------------------------------------
  addLateSourceRows();
  const sourceAfterMutation = snapshotDir(sourceDir);
  const before3 = snapshotDir(destDir);
  const run3 = runImporter(sourceDir, destDir);
  eq(run3.status, 0, `third import exits 0 (stderr: ${errorSummary(run3.stderr)})`);
  deq(parseReport(run3).imported, { agents: 1, messages: 1, events: 1, usage_samples: 1, usage_cursors: 1 },
    'third import takes only the rows added upstream');
  const dest3 = snapshotDir(destDir);
  assertRowsPreserved('third import preserves every earlier row', before3, dest3);
  const agents3 = Object.fromEntries(dest3.agents.map((a) => [a.id, a]));
  eq(agents3['late-agent'].status, 'stopped', 'late running agent is recovered as stopped');
  eq(agents3['late-agent'].pid, null, 'late recovered agent pid is cleared');
  eq(agents3['late-agent'].note, `late arrival ${RECOVERY_NOTE}`, 'late recovery note is appended');
  eq(agents3['run-now'].note, `working hard ${RECOVERY_NOTE}`, 'an edited already-imported source row is not replayed');
  ok(dest3.messages.some((m) => m.text === 'source message gamma'), 'late source message is imported');
  ok(dest3.events.some((e) => e.agent_id === 'late-agent' && e.data === '{"late":1}'), 'late source event is imported');
  ok(dest3.usage_samples.some((s) => s.agent_id === 'late-agent' && s.day === '2026-09-18'), 'late usage sample is imported');
  ok(dest3.usage_cursors.some((c) => c.agent_id === 'late-agent'), 'late usage cursor is imported');
  eq(historyImportCount(destDir), 20, 'third import records exactly the five added source rows');
  eq(backupFiles(destDir).length, 3, 'third import takes a third backup');
  deq(snapshotDir(sourceDir), sourceAfterMutation, 'third import leaves the source unchanged');
  eq(read(destDir, 'scrollback', 'late.txt'), 'late scrollback', 'a file that appears upstream later is copied on the next run');
  eq(read(destDir, 'scrollback', 'shared.txt'), 'dest shared scrollback', 'existing scrollback still wins on later runs');

  // -------------------------------------------------------------------------
  // Same source and destination: rejected before anything is touched
  // -------------------------------------------------------------------------
  const backupsBeforeSame = backupFiles(sourceDir).length;
  const runSame = runImporter(sourceDir, sourceDir);
  neq(runSame.status, 0, 'same source and destination is rejected');
  includes(runSame.stderr, 'Source and destination must differ', 'rejection explains the reason');
  deq(snapshotDir(sourceDir), sourceAfterMutation, 'rejected same-directory import leaves contents unchanged');
  eq(backupFiles(sourceDir).length, backupsBeforeSame, 'rejected same-directory import creates no backup');
  eq(read(sourceDir, 'briefs', 'shared.md'), 'source shared brief', 'rejected same-directory import leaves files alone');

  // -------------------------------------------------------------------------
  // Missing paths: observe what the CLI actually does and prove it is safe
  // -------------------------------------------------------------------------
  const backupsBeforeMissing = backupFiles(destDir).length;

  const missingSource = path.join(root, 'missing-source-dir');
  const destBeforeMissingSource = snapshotDir(destDir);
  const runMissingSource = runImporter(missingSource, destDir);
  neq(runMissingSource.status, 0, 'missing source directory fails');
  ok(!fs.existsSync(missingSource), 'missing source directory is not created');
  deq(snapshotDir(destDir), destBeforeMissingSource, 'missing source directory leaves the destination unchanged');
  eq(backupFiles(destDir).length, backupsBeforeMissing, 'missing source directory creates no backup');
  observations.push(`missing source directory -> exit ${runMissingSource.status}: ${errorSummary(runMissingSource.stderr)}`);

  const missingTarget = path.join(root, 'missing-target-dir');
  const sourceBeforeMissingTarget = snapshotDir(sourceDir);
  const runMissingTarget = runImporter(sourceDir, missingTarget);
  neq(runMissingTarget.status, 0, 'missing target directory fails');
  ok(!fs.existsSync(missingTarget), 'missing target directory is not created');
  deq(snapshotDir(sourceDir), sourceBeforeMissingTarget, 'missing target directory leaves the source unchanged');
  observations.push(`missing target directory -> exit ${runMissingTarget.status}: ${errorSummary(runMissingTarget.stderr)}`);

  const emptySource = path.join(root, 'source-without-db');
  fs.mkdirSync(emptySource);
  const destBeforeEmptySource = snapshotDir(destDir);
  const runEmptySource = runImporter(emptySource, destDir);
  neq(runEmptySource.status, 0, 'source directory without a database fails');
  deq(snapshotDir(destDir), destBeforeEmptySource, 'source without a database leaves the destination unchanged');
  eq(backupFiles(destDir).length, backupsBeforeMissing, 'source without a database creates no backup');
  observations.push(`source directory without control-room.sqlite -> exit ${runEmptySource.status}: ${errorSummary(runEmptySource.stderr)}`);

  const emptyTarget = path.join(root, 'target-without-db');
  fs.mkdirSync(emptyTarget);
  const sourceBeforeEmptyTarget = snapshotDir(sourceDir);
  const runEmptyTarget = runImporter(sourceDir, emptyTarget);
  neq(runEmptyTarget.status, 0, 'target directory without a database fails');
  deq(snapshotDir(sourceDir), sourceBeforeEmptyTarget, 'target without a database leaves the source unchanged');
  const emptyTargetFiles = fs.readdirSync(emptyTarget).sort();
  observations.push(`target directory without control-room.sqlite -> exit ${runEmptyTarget.status}; destination files created: ${JSON.stringify(emptyTargetFiles)}: ${errorSummary(runEmptyTarget.stderr)}`);
  if (emptyTargetFiles.length) {
    console.warn(`WARN target-without-database: the failed import still created ${emptyTargetFiles.length} file(s) in the destination: ${emptyTargetFiles.join(', ')} - the destination directory is mutated before the failure.`);
  }

  // -------------------------------------------------------------------------
  // Chat render signature: the same-length capped update fix in cto.js and
  // tabs/chat.js. The expression is read out of the real sources rather than
  // reimplemented here, and only after a strict shape match.
  // -------------------------------------------------------------------------
  function extractChatSignature(relPath) {
    const text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    const match = text.match(/const sig = (JSON\.stringify\(\[shown,\s*\[\.\.\.expanded\],\s*\[\.\.\.expandedText\],\s*merged\]\))\s*;/);
    return match ? match[1] : null;
  }

  const signatureSources = ['ui/views/cto.js', 'ui/views/tabs/chat.js'];
  const signatures = signatureSources.map((relPath) => {
    const expression = extractChatSignature(relPath);
    ok(expression, `same-length chat signature expression is present in ${relPath}`);
    // eslint-disable-next-line no-new-func
    return new Function('shown', 'expanded', 'expandedText', 'merged', `return ${expression};`);
  });
  const asSet = (...items) => new Set(items);
  const thread = (lastText) => [
    { key: 'm1', text: 'first bubble', ts: '2026-09-16T10:00:00.000Z' },
    { key: 'm2', text: lastText, ts: '2026-09-16T10:00:01.000Z' },
  ];
  for (let index = 0; index < signatures.length; index += 1) {
    const label = signatureSources[index];
    const sig = signatures[index];
    const base = sig(40, asSet('open'), asSet('long'), thread('aaaa'));
    neq(base, sig(40, asSet('open'), asSet('long'), thread('bbbb')), `${label}: a same-length capped update changes the signature`);
    neq(base, sig(40, asSet('open'), asSet('long'), thread('aaaaa')), `${label}: a grown update changes the signature`);
    neq(base, sig(41, asSet('open'), asSet('long'), thread('aaaa')), `${label}: a shown-count change changes the signature`);
    neq(base, sig(40, asSet('open', 'more'), asSet('long'), thread('aaaa')), `${label}: an expanded-set change changes the signature`);
    eq(base, sig(40, asSet('open'), asSet('long'), thread('aaaa')), `${label}: identical state yields an identical signature`);
  }
  eq(signatures[0](40, asSet('open'), asSet('long'), thread('aaaa')), signatures[1](40, asSet('open'), asSet('long'), thread('aaaa')),
    'cto.js and tabs/chat.js derive the same chat signature');

  console.log(`history recovery tests passed: ${checks} assertions covering additive import, destination preservation, backups, file copy, repeated runs and CLI edge cases.`);
  if (observations.length) {
    console.log('Observed CLI edge behavior:');
    for (const line of observations) console.log(`  - ${line}`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
