// CTO chat — the live CLI session rendered as a conversation.
//
// The transcript is a merge of two sources on one clock: the parsed CLI
// transcript and the control room's own message log (reports from child
// agents). Turns from the same speaker group under one avatar (a spacer keeps
// the column straight where a face is suppressed); a tool call is a compact
// pill rather than a bubble, so it is always visible but never mistaken for
// something the agent said; the waiting state stands where the reply will land.
//
// Why it is capped AND windowed: a long-running CTO session runs to thousands
// of turns, which is far more than anyone scrolls and more than the DOM should
// hold. Only the newest CAP items are kept in memory at all, and of those only
// WINDOW rows are in the document; "Show earlier" pages further back in
// WINDOW_STEP chunks. Keeping both limits means neither a huge history nor a
// fast-growing live session can make the page janky.
//
// Composer behaviour: Enter sends, Shift+Enter inserts a newline, the field is
// never disabled (queue rather than block), and focus returns to it after a
// pointer send.

import { h, replace, clear, toast, setText, qs } from '../lib/dom.js';
import * as f from '../lib/format.js';
import api from '../lib/api.js';
import { store, getAgents, getAgent, getConfig, select } from '../lib/store.js';

const POLL_MS = 5000;
/** Newest N merged items kept in memory. The session is far longer than this. */
const CAP = 300;
/** Rows put in the DOM at once. */
const WINDOW = 60;
const WINDOW_STEP = 60;

export function ctoAgent() {
  const candidates = getAgents().filter((a) => a.role === 'cto' && !a.successorId);
  return candidates.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
}

/**
 * Merge the parsed transcript with the control-room message log by time.
 * Transcript entries carry `ts`, message records carry `createdAt`; both are
 * ISO strings from the same server clock.
 */
export function mergeThread(transcript, messages) {
  const out = [];
  let seq = 0;
  for (const m of transcript || []) {
    const role = normalizeRole(m.role);
    out.push({
      key: 'x' + seq,
      seq: seq++,
      t: ms(m.ts),
      kind: role === 'tool' ? 'tool' : 'bubble',
      side: role === 'user' ? 'user' : 'agent',
      role,
      name: m.name || '',
      text: String(m.text ?? ''),
      ts: m.ts || null,
    });
  }
  for (const m of messages || []) {
    const human = m.sender === 'human';
    out.push({
      key: 'm' + m.id,
      seq: seq++,
      t: ms(m.createdAt),
      id: m.id,
      kind: human ? 'bubble' : 'event',
      side: human ? 'user' : 'agent',
      role: human ? 'user' : 'system',
      sender: m.sender || 'system',
      from: m.fromAgentId || null,
      direction: m.direction || 'system',
      text: String(m.text ?? ''),
      ts: m.createdAt || null,
    });
  }
  // Stable: equal timestamps keep insertion order (transcript before messages).
  out.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
  return out;
}

function ms(iso) {
  const d = f.toDate(iso);
  return d ? d.getTime() : 0;
}

export function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'agent') return 'assistant';
  if (r === 'tool' || r === 'tool_use' || r === 'tool_result') return 'tool';
  return 'system';
}

/** First line of a tool payload, for the collapsed pill. */
export function toolSummary(item) {
  const first = String(item.text || '').split('\n').find((l) => l.trim()) || '';
  const label = item.name ? `${item.name} · ` : '';
  return (label + f.truncate(first.trim(), 120)) || 'tool call';
}

