// Chat tab — the agent's conversation, in the same anatomy as the CTO view.
//
// The transcript (GET /chat) and the control-room message log (GET /messages)
// are merged by time with `mergeThread` from views/cto.js, so a worker's tab
// and the CTO page are the same object at two sizes: avatar-led bubble runs,
// tool calls as quiet pills rather than bubbles, reports from children as
// ruled cards, and a one-bar composer with a round send button.

import { h, replace, clear, toast } from '../../lib/dom.js';
import * as f from '../../lib/format.js';
import api from '../../lib/api.js';
import { getAgent, select } from '../../lib/store.js';
import { mergeThread, toolSummary } from '../cto.js';

const POLL_MS = 5000;
const CAP = 200;
const WINDOW = 40;

export function createChatTab(ctx) {
  const inboxEl = h('div', { class: 'inbox', hidden: true });
  const list = h('div', { class: 'cto-list' });
  const scroll = h('div', { class: 'cto-scroll' }, h('div', { class: 'loading' }, 'Loading conversation…'));

  const textarea = h('textarea', {
    class: 'cto-input', rows: '1',
    placeholder: 'Message this agent as the human operator…',
    'aria-label': 'Message this agent',
    oninput: grow,
    onkeydown: (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); doSend(); }
    },
  });
  const sendBtn = h('button', { class: 'cto-send', type: 'submit', 'aria-label': 'Send' }, iconArrowUp());
  const form = h('form', { class: 'cto-composer', onsubmit: (ev) => { ev.preventDefault(); doSend(); } }, textarea, sendBtn);

  const el = h('div', { class: 'pane pane-flush' },
    inboxEl,
    h('div', { class: 'thread' },
      scroll,
      h('div', { class: 'cto-composer-wrap' },
        form,
        h('div', { class: 'cto-hint' },
          'Enter sends · Shift+Enter for a new line · sent as ',
          h('code', { class: 'mono' }, 'X-Sender: human')))));

  let timer = 0;
  let active = false;
  let inflight = false;
  let transcript = [];
  let messages = [];
  let pending = null;
  let shown = WINDOW;
  let lastSig = '';
  let stickBottom = true;
  const expanded = new Set();
  const expandedText = new Set(); // long bubbles the operator opened

  scroll.addEventListener('scroll', () => {
    stickBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  }, { passive: true });

  function grow() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 170) + 'px';
    sendBtn.dataset.ready = textarea.value.trim() ? '1' : '0';
  }
  grow();

  async function refresh() {
    if (inflight) return;
    inflight = true;
    try {
      const [chat, msgs, inbox] = await Promise.all([
        api.chat(ctx.agentId).catch((e) => ({ __error: e })),
        api.messages(ctx.agentId).catch(() => []),
        api.inbox(ctx.agentId).catch(() => []),
      ]);
      if (chat && chat.__error) throw chat.__error;
      transcript = Array.isArray(chat && chat.messages) ? chat.messages : [];
      messages = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
      render();
      renderInbox(Array.isArray(inbox) ? inbox : (inbox && Array.isArray(inbox.messages) ? inbox.messages : []));
    } catch (err) {
      if (!list.childElementCount) replace(scroll, h('div', { class: 'error-box' }, 'Could not load chat: ' + err.message));
    } finally {
      inflight = false;
    }
  }

  function render() {
    const merged = mergeThread(transcript, messages).slice(-CAP);
    if (pending) merged.push(pending);

    const last = merged[merged.length - 1];
    const sig = merged.length + '|' + shown + '|' + expanded.size + ':' + expandedText.size + '|' + (last ? last.key + ':' + String(last.text).length : '');
    if (sig === lastSig) return;
    lastSig = sig;

    if (scroll.firstChild !== list) replace(scroll, list);
    clear(list);

    if (!merged.length) {
      const a = ctx.getAgent();
      list.appendChild(h('div', { class: 'cto-empty' },
        h('p', { class: 'cto-empty-title' }, 'No conversation yet'),
        h('p', { class: 'cto-empty-body' },
          a && a.runtime === 'deepseek'
            ? 'DeepSeek workers report through their stdout log; if this stays empty, the Terminal tab has the raw run.'
            : 'Nothing has been said in this session yet. Anything you send lands in the agent’s inbox.')));
      return;
    }

    const hidden = Math.max(0, merged.length - shown);
    if (hidden > 0) {
      list.appendChild(h('button', {
        class: 'cto-earlier', type: 'button',
        onclick: () => { shown += WINDOW; lastSig = ''; render(); },
      }, `Show earlier (${hidden} more)`));
    }

    const agent = ctx.getAgent();
    const agentName = agent ? (agent.name || agent.id) : 'agent';
    let lastSide = null;
    let lastDay = '';
    for (const item of (hidden > 0 ? merged.slice(hidden) : merged)) {
      const day = item.ts ? new Date(item.ts).toDateString() : '';
      if (day && day !== lastDay) {
        lastDay = day; lastSide = null;
        list.appendChild(h('div', { class: 'cto-day' }, h('span', null, day)));
      }
      if (item.kind === 'tool') { list.appendChild(toolRow(item)); continue; }
      if (item.kind === 'event') { lastSide = null; list.appendChild(eventRow(item)); continue; }
      const leads = item.side !== lastSide;
      lastSide = item.side;
      list.appendChild(bubbleRow(item, leads, agentName));
    }
    if (stickBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function bubbleRow(item, leads, agentName) {
    const isUser = item.side === 'user';
    const face = leads
      ? h('span', { class: 'cto-face', dataset: { tone: isUser ? 'user' : 'agent' }, 'aria-hidden': 'true' },
          initials(isUser ? 'You' : agentName))
      : h('span', { class: 'cto-face cto-face-gap', 'aria-hidden': 'true' });
    const meta = [];
    if (leads) meta.push(isUser ? 'you' : (item.role === 'assistant' ? 'agent' : item.role));
    if (item.ts) meta.push(f.clock(item.ts));
    if (item.kind === 'pending') meta.push('sending…');

    const long = String(item.text || '').length > 1400;
    const open = expandedText.has(item.key);
    const bubble = h('div', {
      class: 'cto-bubble' + (long ? (open ? ' is-open' : ' is-clamped') : ''),
      dataset: { side: item.side, state: item.kind === 'pending' ? 'pending' : 'ok' },
    }, item.text);
    const more = long
      ? h('button', {
          class: 'link cto-more', type: 'button',
          onclick: () => {
            if (open) expandedText.delete(item.key); else expandedText.add(item.key);
            lastSig = ''; render();
          },
        }, open ? 'Collapse' : `Show the whole message (${String(item.text).length.toLocaleString('en-US')} characters)`)
      : null;

    const line = h('div', { class: 'cto-line' },
      isUser ? null : face,
      bubble,
      isUser ? face : null);

    return h('div', { class: 'cto-row', dataset: { side: item.side } },
      h('div', { class: 'cto-col' }, line, more, meta.length ? h('div', { class: 'cto-meta' }, meta.join(' · ')) : null));
  }

  function toolRow(item) {
    const open = expanded.has(item.key);
    const pill = h('button', {
      class: 'cto-tool', type: 'button', 'aria-expanded': open ? 'true' : 'false',
      onclick: () => {
        if (expanded.has(item.key)) expanded.delete(item.key); else expanded.add(item.key);
        lastSig = ''; render();
      },
    },
      iconWrench(),
      h('span', { class: 'cto-tool-text' }, open ? (item.name || 'tool') : toolSummary(item)),
      item.ts ? h('span', { class: 'cto-tool-time' }, f.clock(item.ts)) : null);

    return h('div', { class: 'cto-row cto-row-tool' },
      h('div', { class: 'cto-col' }, pill, open ? h('pre', { class: 'cto-tool-body mono' }, item.text) : null));
  }

  function eventRow(item) {
    const from = item.from || (String(item.sender || '').startsWith('agent:') ? item.sender.slice(6) : null);
    const child = from ? getAgent(from) : null;
    return h('div', { class: 'cto-row cto-row-event' },
      h('div', { class: 'cto-card', dataset: { direction: item.direction } },
        h('div', { class: 'cto-card-head' },
          h('span', { class: 'cto-card-kind' }, item.direction === 'report' ? 'report' : item.direction),
          h('span', { class: 'cto-card-from mono' }, from || item.sender || 'system'),
          item.ts ? h('time', { datetime: String(item.ts) }, f.clock(item.ts)) : null,
          from ? h('button', { class: 'link cto-card-open', type: 'button', onclick: () => select(from) },
            child ? `Open ${child.name || from}` : 'Open in hierarchy') : null),
        h('div', { class: 'cto-card-body' }, item.text)));
  }

  function renderInbox(items) {
    if (!items || !items.length) { inboxEl.hidden = true; clear(inboxEl); return; }
    inboxEl.hidden = false;
    replace(inboxEl,
      h('div', { class: 'inbox-label' }, `Inbox — ${items.length} unread report${items.length === 1 ? '' : 's'} from children`),
      ...items.map((m) => h('div', { class: 'inbox-item' },
        h('div', { class: 'inbox-from' }, `${m.sender || 'agent'} · ${f.dateTime(m.createdAt)}`),
        String(m.text ?? ''))));
  }

  async function doSend() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    grow();
    textarea.focus();
    pending = { key: 'p' + Date.now(), seq: 1e9, t: Date.now(), kind: 'pending', side: 'user', role: 'user', text, ts: new Date().toISOString() };
    stickBottom = true;
    lastSig = '';
    render();
    try {
      await api.send(ctx.agentId, text, 'human');
      pending = null; lastSig = '';
      await refresh();
    } catch (err) {
      pending = null; lastSig = '';
      render();
      textarea.value = text; grow();
      if (err.status === 409) toast('Rejected (409): ' + err.message, 'error', 7000);
      else toast('Send failed: ' + err.message, 'error', 7000);
    }
  }

  return {
    el,
    activate() {
      active = true;
      stickBottom = true;
      refresh();
      clearInterval(timer);
      timer = setInterval(() => { if (active) refresh(); }, POLL_MS);
      setTimeout(() => textarea.focus(), 0);
    },
    deactivate() { active = false; clearInterval(timer); timer = 0; },
    onAgentFrame() { if (active) refresh(); },
    destroy() { clearInterval(timer); },
  };
}

function initials(name) {
  const parts = String(name || '?').trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function svg(paths, width) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', width || '1.7');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    el.appendChild(p);
  }
  return el;
}
function iconArrowUp() { return svg(['M12 19V5', 'M5 12l7-7 7 7'], '2'); }
function iconWrench() {
  return svg(['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z']);
}
