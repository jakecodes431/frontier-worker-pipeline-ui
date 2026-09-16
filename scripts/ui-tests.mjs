import assert from 'node:assert/strict';
import { usageCost, tokens } from '../ui/lib/format.js';
import { runtimeNames, runtimeEfforts, continuationProvider } from '../ui/views/newagent.js';
import { ctoAgent } from '../ui/views/cto.js';
import { setState } from '../ui/lib/store.js';
import api, { ApiError } from '../ui/lib/api.js';

// Missing pricing must not look like free usage, while a measured zero stays zero.
assert.equal(usageCost({ costUsd: 0, pricingKnown: false }), 'Unpriced');
assert.equal(usageCost({ costUsd: 0, pricingKnown: true }), '$0.00');
assert.equal(usageCost({}), 'not available');
assert.equal(tokens(undefined), 'not available');
assert.equal(tokens(0), '0');

const config = { runtimes: { codex: { efforts: ['low', 'xhigh'] }, external: {} } };
assert.deepEqual(runtimeNames(config), ['codex', 'external']);
assert.deepEqual(runtimeEfforts(config, 'codex'), ['low', 'xhigh']);
assert.deepEqual(runtimeEfforts(config, 'external'), []);
assert.ok(runtimeNames().includes('codex'));
assert.equal(continuationProvider({ runtime: 'codex', transcriptRuntime: 'claude' }, ['claude', 'codex']), 'claude');
assert.equal(continuationProvider({ runtime: 'external', transcriptRuntime: 'codex' }, ['claude', 'codex']), 'claude');
assert.equal(continuationProvider({ runtime: 'claude' }, ['claude', 'codex']), 'codex');

// Keeping old CTO history must not leave its successor hidden in the CTO view.
setState({ agents: [
  { id: 'old', role: 'cto', successorId: 'next', createdAt: '2026-09-16T09:00:00Z' },
  { id: 'worker', role: 'worker', createdAt: '2026-09-16T11:00:00Z' },
  { id: 'next', role: 'cto', createdAt: '2026-09-16T10:00:00Z' },
] });
assert.equal(ctoAgent().id, 'next');
setState({ agents: [] });
assert.equal(ctoAgent(), null);

const originalFetch = globalThis.fetch;
try {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: 'successor', runtime: 'codex' }), { status: 201 });
  };
  const payload = { runtime: 'codex', autoStart: false, effort: 'xhigh' };
  assert.equal((await api.handoff('old/id', payload)).id, 'successor');
  assert.equal(request.url, '/api/agents/old%2Fid/handoff');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), payload);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Stop the live terminal first' }), { status: 409 });
  await assert.rejects(api.handoff('old', payload), (err) => err instanceof ApiError && err.status === 409 && err.message === 'Stop the live terminal first');
} finally { globalThis.fetch = originalFetch; }

console.log('UI contract tests passed: unknown pricing, config choices, CTO successor, handoff request and refusal.');
