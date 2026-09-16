// Dashboard — operator panels, built to the grafana-dashboards skill:
// a 24-column grid of plates, one question per panel, a stat panel that is a
// big number + unit + ONE secondary line, a bar gauge only where the data
// exists, no decorative stripes, and every panel titled with its question.
//
// Rebuilt wholesale on each `usage` / `agents` event; it holds no live widgets
// (the terminal and the open drawer live elsewhere, untouched by this).
//
// Costs are estimates calculated from reported usage and configured prices.
// They are not invoices or subscription charges; missing prices stay visible.

import { h, replace, qs } from '../lib/dom.js';
import * as f from '../lib/format.js';
import { store, getUsage, getAgents, getConfig, isLoaded, getLoadError } from '../lib/store.js';
import { limitObservation, limitPercent, comparisonModelLabel } from '../lib/limits.js';

const PLAN_BASIS = 'API-equivalent estimate; not a subscription charge';
const API_BASIS = 'API cost estimate from configured prices';

let root = null;
let frame = 0;
let lastSig = '';

export function mountDashboard(el) {
  root = el;
  store.on('usage', schedule);
  store.on('agents', schedule);
  store.on('config', schedule);
  render();
  setInterval(() => {
    const node = root && root.querySelector('[data-run-elapsed]');
    if (node && node.dataset.runElapsed) {
      const s = f.elapsedSince(node.dataset.runElapsed);
      node.textContent = s === null ? '—' : f.duration(s);
    }
  }, 1000);
}

/**
 * This view is rebuilt wholesale, and a single 5s server frame emits BOTH
 * `agents` and `usage`. Without coalescing, a fleet of twenty agents rebuilt
 * the entire panel grid twice every five seconds, throwing away scroll
 * anchoring and any text selection with it. One rebuild per animation frame,
 * and only when the numbers actually moved.
 */
function schedule() {
  if (frame) return;
  // requestAnimationFrame never fires in a background tab, which would leave a
  // page opened in one stuck on "waiting for the first frame"; the timer is the
  // fallback, and whichever lands first wins.
  const run = () => {
    if (!frame) return;
    cancelAnimationFrame(frame.raf);
    clearTimeout(frame.timer);
    frame = 0;
    render();
  };
  frame = { raf: requestAnimationFrame(run), timer: setTimeout(run, 250) };
}

/** Everything the rendered page depends on, cheaply. */
function signature(u, agents) {
  if (!u) return 'none:' + agents.length;
  const t = u.tokens || {};
  const c = u.counts || {};
  const s = u.spend || {};
  const tiers = Object.entries(u.byTier || {}).map(([k, v]) => k + (v && v.costUsd) + ':' + (v && v.totalTokens)).join(',');
  return [
    agents.length, t.total, t.input, t.output, s.today, s.week, s.month,
    c.running, c.blocked, c.done, c.failed, c.stopped, c.idle, c.queued, c.paused, c.total,
    u.currentRun && u.currentRun.startedAt, (u.savings && u.savings.savedUsd), tiers,
    JSON.stringify(u.limits || {}), u.pricingComplete, JSON.stringify(u.unpricedModels || []), JSON.stringify(u.byTier || {}),
    JSON.stringify(getConfig()?.pricing || {}),
  ].join('|');
}

/* ------------------------------------------------------------------ atoms */

/** A plate: one question group, its panels ruled by hairlines inside it. */
function plate(title, note, panels) {
  return h('section', { class: 'plate' },
    h('div', { class: 'plate-head' },
      h('h2', { class: 'plate-title' }, title),
      note ? h('span', { class: 'plate-note' }, note) : null),
    h('div', { class: 'panels' }, panels));
}

/**
 * One stat panel. `value` is [prefix, number, unit] — the number carries the
 * weight, the unit stays quiet, and `sub` is the single secondary line.
 */
function panel(width, title, value, opts = {}) {
  const { sub, badge, viz, basis, tone, na, live } = opts;
  const [pre, num, unit] = value;
  return h('div', { class: 'panel ' + width },
    h('div', { class: 'panel-title' }, title, badge || null),
    h('div', { class: 'stat-value' + (na ? ' na' : ''), dataset: { tone } },
      live ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null,
      pre ? h('span', { class: 'pre' }, pre) : null,
      num,
      unit ? h('span', { class: 'unit' }, unit) : null),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
    viz || null,
    basis ? h('div', { class: 'basis' }, basis) : null);
}

