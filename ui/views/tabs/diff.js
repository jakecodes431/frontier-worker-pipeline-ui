// Diff tab — `stat` header plus the unified diff with +/- line coloring.

import { h, clear } from '../../lib/dom.js';
import api from '../../lib/api.js';

export function createDiffTab(ctx) {
  const statEl = h('pre', { class: 'diffstat mono' }, '');
  const bodyEl = h('pre', { class: 'code' }, '');
  const metaEl = h('span', { class: 'spacer' });
  const refreshBtn = h('button', { class: 'btn btn-sm', onclick: () => load(true) }, 'Refresh');

  const el = h('div', { class: 'pane pane-flush' },
    h('div', { class: 'pane-toolbar' },
      h('span', null, 'git diff'),
      metaEl,
      refreshBtn),
    statEl, bodyEl);

  let loaded = false;

  async function load(force) {
    if (loaded && !force) return;
    refreshBtn.disabled = true;
    metaEl.textContent = 'loading…';
    try {
      const res = await api.diff(ctx.agentId);
      loaded = true;
      metaEl.textContent = '';
      if (res && (res.missing || res.notRepo)) {
        statEl.hidden = true;
        clear(bodyEl);
        bodyEl.appendChild(h('div', { class: 'notice' },
          h('h4', null, res.missing ? 'Working directory is gone' : 'Not a git repository'),
          h('p', null, res.message || 'There is no diff to show for this agent.')));
        return;
      }
      const stat = String((res && res.stat) || '').trim();
      statEl.textContent = stat || 'no stat reported';
      statEl.hidden = false;
      renderDiff(String((res && res.diff) || ''));
    } catch (err) {
      loaded = true;
      statEl.hidden = true;
      clear(bodyEl);
      bodyEl.appendChild(h('div', { class: 'error-box', role: 'alert', style: { margin: '14px' } }, 'Could not load the diff: ' + err.message));
      metaEl.textContent = '';
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function renderDiff(text) {
    clear(bodyEl);
    if (!text.trim()) {
      bodyEl.appendChild(h('span', { class: 'dl-meta' }, 'Working tree is clean — no diff.'));
      return;
    }
    const frag = document.createDocumentFragment();
    let lineCount = 0;
    for (const line of text.split('\n')) {
      frag.appendChild(h('span', { class: 'dl-' + classify(line) }, line === '' ? ' ' : line));
      lineCount += 1;
      if (lineCount > 20000) {
        frag.appendChild(h('span', { class: 'dl-meta' }, '… diff truncated by the UI at 20000 lines …'));
        break;
      }
    }
    bodyEl.appendChild(frag);
  }

  return {
    el,
    activate() { load(false); },
    deactivate() {},
    onAgentFrame() {},
    destroy() {},
  };
}

function classify(line) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('diff ') || line.startsWith('index ') ||
      line.startsWith('new file') || line.startsWith('deleted file') ||
      line.startsWith('similarity ') || line.startsWith('rename ') ||
      line.startsWith('old mode') || line.startsWith('new mode') ||
      line.startsWith('Binary files')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
