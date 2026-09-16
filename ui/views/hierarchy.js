// Hierarchy — the fleet, laid out like a kanban.
//
// LIST (default)
//   Needs you  blocked agents and the question they are waiting on
//   Active     queued / running / idle / paused / blocked agents as a tree, with
//              their finished ancestors kept in for context
//   Finished   a folder (collapsed by default, remembered) of done / failed /
//              stopped agents grouped under their parent's name
// BOARD
//   Queued · Running · Blocked · Finished columns of cards
//
// Every row and card is keyed by agent id and patched in place, never rebuilt,
// so the open drawer and its attached terminal (which live in #panel-host, not
// here) are untouched by state frames. When an agent changes section or column
// its element is MOVED and flashes briefly so the move is visible.

import { h, setText, setAttr, qs } from '../lib/dom.js';
import * as f from '../lib/format.js';
import { store, getAgents, getSelectedId, select, treeOrder, isLoaded, getConfig } from '../lib/store.js';

export const FINISHED = new Set(['done', 'failed', 'stopped']);
const LS_FOLDER = 'cr.hierarchy.finishedOpen';
const LS_MODE = 'cr.hierarchy.mode';

function lsGet(key) { try { return window.localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { window.localStorage.setItem(key, value); } catch { /* storage blocked */ } }

let rootEl = null;
let countEl = null;
let modeEl = null;
let emptyEl = null;
let rovingId = null;   // the one row/card in the tab order (roving tabindex)
let mode = lsGet(LS_MODE) === 'board' ? 'board' : 'list';

// list view
let listEl = null;
let needs = null;     // { el, count, list }
let activeSec = null; // { el, count, tree }
let folder = null;    // { el, head, count, toggle, body }
const rows = new Map();       // id -> tree row
const needRows = new Map();   // id -> needs row
const groups = new Map();     // parent key -> { el, name, chip, count }
const listPlace = new Map();  // id -> 'active' | 'finished:<key>'

// board view
let boardEl = null;
const columns = new Map();    // column key -> { el, body, count, empty }
const cards = new Map();      // id -> card
const boardPlace = new Map(); // id -> column key

const COLUMNS = [
  { key: 'queued', label: 'Queued', empty: 'Nothing waiting to start' },
  { key: 'running', label: 'Running', empty: 'Nothing running' },
  { key: 'blocked', label: 'Blocked', empty: 'Nothing needs you' },
  { key: 'finished', label: 'Finished', empty: 'Nothing finished yet' },
];

export function mountHierarchy({ root, count, modeToggle }) {
  rootEl = root;
  countEl = count;
  modeEl = modeToggle;

  buildList();
  buildBoard();
  buildEmpty();
  rootEl.append(emptyEl, listEl, boardEl);

  if (modeEl) {
    for (const b of modeEl.querySelectorAll('[data-mode]')) {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    }
  }

  store.on('agents', render);
  store.on('select', (id) => {
    for (const [rid, el] of rows) setAttr(el, 'aria-selected', rid === id ? 'true' : 'false');
    for (const [rid, el] of cards) setAttr(el, 'aria-selected', rid === id ? 'true' : 'false');
  });

  setMode(mode, true);
  startTicker();
}

/* ------------------------------------------------------ keyboard traversal */

/**
 * Roving tabindex: one Tab stop for the whole tree (or board), arrows to move
 * inside it. Twenty focusable rows in the tab order is not "navigable", it is a
 * tax on every keyboard user trying to reach the drawer behind them.
 */
function items() {
  const sel = mode === 'list' ? '.node' : '.kcard';
  const scope = mode === 'list' ? listEl : boardEl;
  if (!scope || scope.hidden) return [];
  return Array.from(scope.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
}

function applyRoving() {
  const list = items();
  if (!list.length) return;
  if (!list.some((el) => el.dataset.id === rovingId)) rovingId = getSelectedId() || list[0].dataset.id;
  for (const el of list) el.tabIndex = el.dataset.id === rovingId ? 0 : -1;
}

function focusItem(el) {
  if (!el) return;
  rovingId = el.dataset.id;
  applyRoving();
  el.focus();
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

/** Column-aware movement for the board; plain list movement for the tree. */
function move(current, key) {
  const list = items();
  const i = list.indexOf(current);
  if (i < 0) return null;
  if (key === 'Home') return list[0];
  if (key === 'End') return list[list.length - 1];
  if (mode === 'list') {
    if (key === 'ArrowDown') return list[Math.min(list.length - 1, i + 1)];
    if (key === 'ArrowUp') return list[Math.max(0, i - 1)];
    return null;
  }
  const col = current.parentElement;
  const inCol = Array.from(col.children).filter((el) => el.classList.contains('kcard'));
  const j = inCol.indexOf(current);
  if (key === 'ArrowDown') return inCol[Math.min(inCol.length - 1, j + 1)];
  if (key === 'ArrowUp') return inCol[Math.max(0, j - 1)];
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const bodies = Array.from(boardEl.querySelectorAll('.col-body'));
    let c = bodies.indexOf(col);
    while (true) {
      c += key === 'ArrowRight' ? 1 : -1;
      if (c < 0 || c >= bodies.length) return null;
      const cards = Array.from(bodies[c].children).filter((el) => el.classList.contains('kcard'));
      if (cards.length) return cards[Math.min(j, cards.length - 1)];
    }
  }
  return null;
}

/** Shared row/card key handling: move, select, or fall through. */
function onItemKey(ev, id) {
  if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
    ev.preventDefault();
    select(id);
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
  const next = move(ev.currentTarget, ev.key);
  if (!next) return;
  ev.preventDefault();
  focusItem(next);
}

function setMode(next, force) {
  if (next !== 'list' && next !== 'board') return;
  if (next === mode && !force) return;
  mode = next;
  lsSet(LS_MODE, mode);
  if (modeEl) {
    for (const b of modeEl.querySelectorAll('[data-mode]')) setAttr(b, 'aria-selected', b.dataset.mode === mode ? 'true' : 'false');
  }
  listEl.hidden = mode !== 'list';
  boardEl.hidden = mode !== 'board';
  render();
}

/** The tree is empty on a fresh install; say what to do, not "nothing active". */
function buildEmpty() {
  const cfg = getConfig() || {};
  emptyEl = h('section', { class: 'plate', hidden: true, 'aria-label': 'No agents yet' },
    h('div', { class: 'plate-head' },
      h('h2', { class: 'plate-title' }, 'No agents yet'),
      h('span', { class: 'plate-note' }, 'this is the whole fleet, and it is empty')),
    h('div', { class: 'plate-pad' },
      h('p', { class: 'step-text' },
        'Every node here is a real CLI process (or a session you registered), with its own terminal, diff and conversation. ',
        'Create the first one and it appears in this tree the moment it starts.'),
      h('div', { class: 'btn-row', style: { marginTop: '14px' } },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => { const b = qs('#new-agent-btn') || qs('#new-agent-btn-mobile'); if (b) b.click(); },
        }, 'New agent')),
      h('p', { class: 'step-text', style: { marginTop: '16px' } },
        'From a terminal, the same thing: '),
      h('pre', { class: 'code-inline mono' },
        `node ${cfg.crBin || 'bin/cr.js'} spawn --name "first worker" --role worker \\\n  --runtime deepseek --repo <path-to-repo> --task "one line"`)));
}

