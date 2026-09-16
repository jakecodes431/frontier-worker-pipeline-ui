// Focused tests for the queued local delivery path (problem: a message to a
// one-shot local model stayed marked "queued" and never reached the model).
//
// The durable inbox direction already existed; these checks drive the part that
// consumes it: a queued message is stored once, a fresh local run is started
// with the message in its prompt (never stdin), and the message is marked read
// only after that run really starts. A refused or failed dispatch stays unread
// and retryable; external sessions are never dispatched to.
//
// Everything runs in-process over loopback HTTP plus node:sqlite. The local
// worker's configured script is pointed at a path that does not exist, so a
// real dispatch fails at build time — before any pty is created — which is
// exactly the "refused delivery" branch. Success is exercised by injecting the
// spawn function, so no model runs and no tokens are spent anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-queued-delivery-'));

// A scratch config whose DeepSeek worker points at a file that cannot exist.
// `adapters.deepseek.build` refuses before spawning, so the failure path is real
// without a pty, a model, or a token.
const cfgDir = path.join(scratch, 'config');
fs.mkdirSync(cfgDir);
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/runtimes.json'), 'utf8'));
cfg.runtimes.deepseek.args = [path.join(scratch, 'not-installed-worker-cli.js'), '--profile', 'headless', '{prompt}'];
fs.writeFileSync(path.join(cfgDir, 'runtimes.json'), JSON.stringify(cfg));

const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
process.env.CR_PORT = String(port);
process.env.CR_HOST = '127.0.0.1';
process.env.CR_DATA_DIR = path.join(scratch, 'data');
process.env.CR_CONFIG_DIR = cfgDir;

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

const { adapters } = await import('../server/adapters/index.js');
const { buildDeliveryPrompt, deliverQueued, deliveryEligibility, maybeDeliverAfterExit } = await import('../server/index.js');
const { agents, messages } = await import('../server/db.js');

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
  if (!up) await sleep(50);
}

const createDeepseek = (name, extra = {}) => request('/api/agents', {
  name, role: 'worker', runtime: 'deepseek', cwd: root, task: name, autoStart: false, ...extra,
}, 201);