function basisLine(kind) {
  return kind === 'api' ? API_BASIS : PLAN_BASIS;
}

function meter(fraction, tone) {
  const pct = Math.max(0, Math.min(100, (Number(fraction) || 0) * 100));
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-fill', dataset: { tone }, style: { width: pct.toFixed(1) + '%' } }));
}

/** Grafana's bar gauge: several values against one shared scale. */
function bars(rows) {
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.value) || 0)), 0);
  return h('div', { class: 'bars' },
    rows.map((r) => h('div', { class: 'bar-row' },
      h('span', { class: 'bar-label' }, r.label),
      h('div', { class: 'bar-track' },
        h('div', {
          class: 'bar-fill', dataset: { tone: r.tone },
          style: { width: (max > 0 ? (Math.abs(Number(r.value) || 0) / max) * 100 : 0).toFixed(1) + '%' },
        })),
      h('span', { class: 'bar-val' }, r.display))));
}

function stack(segments) {
  const total = segments.reduce((a, s) => a + Math.max(0, Number(s.value) || 0), 0);
  return h('div', null,
    h('div', { class: 'stack' },
      segments.map((s) => h('div', {
        class: 'stack-seg',
        title: `${s.label}: ${s.display}`,
        style: { width: (total > 0 ? (Math.max(0, Number(s.value) || 0) / total) * 100 : 0).toFixed(2) + '%', background: s.color },
      }))),
    h('div', { class: 'stack-key' },
      segments.map((s) => h('div', { class: 'stack-key-item' },
        h('span', { class: 'stack-key-dot', style: { background: s.color } }),
        s.label,
        h('span', { class: 'stack-key-val' }, s.display)))));
}

/* --------------------------------------------------------------- formats */

/** "$133.23" -> ['$', '133.23']; not-available -> [null, 'not reported'] */
function money(v) {
  const s = f.usd(v);
  if (!s.startsWith('$') && !s.startsWith('-$')) return [null, 'not reported', null];
  const neg = s.startsWith('-');
  return [neg ? '-$' : '$', s.slice(neg ? 2 : 1), null];
}

/** 97909805 -> ['', '97.9', 'M tokens'] */
function tokenValue(v) {
  const s = f.tokens(v);
  const m = /^(-?[\d.]+)([kMB])?$/.exec(s);
  if (!m) return [null, s, null];
  return [null, m[1], (m[2] ? m[2] + ' ' : '') + 'tokens'];
}

function pct(part, whole) {
  if (!whole) return null;
  return ((Number(part) || 0) / whole) * 100;
}

/* ----------------------------------------------------------------- render */

function render() {
  if (!root) return;
  const u = getUsage();
  const agents = getAgents();

  const sig = signature(u, agents);
  if (sig === lastSig && root.firstChild) return;
  lastSig = sig;

  if (!u) {
    const err = getLoadError();
    replace(root, h('div', { class: 'page' }, err ? serverDown(err) : h('div', { class: 'loading' }, 'Waiting for the first state frame from the server…')));
    return;
  }

  if (!agents.length && isLoaded()) {
    replace(root, h('div', { class: 'page' }, firstRun()));
    return;
  }

  const counts = u.counts || {};
  const running = agents.filter((a) => a.status === 'running').length;
  const active = counts.active ?? agents.filter((a) => a.status === 'running' || a.status === 'queued').length;

  replace(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('span', { class: 'label' }, 'Control room · operations'),
      h('h1', { class: 'page-title' }, 'What the fleet is spending and doing'),
      h('div', { class: 'page-sub' },
        `${agents.length} agent${agents.length === 1 ? '' : 's'} tracked · ${running} running · updated ${f.clock(new Date().toISOString())}. `,
        'Claude and Codex costs are API-equivalent estimates, not subscription charges. DeepSeek costs use configured API prices. Unknown model prices are excluded from subtotals.')),
    h('div', { class: 'plates' },
      spendPlate(u),
      tierPlate(u.byTier || {}, u.byTierAgents || {}),
      fleetPlate({ agents, counts, running, active }),
      tokenPlate(u.tokens || {}),
      limitPlate(u.limits || {}),
      savingsPlate(u.savings || null))));
}

/* ------------------------------------------------------------ empty states */

