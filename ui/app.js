// Control Room — application entry point.
//
// Boot order matters: when ?mock=1 is present the in-page fake server must
// replace fetch/WebSocket before any module issues a request, so mock.js is
// imported (and awaited) first.

const params = new URLSearchParams(location.search);
if (params.get('mock') === '1' || params.has('mock')) {
  await import('./mock.js');
}

const { qs, qsa, toast, setText } = await import('./lib/dom.js');
const { Conn, wsUrl } = await import('./lib/ws.js');
const store = await import('./lib/store.js');
const f = await import('./lib/format.js');
const { api } = await import('./lib/api.js');
const { mountDashboard } = await import('./views/dashboard.js');
const { mountHierarchy } = await import('./views/hierarchy.js');
const { mountPanel } = await import('./views/panel.js');
const { mountNewAgent } = await import('./views/newagent.js');
const { mountCto } = await import('./views/cto.js');

window.__CR_BOOTED__ = true;
// The classic-script guard in index.html shows its card after 600ms. A slow
// first load (cold module graph, a hard reload) can beat the modules to it, so
// clear it once the graph really is up.
const bootBox = document.getElementById('boot-error');
if (bootBox) bootBox.hidden = true;

// ------------------------------------------------------------- navigation

const views = {
  dashboard: qs('#view-dashboard'),
  cto: qs('#view-cto'),
  hierarchy: qs('#view-hierarchy'),
};

// Mounted before showView() can run so the CTO tab can be activated/idled by it.
const cto = mountCto({ view: views.cto, badge: qs('#nav-badge-cto') });
const navButtons = qsa('#nav .nav-item');

function showView(name) {
  if (!views[name]) name = 'dashboard';
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  for (const b of navButtons) b.setAttribute('aria-selected', b.dataset.view === name ? 'true' : 'false');
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  if (name === 'cto') cto.activate(); else cto.deactivate();
  closeNav();
}

for (const b of navButtons) b.addEventListener('click', () => showView(b.dataset.view));
window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'dashboard'));

// ---- the rail becomes a drawer under 900px -------------------------------

const navToggle = qs('#nav-toggle');
const navScrim = qs('#nav-scrim');

function openNav() {
  document.body.dataset.nav = 'open';
  navToggle.setAttribute('aria-expanded', 'true');
}
function closeNav() {
  if (document.body.dataset.nav !== 'open') return;
  delete document.body.dataset.nav;
  navToggle.setAttribute('aria-expanded', 'false');
}
navToggle.addEventListener('click', () => {
  if (document.body.dataset.nav === 'open') closeNav(); else openNav();
});
navScrim.addEventListener('click', closeNav);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeNav(); });

// ------------------------------------------------------------- connection

const conn = new Conn(wsUrl());
let everConnected = false;

const connEls = [qs('#conn'), qs('#conn-mobile')].filter(Boolean);
const connMeta = qs('#conn-meta');
const netbar = qs('#netbar');
const netbarText = qs('#netbar-text');
const netbarRetry = qs('#netbar-retry');

if (netbarRetry) {
  netbarRetry.addEventListener('click', () => {
    setText(netbarText, 'Reconnecting…');
    conn.connect();
    api.state()
      .then((s) => store.setState({ agents: s.agents, usage: s.usage, config: s.config }))
      .catch((err) => toast('Still cannot reach the server: ' + err.message, 'error'));
  });
}

conn.onState((state, attempt) => {
  let label, title;
  if (state === 'open') {
    label = 'live';
    title = 'Connected to ' + conn.url;
  } else if (state === 'connecting') {
    label = attempt ? `retry ${attempt}` : 'connecting';
    title = attempt ? `Reconnecting (attempt ${attempt})` : 'Connecting…';
  } else {
    label = 'offline';
    const wait = conn.nextRetryMs ? Math.round(conn.nextRetryMs / 100) / 10 : null;
    title = wait ? `Disconnected — retrying in ${wait}s` : 'Disconnected';
  }
  for (const el of connEls) {
    el.querySelector('.conn-dot').dataset.state = state;
    setText(el.querySelector('.conn-text'), label);
    el.title = title;
  }
  // The rail's meta line is the address actually in use, not a baked-in port.
  if (connMeta) setText(connMeta, state === 'open' ? (location.host || conn.url) : '');
  if (netbar) {
    // A first connection attempt is not a failure; the banner appears once the
    // socket has actually dropped (or the first attempt has visibly failed).
    const down = state === 'closed' || (state === 'connecting' && attempt > 0);
    netbar.hidden = !down;
    netbar.dataset.state = state;
    if (down) {
      const wait = conn.nextRetryMs ? Math.max(1, Math.round(conn.nextRetryMs / 1000)) : null;
      setText(netbarText, everConnected
        ? `Lost the control server. Live updates are paused${wait ? ` — retrying in ${wait}s` : ''}.`
        : `Cannot reach the control server at ${location.host}. Is \`npm start\` running?`);
    }
  }
});

