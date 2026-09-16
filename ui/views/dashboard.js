// Dashboard — operator panels, built to the grafana-dashboards skill:
// a 24-column grid of plates, one question per panel, a stat panel that is a
// big number + unit + ONE secondary line, a bar gauge only where the data
// exists, no decorative stripes, and every panel titled with its question.
//
// Rebuilt wholesale on each `usage` / `agents` event; it holds no live widgets
// (the terminal and the open drawer live elsewhere, untouched by this).
//
// LABELLING IS LOAD-BEARING. Claude/Fable dollars are API-equivalent estimates
// computed from token counts — those sessions run on Jake's Claude plan and are
// never invoiced per token. Only DeepSeek figures are real money. Every money
// panel therefore carries its basis.

import { h, replace } from '../lib/dom.js';
import * as f from '../lib/format.js';
import { store, getUsage, getAgents } from '../lib/store.js';

const PLAN_BASIS = 'API-equivalent · on plan (estimate)';
const ACTUAL_BASIS = 'actual API cost';

let root = null;

export function mountDashboard(el) {
  root = el;
  store.on('usage', render);
  store.on('agents', render);
  render();
  setInterval(() => {
    const node = root && root.querySelector('[data-run-elapsed]');
    if (node && node.dataset.runElapsed) {
      const s = f.elapsedSince(node.dataset.runElapsed);
      node.textContent = s === null ? '—' : f.duration(s);
    }
  }, 1000);
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
  return kind === 'actual' ? ACTUAL_BASIS : PLAN_BASIS;
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

  if (!u) {
    replace(root, h('div', { class: 'page' }, h('div', { class: 'loading' }, 'Waiting for the first state frame from the server…')));
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
        'Claude dollars are API-equivalent estimates priced from token counts — those sessions run on the Claude plan and are never billed per token. DeepSeek dollars are real, metered API spend.')),
    h('div', { class: 'plates' },
      spendPlate(u),
      tierPlate(u.byTier || {}),
      fleetPlate({ agents, counts, running, active }),
      tokenPlate(u.tokens || {}),
      limitPlate(u.limits || {}),
      savingsPlate(u.savings || null))));
}

/* ------------------------------------------------------------------ spend */

