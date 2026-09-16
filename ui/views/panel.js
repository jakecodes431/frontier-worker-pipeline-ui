// Agent detail panel: [ Chat ] [ Terminal ] [ Diff ] [ Files ] [ Logs ] [ Extra ]
//
// Chat is what opens. Extra holds what used to be Overview: control handoff,
// run controls, mark status, the agent's fields and its usage breakdown.
//
// The panel is a standalone component, deliberately decoupled from the tree
// renderer: state frames patch the tree without touching this DOM, so the open
// tab, scroll position and the attached terminal all survive re-renders.
// Tab panes are created lazily and then kept alive (hidden) until the panel
// closes or switches agent.

import { h, replace, clear, setText, setAttr, toast } from '../lib/dom.js';
import * as f from '../lib/format.js';
import api from '../lib/api.js';
import { store, getAgent, select } from '../lib/store.js';
import { applyElapsed } from './hierarchy.js';

import { createChatTab } from './tabs/chat.js';
import { createTerminalTab } from './tabs/terminal.js';
import { createDiffTab } from './tabs/diff.js';
import { createFilesTab } from './tabs/files.js';
import { createLogsTab } from './tabs/logs.js';

const TABS = [
  { key: 'chat', label: 'Chat' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'diff', label: 'Diff' },
  { key: 'files', label: 'Files' },
  { key: 'logs', label: 'Logs' },
  { key: 'extra', label: 'Extra' },
];
const DEFAULT_TAB = 'chat';

const ACTIONS = [
  { action: 'interrupt', label: 'Interrupt' },
  { action: 'pause', label: 'Pause' },
  { action: 'resume', label: 'Resume' },
  { action: 'stop', label: 'Stop', danger: true },
  { action: 'restart', label: 'Restart' },
];

let hostEl = null;
let conn = null;
let current = null; // { id, root, tabs: Map, activeKey, head, extra }

export function mountPanel({ host, connection }) {
  hostEl = host;
  conn = connection;

  store.on('select', (id) => { if (id) open(id); else close(); });
  store.on('agent', (agent) => {
    if (!current || agent.id !== current.id) return;
    if (current.extra) current.extra.update(agent);
    current.head.update(agent);
    const tab = current.tabs.get(current.activeKey);
    if (tab && tab.onAgentFrame) tab.onAgentFrame(agent);
  });
  store.on('agents', () => {
    if (!current) return;
    const agent = getAgent(current.id);
    if (!agent) { close(); return; }
    if (current.extra) current.extra.update(agent);
    current.head.update(agent);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && current) { ev.preventDefault(); select(null); }
  });
}

export function open(agentId) {
  if (current && current.id === agentId) return;
  close();
  const agent = getAgent(agentId);
  if (!agent) return;

  const ctx = { agentId, conn, getAgent: () => getAgent(agentId), switchTab: (key) => setActive(key) };

  const head = buildHead(agent);
  const body = h('div', { class: 'panel-body' });
  const root = h('div', { class: 'panel' }, head.el, body);

  current = { id: agentId, root, body, ctx, tabs: new Map(), activeKey: null, head, extra: null };

  replace(hostEl, root);
  hostEl.hidden = false;
  head.update(agent);
  setActive(DEFAULT_TAB);
}

export function close() {
  if (!current) return;
  for (const tab of current.tabs.values()) {
    try { if (tab.deactivate) tab.deactivate(); } catch (e) { console.error(e); }
    try { if (tab.destroy) tab.destroy(); } catch (e) { console.error(e); }
  }
  current = null;
  clear(hostEl);
  hostEl.hidden = true;
}

function setActive(key) {
  if (!current) return;
  if (current.activeKey === key) return;

  const prev = current.tabs.get(current.activeKey);
  if (prev && prev.deactivate) prev.deactivate();
  if (prev) prev.el.hidden = true;

  let tab = current.tabs.get(key);
  if (!tab) {
    tab = makeTab(key, current.ctx);
    current.tabs.set(key, tab);
    if (key === 'extra') current.extra = tab;
    current.body.appendChild(tab.el);
  }
  tab.el.hidden = false;
  current.activeKey = key;
  if (tab.activate) tab.activate();
  current.head.setActive(key);
}

function makeTab(key, ctx) {
  switch (key) {
    case 'chat': return createChatTab(ctx);
    case 'terminal': return createTerminalTab(ctx);
    case 'diff': return createDiffTab(ctx);
    case 'files': return createFilesTab(ctx);
    case 'logs': return createLogsTab(ctx);
    default: return createExtraTab(ctx);
  }
}

// ---------------------------------------------------------------- head

