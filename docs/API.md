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

`worktree` is `null` for an agent started directly in a `cwd`.

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
| GET | `/api/health` | | `{ ok: true, port, agents }` |
| GET | `/api/state` | | `{ agents: Agent[], usage: UsageSummary, config: PublicConfig }` |
| GET | `/api/usage` | | `UsageSummary` |
| GET | `/api/agents` | | `Agent[]` (flat; build the tree from `parentId`) |
| POST | `/api/agents` | see below | `201` + `Agent` |
| GET | `/api/agents/:id` | | `{ agent, messages, events, children: Agent[] }` (refreshes usage first; `events` capped at 200) |
| DELETE | `/api/agents/:id` | | `{ ok: true }`. `409` while the agent has a live terminal. Children are re-parented to the deleted agent's parent. The git worktree is **not** removed. |
| POST | `/api/agents/:id/send` | `{ text }`, header `X-Sender: human \| agent:<id>` | `{ ok: true }`; see *Send semantics* |
| POST | `/api/agents/:id/input` | `{ data }` raw pty bytes | `{ ok: true }` |
| POST | `/api/agents/:id/control` | `{ holder: "human" \| "parent" }` | `Agent` |
| POST | `/api/agents/:id/action` | `{ action: "stop" \| "restart" \| "interrupt" \| "pause" \| "resume" }` | `Agent`, or `400` for an unknown action |
| POST | `/api/agents/:id/status` | `{ status, note? }` | `Agent`, or `400` if `status` is not one of `done`, `blocked`, `failed`, `running`, `idle` |
| POST | `/api/agents/:id/report` | `{ text }` | `{ ok: true }`, or `400` on empty text |
| GET | `/api/agents/:id/inbox` | `?ack=1` marks the returned messages read | `Message[]` — reports from children |
| GET | `/api/agents/:id/messages` | | `Message[]` — the full message log for this agent |
| GET | `/api/agents/:id/chat` | | `{ messages: [{ role: "user\|assistant\|tool", text, ts }] }` parsed from the CLI's transcript, or from scrollback for runtimes that write none |
| GET | `/api/agents/:id/result` | | `{ result: string\|null, status }` |
| GET | `/api/agents/:id/diff` | | `{ diff, stat, log }` — `git diff` text, diffstat, and recent commits from the agent's cwd/worktree |
| GET | `/api/agents/:id/files` | | `{ changed: [{ path, status }], tree: [{ path, size }] }` |
| GET | `/api/agents/:id/file` | `?path=<relative>` | `{ path, content }` |
| GET | `/api/agents/:id/logs` | | `Event[]` (up to 1000) |
| GET | `/api/agents/:id/scrollback` | | `{ data, live }` — recent pty output and whether a process is attached |

Unknown routes return `404 { error }`. A missing agent returns `404`; any other
thrown error returns `500 { error }`.

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
`cr/<name>-<stamp>` and uses it as `cwd`. A `cwd` that does not exist is an
error. If the spawn itself fails the agent is stored as `failed` with the reason
in `note`, and the request returns `500`.

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
  "currentRun": { "costUsd": 0.4, "startedAt": "ISO|null" },
  "byTier": { "cto": {…usage}, "orchestrator": {…usage}, "deepseek": {…usage}, "other": {…usage} },
  "counts": { "active": 3, "idle": 0, "done": 5, "blocked": 1, "failed": 0, "stopped": 0, "queued": 0 },
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
  restarts and includes agents that have since been deleted.
- `currentRun` sums the cost of every agent not in a terminal status
  (`done`, `failed`, `stopped`), and `startedAt` is the earliest of their start
  times.
- `counts.active` counts `running`; the other keys count their own status.
- `limits` is a placeholder for provider rate-limit reporting and is currently
  always `null`.
- `savings.estimated` is always `true`. See the note under *Agent*.

`PublicConfig` (from `/api/state`) is deliberately small:
`{ runtimes: { <name>: { label, defaults } }, pricing, crBin }` — no commands,
no argv, no environment.

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