function initials(name) {
  // Agent names carry parentheticals ("CTO (this Claude desktop session)"), so
  // the letters are picked from word CHARACTERS rather than from whitespace
  // splits — otherwise the face reads "C(".
  const parts = String(name || '?').trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatar(name, tone) {
  return h('span', { class: 'cto-face', dataset: { tone }, 'aria-hidden': 'true' }, initials(name));
}

/* ------------------------------------------------------------------ mount */

export function mountCto({ view, badge }) {
  let agentId = null;
  let shown = WINDOW;
  let unread = 0;
  let active = false;
  let timer = 0;
  let inflight = false;
  let transcript = [];
  let messages = [];
  let pending = null;          // optimistic bubble while the POST is in flight
  const queuedIds = new Set(); // message ids this tab queued to the CTO inbox
  const expanded = new Set();
  const expandedText = new Set(); // long bubbles the operator opened
  let lastSig = '';
  let stickBottom = true;

  // ---- header ------------------------------------------------------------
  const headFace = h('span', { class: 'cto-face cto-face-lg', dataset: { tone: 'agent' } }, 'CT');
  const headName = h('div', { class: 'cto-head-name' }, 'CTO');
  const headSub = h('div', { class: 'cto-head-sub' }, 'looking for the CTO agent…');
  const headChip = h('span', { class: 'chip', dataset: { status: 'queued' } }, 'queued');
  const headStats = h('div', { class: 'cto-head-stats' });
  const openBtn = h('button', {
    class: 'btn btn-sm',
    onclick: () => { if (agentId) select(agentId); },
  }, 'Open in hierarchy');
  const head = h('header', { class: 'cto-head' },
    headFace,
    h('div', { class: 'cto-head-id' }, headName, headSub),
    headStats,
    headChip,
    openBtn);

  // ---- thread ------------------------------------------------------------
  const list = h('div', { class: 'cto-list' });
  const scroll = h('div', { class: 'cto-scroll', tabindex: '0' },
    h('div', { class: 'loading' }, 'Loading the CTO session…'));
  scroll.addEventListener('scroll', () => {
    stickBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  }, { passive: true });

  // ---- composer ----------------------------------------------------------
  const textarea = h('textarea', {
    class: 'cto-input',
    rows: '1',
    placeholder: 'Message the CTO…',
    'aria-label': 'Message the CTO',
    oninput: grow,
    onkeydown: (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        doSend();
      }
    },
  });
  const sendBtn = h('button', { class: 'cto-send', type: 'submit', 'aria-label': 'Send' },
    iconArrowUp());
  const form = h('form', {
    class: 'cto-composer',
    onsubmit: (ev) => { ev.preventDefault(); doSend(); },
  }, textarea, sendBtn);

  const composer = h('div', { class: 'cto-composer-wrap' },
    form,
    h('div', { class: 'cto-hint' },
      'Enter sends · Shift+Enter for a new line · sent as ',
      h('code', { class: 'mono' }, 'X-Sender: human'),
      ' and queued to the CTO inbox'));

  const root = h('div', { class: 'cto' }, head, scroll, composer);
  replace(view, root);

  function grow() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 170) + 'px';
    sendBtn.dataset.ready = textarea.value.trim() ? '1' : '0';
  }
  grow();

  // ---- data --------------------------------------------------------------

  function resolveAgent() {
    const a = ctoAgent();
    const id = a ? a.id : null;
    if (id !== agentId) {
      agentId = id;
      transcript = []; messages = []; lastSig = ''; shown = WINDOW;
      expanded.clear(); expandedText.clear(); queuedIds.clear(); pending = null;
      clear(list);
      if (id) replace(scroll, h('div', { class: 'loading' }, 'Loading the CTO session…'));
      if (!id) renderNoCto();
      else if (active) refresh();
    }
    renderHead(a);
    setComposerEnabled(Boolean(id));
    return a;
  }

  function setComposerEnabled(on) {
    textarea.disabled = !on;
    sendBtn.disabled = !on;
    textarea.placeholder = on ? 'Message the CTO…' : 'Register a CTO agent first';
    form.dataset.disabled = on ? '0' : '1';
  }

  /**
   * There is no agent with role "cto" yet. This is the state a fresh install
   * opens in, so it explains what a CTO is here and how to get one — the view
   * used to sit on "Loading the CTO session…" forever.
   */
  function renderNoCto() {
    const cfg = getConfig() || {};
    replace(scroll, h('div', { class: 'cto-empty' },
      h('div', { class: 'cto-empty-mark' }, iconChat()),
      h('p', { class: 'cto-empty-title' }, 'No CTO agent yet'),
      h('p', { class: 'cto-empty-body' },
        'The CTO is the top of the tree: the one agent you talk to, which delegates to orchestrators and workers. ',
        'This page is its conversation. Create an agent with the role ',
        h('strong', null, 'cto'), ' and it takes over here.'),
      h('div', { class: 'btn-row', style: { justifyContent: 'center', marginTop: '16px' } },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => { const b = qs('#new-agent-btn') || qs('#new-agent-btn-mobile'); if (b) b.click(); },
        }, 'New agent')),
      h('p', { class: 'cto-empty-body', style: { marginTop: '18px' } },
        'Registering the session you are already in — the usual case — means runtime ',
        h('code', { class: 'mono' }, 'external'), ' and its session id, or from a terminal:'),
      h('pre', { class: 'code-inline mono' },
        `node ${cfg.crBin || 'bin/cr.js'} register --name "CTO" --role cto --session <session-id>`)));
  }

  function renderHead(a) {
    if (!a) {
      setText(headName, 'CTO');
      setText(headSub, 'nothing registered at the top of the tree yet');
      clear(headStats);
      openBtn.hidden = true;
      headChip.hidden = true;
      return;
    }
    openBtn.hidden = false;
    openBtn.disabled = false;
    headChip.hidden = false;
    setText(headName, a.name || a.id);
    const bits = [a.model || a.runtime || '—'];
    if (a.runtime === 'external') bits.push('external session');
    if (a.cwd) bits.push(a.cwd);
    setText(headSub, bits.join(' · '));
    headFace.textContent = initials(a.name || 'CTO');
    headChip.dataset.status = a.status || 'queued';
    setText(headChip, a.status || 'queued');
    const u = a.usage || {};
    const elapsed = a.elapsedS != null ? a.elapsedS : f.elapsedSince(a.startedAt || a.createdAt);
    // Missing usage and unknown pricing must remain visibly unknown.
    replace(headStats,
      stat('elapsed', f.duration(elapsed)),
      stat('tokens', f.tokens(u.totalTokens)),
      stat('cost', f.usageCost(u)));
  }

  function stat(label, value) {
    return h('div', { class: 'cto-stat' },
      h('span', { class: 'cto-stat-v' }, value),
      h('span', { class: 'cto-stat-l' }, label));
  }

  async function refresh() {
    if (!agentId) { renderNoCto(); return; }
    if (inflight) return;
    inflight = true;
    const requestedId = agentId;
    try {
      const [chat, msgs] = await Promise.all([
        api.chat(requestedId).catch((e) => ({ __error: e })),
        api.messages(requestedId).catch(() => []),
      ]);
      if (requestedId !== agentId) return;
      if (chat && chat.__error) throw chat.__error;
      transcript = Array.isArray(chat && chat.messages) ? chat.messages : [];
      messages = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
      render();
    } catch (err) {
      // A failed poll must not wipe a thread that is already on screen.
      if (!list.childElementCount) {
        replace(scroll, h('div', { class: 'error-box', role: 'alert', style: { margin: '18px' } },
          'Could not load the CTO session: ' + err.message));
      }
    } finally {
      inflight = false;
    }
  }

  function render() {
    const merged = mergeThread(transcript, messages).slice(-CAP);
    if (pending) merged.push(pending);

    const sig = merged.length + '|' + shown + '|' + expanded.size + ':' + expandedText.size + '|' +
      (merged.length ? merged[merged.length - 1].key + ':' + String(merged[merged.length - 1].text).length : '');
    if (sig === lastSig) return;
    lastSig = sig;

    if (scroll.firstChild !== list) replace(scroll, list);

    const beforeH = scroll.scrollHeight;
    const beforeTop = scroll.scrollTop;
    clear(list);

    if (!merged.length) {
      list.appendChild(h('div', { class: 'cto-empty' },
        h('div', { class: 'cto-empty-mark' }, iconChat()),
        h('p', { class: 'cto-empty-title' }, 'No conversation yet'),
        h('p', { class: 'cto-empty-body' },
          'This is the CTO session\u2019s live transcript. Messages you send land in its inbox and it picks them up on its next check; everything it says, and every report its children file, appears here.')));
      return;
    }

    const hidden = Math.max(0, merged.length - shown);
    if (hidden > 0) {
      list.appendChild(h('button', {
        class: 'cto-earlier',
        type: 'button',
        onclick: () => { shown += WINDOW_STEP; lastSig = ''; render(); },
      }, `Show earlier (${hidden} more)`));
    }

    const visible = hidden > 0 ? merged.slice(hidden) : merged;
    let lastSide = null;
    let lastDay = '';
    for (const item of visible) {
      const day = item.ts ? new Date(item.ts).toDateString() : '';
      if (day && day !== lastDay) {
        lastDay = day;
        lastSide = null;
        list.appendChild(h('div', { class: 'cto-day' }, h('span', null, day)));
      }
      if (item.kind === 'tool') { list.appendChild(toolRow(item)); continue; }
      if (item.kind === 'event') { lastSide = null; list.appendChild(eventRow(item)); continue; }
      const leads = item.side !== lastSide;
      lastSide = item.side;
      list.appendChild(bubbleRow(item, leads));
    }

    if (stickBottom) {
      scroll.scrollTop = scroll.scrollHeight;
    } else if (hidden > 0 || beforeTop > 0) {
      // Keep the reading position when rows were prepended.
      scroll.scrollTop = beforeTop + (scroll.scrollHeight - beforeH);
    }
  }

  function bubbleRow(item, leads) {
    const isUser = item.side === 'user';
    const face = leads
      ? avatar(isUser ? 'You' : (headName.textContent || 'CTO'), isUser ? 'user' : 'agent')
      : h('span', { class: 'cto-face cto-face-gap', 'aria-hidden': 'true' });
    const meta = [];
    if (leads) meta.push(isUser ? 'you' : (item.role === 'assistant' ? 'CTO' : item.role));
    if (item.ts) meta.push(f.clock(item.ts));
    if (item.id && queuedIds.has(item.id)) meta.push('queued to CTO inbox');
    if (item.kind === 'pending') meta.push('sending…');

    // The face sits OUTSIDE the bubble, level with its bottom edge, and the
    // timestamp has to live below the pair rather than beside it: a stamp made
    // a sibling of the bubble in the same column drags the face down past it.
    // `.cto-line` is the face-and-bubble pair; the stamp sits under the pair.
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

    const col = h('div', { class: 'cto-col' },
      line,
      more,
      meta.length ? h('div', { class: 'cto-meta' }, meta.join(' · ')) : null);

    return h('div', { class: 'cto-row', dataset: { side: item.side } }, col);
  }

  function toolRow(item) {
    const open = expanded.has(item.key);
    const pill = h('button', {
      class: 'cto-tool',
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      onclick: () => {
        if (expanded.has(item.key)) expanded.delete(item.key); else expanded.add(item.key);
        lastSig = '';
        render();
      },
    },
      iconWrench(),
      h('span', { class: 'cto-tool-text' }, open ? (item.name || 'tool') : toolSummary(item)),
      item.ts ? h('span', { class: 'cto-tool-time' }, f.clock(item.ts)) : null);

    return h('div', { class: 'cto-row cto-row-tool' },
      h('div', { class: 'cto-col' },
        pill,
        open ? h('pre', { class: 'cto-tool-body mono' }, item.text) : null));
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
          from ? h('button', {
            class: 'link cto-card-open',
            type: 'button',
            onclick: () => select(from),
          }, child ? `Open ${child.name || from}` : 'Open in hierarchy') : null),
        h('div', { class: 'cto-card-body' }, item.text)));
  }

  async function doSend() {
    const text = textarea.value.trim();
    if (!agentId) { toast('There is no CTO agent to message yet.', 'error'); return; }
    if (!text) return;
    textarea.value = '';
    grow();
    textarea.focus();
    pending = {
      key: 'p' + Date.now(), seq: 1e9, t: Date.now(),
      kind: 'pending', side: 'user', role: 'user', text, ts: new Date().toISOString(),
    };
    stickBottom = true;
    lastSig = '';
    render();
    try {
      const res = await api.send(agentId, text, 'human');
      if (res && res.message && res.message.id != null && res.queued) queuedIds.add(res.message.id);
      pending = null;
      lastSig = '';
      await refresh();
    } catch (err) {
      pending = null;
      lastSig = '';
      render();
      textarea.value = text;
      grow();
      if (err.status === 409) toast('Rejected (409): ' + err.message, 'error', 7000);
      else toast('Send failed: ' + err.message, 'error', 7000);
    }
  }

  // ---- badge -------------------------------------------------------------

  function renderBadge() {
    if (!badge) return;
    setText(badge, unread ? String(unread > 99 ? '99+' : unread) : '');
    badge.dataset.tone = unread ? 'alert' : '';
    badge.hidden = !unread;
  }

  store.on('agents', () => resolveAgent());
  store.on('agent', (a) => {
    if (!agentId || !a || a.id !== agentId) { resolveAgent(); return; }
    renderHead(a);
    if (active) refresh();
  });

  const tick = setInterval(() => { if (agentId && !document.hidden) renderHead(getAgent(agentId)); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) refresh(); });

  resolveAgent();
  if (!agentId) renderNoCto();
  renderBadge();

  return {
    /** A WS `message` frame arrived. Returns true when it was for the CTO. */
    onMessageFrame(m) {
      if (!m || !agentId || m.agentId !== agentId) return false;
      if (active) { refresh(); return true; }
      if (m.sender !== 'human') { unread += 1; renderBadge(); }
      return true;
    },
    activate() {
      active = true;
      unread = 0;
      renderBadge();
      resolveAgent();
      stickBottom = true;
      refresh();
      clearInterval(timer);
      // A hidden tab polls nothing: the CTO transcript is the most expensive
      // read in the app and a background window has no reason to ask for it.
      timer = setInterval(() => { if (active && !document.hidden) refresh(); }, POLL_MS);
      if (agentId) setTimeout(() => textarea.focus(), 0);
    },
    deactivate() {
      active = false;
      clearInterval(timer);
      timer = 0;
    },
    destroy() { clearInterval(timer); clearInterval(tick); },
  };
}

/* --------------------------------------------------------------- glyphs -- */
// Three shapes (wrench, arrow-up, chat), inlined as paths because this repo
// ships no icon library.

function svg(children, extra) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', extra || '1.7');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  for (const d of children) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    el.appendChild(p);
  }
  return el;
}

function iconArrowUp() { return svg(['M12 19V5', 'M5 12l7-7 7 7'], '2'); }
function iconWrench() {
  // A real wrench outline; the previous single-path approximation read as a
  // paperclip, which is a different promise entirely.
  return svg(['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z']);
}
function iconChat() {
  return svg(['M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-4.6A8.4 8.4 0 1 1 21 11.5z']);
}