try {
  assert.ok(up, 'the in-process control room did not start listening');
  const parent = await request('/api/agents', { name: 'delivery parent', role: 'cto', runtime: 'external', cwd: root, task: 'own it' }, 201);
  const sendHeaders = { 'x-sender': `agent:${parent.id}` };

  // -- the decision is pure and names every refusal --------------------------
  check('deepseek is the one-shot local adapter under test', () => assert.equal(adapters.deepseek.oneShot, true));
  check('a finished managed local agent is eligible for delivery', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'deepseek', status: 'done' }, { live: false });
    assert.equal(g.ok, true);
  });
  check('external sessions can never be dispatched to', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'external', status: 'done' }, { live: false });
    assert.equal(g.ok, false);
    assert.match(g.reason, /external/);
  });
  check('a live terminal defers delivery instead of injecting stdin', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'deepseek', status: 'running' }, { live: true });
    assert.equal(g.ok, false);
    assert.equal(g.live, true);
    assert.match(g.reason, /live terminal/);
  });
  check('human control defers delivery', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'deepseek', status: 'done', controlledBy: 'human' }, { live: false });
    assert.equal(g.ok, false);
    assert.match(g.reason, /human/);
  });
  check('human control does not block the human operator\'s own dispatch', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'deepseek', status: 'done', controlledBy: 'human' }, { live: false, allowHumanControl: true });
    assert.equal(g.ok, true);
  });
  check('a paused agent defers delivery', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'deepseek', status: 'paused' }, { live: false });
    assert.equal(g.ok, false);
    assert.match(g.reason, /paused/);
  });
  check('a continued task defers to its successor', () => {
    const g = deliveryEligibility({ id: 'a', runtime: 'deepseek', status: 'done', successorId: 'next' }, { live: false });
    assert.equal(g.ok, false);
    assert.match(g.reason, /next/);
  });
  check('the delivery prompt keeps the brief, the order and each sender', () => {
    const prompt = buildDeliveryPrompt({ id: 'a', prompt: 'ORIGINAL-BRIEF' }, [
      { id: 1, sender: 'agent:p', text: 'first instruction', createdAt: '2026-09-16T10:00:00.000Z' },
      { id: 2, sender: 'human', text: 'second instruction', createdAt: '2026-09-16T10:00:01.000Z' },
    ]);
    assert.match(prompt, /ORIGINAL-BRIEF/);
    assert.match(prompt, /agent:p/);
    assert.match(prompt, /human/);
    assert.ok(prompt.indexOf('first instruction') < prompt.indexOf('second instruction'), 'messages must keep their order');
  });

  // -- a refused dispatch is reported and stays retryable --------------------
  const ds = await createDeepseek('finished one-shot', { parentId: parent.id });
  await request(`/api/agents/${ds.id}/status`, { status: 'done' });
  const sent = await request(`/api/agents/${ds.id}/send`, { text: 'DELIVER-ME' }, 200, sendHeaders);
  check('a refused dispatch is reported, never claimed as delivered', () => {
    assert.equal(sent.ok, true);
    assert.equal(sent.queued, true);
    assert.equal(sent.delivered, false);
    assert.match(sent.deliveryError, /worker CLI was not found/);
  });
  const inboxAfterFail = await request(`/api/agents/${ds.id}/inbox?ack=0`);
  check('a refused dispatch stays unread and retryable', () => assert.equal(inboxAfterFail.filter((m) => m.text === 'DELIVER-ME').length, 1));
  const dsEvents = await request(`/api/agents/${ds.id}/logs`);
  check('the refused dispatch is recorded as a delivery error', () => assert.ok(dsEvents.some((e) => e.kind === 'delivery-error' && /worker CLI/.test(e.data))));
  check('the refused dispatch did not start a run', () => {
    const fresh = agents.get(ds.id);
    assert.equal(fresh.status, 'done');
    assert.equal(fresh.pid ?? null, null);
  });
  check('the queued message keeps its real sender', () => {
    const pending = messages.pendingDelivery(ds.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sender, `agent:${parent.id}`);
    assert.equal(pending[0].fromAgentId, parent.id);
  });

  // -- a successful run consumes the queue, in order, and acks --------------
  const calls = [];
  const delivered = await deliverQueued(agents.get(ds.id), { spawn: async (a, opts) => { calls.push({ id: a.id, opts }); } });
  check('a started local run consumes the queued input', () => {
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.count, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, ds.id);
    assert.match(calls[0].opts.prompt, /DELIVER-ME/);
  });
  const inboxAfterOk = await request(`/api/agents/${ds.id}/inbox?ack=0`);
  check('the consumed message is acknowledged exactly once', () => assert.equal(inboxAfterOk.filter((m) => m.text === 'DELIVER-ME').length, 0));
  const deliveredEvents = await request(`/api/agents/${ds.id}/logs`);
  check('the successful delivery is recorded', () => assert.ok(deliveredEvents.some((e) => e.kind === 'delivered')));
  const stillStored = await request(`/api/agents/${ds.id}/messages`);
  check('acknowledgement never deletes history', () => assert.equal(stillStored.filter((m) => m.text === 'DELIVER-ME').length, 1));

  // -- ordering across several queued messages -------------------------------
  const dsOrder = await createDeepseek('ordered one-shot');
  await request(`/api/agents/${dsOrder.id}/status`, { status: 'done' });
  await request(`/api/agents/${dsOrder.id}/send`, { text: 'FIRST-INPUT' }, 200, sendHeaders);
  await request(`/api/agents/${dsOrder.id}/send`, { text: 'SECOND-INPUT' }, 200, sendHeaders);
  assert.equal(messages.pendingDelivery(dsOrder.id).filter((m) => m.text === 'FIRST-INPUT').length, 1);
  const orderCalls = [];
  const orderResult = await deliverQueued(agents.get(dsOrder.id), { spawn: async (a, opts) => { orderCalls.push(opts.prompt); } });
  check('two queued messages are delivered together in id order', () => {
    assert.equal(orderResult.delivered, true);
    assert.equal(orderResult.count, 2);
    const prompt = orderCalls[0];
    assert.ok(prompt.indexOf('FIRST-INPUT') < prompt.indexOf('SECOND-INPUT'));
  });
  check('both ordered messages are acknowledged', () => assert.equal(messages.pendingDelivery(dsOrder.id).length, 0));

  // -- a report is not operator input and is not dispatched ------------------
  const dsReport = await createDeepseek('reported one-shot');
  await request(`/api/agents/${dsReport.id}/status`, { status: 'done' });
  await request(`/api/agents/${dsReport.id}/report`, { text: 'CHILD-REPORT' });
  await request(`/api/agents/${dsReport.id}/send`, { text: 'OPERATOR-INPUT' }, 200, sendHeaders);
  const reportCalls = [];
  await deliverQueued(agents.get(dsReport.id), { spawn: async (a, opts) => { reportCalls.push(opts.prompt); } });
  check('a child report is not dispatched as an instruction', () => {
    assert.equal(reportCalls.length, 1);
    assert.doesNotMatch(reportCalls[0], /CHILD-REPORT/);
    assert.match(reportCalls[0], /OPERATOR-INPUT/);
  });
  check('the child report stays unread for the agent to read', () => assert.equal(messages.pendingDelivery(dsReport.id).length, 0));
  const reportInbox = await request(`/api/agents/${dsReport.id}/inbox?ack=0`);
  check('the child report is still in the inbox', () => assert.equal(reportInbox.filter((m) => m.text === 'CHILD-REPORT').length, 1));

  // -- a message to an unstarted agent waits for its start -------------------
  const unstarted = await createDeepseek('never started');
  const waiting = await request(`/api/agents/${unstarted.id}/send`, { text: 'WAITING-INPUT' }, 200, sendHeaders);
  check('an unstarted agent keeps the message instead of auto-starting', () => {
    assert.equal(waiting.queued, true);
    assert.equal(waiting.delivered, false);
    assert.equal(waiting.deliveryError, undefined);
    assert.match(waiting.deliveryReason, /has not started/);
    assert.equal(agents.get(unstarted.id).status, 'queued');
  });
  const startCalls = [];
  const started = await deliverQueued(agents.get(unstarted.id), { spawn: async (a, opts) => { startCalls.push(opts.prompt); } });
  check('an explicit start consumes the waiting message', () => {
    assert.equal(started.delivered, true);
    assert.match(startCalls[0], /WAITING-INPUT/);
  });

  // -- external sessions and human control are never dispatched to -----------
  const external = await request('/api/agents', { name: 'registered cto', role: 'cto', runtime: 'external', cwd: root, task: 'registered' }, 201);
  const externalSend = await request(`/api/agents/${external.id}/send`, { text: 'EXTERNAL-INPUT' }, 200, sendHeaders);
  check('an external send still queues without pretending to dispatch', () => {
    assert.equal(externalSend.queued, true);
    assert.equal(externalSend.delivered, undefined);
  });
  let externalSpawns = 0;
  const externalDelivery = await deliverQueued(agents.get(external.id), { spawn: async () => { externalSpawns += 1; } });
  check('an external session is never spawned for delivery', () => {
    assert.equal(externalDelivery.delivered, false);
    assert.equal(externalSpawns, 0);
    assert.match(externalDelivery.reason, /nothing is queued/);
  });
  const externalAfter = await request(`/api/agents/${external.id}/inbox?ack=0`);
  check('the external message is still reviewable in its inbox', () => assert.equal(externalAfter.filter((m) => m.text === 'EXTERNAL-INPUT').length, 1));

  const claude = await request('/api/agents', { name: 'human held', role: 'orchestrator', runtime: 'claude', cwd: root, task: 'interactive', autoStart: false }, 201);
  await request(`/api/agents/${claude.id}/control`, { holder: 'human' });
  const refused = await request(`/api/agents/${claude.id}/send`, { text: 'HUMAN-HELD' }, 409, sendHeaders);
  check('a human-held refusal is stored for review, never auto-delivered', () => {
    assert.equal(refused.queued, true);
    assert.equal(refused.message.text, 'HUMAN-HELD');
    assert.equal(messages.pendingDelivery(claude.id).length, 0);
  });
  let humanSpawns = 0;
  const humanDelivery = await deliverQueued(agents.get(claude.id), { spawn: async () => { humanSpawns += 1; } });
  check('human-held input is not dispatched', () => {
    assert.equal(humanDelivery.delivered, false);
    assert.equal(humanSpawns, 0);
  });

  // A human who owns a one-shot agent may still dispatch their own message:
  // the guard keeps agent input from racing a human prompt, not the human.
  const heldOneShot = await createDeepseek('human held one-shot');
  await request(`/api/agents/${heldOneShot.id}/status`, { status: 'done' });
  await request(`/api/agents/${heldOneShot.id}/control`, { holder: 'human' });
  const humanOneShot = await request(`/api/agents/${heldOneShot.id}/send`, { text: 'HUMAN-ONE-SHOT' }, 200);
  check('a human send to a held one-shot is queued and attempted', () => {
    assert.equal(humanOneShot.queued, true);
    assert.equal(humanOneShot.delivered, false);
    assert.match(humanOneShot.deliveryError, /worker CLI was not found/);
  });
  let heldSpawns = 0;
  const blocked = await deliverQueued(agents.get(heldOneShot.id), { spawn: async () => { heldSpawns += 1; } });
  check('agent input is still blocked while a human holds the prompt', () => {
    assert.equal(blocked.delivered, false);
    assert.match(blocked.reason, /human holds control/);
    assert.equal(heldSpawns, 0);
  });
  const heldCalls = [];
  const heldResult = await deliverQueued(agents.get(heldOneShot.id), { allowHumanControl: true, spawn: async (a, opts) => { heldCalls.push(opts.prompt); } });
  check('the human operator can dispatch their own queued message', () => {
    assert.equal(heldResult.delivered, true);
    assert.match(heldCalls[0], /HUMAN-ONE-SHOT/);
  });

  // -- a one-shot exit consumes what was queued while it ran -----------------
  const exiting = await createDeepseek('exiting one-shot');
  await request(`/api/agents/${exiting.id}/status`, { status: 'done' });
  await request(`/api/agents/${exiting.id}/send`, { text: 'EXIT-INPUT' }, 200, sendHeaders);
  const exitCalls = [];
  const exitResult = await maybeDeliverAfterExit(exiting.id, { spawn: async (a, opts) => { exitCalls.push(opts.prompt); } });
  check('a one-shot exit starts the follow-up that consumes queued input', () => {
    assert.equal(exitResult.delivered, true);
    assert.equal(exitCalls.length, 1);
    assert.match(exitCalls[0], /EXIT-INPUT/);
  });
  const stopped = await createDeepseek('deliberately stopped');
  await request(`/api/agents/${stopped.id}/status`, { status: 'done' });
  await request(`/api/agents/${stopped.id}/send`, { text: 'STOP-NO-CONTINUE' }, 200, sendHeaders);
  let stopSpawns = 0;
  const stopResult = await maybeDeliverAfterExit(stopped.id, { wasStopping: true, spawn: async () => { stopSpawns += 1; } });
  check('an explicit stop is never auto-continued', () => {
    assert.equal(stopResult.delivered, false);
    assert.equal(stopSpawns, 0);
    assert.match(stopResult.reason, /stopped on purpose/);
  });
  check('the stopped agent\'s message is still retryable', () => assert.equal(messages.pendingDelivery(stopped.id).length, 1));

  // -- db helpers refuse to fabricate acks -----------------------------------
  check('acking an empty id set changes nothing', () => assert.equal(messages.ackIds([]), 0));
  check('acking the wrong agent leaves the target unread', () => {
    assert.equal(messages.ackIds([messages.pendingDelivery(stopped.id)[0].id + 100000]), 0);
    assert.equal(messages.pendingDelivery(stopped.id).length, 1);
  });

  console.log(`${count} queued-delivery checks passed`);
  process.exitCode = 0;
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* windows keeps the open db */ }
}

await sleep(150);
process.exit(process.exitCode || 0);