function spendPlate(u) {
  const spend = u.spend || {};
  const run = u.currentRun || {};
  const today = Number(spend.today) || 0;
  const week = Number(spend.week) || 0;
  const month = Number(spend.month) || 0;
  const runElapsed = run.startedAt ? f.elapsedSince(run.startedAt) : null;
  const sharePct = (v) => {
    const p = pct(v, month);
    return p === null ? 'no spend recorded this month' : `${p.toFixed(0)}% of the month to date`;
  };

  return plate('Spend', 'rolling windows · all tiers combined', [
    panel('w-6', 'Spend today', money(today), {
      sub: sharePct(today),
      viz: meter(month > 0 ? today / month : 0, 'quiet'),
      basis: basisLine('estimate'),
    }),
    panel('w-6', 'Spend this week', money(week), {
      sub: sharePct(week),
      viz: meter(month > 0 ? week / month : 0, 'quiet'),
      basis: basisLine('estimate'),
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
    panel('w-6', 'Current run', money(run.costUsd), {
      live: Boolean(run.startedAt),
      sub: run.startedAt
        ? h('span', null, 'running for ', h('span', { class: 'mono', dataset: { runElapsed: run.startedAt } },
            runElapsed === null ? '—' : f.duration(runElapsed)))
        : 'no run in progress',
      basis: basisLine('estimate'),
    }),
  ]);
}

/* ------------------------------------------------------------------ tiers */

const TIERS = [
  ['cto', 'Claude CTO', 'estimate'],
  ['orchestrator', 'Claude orchestrators', 'estimate'],
  ['deepseek', 'DeepSeek workers', 'actual'],
];

function tierPlate(tiers) {
  const keys = TIERS.map((t) => t[0]);
  const extra = Object.keys(tiers).filter((k) => !keys.includes(k) && tiers[k] && tiers[k].totalTokens);
  const all = TIERS.concat(extra.map((k) => [k, k, 'estimate']));
  const totalCost = all.reduce((a, [k]) => a + (Number(tiers[k] && tiers[k].costUsd) || 0), 0);

  return plate('Usage by tier', 'what each model tier has cost and consumed',
    all.map(([key, label, kind]) => {
      const t = tiers[key];
      const badge = h('span', { class: 'badge ' + (kind === 'actual' ? 'badge-actual' : 'badge-est') },
        kind === 'actual' ? 'actual' : 'estimated');
      if (!t || !t.totalTokens) {
        return panel('w-8', label, [null, 'no usage yet', null], {
          na: true, badge,
          sub: kind === 'actual' ? 'no DeepSeek work has run' : 'nothing has run at this tier',
          basis: basisLine(kind),
        });
      }
      const cost = Number(t.costUsd) || 0;
      const share = pct(cost, totalCost);
      return panel('w-8', label, money(cost), {
        badge,
        sub: `${f.tokens(t.totalTokens)} tokens${share === null ? '' : ` · ${share.toFixed(1)}% of all reported cost`}`,
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
  const total = Math.max(1, agents.length);

  return plate('Fleet', `${agents.length} node${agents.length === 1 ? '' : 's'} in the tree`, [
    panel('w-6', 'Running now', [null, f.count(running), running === 1 ? 'agent' : 'agents'], {
      live: running > 0,
      sub: `${queued} queued · ${idle} idle`,
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
  const extra = Object.entries(limits).filter(([k]) => k !== 'claude' && k !== 'deepseek');
  return plate('Limits & resets', 'as reported by the server', [
    limitPanel('Claude plan limits', limits.claude, extra.length ? 'w-8' : 'w-12'),
    limitPanel('DeepSeek limits', limits.deepseek, extra.length ? 'w-8' : 'w-12'),
    extra.map(([k, v]) => limitPanel(k + ' limits', v, 'w-8')),
  ]);
}

function limitPanel(label, lim, width) {
  if (!lim) {
    return panel(width, label, [null, 'not reported', null], {
      na: true, sub: 'the server reported no limit block for this runtime',
    });
  }
  const rows = Object.entries(lim).filter(([k]) => k !== 'note');
  const headline = lim.note || lim.resetsAt || lim.reset || (rows.length ? 'see below' : 'no detail');
  return panel(width, label, [null, String(headline), null], {
    na: true,
    viz: rows.length
      ? h('div', { class: 'spec' }, rows.map(([k, v]) => h('div', { class: 'spec-row' },
          h('span', null, k),
          h('span', null, typeof v === 'object' && v !== null ? f.compactJson(v, 60) : String(v)))))
      : null,
  });
}

/* ---------------------------------------------------------------- savings */

function savingsPlate(sav) {
  if (!sav) {
    return plate('Savings', 'what the delegated work would have cost at the top tier', [
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
    : 'estimated against the Fable price sheet';

  const compare = h('div', { class: 'panel w-16' },
    h('div', { class: 'panel-title' }, 'DeepSeek actual vs the same work on Fable',
      h('span', { class: 'badge badge-est' }, 'estimated')),
    h('div', { class: 'cmp' },
      h('div', null,
        h('div', { class: 'cmp-top' },
          h('span', { class: 'cmp-name' }, 'DeepSeek — actual API cost'),
          h('span', { class: 'cmp-val' }, f.usd(actual))),
        h('div', { class: 'cmp-bar' }, h('div', { class: 'cmp-fill', dataset: { tone: 'done' }, style: { width: ((actual / max) * 100).toFixed(2) + '%' } }))),
      h('div', null,
        h('div', { class: 'cmp-top' },
          h('span', { class: 'cmp-name' }, 'Same work on Fable — API-equivalent'),
          h('span', { class: 'cmp-val' }, f.usd(equiv))),
        h('div', { class: 'cmp-bar' }, h('div', { class: 'cmp-fill', style: { width: ((equiv / max) * 100).toFixed(2) + '%' } })))),
    h('div', { class: 'basis' }, sav.basis || 'DeepSeek usage re-priced at the Fable price sheet. The DeepSeek side is actual API cost; the Fable side is an estimate.'));

  return plate('Savings', 'what the delegated work would have cost at the top tier', [
    panel('w-8', 'Saved by delegating to DeepSeek', money(sav.savedUsd), {
      badge: h('span', { class: 'badge badge-est' }, 'estimated'),
      sub: ratio,
      viz: meter(equiv > 0 ? (equiv - actual) / equiv : 0, 'done'),
      basis: 'never billed — the avoided side would have run on the Claude plan',
    }),
    compare,
  ]);
}
