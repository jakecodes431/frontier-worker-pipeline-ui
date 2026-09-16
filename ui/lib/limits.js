// CLI limit observations are account-wide snapshots, not a live quota query.
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function limitWindowLabel(minutes, fallback = 'Usage window') {
  if (!finite(minutes) || minutes <= 0) return fallback;
  if (minutes === 10080) return 'Weekly window';
  if (minutes === 1440) return 'Daily window';
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

export function limitTime(value, { locale, timeZone } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) }).format(date);
}

export function limitObservation(limits, timeOptions) {
  if (!limits || typeof limits !== 'object') return { windows: [], observedAt: null, note: null };
  const rows = [];
  const add = (key, value) => {
    if (!value || typeof value !== 'object') return;
    const candidate = value.used_percent ?? value.usedPercent;
    const used = finite(candidate) && candidate >= 0 && candidate <= 100 ? candidate : null;
    const minutes = value.window_minutes ?? value.windowDurationMins ?? value.windowMinutes;
    rows.push({
      key, label: limitWindowLabel(minutes, key === 'primary' ? 'Primary window' : key === 'secondary' ? 'Secondary window' : 'Usage window'),
      used, remaining: used === null ? null : Math.max(0, 100 - used),
      resetsAt: limitTime(value.resets_at ?? value.resetsAt ?? value.reset, timeOptions),
    });
  };
  if ('primary' in limits || 'secondary' in limits) {
    add('primary', limits.primary); add('secondary', limits.secondary);
  } else if ('used_percent' in limits || 'usedPercent' in limits || 'resetsAt' in limits || 'resets_at' in limits) add('window', limits);
  return { windows: rows, observedAt: limitTime(limits.observedAt ?? limits.limitsObservedAt, timeOptions), note: typeof limits.note === 'string' ? limits.note : null };
}

export function limitPercent(value) {
  return finite(value) ? `${Number(value.toFixed(1))}%` : 'not reported';
}

export function comparisonModelLabel(config) {
  return config?.pricing?.fableEquivalentModel || 'configured comparison model';
}

/* ------------------------------------------------ Claude usage dialog --- */

/**
 * Claude plan observations are snapshots, never a live quota query. An
 * observation older than this is rendered as a past snapshot the operator must
 * not read as current.
 */
export const CLAUDE_USAGE_STALE_MS = 30 * 60 * 1000;

/** Milliseconds for a Date / epoch-number / ISO-string instant, or null. */
function instantMillis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 1e11 ? value : value * 1000;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * The command the server would propose, derived from the public config the page
 * already holds. Used only as a fallback so the dialog can still show a
 * ready-to-apply block when `/api/claude-usage` is unreachable; never used to
 * fabricate usage numbers.
 */
export function claudeStatuslineCommand(config) {
  const root = typeof config?.defaultCwd === 'string' && config.defaultCwd
    ? config.defaultCwd
    : (typeof config?.crBin === 'string' && config.crBin ? config.crBin.replace(/\/bin\/cr\.js$/, '') : null);
  const dataDir = typeof config?.dataDir === 'string' ? config.dataDir : null;
  if (!root || !dataDir) return null;
  const script = `${String(root).replace(/\\/g, '/').replace(/\/+$/, '')}/scripts/claude-statusline.mjs`;
  return { statusLine: { type: 'command', command: `node "${script}" "${String(dataDir).replace(/\\/g, '/')}"` } };
}

/**
 * Turn one `/api/claude-usage` attempt into the dialog's state. Pure and free
 * of DOM/network access so every branch is testable in Node.
 *
 * `result` is `{ ok: false, status, message? }` (status 0 means the fetch was
 * rejected) or `{ ok: true, data }`. The returned `kind` distinguishes:
 *   stale-server      the running server 404s the endpoint (old process)
 *   network-error     the request never reached a server
 *   server-error      the server answered 5xx / another non-ok status
 *   invalid-payload   a 2xx body without the settings block
 *   not-connected     endpoint present, no observation yet (not 0% used)
 *   stale-observation observation present but a past snapshot
 *   present           observation present and recent
 */
