// Terminal tab — an xterm.js terminal bound to the agent's PTY over the WS.
//
// Protocol (docs/API.md, server/index.js):
//   out: {type:"attach", id}
//   in : {type:"pty", id, data, scrollback:true, live:boolean}   first frame
//   in : {type:"pty", id, data}                                  live output
//   out: {type:"input", id, data} / {type:"resize", id, cols, rows}
//   out: {type:"detach", id}
//
// Three states, decided before anything is drawn:
//   external  runtime === "external" (the CTO and in-app orchestrators). They
//             are in-app Claude sessions with no PTY, so the tab never attaches
//             and explains where the conversation is instead.
//   exited    a spawned agent whose process is gone. Attach still returns the
//             recorded scrollback with live:false; it is shown read-only and
//             the tab never claims to be attached.
//   live      a live PTY, attached as before.

import { h, debounce } from '../../lib/dom.js';

const FINISHED = new Set(['done', 'failed', 'stopped']);

const THEME = {
  background: '#1B1A18',
  foreground: '#E7E3DC',
  cursor: '#E7E3DC',
  cursorAccent: '#1B1A18',
  selectionBackground: 'rgba(231, 227, 220, .22)',
  black: '#1B1A18', red: '#E5776B', green: '#7FC4A0', yellow: '#D9B26A',
  blue: '#8FB3D9', magenta: '#C9A2C9', cyan: '#8CC7C4', white: '#DCD7CE',
  brightBlack: '#6B6862', brightRed: '#F0968C', brightGreen: '#9ED6B8',
  brightYellow: '#E8C88A', brightBlue: '#AFCBE6', brightMagenta: '#DBBEDB',
  brightCyan: '#AEDAD7', brightWhite: '#FFFFFF',
};