function buildHead(agent) {
  const nameEl = h('h2', { class: 'panel-name' }, agent.name || agent.id);
  const subEl = h('div', { class: 'panel-sub' }, '');
  const chipEl = h('span', { class: 'chip' });
  const closeBtn = h('button', { class: 'btn btn-sm btn-ghost panel-close', onclick: () => select(null), title: 'Close (Esc)' }, 'Close');

  const tabBtns = new Map();
  const tabsEl = h('nav', { class: 'tabs panel-tabs', role: 'tablist', 'aria-label': 'Agent detail' },
    ...TABS.map((t) => {
      const b = h('button', {
        class: 'tab', role: 'tab', 'aria-selected': 'false',
        onclick: () => setActive(t.key),
      }, t.label);
      tabBtns.set(t.key, b);
      return b;
    }));

  const el = h('div', { class: 'panel-head' },
    h('div', { class: 'panel-head-top' },
      h('div', { class: 'panel-ident' }, nameEl, subEl),
      h('div', { class: 'panel-head-actions' }, chipEl, closeBtn)),
    tabsEl);

  return {
    el,
    update(a) {
      setText(nameEl, a.name || a.id);
      setText(subEl, [a.role, a.runtime, a.model, a.effort && ('effort: ' + a.effort), a.id]
        .filter(Boolean).join('  ·  '));
      setAttr(chipEl, 'data-status', a.status || 'queued');
      setText(chipEl, a.status || 'queued');
    },
    setActive(key) {
      for (const [k, b] of tabBtns) setAttr(b, 'aria-selected', k === key ? 'true' : 'false');
    },
  };
}

// --------------------------------------------------------------- extra