export function claudeUsageState(result, { now, staleMs } = {}) {
  const at = instantMillis(now);
  const nowMs = at === null ? Date.now() : at;
  const staleAfter = finite(staleMs) && staleMs >= 0 ? staleMs : CLAUDE_USAGE_STALE_MS;
  const failure = (kind, title, message, action, extra) => ({
    ok: false, kind, title, message, action, limits: null, settings: null, note: null,
    observedAt: null, stale: false, ageMs: null, ...(extra || {}),
  });

  if (!result || typeof result !== 'object') {
    return failure('invalid-payload', 'The Claude usage response was not understood',
      'The page sent a request but could not read an answer. No usage percentage can be shown, and this is not 0% used.',
      'Reload the page, then reopen Connect Claude usage.');
  }

  if (result.ok !== true) {
    const status = Number(result.status);
    if (status === 404) {
      return failure('stale-server', 'This server does not serve /api/claude-usage',
        'The running control room server answered 404 for /api/claude-usage, which means it is an older process started before this endpoint existed. Usage cannot be captured against it, and this must not be read as empty or 0% usage.',
        'Restart the control room server: stop the current process and start it again with npm start. This dialog cannot restart it for you. Until then the endpoint will keep answering 404.',
        { status: 404 });
    }
    if (!Number.isFinite(status) || status <= 0) {
      const detail = typeof result.message === 'string' && result.message ? ` (${result.message})` : '';
      return failure('network-error', 'Could not reach the control room server',
        `The request for /api/claude-usage failed${detail}. This is a connection problem, not an empty usage reading and not 0% used.`,
        'Check that the control room server is still running, then close and reopen this dialog to retry.');
    }
    return failure('server-error', `The server could not report Claude usage (HTTP ${status})`,
      `The running server answered HTTP ${status} for /api/claude-usage, so no usage state is available. This is an error, not empty or 0% usage.`,
      'Check the server terminal for the error, then retry. Restarting the control room server reloads the endpoint.',
      { status });
  }

  const data = result.data;
  if (!data || typeof data !== 'object' || !data.settings || typeof data.settings !== 'object') {
    return failure('invalid-payload', 'The server returned an unexpected Claude usage response',
      'The response did not include the statusLine settings this dialog needs, so it cannot show a trustworthy connection state.',
      'Restart the control room server, then reopen this dialog.');
  }
  const settings = data.settings;
  const note = typeof data.note === 'string' && data.note ? data.note : null;
  const limits = data.limits && typeof data.limits === 'object' ? data.limits : null;
  if (!limits || (!limits.primary && !limits.secondary)) {
    return {
      ok: true, kind: 'not-connected', title: 'Not connected yet',
      message: 'No Claude usage observation has been recorded yet. This is not 0% used: Claude Code reports these numbers only after the first API response on a supported plan, and only when the statusLine capture is configured.',
      action: 'Add the statusLine block below to your Claude Code settings (or use a managed session), send a message in Claude Code, then reopen this dialog.',
      limits: null, settings, note, observedAt: null, stale: false, ageMs: null,
    };
  }
  const observed = instantMillis(limits.observedAt);
  const observedAt = typeof limits.observedAt === 'string' && limits.observedAt
    ? limits.observedAt
    : (observed === null ? null : new Date(observed).toISOString());
  const ageMs = observed === null ? null : Math.max(0, nowMs - observed);
  if (ageMs === null || ageMs > staleAfter) {
    return {
      ok: true, kind: 'stale-observation', title: 'The last observation is a past snapshot',
      message: ageMs === null
        ? 'Claude usage was observed, but the observation time was not recorded. Treat it as a past snapshot that may have changed since; it is not a live limit check.'
        : 'This observation is a past snapshot that may have changed since. It is not a live limit check.',
      action: 'Send a message in Claude Code to refresh the statusLine observation.',
      limits, settings, note, observedAt, stale: true, ageMs,
    };
  }
  return {
    ok: true, kind: 'present', title: 'Claude usage is connected',
    message: 'A recent Claude plan-usage observation is available. It is a past snapshot, not a live quota query.',
    action: null, limits, settings, note, observedAt, stale: false, ageMs,
  };
}

/* ---------------------------------------------------------- daily budget --- */
// Client half of GET/POST /api/budget. The server always sends the full
// summary; these helpers only parse what the operator typed, render what the
// server sent, and do the two HTTP calls. Any number shown here is the server's;
// the form never recomputes remaining or percent from local spend, so the card
// cannot drift from the API contract.

