# Control room API contract (v0.1)

Local only. The server listens on `http://127.0.0.1:4800` by default (`host` and
`port` in `config/runtimes.json`, `CR_PORT` overrides the port). There is **no
authentication**: anything that can reach the port can spawn processes. Do not
expose it.

Static assets: the UI is served from `/` (files in `ui/`); xterm.js is served
out of `node_modules` at `/vendor/xterm/xterm.js`, `/vendor/xterm/xterm.css`
and `/vendor/xterm-addon-fit/addon-fit.js`.

Everything below is also reachable through `bin/cr.js`, which is the same API
with a command line on top.

---

## Records

### Agent

```json
{
  "id": "a-20260915150500-1a2b",
  "parentId": null,
  "name": "site orchestrator",
  "role": "cto | orchestrator | worker",
  "runtime": "claude | deepseek | external",
  "model": "claude-opus-5",
  "effort": "high",
  "permissionMode": "acceptEdits",
  "status": "queued | running | idle | paused | blocked | done | failed | stopping | stopped",
  "task": "one-line task",
  "note": "free text, e.g. the blocking question",
  "cwd": "/abs/path",
  "cwdExists": true,
  "worktree": { "repo": "/abs/repo", "branch": "cr/name-stamp", "path": "/abs/repo/.worktrees/name-stamp" },
  "controlledBy": "parent | human",
  "sessionId": "the CLI's own session id, or null",
  "briefPath": "<dataDir>/briefs/<id>.md",
  "prompt": "what was passed to the CLI (the brief, or an instruction to read briefPath)",
  "pid": 1234,
  "exitCode": null,
  "createdAt": "ISO", "startedAt": "ISO|null", "endedAt": "ISO|null",
  "elapsedS": 123,
  "result": "final answer, when the runtime can produce one",
  "usage": {
    "inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0,
    "totalTokens": 0,
    "costUsd": 0.0,
    "fableEquivalentUsd": 0.0
  }
}
```

`worktree` is `null` for an agent started directly in a `cwd`. `cwdExists` is
recomputed (cached for 5s) on every read, so a folder deleted under a finished
agent shows up as `false` rather than as a broken panel.

**`costUsd` vs `fableEquivalentUsd`.** `costUsd` prices the agent's own tokens at
its own model's row in `config/pricing.json`. `fableEquivalentUsd` re-prices the
same tokens at the frontier model named by `pricing.fableEquivalentModel` — it
answers "what would this work have cost on the frontier model?" and is what the
savings figure is built from. Frontier rows in the price sheet are hand-entered
estimates (`"estimated": true`), and a plan subscription is not billed per
token, so any dollar figure derived from them is an API-equivalent estimate, not
a charge. Worker rows priced from a real per-token API are real.

### Message

```json
{ "id": 12, "agentId": "a-…", "fromAgentId": "a-…|null",
  "direction": "in | out | report | system",
  "sender": "human | agent:<id> | parent | system",
  "text": "…", "createdAt": "ISO" }
```

### Event

```json
{ "id": 34, "agentId": "a-…", "kind": "created | spawned | resumed | exit | status | control | action | report | send | lost | error | usage-error",
  "data": {}, "createdAt": "ISO" }
```

---