conn.on('state', (frame) => {
  store.setState({ agents: frame.agents, usage: frame.usage, config: frame.config });
});
conn.on('agent', (frame) => { if (frame.agent) store.upsertAgent(frame.agent); });
conn.on('usage', (frame) => { if (frame.usage) store.setUsage(frame.usage); });
conn.on('message', (frame) => {
  const m = frame.message;
  if (!m) return;
  // The CTO tab owns its own unread badge; a frame it claims is not toasted
  // twice (the CTO view is where that message is already on screen).
  if (cto.onMessageFrame(m)) return;
  if (m.direction === 'report') {
    const from = store.getAgent(m.agentId);
    toast(`Report from ${from ? (from.name || m.agentId) : m.agentId}`, 'info');
  }
});

conn.on('open', () => {
  if (everConnected) toast('Reconnected to the control server.', 'ok');
  everConnected = true;
  // A reconnect may have missed frames; re-prime from HTTP.
  if (netbar) netbar.hidden = true;
  api.state().then((s) => store.setState({ agents: s.agents, usage: s.usage, config: s.config })).catch(() => { /* the socket will fill in */ });
});
conn.on('close', () => { if (everConnected) toast('Lost the control server — reconnecting…', 'error'); });

// ------------------------------------------------------------- rail summary

const sideActive = qs('#side-active');
const sideDone = qs('#side-done');
const sideSpend = qs('#side-spend');
const sideTokens = qs('#side-tokens');
const navCount = qs('#nav-count-hierarchy');
const brandSub = qs('#brand-sub');

function renderRailSummary() {
  const agents = store.getAgents();
  const u = store.getUsage() || {};
  const counts = u.counts || {};
  const active = counts.active ?? agents.filter((a) => a.status === 'running' || a.status === 'queued').length;
  const done = counts.done ?? agents.filter((a) => a.status === 'done').length;
  setText(sideActive, String(active));
  // the gem dot is live state: it appears only while something is actually running
  const activeCell = sideActive.parentElement;
  if (activeCell) activeCell.dataset.live = active > 0 ? '1' : '0';
  setText(sideDone, String(done));
  setText(sideSpend, u.spend ? f.usd(u.spend.today) : '—');
  setText(sideTokens, u.tokens ? f.tokens(u.tokens.total) : '—');
  setText(navCount, agents.length ? String(agents.length) : '');
  const cfg = store.getConfig();
  if (cfg && cfg.defaultCwd) brandSub.title = cfg.defaultCwd;
}

store.store.on('agents', renderRailSummary);
store.store.on('usage', renderRailSummary);

// ------------------------------------------------------------- mount views

mountDashboard(views.dashboard);
mountHierarchy({ root: qs('#hier-root'), count: qs('#tree-count'), modeToggle: qs('#hier-mode') });
mountPanel({ host: qs('#panel-host'), connection: conn });
mountNewAgent({ root: qs('#modal-root'), buttons: [qs('#new-agent-btn'), qs('#new-agent-btn-mobile')] });

showView(location.hash.slice(1) || 'dashboard');
renderRailSummary();

// Prime from HTTP so the UI is populated even if the socket is slow/unavailable,
// then let the socket take over.
api.state()
  .then((s) => store.setState({ agents: s.agents, usage: s.usage, config: s.config }))
  .catch((err) => {
    console.warn('[app] initial /api/state failed', err);
    toast('Could not load the fleet: ' + err.message, 'error', 7000);
    store.setLoadError(err.message);
  });

// A crash inside a view must not leave a half-drawn page with nothing said.
// Browser extensions and cross-origin scripts also land here, so the message is
// deliberately non-alarming and deduplicated by the toast layer.
window.addEventListener('error', (ev) => {
  if (!ev || !ev.message) return;
  toast('UI error: ' + ev.message, 'error', 6000);
});
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev && ev.reason;
  const msg = reason && reason.message ? reason.message : String(reason ?? 'unknown');
  toast('Request failed: ' + msg, 'error', 6000);
});

conn.connect();

// Selecting an agent from anywhere reveals the tree behind the drawer.
store.store.on('select', (id) => { if (id) showView('hierarchy'); });

// Expose a tiny handle for console debugging.
window.controlRoom = { conn, store, api, cto };