/** Largest daily budget POST /api/budget accepts. Mirror of server/budget.js. */
export const MAX_DAILY_USD = 1000000;

/**
 * Parse the operator's text into a POST value.
 *
 * An empty field is an explicit "unset" (null), not an error — that is how the
 * operator removes a budget. Returns `{ value }` or `{ error }`; callers show
 * the error next to the field rather than guessing.
 */
export function parseBudgetInput(text) {
  const raw = String(text ?? '').trim().replace(/^\$/, '');
  if (raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: 'Enter a number, for example 10 or 12.50.' };
  if (n <= 0) return { error: 'The daily budget must be greater than $0.' };
  if (n > MAX_DAILY_USD) return { error: `The daily budget must be ${MAX_DAILY_USD} or less.` };
  return { value: n };
}

/** Text for a budget value coming back from the server ('' when unset). */
export function formatBudgetValue(value) {
  return finite(value) && value > 0 ? String(value) : '';
}

/**
 * The one secondary line under the spend figure.
 *
 * The over-budget case is named in words — "over budget" — rather than shown
 * as a negative remaining, because the number is a tracking readout, not a
 * balance that can go into debt.
 */
export function budgetStatusText(summary) {
  if (!summary || !finite(summary.dailyUsd)) return 'No daily budget set.';
  const pct = finite(summary.percentUsed) ? limitPercent(summary.percentUsed) + ' used' : null;
  if (finite(summary.spentUsd) && summary.spentUsd > summary.dailyUsd) {
    const over = summary.spentUsd - summary.dailyUsd;
    return `Over budget by ${usd(over)} · ${pct}`;
  }
  const left = finite(summary.remainingUsd) ? summary.remainingUsd : Math.max(0, summary.dailyUsd - (Number(summary.spentUsd) || 0));
  return `${usd(left)} left today · ${pct}`;
}

/** Meter tone: quiet in budget, warn at or past it. */
export function budgetTone(summary) {
  if (!summary || !finite(summary.dailyUsd) || !finite(summary.percentUsed)) return 'quiet';
  return summary.percentUsed >= 100 ? 'blocked' : 'quiet';
}

/** Fraction of the budget used, clamped for the meter (over budget fills it). */
export function budgetFraction(summary) {
  if (!summary || !finite(summary.dailyUsd) || !finite(summary.percentUsed)) return 0;
  return Math.max(0, Math.min(1, summary.percentUsed / 100));
}

function usd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not available';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs === 0) return '$0.00';
  if (abs < 1) return sign + '$' + abs.toFixed(4);
  return sign + '$' + abs.toFixed(2);
}

/**
 * Validate a GET /api/budget payload. Throws on anything that is not the
 * documented shape, so a stale server or a proxy error page fails loudly
 * instead of painting "NaN" into the card.
 */
export function assertBudgetSummary(data) {
  const fail = (what) => { throw new Error(`unexpected /api/budget payload: ${what}`); };
  if (!data || typeof data !== 'object') fail('not an object');
  if (data.dailyUsd !== null && !finite(data.dailyUsd)) fail('dailyUsd is neither null nor a number');
  if (typeof data.day !== 'string') fail('day is not a string');
  if (!finite(data.spentUsd)) fail('spentUsd is not a number');
  if (data.remainingUsd !== null && !finite(data.remainingUsd)) fail('remainingUsd is neither null nor a number');
  if (data.percentUsed !== null && !finite(data.percentUsed)) fail('percentUsed is neither null nor a number');
  return data;
}

/** GET/POST /api/budget. Errors carry `.status` when the server answered. */
export const budgetClient = {
  async read() {
    return assertBudgetSummary(await budgetRequest('GET'));
  },
  async save(dailyUsd) {
    return assertBudgetSummary(await budgetRequest('POST', { dailyUsd }));
  },
};

async function budgetRequest(method, body) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api/budget', init);
  } catch (err) {
    const e = new Error(`network error: ${err && err.message ? err.message : err}`);
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const e = new Error((data && (data.error || data.message)) || `${res.status} ${res.statusText}`);
    e.status = res.status;
    throw e;
  }
  if (!data) throw new Error('the server returned an empty /api/budget response');
  return data;
}