## HTTP

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok: true, port, agents, node, version }` |
| GET | `/api/config` | | `PublicConfig` |
| GET | `/api/state` | | `{ agents: Agent[], usage: UsageSummary, config: PublicConfig }` |
| GET | `/api/usage` | | `UsageSummary` |
| GET | `/api/agents` | | `Agent[]` (flat; build the tree from `parentId`) |
| POST | `/api/agents` | see below | `201` + `Agent`, or `400 { error }` naming the field that is wrong |
| GET | `/api/agents/:id` | | `{ agent, messages, events, children: Agent[] }` (refreshes usage first; `events` capped at 200) |
| DELETE | `/api/agents/:id` | | `{ ok: true }`. `409` while the agent has a live terminal. Children are re-parented to the deleted agent's parent. The git worktree is **not** removed. |
| POST | `/api/agents/:id/send` | `{ text }`, header `X-Sender: human \| agent:<id>` | `{ ok: true }`, or `{ ok: true, queued: true, message }` for an `external` agent; see *Send semantics*. `400` on empty text |
| POST | `/api/agents/:id/input` | `{ data }` raw pty bytes | `{ ok: true }`, or `409` when the agent has no live terminal |
| POST | `/api/agents/:id/control` | `{ holder: "human" \| "parent" }` | `Agent` |
| POST | `/api/agents/:id/action` | `{ action: "stop" \| "restart" \| "interrupt" \| "pause" \| "resume" }` | `Agent`, or `400` for an unknown action, or `400` when `restart` is asked for an agent whose working directory is gone |
| POST | `/api/agents/:id/status` | `{ status, note? }` | `Agent`, or `400` listing the allowed values if `status` is not one of `done`, `blocked`, `failed`, `running`, `idle` |
| POST | `/api/agents/:id/report` | `{ text }` | `{ ok: true }`, or `400` on empty text |
| GET | `/api/agents/:id/inbox` | `?ack=1` marks the returned messages read | `Message[]` — reports from children |
| GET | `/api/agents/:id/messages` | | `Message[]` — the full message log for this agent |
| GET | `/api/agents/:id/chat` | | `{ messages: [{ role: "user\|assistant\|tool", text, ts }] }` parsed from the CLI's transcript, or from scrollback for runtimes that write none |
| GET | `/api/agents/:id/result` | | `{ result: string\|null, status }` |
| GET | `/api/agents/:id/diff` | | `{ diff, stat, log }` — `git diff` text, diffstat, and recent commits from the agent's cwd/worktree — or `{ missing: true, message }` when the folder is gone, or `{ notRepo: true, message }` when it is not a git repository |
| GET | `/api/agents/:id/files` | | `{ changed: [{ path, status }], tree: [{ path, size }] }`, or `{ missing: true, message }` |
| GET | `/api/agents/:id/file` | `?path=<relative>` | `{ path, content, truncated? }`; `400` with no `path` or when the path escapes the agent's folder, `404` when the file (or the folder) is not there |
| GET | `/api/agents/:id/logs` | | `Event[]` (up to 1000) |
| GET | `/api/agents/:id/scrollback` | | `{ data, live }` — recent pty output and whether a process is attached |

Unknown routes return `404 { error }`. A missing agent returns `404`. A request
body that is not valid JSON returns `400 { error }`. Anything an endpoint
refuses on its own terms carries the status it set (`400` for bad input, `409`
for a conflict); only an unexpected failure reaches `500 { error }`.

### `POST /api/agents`

```jsonc
{
  "parentId": "a-… | null",       // omitted by cr.js only for a top-level agent
  "name": "string",               // required
  "role": "cto | orchestrator | worker",   // default "worker"
  "runtime": "claude | deepseek | external", // default: "deepseek" for workers, else "claude"
  "model": "…", "effort": "…", "permissionMode": "…",  // default from the runtime's config
  "task": "one line",             // required
  "note": "…",
  "brief": "full markdown brief",  // prepended with config/protocol.md and staged to disk
  "cwd": "/abs/path",             // required unless worktree.repo is given
  "worktree": { "repo": "/abs/repo", "branch": "optional", "base": "optional base ref" },
  "sessionId": "…",               // external/one-shot runtimes only; claude gets a fresh uuid
  "status": "running",            // external only
  "autoStart": true,              // false creates the record without spawning
  "id": "…"                       // optional explicit id
}
```

`worktree.repo` creates `<repo>/.worktrees/<name>-<stamp>` on branch
`cr/<name>-<stamp>` and uses it as `cwd`. If the spawn itself fails the agent is
stored as `failed` with the reason in `note`, and the request returns `500`.

Bad input is a `400` with a sentence, not a stack trace. The checks run in this
order, and each names the field it refused:

| Condition | Message |
|---|---|
| no `name` | `name is required` |
| `name` over 200 characters | `name is too long (… the maximum is 200)` |
| no `task` | `task is required` |
| `task` over 4000 characters | `task is too long …` |
| neither `cwd` nor `worktree.repo` | `cwd or worktree.repo is required` |
| `cwd` that is not there | `cwd does not exist: <path>` |
| `role` outside the enum | `unknown role "…" — one of cto, orchestrator, worker` |
| `runtime` outside the enum | `unknown runtime "…" — one of claude, deepseek, external` |
| `parentId` that matches no agent | `parent <id> not found` |
| a body that is not valid JSON | `… valid JSON …` |

### Send semantics

`POST /api/agents/:id/send` writes the text into the agent's real terminal and
then submits it (a short delay first, longer for a large paste, so the CLI's TUI
can ingest it). Exceptions:

- `409 { error, queued: true, message }` — a **human** holds control and the
  sender is not `human`. The text is stored in the agent's inbox instead.
- `409 { error }` — the agent is `paused` and the sender is not `human`.
- `409 { error }` — the agent has no live terminal.
- `runtime: "external"` has no terminal to type into, so the message is always
  queued to its inbox and the call returns `200 { ok: true, queued: true, message }`.

A child that sets its status to `blocked` also posts `BLOCKED: <note>` to its
parent's inbox.

### Actions

| Action | Effect |
|---|---|
| `stop` | Kills the pty and the process tree; status goes `stopping` then `stopped`. |
| `restart` | Kills anything running, then respawns. Runtimes with `resumeArgs` and a known `sessionId` resume that session; one-shot workers start over. |
| `interrupt` | Sends `ESC` to the terminal (cancels the current turn in a TUI CLI). |
| `pause` | Sends `ESC` and marks the agent `paused`; the server then refuses parent `send`. There is no `SIGSTOP` on Windows, so the process is not frozen. |
| `resume` | Clears `paused` (back to `running` if the pty is alive, else `stopped`). |

### `UsageSummary`

```json
{
  "spend": { "today": 1.23, "week": 4.5, "month": 9.0 },
  "spendWindows": { "today": "2026-09-15", "weekFrom": "2026-09-09", "monthFrom": "2026-09-01", "basis": "local calendar days" },
  "currentRun": { "costUsd": 0.4, "startedAt": "ISO|null", "basis": "what the number sums" },
  "byTier": { "cto": {…usage}, "orchestrator": {…usage}, "deepseek": {…usage}, "other": {…usage} },
  "byTierAgents": { "cto": 1, "orchestrator": 1, "deepseek": 4, "other": 0 },
  "counts": { "total": 6, "active": 3, "running": 3, "queued": 0, "idle": 0, "paused": 0, "stopping": 0, "blocked": 1, "done": 5, "failed": 0, "stopped": 0, "unknown": 0 },
  "tokens": { "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0, "total": 0 },
  "limits": { "claude": null, "deepseek": null },
  "savings": {
    "deepseekActualUsd": 0.1,
    "fableEquivalentUsd": 8.2,
    "savedUsd": 8.1,
    "estimated": true,
    "basis": "worker usage re-priced at the configured frontier model"
  },
  "pricing": { "…": "the parsed config/pricing.json" }
}
```

- `spend` is summed from persisted per-day usage samples, so it survives
  restarts and includes agents that have since been deleted. Each sample is
  banked as the **increment** since the previous reading of that session, so a
  restart (or a re-read of the same transcript) does not double-count, and a
  session whose counters reset starts adding again from zero.
- `spendWindows` names the days those figures cover, in the operator's **local**
  timezone — a UTC day key put an evening's work into "tomorrow" and made
  "spend today" read `$0.00` while money was being spent.
- `currentRun` sums the cost of every agent not in a terminal status
  (`done`, `failed`, `stopped`), and `startedAt` is the earliest of their start
  times. `basis` says so in words, because the number is otherwise unreadable.
- `counts` has one key per status and always sums to `counts.total`; a status
  the server does not recognise lands in `unknown` rather than disappearing.
  `counts.active` counts `running`.
- `byTier` / `byTierAgents` bucket by `deepseek` runtime, then `cto` and
  `orchestrator` roles; anything else lands in `other`, so an agent with an
  unusual role is still counted somewhere.
- `limits` is a placeholder for provider rate-limit reporting and is currently
  always `null`.
- `savings.estimated` is always `true`. See the note under *Agent*.

`PublicConfig` (from `/api/state` and `/api/config`) is deliberately small:
`{ runtimes: { <name>: { label, defaults } }, pricing, crBin, defaultCwd,
defaultModel, dataDir, version }` — no commands, no argv, no environment.
`defaultCwd` is this checkout, which is what the New agent form offers when the
operator has not typed a path; it is never a path baked into the source.

Usage is refreshed from disk on `GET /api/agents/:id` and on a ~5s server tick
that also re-broadcasts state and marks agents whose process has disappeared as
`stopped`.

---

## WebSocket `/ws`

One connection carries everything. On connect the server sends a `state` frame.
Any other path on upgrade is dropped.

**Server → client**

| Frame | When |
|---|---|
| `{ type: "state", agents, usage }` | On connect, on any change, and on the ~5s tick. |
| `{ type: "agent", agent }` | A single agent changed (spawn, status, control). |
| `{ type: "pty", id, data }` | Live terminal output, only for agents this socket has attached to. |
| `{ type: "pty", id, data, scrollback: true, live }` | Immediate reply to `attach`: the stored scrollback, plus whether a process is currently attached. |
| `{ type: "message", message }` | A new report reached an inbox. |
| `{ type: "event", event }` | A new event was logged. |

There is no separate `usage` frame — usage rides along in `state`.

**Client → server**

| Frame | Meaning |
|---|---|
| `{ type: "attach", id }` | Start receiving that agent's pty output; the scrollback reply comes first. |
| `{ type: "detach", id }` | Stop receiving it. |
| `{ type: "input", id, data }` | Raw keystrokes into the pty. |
| `{ type: "resize", id, cols, rows }` | Resize the pty. |

Malformed JSON is ignored. `input` and `resize` for an agent with no live pty
are no-ops.

> **Note on `input`.** Unlike `POST /api/agents/:id/send`, the WebSocket `input`
> frame is *not* gated on who holds control — it is the human sitting at the UI
> typing into a terminal. The control flag exists to stop a **parent agent**
> from typing over a human, and that check lives on the HTTP route.

---

## Environment

| Variable | Effect |
|---|---|
| `CR_PORT` | Port to listen on (default: `port` in `config/runtimes.json`, else `4800`). |
| `CR_HOST` | Interface to bind (default: `host` in `config/runtimes.json`, else `127.0.0.1`). |
| `CR_DATA_DIR` | Database, scrollback and staged briefs (default: `dataDir` in the config, else `./data`). |
| `CR_CONFIG_DIR` | Directory holding your own `runtimes.json` / `pricing.json` / `protocol.md`. Any file missing there falls back to the repo's `config/`. |
| `CR_URL` | Server address used by `bin/cr.js` and `scripts/launch-orchestrator.mjs` (default: built from the config's host and port). |
| `CR_AGENT_ID` | Identity used by `bin/cr.js`; set automatically in every spawned terminal. |
| `CR_SMOKE_PORT` | Pins the port `scripts/smoke.mjs` uses; by default it takes a free one from the OS. |

Config values may themselves reference the environment: `${VAR}` and
`${VAR:-fallback}` are expanded at startup and a leading `~` becomes your home
directory, which is how `config/runtimes.json` stays free of machine-specific
paths. `DSH_REPO`, `DSH_HOME` and `CLAUDE_CONFIG_DIR` have built-in defaults;
`.env.example` lists them.
