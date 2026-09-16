/** Local Codex rollout reader. Cumulative token_count snapshots are not invoices. */
import fs from 'node:fs';
import path from 'node:path';
import { config, expandHome, costOf, priceFor, markerFor, pricing, resolveModel } from './config.js';

const zero = () => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, fableEquivalentUsd: 0 });
const number = n => Number.isFinite(n) && n >= 0 ? n : 0;
const tokenKeys = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];
const cache = new Map();
function sameCwd(a, b) {
  if (!a || !b) return false;
  const normalize = p => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}
function* rollouts(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* rollouts(file);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
  }
}

/** Explicit ids never fall back to another session. Ambiguous discoveries stay unbound. */
export function locateCodexSession(agent) {
  if (agent.sessionId && path.isAbsolute(agent.sessionId)) {
    try { return fs.statSync(agent.sessionId).isFile() ? { file: agent.sessionId } : null; } catch { return null; }
  }
  const root = expandHome(config.runtimes.codex?.transcriptRoot || '~/.codex/sessions');
  const started = Date.parse(agent.startedAt || '');
  if (!agent.sessionId && (!agent.cwd || !Number.isFinite(started))) return null;
  const matches = [];
  for (const file of rollouts(root)) {
    if (agent.sessionId && !path.basename(file).includes(agent.sessionId)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!agent.sessionId && st.mtimeMs < started - 2000) continue;
    const parsed = readCodexTranscript(file, { withMessages: true });
    if (agent.sessionId) {
      if (parsed.sessionId === agent.sessionId) return { file, id: parsed.sessionId };
      continue;
    }
    const created = Date.parse(parsed.startedAt || '');
    if (!sameCwd(parsed.cwd, agent.cwd) || !Number.isFinite(created) || created < started - 2000 || created > started + 120000) continue;
    // A subagent inherits its parent's cwd and brief. It must never become the parent.
    if (parsed.isSubagent) continue;
    matches.push({ file, id: parsed.sessionId, marker: !!agent.id && parsed.messages.some(m => m.role === 'user' && m.text.includes(agent.id)) });
  }
  const marked = matches.filter(m => m.marker);
  return agent.id ? (marked.length === 1 ? marked[0] : null) : (matches.length === 1 ? matches[0] : null);
}

