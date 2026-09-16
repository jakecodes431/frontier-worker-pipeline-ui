# Control room API contract (v0.1)

Local only. Non-loopback bind addresses and cross-origin HTTP/WebSocket requests
are refused. This is still a single-user tool without authentication.

The server listens on `http://127.0.0.1:4800` by default (`host` and
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
  "runtime": "claude | codex | deepseek | external",
  "transcriptRuntime": "claude | codex | null",
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
  "sessionId": "the CLI's own session id, or an absolute transcript path for an external registration",
  "continuedFromId": "a-… | null",
  "successorId": "a-… | null",
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
    "pricingKnown": true, "unpricedModels": [], "unpricedMarkers": [],
    "limits": null,
    "fableEquivalentUsd": 0.0
  }
}
```

`worktree` is `null` for an agent started directly in a `cwd`. `cwdExists` is
recomputed (cached for 5s) on every read, so a folder deleted under a finished
agent shows up as `false` rather than as a broken panel.

**`runtime` vs `transcriptRuntime`.** `runtime` is what the control room does
with the agent: `claude` and `codex` are native runtimes it spawns and drives in
a pty, `deepseek` is the optional one-shot worker, and `external` is a session it
did **not** spawn. An external agent has no pty and no terminal input; because
its own `runtime` is only `external`, `transcriptRuntime` (`claude` or `codex`)
says whose transcript reader to use, and messages to it are queued to its inbox
instead of typed in. For a spawned native agent it mirrors that native runtime.

**`continuedFromId` / `successorId`.** Set by
[`POST /api/agents/:id/handoff`](#post-apiagentsidhandoff). `continuedFromId` on
the successor names the agent whose role it took over; `successorId` on the old
agent names the replacement. Both are `null` otherwise.

**`costUsd` vs `fableEquivalentUsd`.** `costUsd` prices the agent's own tokens at
its own model's row in `config/pricing.json`. `fableEquivalentUsd` re-prices the
same tokens at the frontier model named by `pricing.fableEquivalentModel` — it
answers "what would this work have cost on the frontier model?" and is what the
savings figure is built from. Frontier rows in the price sheet are hand-entered
estimates (`"estimated": true`), and a plan subscription is not billed per
token, so any dollar figure derived from them is an API-equivalent estimate, not
a charge. Worker dollar values are also price-sheet estimates; no billing API is queried.

### Message

```json
{ "id": 12, "agentId": "a-…", "fromAgentId": "a-…|null",
  "direction": "in | out | report | system",
  "sender": "human | agent:<id> | parent | system",
  "text": "…", "deliver": false, "createdAt": "ISO" }
