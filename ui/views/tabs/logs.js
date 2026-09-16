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

  const PAGE = 200;
  let shown = PAGE;
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
      listEl.appendChild(h('div', { class: 'empty' }, 'No events recorded for this agent yet. Spawning, exits, status changes and errors all land here.'));
      return;
    }
    // Contract order is chronological; render newest last regardless.
    const sorted = events.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    // The server hands back up to 1000 events and this pane re-renders on every
    // agent frame; only the tail is put in the DOM.
    const hidden = Math.max(0, sorted.length - shown);
    const visible = hidden ? sorted.slice(hidden) : sorted;
    const frag = document.createDocumentFragment();
    if (hidden > 0) {
      frag.appendChild(h('button', {
        class: 'cto-earlier', type: 'button', style: { margin: '10px auto' },
        onclick: () => { shown += PAGE; render(events); },
      }, `Show earlier (${hidden} more)`));
    }
    for (const e of visible) {
      frag.appendChild(h('div', { class: 'log-row' },
        h('span', { class: 'log-ts', title: f.dateTime(e.createdAt) }, f.clock(e.createdAt)),
        h('span', { class: 'log-kind', dataset: { kind: e.kind || 'event' } }, String(e.kind || 'event')),
        h('span', { class: 'log-data' }, f.compactJson(e.data, 1200))));
    }
    listEl.appendChild(frag);
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  let pending = 0;
  return {
    el,
    activate() { load(false); },
    deactivate() {},
    // Agent frames can arrive in bursts (one per agent every five seconds);
    // reloading the event list on each one is wasted work.
    onAgentFrame() {
      if (pending) return;
      pending = setTimeout(() => { pending = 0; load(true); }, 1000);
    },
    destroy() { clearTimeout(pending); },
  };
}
