/**
 * Runtime adapters. Each adapter turns an agent record into { command, args, env }
 * from config/runtimes.json, and knows how to read usage / chat / status for
 * its runtime. Add a runtime by adding a config entry and a small adapter here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, expandHome, expandValue, protocolTemplate, CR_BIN, BRIEFS_DIR } from '../config.js';
import { readClaudeTranscript, claudeTranscriptPath, findDshSession, readDshSession } from '../usage.js';
import { locateCodexSession, readCodexTranscript } from '../codex-usage.js';
import { claudeStatuslineSettings } from '../claude-limits.js';

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? (vars[k] ?? '') : whole));
}

/**
 * Turn an argv template from config/runtimes.json into real argv.
 * A standalone "{placeholder}" that has no value is dropped together with the
 * option flag right in front of it, so an unset model or effort falls back to
 * the CLI's own default instead of emitting a dangling flag.
 */
function buildArgs(templates, vars) {
  const out = [];
  for (const t of templates || []) {
    const lone = /^\{(\w+)\}$/.exec(t);
    if (lone) {
      const v = vars[lone[1]];
      if (v === undefined || v === null || v === '') {
        if (out.length && /^-/.test(out[out.length - 1])) out.pop();
        continue;
      }
      out.push(String(v));
      continue;
    }
    const filled = fill(t, vars);
    if (filled !== '') out.push(filled);
  }
  return out;
}

function baseEnv(agent, port, rt = {}) {
  const env = { ...process.env };
  // The host runner may be non-interactive (TERM=dumb), but this child receives
  // a real xterm-compatible PTY. Do not trigger a CLI's non-terminal fallback.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // The control room may itself have been started from inside a Claude Code session. A child `claude`
  // that inherits those markers treats itself as a nested child and turns transcript saving off,
  // which would blind usage and chat. Strip them and force persistence.
  for (const k of Object.keys(env)) if (/^(CLAUDE_CODE_|CLAUDECODE)/i.test(k)) delete env[k];
  // Preserve CODEX_HOME and CLI authentication/configuration, but detach desktop
  // IPC, inherited session identity and the enclosing process's permission flags.
  for (const k of Object.keys(env)) if (/^CODEX_(THREAD_ID|SESSION_ID|TURN_ID|INTERNAL_ORIGINATOR_OVERRIDE|MANAGED_BY_|SANDBOX|APP_|PERMISSION_PROFILE|CI$|SAGE_|SHELL$)/i.test(k)) delete env[k];
  const keep = new Set((rt.keepEnv || []).map(k => k.toUpperCase()));
  const scrub = (rt.scrubEnvContaining || []).map(k => k.toUpperCase());
  for (const k of Object.keys(env)) if (scrub.some(s => k.toUpperCase().includes(s)) && !keep.has(k.toUpperCase())) delete env[k];
  for (const [k, v] of Object.entries(rt.env || {})) env[k] = expandValue(v);
  if (agent.runtime === 'claude') env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  env.CR_AGENT_ID = agent.id;
  env.CR_URL = `http://127.0.0.1:${port}`;
  env.CR_BIN = CR_BIN;
  env.CR_PARENT_ID = agent.parentId || '';
  return env;
}

function protocolFor(agent) {
  return fill(protocolTemplate, { id: agent.id, role: agent.role, parentId: agent.parentId || 'none (top level)', crBin: CR_BIN });
}

/**
 * Write the full brief (protocol + task + brief text) to a file and return
 * { prompt, briefPath }. The path is outside the agent's cwd, so the Claude
 * adapter passes this directory to the CLI with --add-dir (see below).
 */
export function stageBrief(agent, brief) {
  const full = `${protocolFor(agent)}# Task\n\n${agent.task}\n\n${brief || ''}`.trim() + '\n';
  const briefPath = path.join(BRIEFS_DIR, `${agent.id}.md`);
  fs.writeFileSync(briefPath, full, 'utf8');
  const fwd = briefPath.replace(/\\/g, '/');
  const prompt = full.length <= (config.briefArgvLimit || 6000)
    ? full
    : `Read the file ${fwd} now and carry out the task it describes exactly. It is your complete brief and includes the control room protocol you must follow.`;
  return { prompt, briefPath };
}