function openNewAgent() {
  const btn = qs('#new-agent-btn') || qs('#new-agent-btn-mobile');
  if (btn) btn.click();
}

function step(n, title, body, action) {
  return h('li', { class: 'step' },
    h('span', { class: 'step-n', 'aria-hidden': 'true' }, String(n)),
    h('div', { class: 'step-body' },
      h('h3', { class: 'step-title' }, title),
      h('p', { class: 'step-text' }, body),
      action || null));
}

/** What a brand-new install sees instead of a grid of zeroes. */
function firstRun() {
  const u = getUsage() || {};
  const spend = Number(u.spend && u.spend.month) || 0;
  const cfg = getConfig() || {};
  const bin = cfg.crBin || 'bin/cr.js';
  return h('div', null,
    h('div', { class: 'page-head' },
      h('span', { class: 'label' }, 'Control room · first run'),
      h('h1', { class: 'page-title' }, 'Nothing is being tracked yet'),
      h('div', { class: 'page-sub' },
        'The control room is running and the database is empty. It shows spend and progress for agents it knows about, ',
        'so the first step is to give it one — either the session you are already in, or a new process it starts for you.')),
    h('section', { class: 'plate' },
      h('div', { class: 'plate-head' },
        h('h2', { class: 'plate-title' }, 'Start here'),
        h('span', { class: 'plate-note' }, 'two ways in; both take under a minute')),
      h('ol', { class: 'steps' },
        step(1, 'Register the session you are already in',
          'An "external" agent is a CLI session the control room did not start — the one you are reading this from, for example. It is tracked by its session id: usage, transcript and reports all appear here, and it can spawn children.',
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: openNewAgent }, 'New agent → runtime "external"'))),
        step(2, 'Or let the control room spawn one',
          'Pick a role and a working directory and it launches a real CLI in a real terminal — Claude Code or Codex for a CTO or orchestrator, the DeepSeek harness for a worker. Point it at a git repo and the worker gets its own worktree and branch.',
          h('pre', { class: 'code-inline mono' },
            `node ${bin} spawn --name "docs pass" --role worker \\\n  --runtime deepseek --repo <path-to-repo> --task "one line"`)),
        step(3, 'Then watch it here',
          'Dashboard is money and fleet health; Hierarchy is the tree with a terminal attached to every live process; CTO is the conversation with your top-level agent.',
          null)),
      spend > 0
        ? h('div', { class: 'plate-foot' },
            `Recorded spend this month: ${f.usd(spend)} — from agents that have since been removed from the tree.`)
        : null));
}

/** The server is not answering: say which one, and what to do about it. */
function serverDown(message) {
  return h('div', null,
    h('div', { class: 'page-head' },
      h('span', { class: 'label' }, 'Control room · offline'),
      h('h1', { class: 'page-title' }, 'The control server is not answering')),
    h('section', { class: 'plate' },
      h('div', { class: 'plate-head' }, h('h2', { class: 'plate-title' }, 'What happened')),
      h('div', { class: 'plate-pad' },
        h('div', { class: 'error-box', role: 'alert' }, String(message)),
        h('p', { class: 'step-text', style: { marginTop: '12px' } },
          'This page is served by the control room itself, so it is usually a server that stopped after the page was loaded. ',
          'Start it again with ', h('code', { class: 'mono' }, 'npm start'), ' and the banner at the top will clear on its own.'))));
}

/* ------------------------------------------------------------------ spend */