function render() {
  if (!rootEl) return;
  const agents = getAgents();
  if (countEl) {
    const live = agents.filter((a) => !FINISHED.has(a.status)).length;
    setText(countEl, agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${live} active` : '');
  }
  const blank = agents.length === 0 && isLoaded();
  if (emptyEl) emptyEl.hidden = !blank;
  listEl.hidden = blank || mode !== 'list';
  boardEl.hidden = blank || mode !== 'board';
  if (blank) return;
  if (mode === 'list') renderList(agents); else renderBoard(agents);
  applyRoving();
}

function flash(el) {
  el.classList.remove('arrived');
  void el.offsetWidth; // restart the animation
  el.classList.add('arrived');
}

/* ================================================================== LIST */

function buildList() {
  const needsCount = h('span', { class: 'section-count' }, '0');
  const needsList = h('div', { class: 'needs-list' });
  const needsEl = h('section', { class: 'plate needs', hidden: true, 'aria-label': 'Needs you' },
    h('div', { class: 'plate-head' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('h2', { class: 'plate-title' }, 'Needs you'),
      needsCount,
      h('span', { class: 'plate-note' }, 'blocked agents waiting on a decision')),
    needsList);
  needs = { el: needsEl, count: needsCount, list: needsList };

  const activeCount = h('span', { class: 'section-count' }, '0');
  const tree = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Active agents' });
  const activeEl = h('section', { class: 'plate', 'aria-label': 'Active' },
    h('div', { class: 'plate-head' },
      h('h2', { class: 'plate-title' }, 'Active'),
      activeCount,
      h('span', { class: 'plate-note' }, 'queued, running, idle, paused and blocked, under their parents')),
    h('div', { class: 'tree-cols', 'aria-hidden': 'true' },
      h('span', null, 'Agent'), h('span', null, 'Status'), h('span', null, 'Task'),
      h('span', null, 'Elapsed'), h('span', null, 'Tokens'), h('span', null, 'Cost')),
    tree);
  activeSec = { el: activeEl, count: activeCount, tree };

  const folderCount = h('span', { class: 'section-count' }, '0');
  const toggle = h('span', { class: 'folder-toggle' }, 'Show');
  const head = h('button', { class: 'folder-head', type: 'button', 'aria-expanded': 'false' },
    svgIcon('M9 6l6 6-6 6', 'folder-chev'),
    svgIcon('M3 7.5A1.5 1.5 0 0 1 4.5 6h4.1l2 2h8.9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z', 'folder-icon'),
    h('span', { class: 'plate-title' }, 'Finished'),
    folderCount,
    h('span', { class: 'folder-hint' }, 'done, failed and stopped, grouped by parent'),
    toggle);
  const body = h('div', { class: 'folder-body', hidden: true });
  const folderEl = h('section', { class: 'plate folder', dataset: { open: '0' }, 'aria-label': 'Finished' }, head, body);
  folder = { el: folderEl, head, count: folderCount, toggle, body };
  head.addEventListener('click', () => setFolderOpen(folderEl.dataset.open !== '1'));
  setFolderOpen(lsGet(LS_FOLDER) === '1', true);

  listEl = h('div', { class: 'plates hier-list' }, needsEl, activeEl, folderEl);
}

function setFolderOpen(open, initial) {
  folder.el.dataset.open = open ? '1' : '0';
  folder.body.hidden = !open;
  setAttr(folder.head, 'aria-expanded', open ? 'true' : 'false');
  setText(folder.toggle, open ? 'Hide' : 'Show');
  if (!initial) lsSet(LS_FOLDER, open ? '1' : '0');
}

function renderList(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const selected = getSelectedId();

  // Active = not finished. Their finished ancestors stay in the tree as context.
  const active = new Set(agents.filter((a) => !FINISHED.has(a.status)).map((a) => a.id));
  const context = new Set();
  for (const id of active) {
    const guard = new Set();
    let p = byId.get(id).parentId;
    while (p && byId.has(p) && !guard.has(p)) {
      guard.add(p);
      if (!active.has(p)) context.add(p);
      p = byId.get(p).parentId;
    }
  }
  const inTree = agents.filter((a) => active.has(a.id) || context.has(a.id));
  const finished = agents.filter((a) => !active.has(a.id) && !context.has(a.id));
  const order = new Map(treeOrder(agents).map((e, i) => [e.agent.id, i]));

  // ---- Needs you ------------------------------------------------------
  const blocked = agents.filter((a) => a.status === 'blocked').sort((x, y) => order.get(x.id) - order.get(y.id));
  needs.el.hidden = blocked.length === 0;
  setText(needs.count, String(blocked.length));
  const seenNeeds = new Set();
  let prev = null;
  for (const a of blocked) {
    seenNeeds.add(a.id);
    let row = needRows.get(a.id);
    const isNew = !row;
    if (!row) { row = buildNeedsRow(a); needRows.set(a.id, row); }
    updateNeedsRow(row, a, byId);
    const expected = prev ? prev.nextElementSibling : needs.list.firstElementChild;
    if (expected !== row) needs.list.insertBefore(row, expected);
    if (isNew && listPlace.size) flash(row);
    prev = row;
  }
  for (const [id, row] of Array.from(needRows)) if (!seenNeeds.has(id)) { row.remove(); needRows.delete(id); }

  // ---- Active tree ----------------------------------------------------
  const tree = activeSec.tree;
  const ordered = treeOrder(inTree);
  setText(activeSec.count, String(active.size));
  const emptyEl = tree.querySelector(':scope > .empty');
  if (!ordered.length) {
    if (!emptyEl) tree.appendChild(h('div', { class: 'empty' }, 'Nothing is active. Finished work is in the folder below.'));
  } else if (emptyEl) {
    emptyEl.remove();
  }

  const placed = new Set();
  let cursor = null;
  for (const entry of ordered) {
    const a = entry.agent;
    placed.add(a.id);
    const row = ensureRow(a);
    row.dataset.rail = rail(entry.depth, entry.isLast, entry.ancestorsLast);
    setAttr(row, 'data-context', context.has(a.id) ? '1' : null);
    setAttr(row, 'aria-level', String(entry.depth + 1));
    updateRow(row, a, byId);
    setAttr(row, 'aria-selected', a.id === selected ? 'true' : 'false');
    const expected = cursor ? cursor.nextElementSibling : tree.firstElementChild;
    if (expected !== row) tree.insertBefore(row, expected);
    cursor = row;
    notePlace(row, a.id, 'active');
  }

  // ---- Finished folder -------------------------------------------------
  const prevFinished = Number(folder.count.textContent) || 0;
  setText(folder.count, String(finished.length));
  if (listPlace.size && finished.length > prevFinished) flash(folder.count);

  const buckets = new Map();
  for (const a of finished) {
    const key = a.parentId && byId.has(a.parentId) ? a.parentId : '__root';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(a);
  }
  const groupKeys = Array.from(buckets.keys()).sort((x, y) => {
    if (x === '__root') return -1;
    if (y === '__root') return 1;
    return (order.get(x) ?? 0) - (order.get(y) ?? 0);
  });

  if (!finished.length) {
    if (!folder.body.querySelector(':scope > .empty')) folder.body.appendChild(h('div', { class: 'empty' }, 'Nothing has finished yet.'));
  } else {
    const e = folder.body.querySelector(':scope > .empty');
    if (e) e.remove();
  }

  let gCursor = null;
  const seenGroups = new Set();
  for (const key of groupKeys) {
    seenGroups.add(key);
    let g = groups.get(key);
    if (!g) { g = buildGroup(); groups.set(key, g); }
    const parent = key === '__root' ? null : byId.get(key);
    updateGroup(g, parent, buckets.get(key).length);
    const expected = gCursor ? gCursor.nextElementSibling : folder.body.firstElementChild;
    if (expected !== g.el) folder.body.insertBefore(g.el, expected);
    gCursor = g.el;

    const list = buckets.get(key).sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
    let rCursor = g.head;
    for (const a of list) {
      placed.add(a.id);
      const row = ensureRow(a);
      row.dataset.rail = '';
      setAttr(row, 'data-context', null);
      setAttr(row, 'aria-level', null);
      updateRow(row, a, byId);
      setAttr(row, 'aria-selected', a.id === selected ? 'true' : 'false');
      if (rCursor.nextElementSibling !== row) g.el.insertBefore(row, rCursor.nextElementSibling);
      rCursor = row;
      notePlace(row, a.id, 'finished:' + key);
    }
  }
  for (const [key, g] of Array.from(groups)) {
    if (!seenGroups.has(key)) { g.el.remove(); groups.delete(key); }
  }
  // A group may still hold rows that moved elsewhere this pass; they were
  // re-inserted above, so only rows no longer placed anywhere are dropped.
  for (const [id, row] of Array.from(rows)) {
    if (!placed.has(id)) { row.remove(); rows.delete(id); listPlace.delete(id); }
  }
}

function notePlace(row, id, place) {
  const was = listPlace.get(id);
  listPlace.set(id, place);
  if (was && was !== place) flash(row);
}

function ensureRow(agent) {
  let row = rows.get(agent.id);
  if (!row) { row = buildRow(agent); rows.set(agent.id, row); }
  return row;
}

function rail(depth, isLast, ancestorsLast) {
  if (depth === 0) return '';
  const stems = ancestorsLast.slice(1).map((last) => (last ? '   ' : '│  ')).join('');
  return stems + (isLast ? '└─ ' : '├─ ');
}

function buildRow(agent) {
  const railEl = h('span', { class: 'node-rail', 'aria-hidden': 'true' });
  const warnEl = h('span', { class: 'node-warn', hidden: true, title: '' }, '!');
  const nameEl = h('div', { class: 'node-name' });
  const metaEl = h('div', { class: 'node-meta' });
  const roleEl = h('span', { class: 'role-tag' });
  const chipEl = h('span', { class: 'chip' });
  const taskEl = h('div', { class: 'node-task' });
  const elapsedEl = h('div', { class: 'node-num node-num-elapsed' });
  const tokensEl = h('div', { class: 'node-num node-num-tokens' });
  const costEl = h('div', { class: 'node-num node-num-cost' });

  const row = h('div', {
    class: 'node', role: 'treeitem', tabindex: '-1',
    dataset: { id: agent.id },
    onclick: () => { rovingId = agent.id; select(agent.id); },
    onkeydown: (ev) => onItemKey(ev, agent.id),
    onfocus: () => { rovingId = agent.id; },
  },
    h('div', { class: 'node-main' }, railEl, roleEl, h('div', { class: 'node-ident' }, nameEl, metaEl), warnEl),
    chipEl, taskEl, elapsedEl, tokensEl, costEl);

  row._parts = { railEl, warnEl, nameEl, metaEl, roleEl, chipEl, taskEl, elapsedEl, tokensEl, costEl };
  return row;
}

function updateRow(row, agent, byId) {
  const p = row._parts;
  if (!p) return;
  setText(p.railEl, row.dataset.rail || '');
  setText(p.nameEl, agent.name || agent.id);
  // Names can be arbitrarily long; the cell ellipsises, the tooltip does not.
  setAttr(p.nameEl, 'title', agent.name || agent.id);
  setText(p.roleEl, shortRole(agent.role));
  setAttr(p.roleEl, 'title', 'role: ' + (agent.role || 'unknown'));
  const parent = agent.parentId && byId ? byId.get(agent.parentId) : null;
  setText(p.metaEl, [agent.model || agent.runtime || '—', agent.id].join('  ·  '));
  setAttr(p.metaEl, 'title', `${agent.runtime || '?'} · ${agent.model || 'no model'} · ${agent.id}${parent ? ' · under ' + (parent.name || parent.id) : ''}`);

  const status = agent.status || 'queued';
  setAttr(p.chipEl, 'data-status', status);
  setText(p.chipEl, status);
  setAttr(p.chipEl, 'title', agent.controlledBy === 'human' ? `${status} · human control` : `status: ${status}`);

  setText(p.taskEl, f.truncate(agent.task || '', 120));
  setAttr(p.taskEl, 'title', agent.task || '');

  // A worktree can be pruned or deleted under a finished agent; say so here
  // rather than letting Files and Diff come back mysteriously empty.
  const missing = agent.cwdExists === false;
  if (p.warnEl) {
    p.warnEl.hidden = !missing;
    setAttr(p.warnEl, 'title', missing ? `Working directory no longer exists: ${agent.cwd || '(none)'}` : null);
    setAttr(p.warnEl, 'aria-label', missing ? 'working directory is missing' : null);
  }

  applyElapsed(p.elapsedEl, agent);
  const u = agent.usage || {};
  setText(p.tokensEl, u.totalTokens ? f.tokens(u.totalTokens) : '—');
  setAttr(p.tokensEl, 'title', `in ${f.tokens(u.inputTokens || 0)} · cache r ${f.tokens(u.cacheReadTokens || 0)} · cache w ${f.tokens(u.cacheWriteTokens || 0)} · out ${f.tokens(u.outputTokens || 0)}`);
  setText(p.costEl, u.costUsd != null ? f.usd(u.costUsd) : '—');
}

function buildNeedsRow(agent) {
  const name = h('div', { class: 'needs-name' });
  const parent = h('div', { class: 'needs-parent' });
  const note = h('div', { class: 'needs-note' });
  // The row is a mouse target; the button inside it is the keyboard path. One
  // tab stop per blocked agent, not two, and no nested button semantics.
  const openBtn = h('button', {
    class: 'btn btn-sm', type: 'button',
    onclick: (ev) => { ev.stopPropagation(); select(agent.id); },
  }, 'Open');
  const row = h('div', {
    class: 'needs-row', dataset: { id: agent.id },
    onclick: () => select(agent.id),
  },
    h('div', null, name, parent),
    note,
    openBtn);
  row._open = openBtn;
  row._parts = { name, parent, note };
  return row;
}

function updateNeedsRow(row, agent, byId) {
  const p = row._parts;
  if (row._open) setAttr(row._open, 'aria-label', `Open ${agent.name || agent.id}`);
  setText(p.name, agent.name || agent.id);
  const parent = agent.parentId ? byId.get(agent.parentId) : null;
  setText(p.parent, parent ? `under ${parent.name || parent.id}` : 'top level');
  setText(p.note, agent.note ? String(agent.note) : 'Blocked with no note. Open it to see its last messages.');
  p.note.classList.toggle('faint', !agent.note);
}

function buildGroup() {
  const name = h('span', { class: 'group-parent' });
  const chip = h('span', { class: 'chip' });
  const count = h('span', { class: 'group-count' });
  const head = h('div', { class: 'group-head' }, h('span', { class: 'label' }, 'Under'), name, chip, count);
  const el = h('div', { class: 'group', role: 'group' }, head);
  return { el, head, name, chip, count };
}

function updateGroup(g, parent, n) {
  if (parent) {
    setText(g.name, parent.name || parent.id);
    g.chip.hidden = false;
    setAttr(g.chip, 'data-status', parent.status || 'queued');
    setText(g.chip, parent.status || 'queued');
  } else {
    setText(g.name, 'Top level');
    g.chip.hidden = true;
  }
  setText(g.count, `${n} finished`);
}

function shortRole(role) {
  if (role === 'orchestrator') return 'orch';
  if (role === 'worker') return 'wrk';
  if (role === 'cto') return 'cto';
  return role || '—';
}

/* ================================================================= BOARD */

function buildBoard() {
  boardEl = h('div', { class: 'board', hidden: true, role: 'list', 'aria-label': 'Agent board' });
  for (const c of COLUMNS) {
    const count = h('span', { class: 'section-count' }, '0');
    const body = h('div', { class: 'col-body' });
    const empty = h('div', { class: 'col-empty' }, c.empty);
    const el = h('section', { class: 'col', dataset: { col: c.key }, 'aria-label': c.label },
      h('div', { class: 'col-head' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('h2', { class: 'col-title' }, c.label),
        count),
      body, empty);
    columns.set(c.key, { el, body, count, empty });
    boardEl.appendChild(el);
  }
}

export function columnOf(status) {
  if (FINISHED.has(status)) return 'finished';
  if (status === 'blocked') return 'blocked';
  if (status === 'running' || status === 'idle' || status === 'paused') return 'running';
  return 'queued';
}

function renderBoard(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const selected = getSelectedId();
  const buckets = new Map(COLUMNS.map((c) => [c.key, []]));
  for (const a of agents) buckets.get(columnOf(a.status)).push(a);

  const t = (iso) => { const d = f.toDate(iso); return d ? d.getTime() : 0; };
  buckets.get('finished').sort((x, y) => t(y.endedAt || y.createdAt) - t(x.endedAt || x.createdAt));
  for (const k of ['queued', 'running', 'blocked']) {
    buckets.get(k).sort((x, y) => t(x.startedAt || x.createdAt) - t(y.startedAt || y.createdAt));
  }

  const seen = new Set();
  for (const c of COLUMNS) {
    const col = columns.get(c.key);
    const list = buckets.get(c.key);
    setText(col.count, String(list.length));
    col.empty.hidden = list.length > 0;
    let prev = null;
    for (const a of list) {
      seen.add(a.id);
      let card = cards.get(a.id);
      if (!card) { card = buildCard(a); cards.set(a.id, card); }
      updateCard(card, a, byId);
      setAttr(card, 'aria-selected', a.id === selected ? 'true' : 'false');
      const expected = prev ? prev.nextElementSibling : col.body.firstElementChild;
      if (expected !== card) col.body.insertBefore(card, expected);
      prev = card;
      const was = boardPlace.get(a.id);
      boardPlace.set(a.id, c.key);
      if (was && was !== c.key) flash(card);
    }
  }
  for (const [id, card] of Array.from(cards)) {
    if (!seen.has(id)) { card.remove(); cards.delete(id); boardPlace.delete(id); }
  }
}

function buildCard(agent) {
  const name = h('div', { class: 'kcard-name' });
  const chip = h('span', { class: 'chip' });
  const role = h('span', { class: 'role-tag' });
  const model = h('span', { class: 'kcard-model' });
  const parent = h('div', { class: 'kcard-parent' });
  const elapsed = h('span', { class: 'kcard-stat-v' });
  const tokens = h('span', { class: 'kcard-stat-v' });
  const cost = h('span', { class: 'kcard-stat-v' });
  const card = h('div', {
    class: 'kcard', role: 'listitem', tabindex: '-1', dataset: { id: agent.id },
    onclick: () => { rovingId = agent.id; select(agent.id); },
    onkeydown: (ev) => onItemKey(ev, agent.id),
    onfocus: () => { rovingId = agent.id; },
  },
    h('div', { class: 'kcard-top' }, name, chip),
    h('div', { class: 'kcard-meta' }, role, model),
    parent,
    h('div', { class: 'kcard-stats' },
      h('div', { class: 'kcard-stat' }, elapsed, h('span', { class: 'kcard-stat-l' }, 'elapsed')),
      h('div', { class: 'kcard-stat' }, tokens, h('span', { class: 'kcard-stat-l' }, 'tokens')),
      h('div', { class: 'kcard-stat' }, cost, h('span', { class: 'kcard-stat-l' }, 'cost'))));
  card._parts = { name, chip, role, model, parent, elapsed, tokens, cost };
  return card;
}

function updateCard(card, agent, byId) {
  const p = card._parts;
  setText(p.name, agent.name || agent.id);
  setAttr(p.name, 'title', agent.task || '');
  const status = agent.status || 'queued';
  setAttr(p.chip, 'data-status', status);
  setText(p.chip, status);
  setText(p.role, shortRole(agent.role));
  setText(p.model, agent.model || agent.runtime || '—');
  const parent = agent.parentId ? byId.get(agent.parentId) : null;
  if (parent) {
    p.parent.replaceChildren('under ', h('b', null, parent.name || parent.id));
  } else {
    setText(p.parent, 'top level');
  }
  applyElapsed(p.elapsed, agent);
  const u = agent.usage || {};
  setText(p.tokens, u.totalTokens ? f.tokens(u.totalTokens) : '—');
  setText(p.cost, u.costUsd != null ? f.usd(u.costUsd) : '—');
}

/* ================================================================ shared */

/** Running agents tick live from startedAt; finished ones show their final elapsed. */
export function applyElapsed(el, agent) {
  const running = agent.status === 'running';
  if (running && agent.startedAt) {
    el.dataset.elapsedStart = agent.startedAt;
    setText(el, f.duration(f.elapsedSince(agent.startedAt)));
  } else {
    delete el.dataset.elapsedStart;
    const s = agent.elapsedS != null
      ? agent.elapsedS
      : (agent.startedAt && agent.endedAt
        ? Math.max(0, (new Date(agent.endedAt) - new Date(agent.startedAt)) / 1000)
        : null);
    setText(el, s == null ? '—' : f.duration(s));
  }
}

function svgIcon(d, cls) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.7');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  el.appendChild(p);
  return el;
}

let tickerStarted = false;
function startTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-elapsed-start]')) {
      const s = f.elapsedSince(el.dataset.elapsedStart);
      if (s !== null) {
        const next = f.duration(s);
        if (el.textContent !== next) el.textContent = next;
      }
    }
  }, 1000);
}

// kept for callers that imported the old name
export const renderTree = render;