```

`deliver` is `true` only on messages queued by `POST /send` for a managed
one-shot local model: they are the durable input that the local delivery path
consumes in a fresh run. Reports from children never set it.

### Event

```json
{ "id": 34, "agentId": "a-…", "kind": "created | spawned | resumed | exit | status | control | action | report | send | delivered | delivery-error | lost | error | usage-error",
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
| GET | `/api/budget` | | `Budget` (see [Budget](#budget)) |
| POST | `/api/budget` | `{ dailyUsd: number \| null }` | `Budget` after saving; `400` for any other value |
| GET | `/api/claude-usage` | | `{ limits, settings, note }` (see [Claude usage connection](#claude-usage-connection)) |
| POST | `/api/directories/pick` | `{ initialPath? }` | folder-picker result (see [`POST /api/directories/pick`](#post-apidirectoriespick)) |
| GET | `/api/agents` | | `Agent[]` (flat; build the tree from `parentId`) |
| POST | `/api/agents` | see below | `201` + `Agent`, or `400 { error }` naming the field that is wrong |
| GET | `/api/agents/:id` | | `{ agent, messages, events, children: Agent[] }` (refreshes usage first; `events` capped at 200) |
| DELETE | `/api/agents/:id` | | `{ ok: true }`. `409` while the agent has a live terminal. Children are re-parented to the deleted agent's parent. The git worktree is **not** removed. |
| POST | `/api/agents/:id/send` | `{ text }`, header `X-Sender: human \| agent:<id>` | `{ ok: true }`, or `{ ok: true, queued: true, message, delivered?, deliveryError? }` when no live prompt can take it; see *Send semantics*. `400` on empty text |
| POST | `/api/agents/:id/input` | `{ data }` raw pty bytes | `{ ok: true }`, or `409` when the agent has no live terminal |
| POST | `/api/agents/:id/control` | `{ holder: "human" \| "parent" }` | `Agent` |
| POST | `/api/agents/:id/action` | `{ action: "stop" \| "restart" \| "interrupt" \| "pause" \| "resume" }` | `Agent`, or `400` for an unknown action, or `400` when `restart` is asked for an agent whose working directory is gone |
| POST | `/api/agents/:id/handoff` | `{ runtime, model?, effort?, autoStart?, brief? }` | `201` + successor `Agent`; `409` while the source has a live terminal; `400` for a `runtime` outside `codex \| claude` |
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
  "runtime": "claude | codex | deepseek | external", // default: "deepseek" for workers, else "claude"
  "transcriptRuntime": "claude | codex", // external registrations: which CLI's transcript reader to use
  "model": "…", "effort": "…", "permissionMode": "…",  // default from the runtime's config
  "task": "one line",             // required
  "note": "…",
  "brief": "full markdown brief",  // prepended with config/protocol.md and staged to disk
  "cwd": "/abs/path",             // required unless worktree.repo is given
  "worktree": { "repo": "/abs/repo", "branch": "optional", "base": "optional base ref" },
  "sessionId": "…",               // external: a real session id or absolute transcript path; native claude/codex get a fresh uuid. Never invent one.
  "status": "running",            // external only
  "autoStart": true               // false creates the record without spawning
}
```

`worktree.repo` creates `<repo>/.worktrees/<name>-<stamp>` on branch
`cr/<name>-<stamp>` and uses it as `cwd`. The worktree starts from a committed
base (the branch/ref), so uncommitted changes in `repo` are not copied into it.
If the spawn itself fails the agent is stored as `failed` with the reason in
`note`, and the request returns `500`.

An `external` agent is a **registration**: `autoStart` never spawns a process
for it, it has no pty and no terminal input, and `POST /api/agents/:id/send`
queues to its inbox (see *Send semantics*). `transcriptRuntime` is required in
practice for an external agent to have usage or chat; set `sessionId` to the
real session id or an absolute transcript path the provider actually wrote, and
pick `transcriptRuntime` to match that provider. Do not guess either value.

Bad input is a `400` with a sentence, not a stack trace. The checks run in this
order, and each names the field it refused:

| Condition | Message |
|---|---|
| no `name` | `name is required` |
| `name` over 200 characters | `name is too long (… the maximum is 200)` |
| no `task` | `task is required` |
| `task` over 2000 characters | `task is too long …` |
| neither `cwd` nor `worktree.repo` | `cwd or worktree.repo is required` |
| `cwd` that is not there | `cwd does not exist: <path>` |
| `role` outside the enum | `unknown role "…" — one of cto, orchestrator, worker` |
| `runtime` outside the enum | `unknown runtime "…" — one of claude, codex, deepseek, external` |
| `parentId` that matches no agent | `parent <id> not found` |
| a body that is not valid JSON | `… valid JSON …` |

### Send semantics

`POST /api/agents/:id/send` writes the text into the agent's real terminal and
then submits it (a short delay first, longer for a large paste, so the CLI's TUI
can ingest it). Exceptions:

- `409 { error, queued: true, message }` — a **human** holds control and the
  sender is not `human`. The text is stored in the agent's inbox instead and is
  never auto-delivered (the human owns that prompt).
- `409 { error }` — the agent is `paused` and the sender is not `human`.
- `409 { error }` — an interactive agent has no live terminal.
- `runtime: "external"` has no terminal to type into, so the message is always
  queued to its inbox and the call returns `200 { ok: true, queued: true, message }`.
  Nothing is delivered anywhere automatically: the registered session picks the
  message up by reading its inbox, and its chat is read back from the transcript
  named by `transcriptRuntime`.
- a managed **one-shot local model** (DeepSeek) consumed its only prompt, so the
  message is queued durably (`deliver: true`) and then **dispatched to a fresh run
  of the same local model**: the run's prompt is the original brief plus the
  queued messages in id order, and nothing is written to stdin. The call returns
  `200 { ok: true, queued: true, delivered: boolean, message }`; `deliveryError`
  carries the reason when the run could not start. A message is marked read only
  after that run actually starts, so a refused or failed delivery stays in the
  inbox and is retried on the next send, restart, or one-shot exit. A message to a
  one-shot agent that has never started waits for its first run
  (`deliveryReason: "… has not started yet …"`); a live one-shot terminal defers
  until it exits.

The `delivered` flag is never optimistic: it is set only after `POST /send` has
successfully started the run that consumed the queue.

A child that sets its status to `blocked` also posts `BLOCKED: <note>` to its
parent's inbox.

### Actions

| Action | Effect |
|---|---|
| `stop` | Kills the pty and the process tree; status goes `stopping` then `stopped`. |
| `restart` | Kills anything running, then respawns. Runtimes with `resumeArgs` and a known `sessionId` resume that session; one-shot workers start over. Any unread queued input (`deliver: true`) is folded into the new run's prompt and acknowledged only after it starts; if that run cannot start the restart fails `409` and the messages stay queued. |
| `interrupt` | Sends `ESC` to the terminal (cancels the current turn in a TUI CLI). |
| `pause` | Sends `ESC` and marks the agent `paused`; the server then refuses parent `send`. There is no `SIGSTOP` on Windows, so the process is not frozen. |
| `resume` | Clears `paused` (back to `running` if the pty is alive, else `stopped`). |

### `POST /api/agents/:id/handoff`

Hand a frontier role to a successor on the other native runtime. This is manual
and explicit — it is **not** an automatic switch, and it does **not** transfer or
bypass a provider's quota.

```jsonc
{
  "runtime": "codex | claude",   // required; the successor's native runtime
  "model": "…",                  // optional; defaults to the successor runtime's config
  "effort": "…",                 // optional
  "autoStart": true,             // false creates the successor record without spawning it
  "brief": "optional extra markdown context"
}
```

Returns `201` with the successor `Agent`.

| Condition | Result |
|---|---|
| the source has a live terminal | `409 { error }` — `cr stop <id>` first |
| `runtime` is missing or not `codex`/`claude` | `400 { error }` |
| source agent does not exist | `404` |

What the successor inherits and what it does not:

- **Inherits** the source's `cwd`/worktree, `role` and `parentId`. The source's
  children are re-parented to the successor, and report routing follows. The old
  agent stays in the tree with its history and events retained.
- **Context is recovered, not cloned.** The successor's context is built from the
  task, brief and reports the control room holds. It is **not** the vendor's
  native conversation, and no vendor session or quota is transferred.
- The source gets `successorId`; the successor gets `continuedFromId` and a
  `transcriptRuntime` matching `runtime`. `--no-start` / `autoStart: false`
  leaves the successor `queued` until it is started.

On a **graceful** server shutdown the managed processes are stopped. On a **hard
crash** terminal attachment is lost and there is no auto-reattach: those agents
need an explicit stop or restart. Agent state and history persist in SQLite in
both cases.

### `UsageSummary`

```json
{
  "spend": { "today": 1.23, "week": 4.5, "month": 9.0 },
  "spendWindows": { "today": "2026-09-15", "weekFrom": "2026-09-09", "monthFrom": "2026-09-01",
    "basis": "local calendar days; each day is the token delta banked for that local day, priced at read time from the current price sheet" },
  "currentRun": { "costUsd": 0.4, "startedAt": "ISO|null", "pricingKnown": true,
    "basis": "total priced estimate of every agent that has not reached a terminal status" },
  "byTier": { "cto": {…usage}, "orchestrator": {…usage}, "deepseek": {…usage}, "other": {…usage} },
  "byTierAgents": { "cto": 1, "orchestrator": 1, "deepseek": 4, "other": 0 },
  "counts": { "total": 6, "active": 3, "running": 3, "queued": 0, "idle": 0, "paused": 0, "stopping": 0, "blocked": 1, "done": 2, "failed": 0, "stopped": 0, "unknown": 0 },
  "tokens": { "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0, "total": 0 },
  "limits": { "claude": null, "codex": null, "deepseek": null },
  "savings": {
    "deepseekActualUsd": 0.1,
    "fableEquivalentUsd": 8.2,
    "savedUsd": 8.1,
    "estimated": true,
    "basis": "DeepSeek token usage re-priced at <fableEquivalentModel> (editable estimated price sheet in config/pricing.json). Both dollar figures are estimates, not provider invoices; the avoided work was never run."
  },
  "pricing": { "_note": "…", "claudeBilling": "…", "fableEquivalentModel": "claude-fable-5-1", "models": {…}, "aliases": {…}, "markers": {…} },
  "pricingComplete": true,
  "unpricedModels": [],
  "unpricedMarkers": [],
  "generatedAt": "2026-09-16T18:41:33.173Z"
}
```

- `spend` is computed at **read time** from persisted per-day TOKEN samples,
  priced against each model's current rate in `config/pricing.json`, so it
  survives restarts and includes agents that have since been deleted. Each
  sample stores the **token increment** since the previous reading of that
  session, so a restart (or a re-read of the same transcript) does not
  double-count, and a session whose counters reset starts adding again from
  zero. A price row that lands later reprices the history already recorded
  instead of banking a whole session into today; `usage_samples.cost_usd` is a
  diagnostic snapshot of the sheet at write time and is never a window total.
  The sheet is loaded when the server starts, so edit `config/pricing.json` and
  restart to apply a rate change.
- `spendWindows` names the days those figures cover, in the operator's **local**
  timezone — a UTC day key put an evening's work into "tomorrow" and made
  "spend today" read `$0.00` while money was being spent. Each window is the
  **token delta banked for that local day** and is priced at read time from the
  current price sheet, so a rate change re-prices history instead of freezing
  the dollars of the day the tokens were spent.
- `currentRun` is the **total priced estimate of every agent that has not
  reached a terminal status** (`done`, `failed`, `stopped`), and `startedAt` is
  the earliest of their start times. `basis` says so in words, because the
  number is otherwise unreadable.
- `currentRun.pricingKnown` is `false` when any non-terminal agent has a model
  with no row in the price sheet, so a run estimate that silently omits a rate
  is flagged rather than presented as complete.
- `counts` has one key per status and always sums to `counts.total`; a status
  the server does not recognise lands in `unknown` rather than disappearing.
  `counts.active` counts `running`.
- `byTier` / `byTierAgents` bucket by `deepseek` runtime, then `cto` and
  `orchestrator` roles; anything else lands in `other`, so an agent with an
  unusual role is still counted somewhere. Each `{…usage}` entry carries
  `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`,
  `totalTokens`, `costUsd`, `fableEquivalentUsd` and `pricingKnown`.
- `limits.codex` may contain the latest account-level limit observation from a
  local Codex rollout. Absent observations are null; Claude and DeepSeek limits
  remain unknown. This is not a live provider quota query.
- A model with no row in `config/pricing.json` is **unpriced, not free**: its
  tokens count, but its cost reads `$0.00` because there is no price, not because
  it was verified as zero. `unpricedModels` names those real models, and any one
  of them makes `pricingComplete` `false`; `pricingComplete` is `true` only when
  no real model is missing a row.
- `unpricedMarkers` lists ids that are deliberately never priced because they
  are not models at all (Claude Code writes `<synthetic>` on assistant entries
  that are API error notices). Markers never set `pricingKnown` to `false` and
  never make `pricingComplete` `false`; each carries its own `id`, `reason` and
  `totalTokens`.
- `savings.basis` is a template: `<fableEquivalentModel>` is substituted with
  `pricing.fableEquivalentModel` from `config/pricing.json`. `savings.estimated`
  is always `true`. All dollar figures are estimates against the configured
  price sheet, and no invoice or billing API is queried. See the note under
  *Agent*.
- `generatedAt` is the ISO timestamp of the read.

`PublicConfig` (from `/api/state` and `/api/config`) is deliberately small:
`{ runtimes: { <name>: { label, defaults } }, pricing, crBin, defaultCwd,
defaultModel, dataDir, version }` — no commands, no argv, no environment.
`defaultCwd` is this checkout, which is what the New agent form offers when the
operator has not typed a path; it is never a path baked into the source.

Usage is refreshed from disk on `GET /api/agents/:id` and on a ~5s server tick
that also re-broadcasts state and marks agents whose process has disappeared as
`stopped`.

### Budget

Operator-set daily cap on **measured DeepSeek spend** (see `server/budget.js`):

```json
{ "dailyUsd": 10, "day": "2026-09-16", "spentUsd": 4.1, "remainingUsd": 5.9, "percentUsed": 41 }
```

- `GET /api/budget` reads the stored cap and today's measured spend.
- `spentUsd` is the **DeepSeek-runtime** portion (`spendRuntimeSince`) of
  `/api/usage` `spend.today`, on the same read-time basis: for that scope the two
  agree exactly, and `spentUsd` is legitimately smaller than the whole-fleet
  `spend.today` because Claude/Codex estimates are not part of the DeepSeek cap.
- `POST /api/budget` with `{ "dailyUsd": <finite number > 0 and <= 1000000> }`
  stores it; `{ "dailyUsd": null }` clears it; any other value is `400` with the
  reason. Both verbs answer with the same payload.
- The value lives in `<dataDir>/budget.json` (`CR_DATA_DIR` moves it) and is
  re-read on every request, so a hand edit is picked up without a restart. An
  absent, unreadable, corrupt or out-of-range file reads as unset (`dailyUsd:
  null`, with `remainingUsd`/`percentUsed` also `null`) — a broken file must not
  invent a limit.

**Tracking aid, not enforcement.** Passing `dailyUsd` never pauses, kills or
refuses an agent; it only lets the dashboard show the proportion used. The
control room does not meter or hard-stop provider spend.

### Claude usage connection

`GET /api/claude-usage` returns the latest normalized Claude plan observation
plus a ready-to-apply statusLine setting:

```json
{
  "limits": { "observedAt": "ISO", "primary": { "used_percent": 25, "window_minutes": 300, "resets_at": 2000000000 },
              "secondary": { "used_percent": 55, "window_minutes": 10080, "resets_at": null } },
  "settings": { "statusLine": { "type": "command", "command": "node \"<repo>/scripts/claude-statusline.mjs\" \"<dataDir>\"" } },
  "note": "Managed Claude sessions connect automatically. For an existing session, add this statusLine setting to Claude Code settings, preserving other settings. Usage appears after an API response on a supported plan."
}
```

- `limits` is the five-hour (`primary`) / seven-day (`secondary`) observation
  read from `<dataDir>/claude-usage.json`, or `null` before anything is seen.
  This is an account observation Claude Code itself reports, not a live quota
  query, and not this agent's private allowance. A window is omitted when its
  `used_percentage` is missing, non-finite or outside `0`–`100`; a measured `0`
  is kept as `0`, and `resets_at` is normalized to the documented Unix epoch
  seconds (a legacy millisecond or ISO-8601 value is converted, an unusable one
  becomes `null`). A `404` from this route means the running server predates the
  endpoint: restart it. The UI reports that as its own state and never as empty
  or 0% usage.
- That file is written by `scripts/claude-statusline.mjs`, run by Claude Code as
  its statusLine with the documented plan-usage payload on stdin. Only the
  percentages and reset times are kept; **no credentials or session id are
  stored**.
- The statusLine command embeds the server's own `dataDir`, so the server and the
  Claude session must share one `CR_DATA_DIR` for the hub to see the file.
  Managed Claude sessions are started with this setting automatically; an
  existing session needs it added to its Claude Code settings, preserving the
  rest. `CR_CONFIG_DIR` changes only where `runtimes.json` / `pricing.json` /
  `protocol.md` are read, and `CR_PORT` changes only where the hub listens — see
  [Environment](#environment).

### `POST /api/directories/pick`

Open the native folder chooser for the New-agent form. The dialog is **only ever
opened by an explicit operator click**; there is no non-interactive or automated
fallback. Body: `{ "initialPath"?: "<absolute directory>" }`.

| Case | Result |
|---|---|
| a directory is chosen | `200 { path: "<absolute existing directory>" }` |
| the dialog is cancelled | `200 { path: null }` — not an error |
| `initialPath` present and not a string | `400 { error: "initialPath must be a directory path" }`, **before** any dialog can open |
| a picker is already open | `409 { path: null, error, code: "EBUSY" }` |
| the picker does not answer in time | `504 { path: null, error, code: "ETIMEDOUT" }` |
| platform is not Windows | `501 { path: null, error, code: "ENOTSUP" }` — type the path instead |
| the answer is not an existing absolute directory | `400 { path: null, error, code: "EINVALIDPATH" }` |
| the picker could not start / failed | `500 { path: null, error, code: "ESPAWN" \| "EFAILED" }` |

A *string* `initialPath` is deliberately **not** rejected by the HTTP guard: an
unusable one (relative, stale or not a directory) is ignored and the dialog opens
at its default, so a path left over in the form cannot block picking a new
folder. `null` or an omitted `initialPath` is valid. The start path travels as
`CR_PICKER_INITIAL` environment data — never as command text — and a picker that
is already open prevents a second process from being spawned. A non-Windows host
returns `501` without spawning anything.

Importing a previous data directory is an offline script, not an endpoint:
`node scripts/import-history.mjs <source-data-dir> <destination-data-dir>` — see
the README.

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

## Codex transcript observations

`Agent.usage.limits` is null or the latest raw `rate_limits` object recorded in
that Codex rollout. Its primary/secondary windows may include `used_percent`,
`window_minutes` and `resets_at`. These are account observations, not per-agent
quotas, and may be stale. Missing provider data remains unknown.

Codex cumulative `token_count` snapshots are not summed across turns. Cached
input is separated from total input, and reasoning output is not added twice.
`pricingKnown: false` and `unpricedModels` identify missing price-sheet rows.
`unpricedMarkers` lists ids that are deliberately never priced because they are
not models at all (Claude Code writes `<synthetic>` on assistant entries that
are API error notices). Markers never set `pricingKnown` to `false` and never
make `/api/usage` report `pricingComplete: false`; each carries its own `id`,
`reason` and `totalTokens`.
`CODEX_HOME` defaults to `~/.codex`; session lookup uses its `sessions/` tree.