function spendPlate(u) {
  const spend = u.spend || {};
  const run = u.currentRun || {};
  const windows = u.spendWindows || {};
  const today = Number(spend.today) || 0;
  const week = Number(spend.week) || 0;
  const month = Number(spend.month) || 0;
  const runElapsed = run.startedAt ? f.elapsedSince(run.startedAt) : null;
  const sharePct = (v) => {
    const p = pct(v, month);
    return p === null ? 'no spend recorded this month' : `${p.toFixed(0)}% of the month to date`;
  };

  return plate(u.pricingComplete === false ? 'Spend · partial estimate' : 'Spend', u.pricingComplete === false ? `Unpriced models excluded: ${(u.unpricedModels || []).join(', ') || 'price unavailable'}` : 'banked on the day it was measured · local calendar days · all tiers combined', [
    panel('w-6', 'Spend today', money(today), {
      sub: sharePct(today),
      viz: meter(month > 0 ? today / month : 0, 'quiet'),
      basis: `${basisLine('estimate')} · since midnight${windows.today ? ` (${windows.today})` : ''}`,
    }),
    panel('w-6', 'Spend this week', money(week), {
      sub: sharePct(week),
      viz: meter(month > 0 ? week / month : 0, 'quiet'),
      basis: `${basisLine('estimate')} · rolling 7 days${windows.weekFrom ? ` from ${windows.weekFrom}` : ''}`,
    }),
    panel('w-6', 'Spend this month', money(month), {
      sub: 'the three windows against each other',
      viz: bars([
        { label: 'today', value: today, display: f.usd(today) },
        { label: 'week', value: week, display: f.usd(week) },
        { label: 'month', value: month, display: f.usd(month) },
      ]),
      basis: basisLine('estimate'),
    }),
    panel('w-6', run.pricingKnown === false ? 'Current run · partial estimate' : 'Current run', money(run.costUsd), {
      live: Boolean(run.startedAt),
      sub: run.startedAt
        ? h('span', null, 'running for ', h('span', { class: 'mono', dataset: { runElapsed: run.startedAt } },
            runElapsed === null ? '—' : f.duration(runElapsed)))
        : 'no run in progress',
      basis: `${basisLine('estimate')} · every agent not yet finished, whole-session cost`,
    }),
  ]);
}

/* ------------------------------------------------------------------ tiers */

const TIERS = [
  ['cto', 'CTO', 'estimate', 'no agent holds the cto role'],
  ['orchestrator', 'Orchestrators', 'estimate', 'no agent holds the orchestrator role'],
  ['deepseek', 'DeepSeek workers', 'api', 'nothing has run on the deepseek runtime'],
  // Nothing is allowed to fall out of this list: an agent that is neither a
  // DeepSeek process nor a CTO/orchestrator (a Claude-run worker, an external
  // session with an unusual role) lands here rather than vanishing from the
  // per-tier totals while still counting in the fleet total.
  ['other', 'Other agents', 'estimate', 'every agent fits one of the tiers above'],
];

function tierPlate(tiers, tierAgents) {
  // A server that does not report per-tier agent counts (an older build) simply
  // gets panels without the count line, rather than a confident "0 agents".
  const counts = tierAgents && Object.keys(tierAgents).length ? tierAgents : null;
  const known = TIERS.map((t) => t[0]);
  const extra = Object.keys(tiers).filter((k) => !known.includes(k));
  const all = TIERS.concat(extra.map((k) => [k, k, 'estimate', 'reported by the server']));
  const totalCost = all.reduce((a, [k]) => a + (Number(tiers[k] && tiers[k].costUsd) || 0), 0);

  return plate('Usage by tier', 'every agent counts in exactly one tier; the four add up to the fleet total',
    all.map(([key, label, kind, what]) => {
      const t = tiers[key];
      const n = counts ? Number(counts[key]) || 0 : null;
      const badge = h('span', { class: 'badge badge-est' }, 'estimated');
      // "Other" is only worth a panel when something is actually in it.
      if (key === 'other' && !n && !(t && t.totalTokens)) return null;
      if (!t || !t.totalTokens) {
        return panel('w-8', label, [null, n ? 'no usage yet' : 'none', null], {
          na: true, badge,
          sub: n ? `${f.count(n)} agent${n === 1 ? '' : 's'} · no tokens reported yet` : what,
          basis: basisLine(kind),
        });
      }
      const cost = t.costUsd;
      if (t.pricingKnown === false) { badge.textContent = 'partial estimate'; }
      const share = pct(cost, totalCost);
      return panel('w-8', label, money(cost), {
        badge,
        sub: [n === null ? null : `${f.count(n)} agent${n === 1 ? '' : 's'}`, `${f.tokens(t.totalTokens)} tokens`, share === null ? null : `${share.toFixed(1)}% of all reported cost`].filter(Boolean).join(' · '),
        viz: bars([
          { label: 'input', value: t.inputTokens, display: f.tokens(t.inputTokens) },
          { label: 'cache', value: (Number(t.cacheReadTokens) || 0) + (Number(t.cacheWriteTokens) || 0), display: f.tokens((Number(t.cacheReadTokens) || 0) + (Number(t.cacheWriteTokens) || 0)) },
          { label: 'output', value: t.outputTokens, display: f.tokens(t.outputTokens) },
        ]),
        basis: basisLine(kind),
      });
    }));
}