export function readCodexTranscript(file, { withMessages = false } = {}) {
  const out = { usage: zero(), byModel: {}, messages: [], sessionId: null, model: null, cwd: null, startedAt: null, lastRole: null, lastStop: null, lastAssistantAt: null, final: null };
  let st, text;
  try { st = fs.statSync(file); } catch { return out; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return withMessages ? hit.value : { ...hit.value, messages: [] };
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  let prior = zero();
  const seen = new Set();
  const add = (role, value, ts, id) => {
    if (typeof value !== 'string' || !value.trim()) return;
    // Some CLI versions mirror an agent_message as a response_item message.
    const key = id || `${role}:${ts}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.messages.push({ role, text: value, ts });
  };
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; } // tolerate the actively-written final line
    const p = e.payload || {};
    if (e.type === 'session_meta' && !out.sessionId) {
      out.sessionId = p.id || p.session_id || null;
      out.cwd = p.cwd || null;
      out.startedAt = p.timestamp || e.timestamp;
      out.isSubagent = !!p.parent_thread_id || (typeof p.source === 'object' && !!p.source?.subagent);
    } else if (e.type === 'turn_context') {
      out.model = p.model || out.model;
    } else if (e.type === 'event_msg') {
      if (p.type === 'token_count') {
        if (p.rate_limits) { out.usage.limits = p.rate_limits; out.usage.limitsObservedAt = e.timestamp || null; }
        const t = p.info?.total_token_usage;
        if (!t) continue;
        const input = number(t.input_tokens), cached = Math.min(input, number(t.cached_input_tokens));
        const written = Math.min(input - cached, number(t.cache_write_input_tokens));
        const current = { inputTokens: input - cached - written, cacheReadTokens: cached, cacheWriteTokens: written, outputTokens: number(t.output_tokens) };
        // Output already includes reasoning; input already includes cached input.
        // Sum only deltas between cumulative snapshots, including repeated snapshots.
        const model = resolveModel(out.model) || 'unknown';
        const bucket = out.byModel[model] || (out.byModel[model] = zero());
        const deltaUsage = {};
        for (const k of tokenKeys) { const delta = Math.max(0, current[k] - prior[k]); deltaUsage[k] = delta; bucket[k] += delta; out.usage[k] += delta; }
        const requestInput = p.info?.last_token_usage?.input_tokens ?? (deltaUsage.inputTokens + deltaUsage.cacheReadTokens + deltaUsage.cacheWriteTokens);
        bucket.costUsd += costOf(deltaUsage, model, requestInput);
        for (const k of tokenKeys) prior[k] = Math.max(prior[k], current[k]);
      } else if (p.type === 'task_started' || p.type === 'user_message') {
        out.lastRole = 'user'; out.lastStop = null;
      } else if (p.type === 'task_complete') {
        out.lastRole = 'assistant'; out.lastStop = 'end_turn'; out.lastAssistantAt = e.timestamp;
        out.final = p.last_agent_message || out.final;
      } else if (p.type === 'turn_aborted') {
        out.lastStop = 'aborted';
      }
    } else if (e.type === 'response_item') {
      if (p.type === 'message') {
        const value = (Array.isArray(p.content) ? p.content : []).filter(c => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text').map(c => c.text || '').join('\n');
        if (p.role === 'user' || p.role === 'assistant') {
          add(p.role, value, e.timestamp, p.id);
          out.lastRole = p.role;
          if (p.role === 'user') out.lastStop = null;
          else { out.lastAssistantAt = e.timestamp; if (p.phase === 'final') { out.final = value; out.lastStop = 'end_turn'; } }
        }
      } else if (p.type === 'agent_message') {
        add('assistant', p.text || p.message, e.timestamp, p.id);
        out.lastRole = 'assistant'; out.lastAssistantAt = e.timestamp;
        if (p.phase === 'final') { out.final = p.text || p.message; out.lastStop = 'end_turn'; }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        add('tool', `${p.name || 'tool'} ${String(p.arguments || p.input || '').slice(0, 400)}`, e.timestamp, p.call_id);
        out.lastStop = null;
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        add('tool', `→ ${String(p.output || '').slice(0, 600)}`, e.timestamp, p.call_id && `${p.call_id}:output`);
      }
    }
  }
  out.usage.unpricedModels = [];
  out.usage.unpricedMarkers = [];
  for (const [model, bucket] of Object.entries(out.byModel)) {
    bucket.totalTokens = tokenKeys.reduce((n, k) => n + bucket[k], 0);
    bucket.pricingKnown = !!priceFor(model);
    // Deliberate placeholders are reported apart from unpriced models; see the
    // matching comment in server/usage.js.
    const marker = bucket.pricingKnown ? null : markerFor(model);
    bucket.deliberateMarker = Boolean(marker);
    if (!bucket.pricingKnown) {
      if (marker) out.usage.unpricedMarkers.push({ ...marker, totalTokens: bucket.totalTokens });
      else out.usage.unpricedModels.push(model);
    }
    bucket.fableEquivalentUsd = costOf(bucket, pricing.fableEquivalentModel);
    out.usage.costUsd += bucket.costUsd;
    out.usage.fableEquivalentUsd += bucket.fableEquivalentUsd;
  }
  out.usage.pricingKnown = out.usage.unpricedModels.length === 0;
  out.usage.totalTokens = tokenKeys.reduce((n, k) => n + out.usage[k], 0);
  out.messages = out.messages.slice(-300);
  if (cache.size >= 24) cache.delete(cache.keys().next().value);
  cache.set(file, { stamp, value: out });
  return withMessages ? out : { ...out, messages: [] };
}
