/**
 * Usage readers. Nothing here talks to a network; it reads the transcripts the
 * CLIs already write locally.
 *
 *  - Claude Code: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, one JSON
 *    object per line; assistant lines carry message.usage and message.model.
 *    Streaming can emit several lines with the same message.id, so usage is
 *    keyed by message id and the last value wins.
 *  - DeepSeek Harness: ~/.dsh/storages/session_projcache/sessions/<id>.json,
 *    record.rows.tokenUsage.val.totals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, expandHome, costOf, pricing, resolveModel } from './config.js';
import { emptyUsage } from './db.js';

export function cwdSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeTranscriptPath(cwd, sessionId) {
  const root = expandHome(config.runtimes.claude.transcriptRoot);
  return path.join(root, cwdSlug(cwd), `${sessionId}.jsonl`);
}

function fable(u) {
  return costOf(u, pricing.fableEquivalentModel);
}

/** Parse a Claude transcript. Returns { usage, byModel, messages, lastAssistantAt, lastStop }. */
export function readClaudeTranscript(file, { withMessages = false } = {}) {
  const out = { usage: emptyUsage(), byModel: {}, messages: [], lastAssistantAt: null, lastStop: null, lastRole: null };
  if (!fs.existsSync(file)) return out;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const perMsg = new Map(); // message.id -> { model, usage }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type === 'assistant' && m) {
      if (m.usage && m.id) perMsg.set(m.id, { model: m.model, usage: m.usage });
      out.lastAssistantAt = e.timestamp || out.lastAssistantAt;
      out.lastStop = m.stop_reason ?? out.lastStop;
      out.lastRole = 'assistant';
      if (withMessages) {
        for (const c of (Array.isArray(m.content) ? m.content : [])) {
          if (c.type === 'text' && c.text?.trim()) out.messages.push({ role: 'assistant', text: c.text, ts: e.timestamp });
          else if (c.type === 'tool_use') out.messages.push({ role: 'tool', text: `${c.name} ${JSON.stringify(c.input).slice(0, 400)}`, ts: e.timestamp });
        }
      }
    } else if (e.type === 'user' && m) {
      out.lastRole = 'user';
      if (withMessages) {
        if (typeof m.content === 'string') out.messages.push({ role: 'user', text: m.content, ts: e.timestamp });
        else for (const c of (m.content || [])) {
          if (c.type === 'text' && c.text?.trim()) out.messages.push({ role: 'user', text: c.text, ts: e.timestamp });
          else if (c.type === 'tool_result') {
            const t = typeof c.content === 'string' ? c.content : (c.content || []).map(x => x.text || '').join('\n');
            if (t.trim()) out.messages.push({ role: 'tool', text: `→ ${t.slice(0, 600)}`, ts: e.timestamp });
          }
        }
      }
    }
  }
  for (const { model, usage } of perMsg.values()) {
    const u = {
      inputTokens: usage.input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
    const key = resolveModel(model) || 'unknown';
    const b = out.byModel[key] || (out.byModel[key] = emptyUsage());
    for (const k of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) { b[k] += u[k]; out.usage[k] += u[k]; }
  }
  finalize(out);
  if (withMessages) out.messages = out.messages.slice(-300);
  return out;
}

function finalize(out) {
  let cost = 0, fab = 0;
  for (const [model, b] of Object.entries(out.byModel)) {
    b.totalTokens = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.outputTokens;
    b.costUsd = costOf(b, model);
    b.fableEquivalentUsd = fable(b);
    cost += b.costUsd; fab += b.fableEquivalentUsd;
  }
  const u = out.usage;
  u.totalTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
  u.costUsd = cost; u.fableEquivalentUsd = fab;
}

/** Find the DeepSeek Harness session record for a worker: newest record whose cwd matches and createdAt >= startedAt. */
export function findDshSession(cwd, startedAtMs) {
  const dir = expandHome(config.runtimes.deepseek.sessionStore);
  if (!fs.existsSync(dir)) return null;
  const want = path.resolve(cwd).toLowerCase();
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (startedAtMs && st.mtimeMs < startedAtMs - 5000) continue;
    let j; try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    const id = j.record?.identity || {};
    if (!id.cwd || path.resolve(id.cwd).toLowerCase() !== want) continue;
    if (startedAtMs && id.createdAt && id.createdAt < startedAtMs - 5000) continue;
    if (!best || (id.createdAt || 0) > (best.createdAt || 0)) best = { file: full, createdAt: id.createdAt, id: f.replace(/\.json$/, '').replace(/^session-/, '') };
  }
  return best;
}

export function readDshSession(file, model = 'deepseek-flash') {
  const out = { usage: emptyUsage(), byModel: {}, messages: [], title: null, turns: 0 };
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return out; }
  const rows = j.record?.rows || {};
  const t = rows.tokenUsage?.val?.totals || {};
  const b = {
    inputTokens: t.uncachedInputTokens || 0,
    cacheReadTokens: t.cacheReadTokens || 0,
    cacheWriteTokens: t.cacheWriteTokens || 0,
    outputTokens: t.outputTokens || 0,
  };
  out.byModel[resolveModel(model)] = { ...emptyUsage(), ...b };
  Object.assign(out.usage, b);
  out.title = rows.title?.val || null;
  out.turns = rows.sessionStats?.val?.turns || 0;
  finalize(out);
  return out;
}