/* ------------------------------------------------------------------ fleet */

function fleetPlate({ agents, counts, running, active }) {
  const done = counts.done ?? 0;
  const blocked = counts.blocked ?? 0;
  const failed = (counts.failed ?? 0) + (counts.stopped ?? 0);
  const idle = counts.idle ?? agents.filter((a) => a.status === 'idle').length;
  const queued = counts.queued ?? Math.max(0, active - running);
  const paused = (counts.paused ?? 0) + (counts.stopping ?? 0) + (counts.unknown ?? 0);
  const total = Math.max(1, agents.length);
  const waiting = [`${queued} queued`, `${idle} idle`];
  if (paused) waiting.push(`${paused} paused or stopping`);

  return plate('Fleet', `${agents.length} node${agents.length === 1 ? '' : 's'} in the tree`, [
    panel('w-6', 'Running now', [null, f.count(running), running === 1 ? 'agent' : 'agents'], {
      live: running > 0,
      sub: waiting.join(' · '),
      viz: meter(running / total, 'live'),
    }),
    panel('w-6', 'Waiting on you', [null, f.count(blocked), blocked === 1 ? 'agent' : 'agents'], {
      tone: blocked > 0 ? 'blocked' : null,
      sub: blocked ? 'blocked on a human decision' : 'nothing is blocked',
      viz: meter(blocked / total, 'blocked'),
    }),
    panel('w-6', 'Finished clean', [null, f.count(done), done === 1 ? 'agent' : 'agents'], {
      sub: 'tasks reported done',
      viz: meter(done / total, 'done'),
    }),
    panel('w-6', 'Failed or stopped', [null, f.count(failed), failed === 1 ? 'agent' : 'agents'], {
      tone: failed > 0 ? 'failed' : null,
      sub: failed ? 'needs triage' : 'no failures recorded',
      viz: meter(failed / total, 'failed'),
    }),
  ]);
}

/* ----------------------------------------------------------------- tokens */

function tokenPlate(tk) {
  const total = Number(tk.total) || 0;
  const share = (v) => (total > 0 ? `${(((Number(v) || 0) / total) * 100).toFixed(1)}% of all tokens` : 'nothing counted yet');

  return plate('Tokens', 'every tier, since the server started tracking', [
    panel('w-8', 'Tokens in total', tokenValue(total), {
      sub: `${f.count(total)} counted across every tier`,
      viz: stack([
        { label: 'input', value: tk.input, display: f.tokens(tk.input), color: 'var(--ink)' },
        { label: 'cache read', value: tk.cacheRead, display: f.tokens(tk.cacheRead), color: 'var(--cave-rule)' },
        { label: 'cache write', value: tk.cacheWrite, display: f.tokens(tk.cacheWrite), color: 'var(--control-line)' },
        { label: 'output', value: tk.output, display: f.tokens(tk.output), color: 'var(--ink-2)' },
      ]),
    }),
    panel('w-4', 'Input', tokenValue(tk.input), { sub: share(tk.input), viz: meter(total ? tk.input / total : 0, 'quiet') }),
    panel('w-4', 'Cache read', tokenValue(tk.cacheRead), { sub: share(tk.cacheRead), viz: meter(total ? tk.cacheRead / total : 0, 'quiet') }),
    panel('w-4', 'Cache write', tokenValue(tk.cacheWrite), { sub: share(tk.cacheWrite), viz: meter(total ? tk.cacheWrite / total : 0, 'quiet') }),
    panel('w-4', 'Output', tokenValue(tk.output), { sub: share(tk.output), viz: meter(total ? tk.output / total : 0, 'quiet') }),
  ]);
}

/* ----------------------------------------------------------------- limits */

function limitPlate(limits) {
  const extra = Object.entries(limits).filter(([k]) => !['claude', 'codex', 'deepseek'].includes(k));
  return plate('Limits & resets', 'latest CLI observations · account-wide, not per agent', [
    limitPanel('Claude plan limits', limits.claude, 'w-8'),
    limitPanel('Codex plan limits', limits.codex, 'w-8'),
    limitPanel('DeepSeek limits', limits.deepseek, 'w-8'),
    extra.map(([k, v]) => limitPanel(k + ' limits', v, 'w-8')),
  ]);
}

