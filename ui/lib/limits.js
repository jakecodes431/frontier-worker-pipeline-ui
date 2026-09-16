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
