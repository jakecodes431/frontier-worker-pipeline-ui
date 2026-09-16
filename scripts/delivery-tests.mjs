// Focused delivery tests for POST /api/agents/:id/send.
//
// The bug: a one-shot DeepSeek worker holds a live terminal while it runs, so a
// follow-up used to be typed into that stdin and recorded with direction=in — a
// direction GET /api/agents/:id/inbox never reads — and the message vanished from
// `cr inbox`. These tests drive the real server over real HTTP, in-process, on a
// scratch port and scratch data dir.
//
// In-process on purpose: spawning the server (or a PTY) needs named pipes, which the
// workspace sandbox can refuse with EPERM. Everything here is loopback HTTP plus
// node:sqlite, so the checks run anywhere `npm run check` runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-delivery-'));

// The server reads CR_PORT / CR_HOST / CR_DATA_DIR when its modules load, so set them
// before the first import of anything under server/.
const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
process.env.CR_PORT = String(port);
process.env.CR_HOST = '127.0.0.1';
process.env.CR_DATA_DIR = path.join(scratch, 'data');

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let count = 0;
function check(label, fn) { fn(); count++; console.log(`PASS ${label}`); }

async function request(route, body, expected = 200, headers = {}) {
  const r = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  assert.equal(r.status, expected, `${route}: got ${r.status} ${JSON.stringify(j)}`);
  return j;
}

// Importing the server starts it listening on our scratch port/data dir. It spawns
// nothing: every agent below is created with autoStart:false.
const { adapters } = await import('../server/adapters/index.js');
await import('../server/index.js');

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
  if (!up) await sleep(50);
}

