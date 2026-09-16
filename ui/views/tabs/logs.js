// Logs tab — Event[] newest last, monospace, auto-refresh on WS agent frames.

import { h, clear } from '../../lib/dom.js';
import * as f from '../../lib/format.js';
import api from '../../lib/api.js';

export function createLogsTab(ctx) {
  const listEl = h('div', { class: 'logs' });
  const scroll = h('div', { class: 'pane', style: { position: 'static', flex: '1 1 auto', minHeight: '0' } }, listEl);
  const metaEl = h('span', { class: 'spacer' });
  const refreshBtn = h('button', { class: 'btn btn-sm', onclick: () => load(true) }, 'Refresh');

  const el = h('div', { class: 'pane pane-flush' },
    h('div', { class: 'pane-toolbar' }, h('span', null, 'Events'), metaEl, refreshBtn),
    scroll);

  let loaded = false;
  let inflight = false;

  async function load(force) {
    if (inflight) return;
    if (loaded && !force) return;
    inflight = true;
    try {
      const events = await api.logs(ctx.agentId);
      loaded = true;
      render(Array.isArray(events) ? events : []);
    } catch (err) {
      loaded = true;
      clear(listEl);
      listEl.appendChild(h('div', { class: 'error-box' }, 'Could not load logs: ' + err.message));
    } finally {
      inflight = false;
    }
  }

  function render(events) {
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    clear(listEl);
    metaEl.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
    if (!events.length) {
      listEl.appendChild(h('div', { class: 'empty' }, 'No events recorded for this agent.'));
      return;
    }
    // Contract order is chronological; render newest last regardless.
    const sorted = events.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const frag = document.createDocumentFragment();
    for (const e of sorted) {
      frag.appendChild(h('div', { class: 'log-row' },
        h('span', { class: 'log-ts', title: f.dateTime(e.createdAt) }, f.clock(e.createdAt)),
        h('span', { class: 'log-kind', dataset: { kind: e.kind || 'event' } }, String(e.kind || 'event')),
        h('span', { class: 'log-data' }, f.compactJson(e.data, 1200))));
    }
    listEl.appendChild(frag);
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  return {
    el,
    activate() { load(false); },
    deactivate() {},
    onAgentFrame() { load(true); },
    destroy() {},
  };
}
