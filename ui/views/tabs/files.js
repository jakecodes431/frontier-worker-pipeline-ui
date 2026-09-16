// Files tab — changed files (with status badge) + the working tree.
// Clicking any entry loads it into the viewer below.

import { h, clear, setAttr } from '../../lib/dom.js';
import * as f from '../../lib/format.js';
import api from '../../lib/api.js';

export function createFilesTab(ctx) {
  const listEl = h('div', { class: 'file-list' }, h('div', { class: 'loading' }, 'Loading files…'));
  const viewerEl = h('pre', { class: 'code' }, 'Select a file to view its contents.');
  const viewerPath = h('span', { class: 'mono spacer' }, '');
  const refreshBtn = h('button', { class: 'btn btn-sm', onclick: () => load(true) }, 'Refresh');

  const el = h('div', { class: 'pane pane-flush' },
    h('div', { class: 'pane-toolbar' }, h('span', null, 'Files'), viewerPath, refreshBtn),
    h('div', { class: 'files-split' }, listEl, viewerEl));

  let loaded = false;
  let selectedPath = null;

  async function load(force) {
    if (loaded && !force) return;
    refreshBtn.disabled = true;
    try {
      const res = await api.files(ctx.agentId);
      loaded = true;
      render(res || {});
    } catch (err) {
      loaded = true;
      clear(listEl);
      listEl.appendChild(h('div', { class: 'error-box' }, 'Could not load files: ' + err.message));
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function render(res) {
    const changed = Array.isArray(res.changed) ? res.changed : [];
    const tree = Array.isArray(res.tree) ? res.tree : [];
    clear(listEl);

    // A worktree can be removed under a finished agent. Two empty lists look
    // like a bug; the server tells us which it is, so say it.
    if (res.missing) {
      listEl.appendChild(h('div', { class: 'notice' },
        h('h4', null, 'Working directory is gone'),
        h('p', null, res.message || 'The folder this agent ran in no longer exists.'),
        h('p', null, 'Its diff and files cannot be read. The transcript, events and terminal scrollback are still available in the other tabs.')));
      viewerEl.textContent = 'No files to show.';
      return;
    }

    listEl.appendChild(h('div', { class: 'subhead' }, `Changed — ${changed.length}`));
    if (!changed.length) {
      listEl.appendChild(h('div', { class: 'empty', style: { padding: '12px' } }, 'No changed files.'));
    } else {
      for (const c of changed) listEl.appendChild(fileRow(c.path, statusLetter(c.status), null, c.status));
    }

    listEl.appendChild(h('div', { class: 'subhead' }, `Tree — ${tree.length}`));
    if (!tree.length) {
      listEl.appendChild(h('div', { class: 'empty', style: { padding: '12px' } }, 'No tree reported.'));
    } else {
      for (const t of tree) listEl.appendChild(fileRow(t.path, '-', t.size, 'tracked'));
    }
    markSelection();
  }

  function fileRow(path, letter, size, title) {
    return h('div', {
      class: 'file-row',
      role: 'button',
      tabindex: '0',
      dataset: { path },
      title: `${title || ''} ${path}`.trim(),
      onclick: () => openFile(path),
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFile(path); } },
    },
      h('span', { class: 'st-badge', dataset: { st: letter } }, letter),
      h('span', { class: 'file-path' }, path),
      size != null ? h('span', { class: 'file-size' }, f.bytes(size)) : null);
  }

  function markSelection() {
    for (const row of listEl.querySelectorAll('.file-row')) {
      setAttr(row, 'aria-selected', row.dataset.path === selectedPath ? 'true' : 'false');
    }
  }

  async function openFile(path) {
    selectedPath = path;
    markSelection();
    viewerPath.textContent = path;
    viewerEl.textContent = 'Loading…';
    try {
      const res = await api.file(ctx.agentId, path);
      const content = res && typeof res.content === 'string' ? res.content : '';
      viewerEl.textContent = content === '' ? '(empty file)' : content;
      viewerEl.scrollTop = 0;
    } catch (err) {
      viewerEl.textContent = 'Could not load file: ' + err.message;
    }
  }

  return {
    el,
    activate() { load(false); },
    deactivate() {},
    onAgentFrame() {},
    destroy() {},
  };
}

function statusLetter(status) {
  const s = String(status || '').trim();
  if (!s) return '-';
  const up = s[0].toUpperCase();
  if ('MADRCU?'.includes(up)) return up === 'U' ? '?' : up;
  const map = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: '?' };
  return map[s.toLowerCase()] || up;
}