function createExtraTab(ctx) {
  const controlWho = h('span', { class: 'control-who' });
  const takeBtn = h('button', { class: 'btn btn-sm' }, 'Take control');
  const returnBtn = h('button', { class: 'btn btn-sm' }, 'Return control');
  const banner = h('div', { class: 'control-banner' },
    controlWho,
    h('div', { class: 'btn-row' }, takeBtn, returnBtn));

  takeBtn.addEventListener('click', () => runControl('human'));
  returnBtn.addEventListener('click', () => runControl('parent'));

  const actionBtns = ACTIONS.map((a) => {
    const b = h('button', { class: 'btn btn-sm' + (a.danger ? ' btn-danger' : '') }, a.label);
    b.addEventListener('click', () => runAction(a.action, b));
    return b;
  });

  const markSelect = h('select', { 'aria-label': 'Mark status' },
    h('option', { value: '' }, 'Mark…'),
    h('option', { value: 'done' }, 'done'),
    h('option', { value: 'blocked' }, 'blocked'),
    h('option', { value: 'failed' }, 'failed'));
  const markNote = h('input', { type: 'text', class: 'mark-note', placeholder: 'optional note' });
  const markBtn = h('button', { class: 'btn btn-sm' }, 'Apply');
  markBtn.addEventListener('click', () => runMark());

  const fieldsEl = h('dl', { class: 'kv' });
  const usageEl = h('dl', { class: 'kv' });
  const noteCard = h('div', { class: 'card', hidden: true });
  const worktreeCard = h('div', { class: 'card', hidden: true });

  const el = h('div', { class: 'pane' },
    banner,
    h('div', { class: 'card' },
      h('h3', { class: 'card-label' }, 'Controls'),
      h('div', { class: 'btn-row', style: { marginBottom: '12px' } }, ...actionBtns),
      h('div', { class: 'btn-row mark-row' },
        h('span', { class: 'mark-label' }, 'Mark status'),
        h('div', { class: 'mark-select' }, markSelect),
        markNote, markBtn)),
    noteCard,
    h('div', { class: 'card' }, h('h3', { class: 'card-label' }, 'Agent'), fieldsEl),
    h('div', { class: 'card' }, h('h3', { class: 'card-label' }, 'Usage breakdown'), usageEl),
    worktreeCard);

  const busy = (on) => {
    for (const b of [takeBtn, returnBtn, markBtn, ...actionBtns]) b.disabled = on;
  };

  async function runControl(holder) {
    busy(true);
    try {
      const a = await api.control(ctx.agentId, holder);
      if (a && a.id) update(a);
      toast(`Control holder set to ${holder}.`, 'ok');
    } catch (err) {
      toast('Control change failed: ' + err.message, 'error');
    } finally { busy(false); }
  }

  async function runAction(action, btn) {
    busy(true);
    const label = btn.textContent;
    btn.textContent = '…';
    try {
      const a = await api.action(ctx.agentId, action);
      if (a && a.id) update(a);
      toast(`${action} sent.`, 'ok');
    } catch (err) {
      toast(`${action} failed: ` + err.message, 'error');
    } finally { btn.textContent = label; busy(false); }
  }

  async function runMark() {
    const status = markSelect.value;
    if (!status) { toast('Pick a status to mark first.', 'error'); return; }
    busy(true);
    try {
      const a = await api.status(ctx.agentId, status, markNote.value.trim() || undefined);
      if (a && a.id) update(a);
      markSelect.value = '';
      markNote.value = '';
      toast(`Marked ${status}.`, 'ok');
    } catch (err) {
      toast('Mark failed: ' + err.message, 'error');
    } finally { busy(false); }
  }

  function update(a) {
    if (!a) return;

    // control banner
    const holder = a.controlledBy === 'human' ? 'human' : 'parent';
    setAttr(banner, 'data-holder', holder);
    replace(controlWho,
      'Controlled by ',
      h('strong', { class: holder === 'human' ? 'who-human' : 'who-parent' }, holder.toUpperCase()),
      holder === 'human'
        ? h('span', { class: 'faint' }, '  — agent senders are rejected with 409')
        : h('span', { class: 'faint' }, '  — the parent drives this agent'));
    takeBtn.disabled = holder === 'human';
    returnBtn.disabled = holder === 'parent';

    // note
    if (a.note) {
      noteCard.hidden = false;
      replace(noteCard, h('h3', { class: 'card-label' }, 'Note'), h('div', { class: 'note-box' }, String(a.note)));
    } else {
      noteCard.hidden = true;
      clear(noteCard);
    }

    // fields
    const elapsedEl = h('dd', { class: 'mono' });
    applyElapsed(elapsedEl, a);

    replace(fieldsEl,
      ...kv('id', h('dd', { class: 'mono' }, a.id)),
      ...kv('parent', h('dd', { class: 'mono' },
        a.parentId
          ? h('a', {
              href: '#', class: 'mono link',
              onclick: (ev) => { ev.preventDefault(); select(a.parentId); },
            }, a.parentId)
          : 'none (root)')),
      ...kv('role', h('dd', null, a.role || '—')),
      ...kv('runtime', h('dd', null, a.runtime || '—')),
      ...kv('model', h('dd', { class: 'mono' }, a.model || '—')),
      ...kv('effort', h('dd', null, a.effort || '—')),
      ...kv('status', h('dd', null, h('span', { class: 'chip', dataset: { status: a.status || 'queued' } }, a.status || 'queued'))),
      ...kv('task', h('dd', null, a.task || '—')),
      ...kv('cwd', h('dd', { class: 'mono' }, a.cwd || '—')),
      ...kv('session', h('dd', { class: 'mono' }, a.sessionId || 'none')),
      ...kv('pid', h('dd', { class: 'mono' }, a.pid != null ? String(a.pid) : '—')),
      ...kv('created', h('dd', { class: 'mono' }, f.dateTime(a.createdAt))),
      ...kv('started', h('dd', { class: 'mono' }, a.startedAt ? f.dateTime(a.startedAt) : 'not started')),
      ...kv('ended', h('dd', { class: 'mono' }, a.endedAt ? f.dateTime(a.endedAt) : '—')),
      ...kv('elapsed', elapsedEl));

    // usage
    const u = a.usage || {};
    replace(usageEl,
      ...kv('input', h('dd', { class: 'mono' }, f.tokens(u.inputTokens || 0))),
      ...kv('cache read', h('dd', { class: 'mono' }, f.tokens(u.cacheReadTokens || 0))),
      ...kv('cache write', h('dd', { class: 'mono' }, f.tokens(u.cacheWriteTokens || 0))),
      ...kv('output', h('dd', { class: 'mono' }, f.tokens(u.outputTokens || 0))),
      ...kv('total', h('dd', { class: 'mono' }, f.tokens(u.totalTokens || 0))),
      ...kv('cost', h('dd', { class: 'mono' }, f.usd(u.costUsd))),
      ...kv('cost basis', h('dd', null,
        h('span', { class: 'badge ' + (a.runtime === 'deepseek' ? 'badge-actual' : 'badge-est') },
          a.runtime === 'deepseek' ? 'actual' : 'estimated'),
        ' ',
        h('span', { class: 'faint' },
          a.runtime === 'deepseek' ? 'actual API cost' : 'API-equivalent · on plan (estimate)'))),
      ...kv('fable equiv.', h('dd', { class: 'mono' },
        f.usd(u.fableEquivalentUsd),
        ' ',
        h('span', { class: 'badge badge-est', title: 'Estimated at the Fable price sheet' }, 'estimated'))));

    // worktree
    if (a.worktree) {
      worktreeCard.hidden = false;
      replace(worktreeCard,
        h('h3', { class: 'card-label' }, 'Worktree'),
        h('dl', { class: 'kv' },
          ...kv('repo', h('dd', { class: 'mono' }, a.worktree.repo || '—')),
          ...kv('branch', h('dd', { class: 'mono' }, a.worktree.branch || '—')),
          ...kv('path', h('dd', { class: 'mono' }, a.worktree.path || '—'))));
    } else {
      worktreeCard.hidden = true;
      clear(worktreeCard);
    }
  }

  return {
    el,
    update,
    activate() { const a = ctx.getAgent(); if (a) update(a); },
    deactivate() {},
    onAgentFrame(a) { update(a); },
    destroy() {},
  };
}

function kv(label, ddEl) {
  return [h('dt', null, label), ddEl];
}
