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
export function costOf(usage, model) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (usage.inputTokens || 0) * p.input +
    (usage.cacheReadTokens || 0) * p.cacheRead +
    (usage.cacheWriteTokens || 0) * p.cacheWrite +
    (usage.outputTokens || 0) * p.output
  ) / 1e6;
}

export function publicConfig() {
  return {
    runtimes: Object.fromEntries(Object.entries(config.runtimes).map(([k, v]) => [k, { label: v.label, defaults: v.defaults }])),
    pricing,
    crBin: CR_BIN,
  };
}
