import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Config files are read from <repo>/config. Set CR_CONFIG_DIR to keep your own
 * copies outside the checkout; any file missing there falls back to <repo>/config.
 */
const CONFIG_DIR = process.env.CR_CONFIG_DIR || '';

/**
 * Fallbacks for ${VAR} placeholders used in config values when the environment
 * does not define them. Keeps config/runtimes.json free of machine-specific paths.
 */
export const ENV_DEFAULTS = {
  DSH_REPO: '~/deepseek-harness',       // where the DeepSeek Harness repo is cloned
  DSH_HOME: '~/.dsh',                   // DeepSeek Harness state (sessions, settings)
  CLAUDE_CONFIG_DIR: '~/.claude',       // Claude Code state (transcripts live under projects/)
};

const unresolvedVars = new Set();

/** Expand ${VAR} and ${VAR:-fallback} from the environment (then ENV_DEFAULTS). */
export function expandEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    const fromEnv = env[name];
    if (fromEnv) return fromEnv;
    if (fallback !== undefined) return fallback;
    if (ENV_DEFAULTS[name] !== undefined) return ENV_DEFAULTS[name];
    unresolvedVars.add(name);
    return whole; // leave it visible so any later error names the variable
  });
}

/** Expand a leading ~ to the current user's home directory. */
export function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** ${ENV_VAR} expansion followed by ~ expansion. Non-strings pass through. */
export function expandValue(v) {
  return typeof v === 'string' ? expandHome(expandEnv(v)) : v;
}

/** Recursively expand every string in a parsed config object. Keys starting with _ are comments and are left alone. */
function expandDeep(v) {
  if (typeof v === 'string') return expandValue(v);
  if (Array.isArray(v)) return v.map(expandDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.startsWith('_') ? x : expandDeep(x)]));
  return v;
}

function configFile(name) {
  if (CONFIG_DIR) {
    const custom = path.resolve(ROOT, expandValue(CONFIG_DIR), name);
    if (fs.existsSync(custom)) return custom;
  }
  return path.join(ROOT, 'config', name);
}

function readJson(name, { expand = false } = {}) {
  const parsed = JSON.parse(fs.readFileSync(configFile(name), 'utf8'));
  return expand ? expandDeep(parsed) : parsed;
}

export const config = readJson('runtimes.json', { expand: true });
export const pricing = readJson('pricing.json');
export const protocolTemplate = fs.readFileSync(configFile('protocol.md'), 'utf8');
/** The checkout's own version, shown in the UI. Never a reason to fail a boot. */
const pkgVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
})();

if (unresolvedVars.size) {
  console.warn(`[control-room] config/runtimes.json references undefined variable(s): ${[...unresolvedVars].join(', ')}. Set them in your environment (see .env.example) or edit the config.`);
}

export const DATA_DIR = path.resolve(ROOT, expandValue(process.env.CR_DATA_DIR || config.dataDir || './data'));
export const BRIEFS_DIR = path.join(DATA_DIR, 'briefs');
export const SCROLLBACK_DIR = path.join(DATA_DIR, 'scrollback');
export const CR_BIN = path.join(ROOT, 'bin', 'cr.js').replace(/\\/g, '/');

for (const d of [DATA_DIR, BRIEFS_DIR, SCROLLBACK_DIR]) fs.mkdirSync(d, { recursive: true });

export function resolveModel(name) {
  if (!name) return name;
  return pricing.aliases?.[name] || name;
}

export function priceFor(model) {
  const m = resolveModel(model);
  return pricing.models[m] || null;
}

/** USD for a usage bucket at a given model's price sheet. */
export function costOf(usage, model, requestInputTokens = 0) {
  const p = priceFor(model);
  if (!p) return 0;
  const long = p.longContextThreshold && requestInputTokens > p.longContextThreshold;
  const inputMultiplier = long ? (p.longContextInputMultiplier || 1) : 1;
  const outputMultiplier = long ? (p.longContextOutputMultiplier || 1) : 1;
  return (
    (usage.inputTokens || 0) * p.input * inputMultiplier +
    (usage.cacheReadTokens || 0) * p.cacheRead * inputMultiplier +
    (usage.cacheWriteTokens || 0) * p.cacheWrite * inputMultiplier +
    (usage.outputTokens || 0) * p.output * outputMultiplier
  ) / 1e6;
}

/**
 * Day key in the operator's LOCAL timezone.
 *
 * Spend windows are read by a human looking at a wall clock. Slicing an ISO
 * string (which is UTC) put every evening's work into "tomorrow" for anyone
 * west of Greenwich, so "spend today" read $0.00 while money was being spent.
 */
export function localDay(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return localDay(new Date());
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export function publicConfig() {
  return {
    runtimes: Object.fromEntries(Object.entries(config.runtimes).map(([k, v]) => [k, { label: v.label, defaults: v.defaults, efforts: v.efforts }])),
    defaultRuntime: config.frontierRuntime || (config.runtimes.codex ? 'codex' : 'claude'),
    pricing,
    crBin: CR_BIN,
    // Sensible starting points for the New agent form — never a path baked into
    // the source: this checkout and whatever the config already defaults to.
    defaultCwd: ROOT.replace(/\\/g, '/'),
    defaultModel: config.runtimes.claude?.defaults?.model || null,
    dataDir: DATA_DIR.replace(/\\/g, '/'),
    version: pkgVersion,
  };
}