export const adapters = {
  claude: {
    oneShot: false,
    build(agent, port, { resume = false } = {}) {
      const rt = config.runtimes.claude;
      const d = rt.defaults || {};
      const vars = {
        model: agent.model || d.model,
        effort: agent.effort || d.effort,
        permissionMode: agent.permissionMode || d.permissionMode,
        sessionId: agent.sessionId,
        name: agent.name,
        prompt: agent.prompt,
      };
      const args = buildArgs(resume ? rt.resumeArgs : rt.args, vars);
      // The staged brief lives in <dataDir>/briefs, outside the agent's cwd. Claude
      // Code's permission system asks before reading outside the working set even
      // in acceptEdits mode, so an unattended orchestrator stalls on its first
      // action. Add that directory to the session's allowed set (`claude --help`:
      // "--add-dir <directories...>  Additional directories to allow tool access
      // to"). Added by the adapter rather than runtimes.json so a per-machine
      // CR_CONFIG_DIR copy cannot silently drop the flag.
      args.push('--add-dir', BRIEFS_DIR.replace(/\\/g, '/'));
      args.push('--settings', JSON.stringify(claudeStatuslineSettings()));
      return { command: rt.command, args, env: baseEnv(agent, port, rt) };
    },
    transcript(agent) { return claudeTranscriptPath(agent.cwd, agent.sessionId, agent.id); },
    usage(agent) { return readClaudeTranscript(this.transcript(agent)); },
    chat(agent) { return readClaudeTranscript(this.transcript(agent), { withMessages: true }).messages; },
    result(agent) {
      const msgs = readClaudeTranscript(this.transcript(agent), { withMessages: true }).messages.filter(m => m.role === 'assistant');
      return msgs.length ? msgs[msgs.length - 1].text : null;
    },
  },

  codex: {
    oneShot: false,
    build(agent, port, { resume = false } = {}) {
      const rt = config.runtimes.codex;
      const d = rt.defaults || {};
      if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent.sessionId || '')) throw Object.assign(new Error('Codex resume requires the saved session UUID.'), { code: 400 });
      const effort = agent.effort || d.effort;
      const permissionMode = agent.permissionMode || d.permissionMode;
      if (permissionMode && !['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode)) throw Object.assign(new Error('Codex permissionMode must be read-only, workspace-write, or danger-full-access.'), { code: 400 });
      if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw Object.assign(new Error('Unsupported Codex reasoning effort.'), { code: 400 });
      const vars = { model: agent.model || d.model, permissionMode, sessionId: agent.sessionId, prompt: agent.prompt, reasoningConfig: effort ? `model_reasoning_effort=${JSON.stringify(effort)}` : null };
      const args = buildArgs(resume ? rt.resumeArgs : rt.args, vars);
      // Desktop may use an external clock supplied by its app-server. A standalone
      // CLI has no such callback; keep that desktop-only reminder out of this child.
      args.push('-c', 'features.current_time_reminder.enabled=false');
      return { command: rt.command, args, env: baseEnv(agent, port, rt) };
    },
    locate: locateCodexSession,
    transcript(agent) { return this.locate(agent)?.file || null; },
    usage(agent) { const file = this.transcript(agent); return file ? readCodexTranscript(file) : null; },
    chat(agent) { const file = this.transcript(agent); return file ? readCodexTranscript(file, { withMessages: true }).messages : []; },
    result(agent) { const file = this.transcript(agent); if (!file) return null; const r = readCodexTranscript(file, { withMessages: true }); return r.final || r.messages.filter(m => m.role === 'assistant').at(-1)?.text || null; },
  },

  deepseek: {
    oneShot: true,
    /**
     * The worker CLI's entry script, as config/runtimes.json spells it — normally
     * "${DSH_REPO}/apps/cli/lib/bin.js", already env- and ~-expanded by config.js.
     * Returned so a missing checkout can be reported before anything is spawned.
     */
    harnessScript() {
      const [first] = config.runtimes.deepseek.args || [];
      if (!first || /^-/.test(first) || /^\{/.test(first)) return null;
      return path.resolve(expandHome(first));
    },
    build(agent, port) {
      const rt = config.runtimes.deepseek;
      // Spawning `node <missing script>` dies with a bare MODULE_NOT_FOUND in the
      // agent's terminal; say what is missing and which variable points at it.
      const script = this.harnessScript();
      if (script && !fs.existsSync(script)) {
        const e = new Error(
          `The worker CLI was not found at ${script}. Clone the DeepSeek Harness (or whatever CLI you run ` +
          'workers with), then point DSH_REPO at it — see .env.example — or edit runtimes.deepseek.args in ' +
          'config/runtimes.json. See docs/TROUBLESHOOTING.md.');
        e.code = 400;
        throw e;
      }
      const vars = { prompt: agent.prompt, model: agent.model || rt.defaults?.model };
      const args = buildArgs(rt.args, vars);
      const env = baseEnv(agent, port, rt);
      return { command: rt.command, args, env };
    },
    locate(agent) {
      if (agent.sessionId) {
        const dir = expandHome(config.runtimes.deepseek.sessionStore);
        for (const cand of [`session-${agent.sessionId}.json`, `${agent.sessionId}.json`]) {
          const f = path.join(dir, cand);
          if (fs.existsSync(f)) return { file: f, id: agent.sessionId };
        }
      }
      return findDshSession(agent.cwd, agent.startedAt ? Date.parse(agent.startedAt) : null);
    },
    usage(agent) {
      const loc = this.locate(agent);
      if (!loc) return null;
      const r = readDshSession(loc.file, agent.model || 'deepseek-flash');
      r.sessionId = loc.id;
      return r;
    },
    chat(agent, scrollback) {
      // Headless dsh prints the final answer on stdout; the scrollback is the best conversation view we have.
      const text = stripAnsi(scrollback || '');
      return text ? [{ role: 'assistant', text, ts: agent.startedAt }] : [];
    },
    result(agent, scrollback) {
      const text = stripAnsi(scrollback || '').trim();
      return text ? text.slice(-8000) : (agent.result || null);
    },
  },

  external: {
    oneShot: false,
    build() { throw new Error('external agents are not spawned by the control room'); },
    // sessionId is either a Claude session uuid (transcript under ~/.claude/projects/<cwd-slug>/) or an
    // absolute path to a transcript .jsonl (e.g. an in-app subagent's output file).
    transcript(agent) {
      if (agent.transcriptRuntime === 'codex') return adapters.codex.transcript(agent);
      if (!agent.sessionId) return null;
      if (path.isAbsolute(agent.sessionId)) return agent.sessionId;
      return agent.cwd ? claudeTranscriptPath(agent.cwd, agent.sessionId, agent.id) : null;
    },
    usage(agent) { if (agent.transcriptRuntime === 'codex') return adapters.codex.usage(agent); const t = this.transcript(agent); return t ? readClaudeTranscript(t) : null; },
    chat(agent) { if (agent.transcriptRuntime === 'codex') return adapters.codex.chat(agent); const t = this.transcript(agent); return t ? readClaudeTranscript(t, { withMessages: true }).messages : []; },
    result(agent) { if (agent.transcriptRuntime === 'codex') return adapters.codex.result(agent); const t = this.transcript(agent); if (!t) return null; const m = readClaudeTranscript(t, { withMessages: true }).messages.filter(x => x.role === 'assistant'); return m.length ? m[m.length - 1].text : null; },
  },
};

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

export function homedir() { return os.homedir(); }