try {
  assert.ok(up, 'the in-process control room did not start listening');
  const cwd = root;
  const parent = await request('/api/agents', { name: 'parent', role: 'cto', runtime: 'external', cwd, task: 'own it' }, 201);
  const sendHeaders = { 'x-sender': `agent:${parent.id}` };

  check('deepseek is the one-shot adapter; claude and codex are interactive', () => {
    assert.equal(adapters.deepseek.oneShot, true);
    assert.equal(adapters.claude.oneShot, false);
    assert.equal(adapters.codex.oneShot, false);
  });

  // -- the reported failure: a one-shot DeepSeek follow-up is silently lost ----
  const ds = await request('/api/agents', { name: 'one-shot worker', role: 'worker', runtime: 'deepseek', cwd, task: 'one shot', parentId: parent.id, autoStart: false }, 201);
  const sent = await request(`/api/agents/${ds.id}/send`, { text: 'FOLLOW-UP-ONCE' }, 200, sendHeaders);
  check('one-shot follow-up answers queued:true with the queued message', () => {
    assert.equal(sent.ok, true);
    assert.equal(sent.queued, true);
    assert.equal(sent.message.text, 'FOLLOW-UP-ONCE');
    assert.equal(sent.message.sender, `agent:${parent.id}`);
    assert.equal(sent.message.fromAgentId, parent.id);
  });

  const dsMessages = await request(`/api/agents/${ds.id}/messages`);
  const stored = dsMessages.filter((m) => m.text === 'FOLLOW-UP-ONCE');
  check('follow-up is stored once, on the inbox direction (never direction=in)', () => {
    assert.equal(stored.length, 1);
    assert.equal(stored[0].direction, 'report');
  });

  const dsInbox = await request(`/api/agents/${ds.id}/inbox?ack=0`);
  check('follow-up is visible in the inbox with its real sender', () => {
    const hit = dsInbox.filter((m) => m.text === 'FOLLOW-UP-ONCE');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].sender, `agent:${parent.id}`);
    assert.equal(hit[0].fromAgentId, parent.id);
  });

  const dsAfterSend = (await request(`/api/agents/${ds.id}`)).agent;
  const dsEvents = await request(`/api/agents/${ds.id}/logs`);
  check('no terminal injection and no auto-restart of the one-shot agent', () => {
    assert.equal(dsAfterSend.status, 'queued');
    assert.equal(dsAfterSend.pid ?? null, null);
    assert.ok(!dsEvents.some((e) => e.kind === 'spawned' || e.kind === 'resumed'));
    assert.ok(dsEvents.some((e) => e.kind === 'send' && JSON.parse(e.data).queued === true));
  });

  // -- delivery exactly once, ack scoped to this agent's unread reports -------
  const acked = await request(`/api/agents/${ds.id}/inbox?ack=1`);
  check('ack returns the unread follow-up once', () => assert.equal(acked.filter((m) => m.text === 'FOLLOW-UP-ONCE').length, 1));
  const afterAck = await request(`/api/agents/${ds.id}/inbox?ack=1`);
  check('ack clears only the intended unread entry (no redelivery)', () => assert.equal(afterAck.length, 0));
  const history = await request(`/api/agents/${ds.id}/messages`);
  check('ack does not delete history; the message is still stored exactly once', () => assert.equal(history.filter((m) => m.text === 'FOLLOW-UP-ONCE').length, 1));

  const dsA = await request('/api/agents', { name: 'one-shot A', role: 'worker', runtime: 'deepseek', cwd, task: 'a', parentId: parent.id, autoStart: false }, 201);
  const dsB = await request('/api/agents', { name: 'one-shot B', role: 'worker', runtime: 'deepseek', cwd, task: 'b', parentId: parent.id, autoStart: false }, 201);
  await request(`/api/agents/${dsA.id}/send`, { text: 'FOR-A' }, 200, sendHeaders);
  await request(`/api/agents/${dsB.id}/send`, { text: 'FOR-B' }, 200, sendHeaders);
  const firstA = await request(`/api/agents/${dsA.id}/inbox?ack=1`);
  check('inbox returns this agent\'s unread report once', () => assert.equal(firstA.filter((m) => m.text === 'FOR-A').length, 1));
  const bInbox = await request(`/api/agents/${dsB.id}/inbox?ack=0`);
  check('acking one agent leaves another agent\'s unread report untouched', () => assert.equal(bInbox.filter((m) => m.text === 'FOR-B').length, 1));
  await request(`/api/agents/${dsA.id}/send`, { text: 'FOR-A-2' }, 200, sendHeaders);
  const secondA = await request(`/api/agents/${dsA.id}/inbox?ack=1`);
  check('an already-acked entry is not redelivered while a newer one is', () => {
    assert.equal(secondA.filter((m) => m.text === 'FOR-A-2').length, 1);
    assert.equal(secondA.filter((m) => m.text === 'FOR-A').length, 0);
  });

  // -- a human-held agent refuses, and the refusal is truly visible ----------
  const claude = await request('/api/agents', { name: 'interactive claude', role: 'orchestrator', runtime: 'claude', cwd, task: 'interactive', autoStart: false }, 201);
  await request(`/api/agents/${claude.id}/control`, { holder: 'human' });
  const refused = await request(`/api/agents/${claude.id}/send`, { text: 'REFUSED-TEXT' }, 409, sendHeaders);
  check('human-held refusal keeps the refusal text and reports queued', () => {
    assert.match(refused.error, /a human holds control of this agent; message queued to its inbox instead/);
    assert.equal(refused.queued, true);
    assert.equal(refused.message.text, 'REFUSED-TEXT');
    assert.equal(refused.message.sender, `agent:${parent.id}`);
    assert.equal(refused.message.direction, 'report');
  });
  const refusedInbox = await request(`/api/agents/${claude.id}/inbox?ack=0`);
  check('human-held refusal is truly visible in the inbox', () => assert.equal(refusedInbox.filter((m) => m.text === 'REFUSED-TEXT').length, 1));
  await request(`/api/agents/${claude.id}/control`, { holder: 'parent' });

  // -- interactive Claude/Codex behavior is untouched ------------------------
  const claudeSend = await request(`/api/agents/${claude.id}/send`, { text: 'INTERACTIVE-CLAUDE' }, 409, sendHeaders);
  check('Claude with no live terminal is still refused, not queued', () => {
    assert.match(claudeSend.error, /has no live terminal/);
    assert.equal(claudeSend.queued, undefined);
    assert.equal(claudeSend.message, undefined);
  });
  const claudeInbox = await request(`/api/agents/${claude.id}/inbox?ack=0`);
  check('the refused interactive text was not queued to the inbox', () => assert.equal(claudeInbox.filter((m) => m.text === 'INTERACTIVE-CLAUDE').length, 0));

  const codex = await request('/api/agents', { name: 'interactive codex', role: 'orchestrator', runtime: 'codex', cwd, task: 'interactive', autoStart: false }, 201);
  const codexSend = await request(`/api/agents/${codex.id}/send`, { text: 'INTERACTIVE-CODEX' }, 409, sendHeaders);
  check('Codex with no live terminal is still refused, not queued', () => {
    assert.match(codexSend.error, /has no live terminal/);
    assert.equal(codexSend.queued, undefined);
  });
  const codexMessages = await request(`/api/agents/${codex.id}/messages`);
  check('no interactive message was recorded for the refused Codex send', () => assert.equal(codexMessages.filter((m) => m.text === 'INTERACTIVE-CODEX').length, 0));

  // -- external registrations keep their exact queued-to-inbox contract ------
  const external = await request('/api/agents', { name: 'external cto', role: 'cto', runtime: 'external', cwd, task: 'registered' }, 201);
  const externalSend = await request(`/api/agents/${external.id}/send`, { text: 'EXTERNAL-QUEUED' }, 200, sendHeaders);
  check('external registration still queues to its inbox and returns queued:true', () => {
    assert.equal(externalSend.queued, true);
    assert.equal(externalSend.message.text, 'EXTERNAL-QUEUED');
    assert.equal(externalSend.message.direction, 'report');
    assert.equal(externalSend.message.fromAgentId, parent.id);
  });
  const externalInbox = await request(`/api/agents/${external.id}/inbox?ack=0`);
  check('external message reaches the inbox', () => assert.equal(externalInbox.filter((m) => m.text === 'EXTERNAL-QUEUED').length, 1));

  // -- real sender and validation on the one-shot path -----------------------
  const humanSend = await request(`/api/agents/${dsB.id}/send`, { text: 'FROM-HUMAN' });
  check('a human follow-up to a one-shot worker is queued with the real sender', () => {
    assert.equal(humanSend.queued, true);
    assert.equal(humanSend.message.sender, 'human');
    assert.equal(humanSend.message.fromAgentId, null);
  });
  const empty = await request(`/api/agents/${ds.id}/send`, { text: '   ' }, 400, sendHeaders);
  check('empty follow-up is still refused with 400', () => assert.match(empty.error, /text is required/));

  console.log(`${count} delivery checks passed`);
  process.exitCode = 0;
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  // The in-process sqlite handle keeps the scratch DB open; removal is best-effort and
  // never allowed to hide the test result.
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* windows keeps the open db */ }
}

// The listening server and its 5s refresh timer keep the loop alive; end explicitly.
// Let in-flight sockets settle first, otherwise Windows libuv can abort on exit.
await sleep(150);
process.exit(process.exitCode || 0);