function limitPanel(label, lim, width) {
  if (!lim) {
    return panel(width, label, [null, 'not reported', null], {
      na: true, sub: 'the server reported no limit block for this runtime',
    });
  }
  const observation = limitObservation(lim);
  const measured = observation.windows.filter(w => w.remaining !== null);
  const tightest = measured.length ? measured.reduce((a, b) => a.remaining <= b.remaining ? a : b) : null;
  const detail = (key, value) => h('div', { class: 'spec-row' },
    h('span', null, key), h('span', { style: { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' } }, value));
  return panel(width, label, [null, tightest ? limitPercent(tightest.remaining) : 'not reported', tightest ? 'remaining' : null], {
    na: !tightest,
    tone: tightest && tightest.remaining <= 10 ? 'blocked' : null,
    sub: tightest ? `${tightest.label} · ${limitPercent(tightest.used)} used` : observation.note || 'the CLI has not reported a usage percentage',
    viz: observation.windows.length ? h('div', { class: 'spec' }, observation.windows.map(w => h('div', { class: 'limit-window' },
      detail(w.label, w.used === null ? 'Usage not reported' : `${limitPercent(w.used)} used · ${limitPercent(w.remaining)} remaining`),
      w.used === null ? null : meter(w.used / 100, w.remaining <= 10 ? 'blocked' : 'quiet'),
      detail('Resets', w.resetsAt || 'not reported')))) : null,
    basis: observation.observedAt ? `Observed ${observation.observedAt} · may have changed since` : 'Observation time not reported · this is not a live limit check',
  });
}

/* ---------------------------------------------------------------- savings */

function savingsPlate(sav) {
  const comparisonModel = comparisonModelLabel(getConfig());
  if (!sav) {
    return plate('Savings estimate', `comparison model: ${comparisonModel}`, [
      panel('w-24', 'Saved by delegating to DeepSeek', [null, 'not reported', null], {
        na: true, badge: h('span', { class: 'badge badge-est' }, 'estimated'),
        sub: 'the server reported no savings block',
      }),
    ]);
  }
  const actual = Number(sav.deepseekActualUsd) || 0;
  const equiv = Number(sav.fableEquivalentUsd) || 0;
  const max = Math.max(actual, equiv, 1e-9);
  const ratio = (actual > 0 && equiv > 0)
    ? `${((1 - actual / equiv) * 100).toFixed(1)}% cheaper · ${(equiv / actual).toFixed(0)}× ratio`
    : (equiv > 0 ? 'no DeepSeek cost estimate recorded yet' : 'no DeepSeek work has run yet');

  const compare = h('div', { class: 'panel w-16' },
    h('div', { class: 'panel-title' }, `DeepSeek estimate vs the same work on ${comparisonModel}`,
      h('span', { class: 'badge badge-est' }, 'estimated')),
    h('div', { class: 'cmp' },
      h('div', null,
        h('div', { class: 'cmp-top' },
          h('span', { class: 'cmp-name' }, 'DeepSeek — estimated API cost'),
          h('span', { class: 'cmp-val' }, f.usd(actual))),
        h('div', { class: 'cmp-bar' }, h('div', { class: 'cmp-fill', dataset: { tone: 'done' }, style: { width: ((actual / max) * 100).toFixed(2) + '%' } }))),
      h('div', null,
        h('div', { class: 'cmp-top' },
          h('span', { class: 'cmp-name' }, `Same work on ${comparisonModel} — API-equivalent estimate`),
          h('span', { class: 'cmp-val' }, f.usd(equiv))),
        h('div', { class: 'cmp-bar' }, h('div', { class: 'cmp-fill', style: { width: ((equiv / max) * 100).toFixed(2) + '%' } })))),
    h('div', { class: 'basis' }, `DeepSeek usage re-priced at the ${comparisonModel} price sheet. Both sides are estimates from configured prices.`));

  return plate('Savings estimate', `comparison model: ${comparisonModel}`, [
    panel('w-8', 'Saved by delegating to DeepSeek', money(sav.savedUsd), {
      badge: h('span', { class: 'badge badge-est' }, 'estimated'),
      sub: ratio,
      viz: meter(equiv > 0 ? (equiv - actual) / equiv : 0, 'done'),
      basis: 'hypothetical comparison at configured API prices; not an invoice',
    }),
    compare,
  ]);
}
