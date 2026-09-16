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
import { openHandoff } from './newagent.js';
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
    if (!agent) {
      // Deleted (or lost) while its drawer was open: say so, don't just vanish.
      const name = current.name || current.id;
      const selfInflicted = current.removing;
      close();
      if (!selfInflicted) toast(`"${name}" is no longer in the fleet — its panel was closed.`, 'info', 6000);
      return;
    }
    if (current.extra) current.extra.update(agent);
    current.head.update(agent);
  });

  // The modal claims Escape first (capture phase + preventDefault), so one
  // press closes one layer.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && current && !ev.defaultPrevented) { ev.preventDefault(); select(null); }
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

  const opener = document.activeElement;
  current = { id: agentId, name: agent.name, root, body, ctx, tabs: new Map(), activeKey: null, head, extra: null, opener };

  replace(hostEl, root);
  hostEl.hidden = false;
  head.update(agent);
  setActive(DEFAULT_TAB);
  // Focus lands on the drawer's own heading, so a keyboard user is inside the
  // thing that just opened rather than still back in the tree.
  head.focus();
}

export function close() {
  if (!current) return;
  for (const tab of current.tabs.values()) {
    try { if (tab.deactivate) tab.deactivate(); } catch (e) { console.error(e); }
    try { if (tab.destroy) tab.destroy(); } catch (e) { console.error(e); }
  }
  const opener = current.opener;
  current = null;
  clear(hostEl);
  hostEl.hidden = true;
  if (opener && opener.isConnected && typeof opener.focus === 'function') {
    try { opener.focus(); } catch { /* the row may be gone */ }
  }
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
  const nameEl = h('h2', { class: 'panel-name', tabindex: '-1' }, agent.name || agent.id);
  const subEl = h('div', { class: 'panel-sub' }, '');
  const chipEl = h('span', { class: 'chip' });
  const warnEl = h('div', { class: 'panel-warn', hidden: true, role: 'status' });
  const continueBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openHandoff(getAgent(agent.id) || agent) }, 'Continue with…');
  const closeBtn = h('button', { class: 'btn btn-sm btn-ghost panel-close', type: 'button', onclick: () => select(null), title: 'Close (Esc)' }, 'Close');

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
      h('div', { class: 'panel-head-actions' }, chipEl, continueBtn, closeBtn)),
    warnEl,
    tabsEl);

  return {
    el,
    focus() { try { nameEl.focus(); } catch { /* ignore */ } },
    update(a) {
      continueBtn.hidden = !['cto', 'orchestrator'].includes(a.role);
      continueBtn.disabled = Boolean(a.successorId) || (!['stopped', 'blocked', 'done', 'failed'].includes(a.status) && a.runtime !== 'external');
      continueBtn.title = a.successorId ? 'This session already has a continuation' : continueBtn.disabled ? 'Stop the current session before continuing with another provider' : 'Create a successor with a recovery brief';
      setText(nameEl, a.name || a.id);
      setAttr(nameEl, 'title', a.name || a.id);
      setText(subEl, [a.role, a.runtime, a.model, a.effort && ('effort: ' + a.effort), a.id]
        .filter(Boolean).join('  ·  '));
      setAttr(chipEl, 'data-status', a.status || 'queued');
      setText(chipEl, a.status || 'queued');
      // One banner for the conditions that make half the tabs look broken.
      const notes = [];
      if (a.cwdExists === false) notes.push(`Working directory is gone: ${a.cwd || '(none)'} — Files, Diff and Restart cannot work until it is back.`);
      if (a.status === 'blocked' && a.note) notes.push(`Blocked: ${a.note}`);
      warnEl.hidden = notes.length === 0;
      setAttr(warnEl, 'data-tone', a.cwdExists === false ? 'bad' : 'warn');
      setText(warnEl, notes.join('  ·  '));
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

  const removeBtn = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Remove from tree');
  removeBtn.addEventListener('click', () => runRemove());

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
        markNote, markBtn),
      h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        removeBtn,
        h('span', { class: 'faint', style: { fontSize: '12px' } },
          'Removes the record from the tree. Its worktree, branch and transcript are left alone.'))),
    noteCard,
    h('div', { class: 'card' }, h('h3', { class: 'card-label' }, 'Agent'), fieldsEl),
    h('div', { class: 'card' }, h('h3', { class: 'card-label' }, 'Usage breakdown'), usageEl),
    worktreeCard);

  const busy = (on) => {
    for (const b of [takeBtn, returnBtn, markBtn, removeBtn, ...actionBtns]) b.disabled = on;
    // Releasing the busy lock must not re-enable actions this agent cannot do;
    // update() owns that decision.
    if (!on) { const a = ctx.getAgent(); if (a) update(a); }
  };

  async function runRemove() {
    const a = ctx.getAgent();
    const label = a ? (a.name || a.id) : ctx.agentId;
    if (!window.confirm(`Remove "${label}" from the tree?\n\nThe agent record and its message history go; the worktree, branch and CLI transcript stay on disk. Its children are re-parented.`)) return;
    busy(true);
    // The state frame announcing the removal would otherwise also fire the
    // "this agent is gone" notice — one action, one message.
    if (current && current.id === ctx.agentId) current.removing = true;
    try {
      await api.deleteAgent(ctx.agentId);
      toast(`Removed "${label}".`, 'ok');
      select(null);
    } catch (err) {
      toast('Remove failed: ' + err.message, 'error', 7000);
    } finally { busy(false); }
  }

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
      ...kv('continued from', h('dd', null, a.continuedFromId ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); select(a.continuedFromId); } }, a.continuedFromId) : '—')),
      ...kv('continuation', h('dd', null, a.successorId ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); select(a.successorId); } }, a.successorId) : '—')),
      ...kv('runtime', h('dd', null, a.runtime || '—')),
      ...kv('model', h('dd', { class: 'mono' }, a.model || '—')),
      ...kv('effort', h('dd', null, a.effort || '—')),
      ...kv('status', h('dd', null, h('span', { class: 'chip', dataset: { status: a.status || 'queued' } }, a.status || 'queued'))),
      ...kv('task', h('dd', null, a.task || '—')),
      ...kv('cwd', h('dd', { class: 'mono' },
        a.cwd || '—',
        a.cwdExists === false ? h('span', { class: 'badge badge-bad', title: 'This folder no longer exists on disk' }, 'missing') : null)),
      ...kv('session', h('dd', { class: 'mono' }, a.sessionId || 'none')),
      ...kv('pid', h('dd', { class: 'mono' }, a.pid != null ? String(a.pid) : '—')),
      ...kv('created', h('dd', { class: 'mono' }, f.dateTime(a.createdAt))),
      ...kv('started', h('dd', { class: 'mono' }, a.startedAt ? f.dateTime(a.startedAt) : 'not started')),
      ...kv('ended', h('dd', { class: 'mono' }, a.endedAt ? f.dateTime(a.endedAt) : '—')),
      ...kv('elapsed', elapsedEl));

    // A restart needs a folder to start in; an agent with no live terminal
    // cannot be interrupted or paused. Disable what cannot work, and say why.
    const live = !['done', 'failed', 'stopped'].includes(a.status);
    for (const [i, spec] of ACTIONS.entries()) {
      const b = actionBtns[i];
      let why = null;
      if (spec.action === 'restart' && a.cwdExists === false) why = 'the working directory no longer exists';
      else if (spec.action === 'restart' && a.runtime === 'external') why = 'external sessions are not started by the control room';
      else if (spec.action !== 'restart' && a.runtime === 'external') why = 'external sessions have no terminal to signal';
      else if (spec.action !== 'restart' && !live) why = `nothing is running (status: ${a.status})`;
      b.disabled = Boolean(why);
      setAttr(b, 'title', why ? `Unavailable: ${why}` : null);
    }

    // usage
    const u = a.usage || {};
    replace(usageEl,
      ...kv('input', h('dd', { class: 'mono' }, f.tokens(u.inputTokens))),
      ...kv('cache read', h('dd', { class: 'mono' }, f.tokens(u.cacheReadTokens))),
      ...kv('cache write', h('dd', { class: 'mono' }, f.tokens(u.cacheWriteTokens))),
      ...kv('output', h('dd', { class: 'mono' }, f.tokens(u.outputTokens))),
      ...kv('total', h('dd', { class: 'mono' }, f.tokens(u.totalTokens))),
      ...kv('cost', h('dd', { class: 'mono' }, f.usageCost(u))),
      ...kv('cost basis', h('dd', null,
        h('span', { class: 'badge badge-est' },
          u.pricingKnown === false || u.costUsd == null ? 'unavailable' : 'estimated'),
        ' ',
        h('span', { class: 'faint' },
          u.pricingKnown === false || u.costUsd == null ? 'No price or usage reported for this model' : a.runtime === 'deepseek' ? 'API cost estimate from configured prices' : 'API-equivalent estimate; not a subscription charge'))),
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
