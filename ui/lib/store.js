// Application state: agents, usage summary, public config, selection.
// Views subscribe to the events they care about; nothing re-renders globally.

class Emitter {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { const s = this.map.get(evt); if (s) s.delete(fn); }
  emit(evt, payload) {
    const s = this.map.get(evt);
    if (!s) return;
    for (const fn of Array.from(s)) {
      try { fn(payload); } catch (err) { console.error(`[store] listener for "${evt}" failed`, err); }
    }
  }
}

export const store = new Emitter();

/** @type {Map<string, object>} */
const agents = new Map();
let usage = null;
let config = null;
let selectedId = null;

export function setState({ agents: list, usage: u, config: c }) {
  if (Array.isArray(list)) {
    agents.clear();
    for (const a of list) if (a && a.id) agents.set(a.id, a);
  }
  if (u) usage = u;
  if (c) config = c;
  store.emit('agents', getAgents());
  if (u) store.emit('usage', usage);
  if (c) store.emit('config', config);
}

export function upsertAgent(agent) {
  if (!agent || !agent.id) return;
  agents.set(agent.id, agent);
  store.emit('agent', agent);
  store.emit('agents', getAgents());
}

export function removeAgent(id) {
  if (agents.delete(id)) store.emit('agents', getAgents());
}

export function setUsage(u) {
  if (!u) return;
  usage = u;
  store.emit('usage', usage);
}

export function getAgent(id) { return agents.get(id) || null; }
export function getAgents() { return Array.from(agents.values()); }
export function getUsage() { return usage; }
export function getConfig() { return config; }

export function getSelectedId() { return selectedId; }
export function select(id) {
  if (selectedId === id) return;
  selectedId = id;
  store.emit('select', id);
}

/**
 * Order agents into a depth-first tree using parentId.
 * Orphans (parentId pointing at an unknown agent) are treated as roots so
 * nothing ever disappears from the operator's view.
 * @returns {{agent: object, depth: number, isLast: boolean, ancestorsLast: boolean[]}[]}
 */
export function treeOrder(list = getAgents()) {
  const byId = new Map(list.map((a) => [a.id, a]));
  const children = new Map();
  const roots = [];
  for (const a of list) {
    const pid = a.parentId && byId.has(a.parentId) && a.parentId !== a.id ? a.parentId : null;
    if (pid) {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(a);
    } else {
      roots.push(a);
    }
  }
  const rank = { cto: 0, orchestrator: 1, worker: 2 };
  const cmp = (x, y) => {
    const rx = rank[x.role] ?? 3, ry = rank[y.role] ?? 3;
    if (rx !== ry) return rx - ry;
    return String(x.createdAt || '').localeCompare(String(y.createdAt || '')) ||
           String(x.id).localeCompare(String(y.id));
  };
  roots.sort(cmp);
  for (const arr of children.values()) arr.sort(cmp);

  const out = [];
  const seen = new Set();
  const walk = (node, depth, ancestorsLast, isLast) => {
    if (seen.has(node.id)) return; // cycle guard
    seen.add(node.id);
    out.push({ agent: node, depth, isLast, ancestorsLast: ancestorsLast.slice() });
    const kids = children.get(node.id) || [];
    kids.forEach((k, i) => walk(k, depth + 1, ancestorsLast.concat(isLast), i === kids.length - 1));
  };
  roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
  // Anything unreachable (shouldn't happen after the orphan rule) gets appended.
  for (const a of list) if (!seen.has(a.id)) out.push({ agent: a, depth: 0, isLast: true, ancestorsLast: [] });
  return out;
}

export const ACTIVE_STATUSES = new Set(['running', 'queued', 'idle']);
export function isLive(agent) {
  return Boolean(agent) && (agent.status === 'running' || agent.status === 'queued');
}