export function createTerminalTab(ctx) {
  const stateChip = h('span', { class: 'chip', dataset: { status: 'queued' } }, 'connecting');
  const noteEl = h('span', { class: 'term-note' }, '');
  const sizeEl = h('span', { class: 'mono' }, '');
  const host = h('div', { class: 'term-wrap' });
  const emptyEl = h('div', { class: 'term-empty', hidden: true }, 'No terminal output was recorded for this agent.');
  host.appendChild(emptyEl);

  const bar = h('div', { class: 'term-bar' },
    h('span', null, 'Terminal'),
    stateChip,
    noteEl,
    h('span', { class: 'mono' }, ctx.agentId),
    h('span', { class: 'spacer' }),
    sizeEl);

  const el = h('div', { class: 'pane pane-flush' }, bar, host);

  let term = null;
  let fit = null;
  let attached = false;
  let live = false;
  let gotFirst = false;
  let offPty = null;
  let offOpen = null;
  let ro = null;
  let degraded = false;
  let external = false;
  let lastAttachAt = 0;

  function setState(kind) {
    // live wears the gem chip; everything else is a quiet neutral chip
    if (kind === 'live') {
      stateChip.dataset.status = 'running'; stateChip.textContent = 'live';
      noteEl.textContent = 'attached to the running process';
    } else if (kind === 'exited') {
      stateChip.dataset.status = 'stopped'; stateChip.textContent = 'read only';
      const a = ctx.getAgent();
      const code = a && a.exitCode != null ? ` (exit code ${a.exitCode})` : '';
      noteEl.textContent = `process exited${code} · read-only scrollback · Restart re-attaches`;
    } else if (kind === 'external') {
      stateChip.dataset.status = 'stopped'; stateChip.textContent = 'no terminal';
      noteEl.textContent = 'in-app Claude session';
    } else if (kind === 'unavailable') {
      stateChip.dataset.status = 'failed'; stateChip.textContent = 'unavailable';
      noteEl.textContent = '';
    } else {
      stateChip.dataset.status = 'queued'; stateChip.textContent = 'connecting';
      noteEl.textContent = '';
    }
    el.dataset.termState = kind;
  }

  function showExternal() {
    external = true;
    setState('external');
    sizeEl.textContent = '';
    const goChat = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.switchTab && ctx.switchTab('chat') }, 'Open Chat');
    host.replaceWith(h('div', { class: 'explain' },
      h('div', { class: 'explain-icon' }, terminalGlyph()),
      h('div', { class: 'explain-title' }, 'No terminal for this agent'),
      h('p', { class: 'explain-body' },
        'This agent runs as an in-app Claude session, so it has no terminal. Its live conversation is in Chat.'),
      goChat));
  }

  function degrade(reason) {
    degraded = true;
    host.replaceChildren(h('div', { class: 'notice' },
      h('h4', null, 'Terminal unavailable'),
      h('p', null, reason),
      h('p', null,
        'The terminal needs ', h('code', null, 'window.Terminal'), ' from ',
        h('code', null, '/vendor/xterm/xterm.js'), ', served by the Control Room server. ',
        'It does not load when this page is opened from disk.'),
      h('p', null, 'Every other tab works normally.')));
    setState('unavailable');
  }

  function ensureTerm() {
    if (term || degraded) return term;
    const Terminal = window.Terminal;
    if (typeof Terminal !== 'function') {
      degrade('xterm.js did not load, so no terminal could be created.');
      return null;
    }
    try {
      term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 10000,
        theme: THEME,
        allowProposedApi: true,
      });
      const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
      if (typeof FitCtor === 'function') {
        fit = new FitCtor();
        term.loadAddon(fit);
      }
      term.open(host);
      term.onData((data) => {
        if (!live) return; // read-only scrollback: nothing to type into
        ctx.conn.send({ type: 'input', id: ctx.agentId, data });
      });
      term.onResize(({ cols, rows }) => {
        sizeEl.textContent = `${cols}×${rows}`;
        if (live) ctx.conn.send({ type: 'resize', id: ctx.agentId, cols, rows });
      });
    } catch (err) {
      console.error('[terminal] init failed', err);
      degrade('xterm.js failed to initialise: ' + (err && err.message ? err.message : err));
      return null;
    }
    return term;
  }

  const doFit = debounce(() => {
    if (!term || !fit) return;
    if (!host.clientWidth || !host.clientHeight) return;
    try { fit.fit(); } catch { /* xterm throws when the host is hidden */ }
  }, 60);

  function onFrame(frame) {
    if (!term || frame.id !== ctx.agentId) return;
    const data = typeof frame.data === 'string' ? frame.data : '';
    if (frame.scrollback || !gotFirst) {
      gotFirst = true;
      // Older servers (and mock mode) omit `live`; fall back to the agent's status.
      const a = ctx.getAgent();
      live = typeof frame.live === 'boolean' ? frame.live : !(a && FINISHED.has(a.status));
      term.options.disableStdin = !live;
      term.options.cursorBlink = live;
      setState(live ? 'live' : 'exited');
      if (frame.scrollback) term.reset();
      emptyEl.hidden = !!data || live;
      if (live) {
        doFit();
        ctx.conn.send({ type: 'resize', id: ctx.agentId, cols: term.cols, rows: term.rows });
      }
    } else if (data) {
      emptyEl.hidden = true;
    }
    if (data) term.write(data);
  }

  function attach() {
    if (attached || degraded || external) return;
    if (!ensureTerm()) return;
    attached = true;
    setState('connecting');

    offPty = ctx.conn.on('pty', onFrame);
    offOpen = ctx.conn.on('open', () => {
      if (!attached) return;
      gotFirst = false;
      setState('connecting');
      ctx.conn.send({ type: 'attach', id: ctx.agentId });
    });

    lastAttachAt = Date.now();
    ctx.conn.send({ type: 'attach', id: ctx.agentId });
    // The attach frame is queued while the socket is down; say so rather than
    // sitting on "connecting" with no explanation.
    if (ctx.conn.state !== 'open') {
      noteEl.textContent = 'waiting for the control server connection…';
    }
    requestAnimationFrame(() => doFit());

    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => doFit());
      ro.observe(host);
    }
    window.addEventListener('resize', doFit);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    ctx.conn.send({ type: 'detach', id: ctx.agentId });
    if (offPty) { offPty(); offPty = null; }
    if (offOpen) { offOpen(); offOpen = null; }
    if (ro) { ro.disconnect(); ro = null; }
    window.removeEventListener('resize', doFit);
  }

  return {
    el,
    activate() {
      const a = ctx.getAgent();
      if (!external && a && a.runtime === 'external') { showExternal(); return; }
      attach();
      doFit();
      if (term && live) term.focus();
    },
    deactivate() { /* stay attached while the panel is open so output is not lost */ },
    onAgentFrame(a) {
      if (!a) return;
      // The process ended while we were watching: the stream stops, the view stays.
      if (live && FINISHED.has(a.status)) {
        live = false;
        if (term) { term.options.disableStdin = true; term.options.cursorBlink = false; }
        setState('exited');
        return;
      }
      // It came back (Restart): re-attach so the new process streams here
      // instead of leaving a dead read-only pane behind.
      if (!live && attached && !FINISHED.has(a.status) && a.pid && Date.now() - lastAttachAt > 3000) {
        lastAttachAt = Date.now();
        gotFirst = false;
        setState('connecting');
        ctx.conn.send({ type: 'attach', id: ctx.agentId });
      }
    },
    destroy() {
      detach();
      if (term) { try { term.dispose(); } catch { /* ignore */ } term = null; }
      fit = null;
    },
  };
}

function terminalGlyph() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M7 10l3 2-3 2', 'M13 15h4']) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
