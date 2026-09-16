# Frontier + Worker Pipeline & UI

A local, desktop-only **app** - a control room for running a shallow hierarchy of
coding agents: a frontier-model *CTO* session spawns frontier *orchestrator* sessions,
which spawn cheap *worker* sessions — each in its own git worktree, each a real
CLI process in a real pseudo-terminal, all visible in one browser UI.

There is no fake chat layer. Every agent you see in the UI is a process you
could have started yourself in a terminal; the UI attaches to that terminal, so
you can read it, type into it, take control, interrupt it, or restart it.

---

## The problem this solves

Cheap models are good enough for bounded, well-specified work — a mechanical
refactor, a migration, a test suite, boilerplate — and cost a fraction of a
frontier model per token. They are *not* good at deciding what the work is,
splitting it up, or judging whether it is right.

So split the roles:

- **Frontier models plan and review.** They write the brief, choose the split,
  read every diff, run the proof command, and integrate.
- **Cheap workers execute.** One bounded task, one worktree, file-disjoint from
  their siblings, then they exit.
- **You watch.** All of it, live, in one place — and you can type into any of
  those terminals at any moment, because they are real terminals.

The control room is the thing in the middle: it spawns the processes, keeps the
tree, streams the terminals to a browser, tracks tokens and cost, and gives
agents a tiny CLI (`bin/cr.js`) to spawn children, report upwards, and ask for
help when they are stuck.

---

## Architecture

```
                         you, in a browser at 127.0.0.1:4800
                                        |  HTTP + WebSocket
                        +---------------+---------------+
                        |      control room server      |   node:sqlite  ->  data/
                        |   HTTP API - /ws - static UI  |   transcript readers -> usage
                        +---------------+---------------+
                                        |  node-pty (ConPTY on Windows)
         +------------------------------+------------------------------+
         |                              |                              |
   +-----+-----+                  +-----+-----+                  +-----+-----+
   |    CTO    |                  | orchestr. |                  | orchestr. |   frontier CLI
   |  session  |                  |  session  |                  |  session  |   sessions
   +-----------+                  +-----+-----+                  +-----+-----+
                                        |                              |
                            +-----------+-----------+                  |
                        +---+---+   +---+---+   +---+---+          +---+---+
                        |worker |   |worker |   |worker |          |worker |   cheap CLI,
                        +-------+   +-------+   +-------+          +-------+   one-shot
                            |           |           |                  |
                        repo/.worktrees/<name>-<stamp>  on branch  cr/<name>-<stamp>
```

Each box is an operating-system process in its own pty. The server is the only
thing that talks to them; the browser talks only to the server.

**Ways up and down the tree.** A parent types into a child's terminal
(`cr send`). A child posts a short report to its parent's inbox (`cr report`)
and sets its own status (`cr status done|blocked|failed`). If you take control
of an agent in the UI, parent messages to it are queued to its inbox instead of
being typed in, so a human and an agent never fight over the same prompt.

---

## Screenshots

**Dashboard** — what the fleet is spending and doing. Frontier-model dollars are
API-equivalent estimates priced from token counts; worker dollars are real,
metered API spend.

![Dashboard](docs/screenshots/dashboard.png)

**Hierarchy** — the agent tree as a board: what needs you, what is active, and a
collapsed folder of everything finished.

![Hierarchy](docs/screenshots/hierarchy.png)

**Chat** — talk to any agent, with its tool calls inline and its children's
reports folded into the same thread.

![Chat](docs/screenshots/cto.png)

---

## Quick start

**Prerequisites**

- **Node.js >= 22.** The server uses the built-in `node:sqlite` module and
  global `fetch`; there is no external database and no ORM.
- **git** on your `PATH` (worktrees, diffs, file listings).
- **At least one agent CLI on your `PATH`.** Out of the box the config expects
  a Claude Code CLI (`claude`) for the frontier tiers. Any CLI that takes a
  prompt as an argument can be configured instead — see [Configuration](#configuration).
- *(optional)* **DeepSeek Harness** for the cheap worker tier. Without it you
  can still run the whole hierarchy on one runtime, or point the `deepseek`
  runtime at whatever cheap CLI you use.

**Install and run**

```sh
git clone <this repo>
cd frontier-worker-pipeline-ui
npm install
npm start
```

Then open <http://127.0.0.1:4800>.

`npm install` fetches a prebuilt `node-pty` binary for your platform; macOS,
Linux and Windows are all supported. On Windows the pty layer uses ConPTY, so
Windows 10 1809 or newer is required.

**First launch notes**

- Start the server from a plain terminal rather than from inside an agent
  session when you can. (The runtime adapters strip inherited agent-CLI
  environment markers either way, so nesting works, but a clean shell is
  simpler to reason about.)
- The first time an agent CLI runs in a folder it may show a trust prompt or a
  one-time feature prompt. Answer it yourself in that agent's **Terminal** tab.
  The control room deliberately does **not** auto-accept trust prompts.
- Nothing is spawned until you create an agent. `npm run check` boots the
  server on a scratch port with a scratch data directory and exercises the API
  without spawning any CLI or spending any tokens.

---

## Configuration

Everything lives in `config/` — `runtimes.json` (how to start each CLI),
`pricing.json` (what tokens cost) and `protocol.md` (what every agent is told
first) — plus environment variables. No config file contains a secret, and none
contains a machine-specific path: string values in `runtimes.json` support
`${VAR}` and `${VAR:-fallback}` expansion from the environment, and a leading
`~` expands to your home directory. If a variable is undefined and has no
built-in default, the server prints a warning naming it at startup.

Built-in fallbacks, so the defaults work on a fresh machine:

| Variable | Default | What it points at |
|---|---|---|
| `DSH_REPO` | `~/deepseek-harness` | Your DeepSeek Harness clone (the worker CLI). |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness state — sessions are read from here for usage. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code state; transcripts live under `projects/`. |

Set these in your shell, or keep them in a `.env` (see `.env.example`) and start
the server with Node's built-in loader:

```sh
node --env-file=.env server/index.js
```

Prefer to keep your edits out of the checkout entirely? Point `CR_CONFIG_DIR`
at a directory holding your own `runtimes.json` / `pricing.json` /
`protocol.md`; any file missing there falls back to the one in `config/`.

### `config/runtimes.json`

The only place CLI invocation lives. Top level:

| Key | Meaning |
|---|---|
| `port`, `host` | Listen address. Default `127.0.0.1:4800`. |
| `dataDir` | Where SQLite, scrollback and staged briefs go. Default `./data`. |
| `briefArgvLimit` | Briefs longer than this are written to a file and the agent is told to read it, instead of being passed as one enormous argv. |
| `worktreeDir`, `worktreeBranchPrefix` | Worktree layout; default `.worktrees` and `cr/`. |
| `runtimes` | One entry per runtime (see below). |

Each runtime entry:

| Key | Meaning |
|---|---|
| `label` | Shown in the UI. |
| `command`, `args` | How to start it. Per-agent placeholders `{model}`, `{effort}`, `{permissionMode}`, `{sessionId}`, `{name}`, `{prompt}` are substituted at spawn time; an argument that resolves to empty is dropped along with the option flag in front of it, so an unset value falls back to the CLI's own default instead of leaving a dangling flag. (`${VAR}` is different — that is environment expansion, done once at load.) |
| `resumeArgs` | Optional. Used by **Restart** when the session can be resumed by id. |
| `defaults` | `model`, `effort`, `permissionMode` when the caller does not pass them. |
| `env` | Extra environment for this runtime (a leading `~` is expanded). |
| `scrubEnvContaining`, `keepEnv` | Credential hygiene: delete inherited variables whose *name* contains any of these substrings (e.g. `KEY`, `TOKEN`, `SECRET`) except the ones explicitly kept. The control room never reads the values it keeps — it only passes them through. |
| `transcriptRoot` / `sessionStore` | Where that CLI writes its session transcripts, so usage and chat can be read back. |
| `idleAfterSilenceMs` | How long a silent-but-finished session waits before it is shown as `idle` rather than `running`. |
| `oneShot` | True for workers that run one task and exit. |

Three runtimes ship in the default config:

- **`claude`** — an interactive Claude Code CLI session. Usage and chat are read
  from the CLI's own JSONL transcript under `transcriptRoot`.
- **`deepseek`** — a headless DeepSeek Harness worker, one task then exit. It
  resolves to `${DSH_REPO}/apps/cli/lib/bin.js`, so set `DSH_REPO` (or edit the
  config) to point at your own install. Usage comes from the harness session
  store under `${DSH_HOME}`.
- **`external`** — a session the control room did *not* spawn (for example a CTO
  you are running yourself in a desktop app). It appears in the tree and its
  usage is tracked by session id; messages to it are queued in its inbox rather
  than typed into a terminal.

Adding a fourth runtime is a config entry plus a small adapter — see
[CONTRIBUTING.md](CONTRIBUTING.md).

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CR_PORT` | server | Overrides `port` from the config file. |
| `CR_DATA_DIR` | server | Overrides `dataDir`. Useful for a scratch run. |
| `CR_CONFIG_DIR` | server | Directory to read config files from before falling back to `config/`. |
| `DSH_REPO`, `DSH_HOME`, `CLAUDE_CONFIG_DIR` | config expansion | See the table above. |
| `CR_URL` | `bin/cr.js` | Control room base URL. Default `http://127.0.0.1:4800`. Set automatically in every spawned agent. |
| `CR_AGENT_ID` | `bin/cr.js` | The calling agent's own id. Set automatically in every spawned agent; you do not set it by hand. |
| `CR_BIN` | agents | Absolute path to `bin/cr.js`, injected so briefs can reference it. |
| `CR_PARENT_ID` | agents | The agent's parent id, or empty for a top-level agent. |
| provider keys | the agent CLIs | e.g. an API key for your worker CLI. These belong to that CLI, not to the control room — set them in your shell or in the runtime's `env`. |

Keep your `.env` out of version control — `.gitignore` already covers `data/`,
`node_modules/` and `.worktrees/`.

### `config/pricing.json`

USD per million tokens, per model, plus aliases and a `tier` label used by the
dashboard. **Edit this to match the price sheet you actually pay.** Every row
carries an `estimated` flag; see [Cost tracking](#cost-tracking) for what that
means.

### `config/protocol.md`

The text prepended to every spawned agent's brief: how to use `cr`, the rules
about worktrees and reviews, and when to mark itself blocked. Edit it to change
how your agents behave.

---

## How agents talk to the control room

Every spawned terminal gets `CR_AGENT_ID`, `CR_URL`, `CR_BIN` and
`CR_PARENT_ID` in its environment, and `config/protocol.md` at the top of its
brief. The agent-facing CLI is a single dependency-free file, `bin/cr.js`:

```sh
# spawn a child in a fresh worktree of a repo and wait for it
node bin/cr.js spawn --name "migrate-config" --role worker --runtime deepseek \
  --repo /path/to/repo --task "one line" --brief-file brief.md --wait

node bin/cr.js list                 # your children: status, tokens, cost
node bin/cr.js tree                 # the whole hierarchy
node bin/cr.js wait <id...>         # block until they reach a terminal status
node bin/cr.js result <id>          # a child's final answer
node bin/cr.js logs <id> --tail 4000
node bin/cr.js send <id> "text"     # type into a child's real CLI
node bin/cr.js report "text"        # short report to your parent's inbox
node bin/cr.js inbox                # reports your children sent you
node bin/cr.js status blocked --note "the exact question"
node bin/cr.js stop <id> | restart <id> | agent <id> | usage | health
```

Every command is a thin wrapper over the HTTP API in
[docs/API.md](docs/API.md), so anything an agent can do you can do with `curl`.

Two rules the server enforces rather than trusts:

- `send` from a parent is refused — and the message queued to the inbox —
  while a **human** holds control of the target, or while the target is paused.
- `status` only accepts `done`, `blocked`, `failed`, `running`, `idle`. A child
  marking itself `blocked` automatically posts `BLOCKED: <note>` to its
  parent's inbox.

---

## The worktree model

Passing `--repo <path>` to `spawn` creates an isolated git worktree:

```
<repo>/.worktrees/<name>-<stamp>      on branch  cr/<name>-<stamp>
```

That directory becomes the agent's working directory. Consequences worth
knowing:

- Workers never share a checkout, so two workers cannot collide in one file —
  provided their briefs are file-disjoint, which is the parent's job.
- The **Diff** and **Files** tabs run `git diff` / `git status` in that
  worktree, so you can read exactly what a worker changed before anything is
  integrated.
- Integration is deliberately a *frontier* job: orchestrators merge their
  workers' branches one at a time, running the proof command after each; the
  CTO merges the orchestrators.
- Worktrees are **not** deleted when you remove an agent from the tree. Clean
  them up with `git worktree remove` when you are done with them.

---

## Cost tracking

The dashboard shows spend today / this week / this month, the cost of the
current run, usage broken down by tier, fleet counts, token totals, and the
saving from delegating to cheap workers.

**Read this before you quote any of those numbers.**

- Token counts are **real**. They are read from each CLI's own session
  transcript on your disk — the same numbers the CLI recorded.
- **Cheap-worker API costs are real charges**, priced at the worker rows of
  `config/pricing.json`, because those calls are billed per token against an
  API key.
- **Frontier dollar figures are API-equivalent ESTIMATES.** If your frontier
  sessions run on a *plan subscription*, you are not billed per token at all —
  the subscription is billed on its own terms. The control room multiplies the
  observed token counts by a hand-entered price sheet to answer "what would this
  have cost on the API?". That is a modelling exercise, not an invoice.
- The **savings** figure is therefore a comparison between one real number and
  one estimate: cheap-worker usage re-priced at the frontier price sheet, minus
  what those workers actually cost. It is labelled `estimated: true` in the API
  and in the UI, and it is only as good as the numbers you put in
  `config/pricing.json`.
- Nothing here talks to a billing API. If you need authoritative spend, read it
  from your provider's console.

---

## Security and limits

This is a local developer tool. It is not hardened, and it is not meant to be.

- **It binds `127.0.0.1` and has no authentication, no accounts and no
  authorization.** Anyone who can reach the port can spawn processes.
- **Do not expose it.** No reverse proxy, no port forwarding, no tunnel, no
  `0.0.0.0`. If you must reach it from elsewhere, forward the loopback port over
  SSH and understand what you are doing.
- **It spawns real processes** with your user's privileges, in directories you
  name, with your environment (minus the scrubbed credential-looking
  variables). The agents it starts can write files and run commands. Give them
  worktrees, not your home directory.
- **It reads CLI transcripts on your machine** to compute usage — the JSONL and
  JSON session files those CLIs already write under your home directory. Those
  files contain your prompts and the models' replies. The control room reads
  them locally and sends them nowhere.
- **Briefs are written to disk** under `data/briefs/`, and terminal scrollback
  under `data/scrollback/`. Treat `data/` as sensitive; it is gitignored.
- There is **no sandbox**. Permission modes are whatever the underlying agent
  CLI supports, passed straight through from the config.
- The control room does not handle provider credentials. It scrubs
  credential-looking environment variables from spawned runtimes except the ones
  a runtime explicitly keeps, and it never reads their values.

---

## Project layout

```
server/            HTTP + WebSocket server, PTY manager, SQLite, git helpers
  index.js         routes, spawn/act/status, usage summary, WS fan-out
  config.js        config + pricing loading, price maths
  db.js            node:sqlite schema and accessors
  pty.js           node-pty process manager and scrollback
  git.js           worktrees, diff, file listing, process-tree kill
  usage.js         transcript readers (per CLI) -> token buckets
  adapters/        one adapter per runtime: build argv/env, read usage + chat
bin/cr.js          the agent-facing CLI (no dependencies)
ui/                browser UI: vanilla ES modules, no build step
  views/           dashboard, hierarchy, agent panel, new-agent form
  views/tabs/      chat, terminal (xterm.js), diff, files, logs
  lib/             api, ws, store, dom, formatting
config/            runtimes.json, pricing.json, protocol.md
scripts/smoke.mjs  offline API smoke test (`npm run check`)
docs/API.md        the HTTP + WebSocket contract
docs/screenshots/  images for this README (and how to take them safely)
.claude/skills/    agent skills shipped with the repo; third-party ones are
                   credited in NOTICE and keep their own LICENSE files
data/              SQLite, scrollback, staged briefs (gitignored)
```

---

## Roadmap and limitations

An honest list of what is unfinished or deliberately absent:

- **No authentication or multi-user support**, and none planned. This is a
  single-user local tool.
- **No rate-limit or quota surfacing.** The usage API has a `limits` field and
  it is always `null`; there is no integration with any provider's limit
  reporting yet.
- **Two real runtime adapters** (one frontier CLI, one cheap CLI) plus
  `external`. Other CLIs need a small adapter, mostly to parse their transcript
  format.
- **Pause is cooperative.** There is no `SIGSTOP` on Windows, so pause
  interrupts the current turn and makes the server refuse parent input until you
  resume; it does not freeze the process.
- **Stopping the server leaves agent processes running.** They are re-attached
  as `stopped` on the next start and can be restarted; sessions that support
  resume-by-id pick up where they left off, one-shot workers re-run from
  scratch.
- **Worktrees are never cleaned up automatically** (see above).
- **Frontier cost figures are estimates** against a hand-maintained price sheet
  (see [Cost tracking](#cost-tracking)).
- **Testing is one offline smoke script.** There is no unit test suite.
- **The UI ships an in-page mock server** (`ui/mock.js`, enabled with `?mock=1`)
  for working on the interface without spawning anything. It is developer
  scaffolding kept in step by hand, not a guaranteed-faithful demo mode.
- **Chat tabs are read-only renderings** of a CLI's transcript. To say something
  to an agent you type into its terminal (directly, or via `send`).
- No packaging, no installer, no auto-update. Clone and `npm start`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — how to run it, how to add a runtime
adapter, and what `npm run check` covers.

## Built by Quartzi

This tool was built by **[Quartzi](https://quartzi.ai)** and released as open
source under the MIT licence.

Quartzi is a platform for **persistent AI agents**: agents that get their own
workspace, memory, files, tools, browser and computer, so they keep working
after the conversation ends. Alongside the core platform, Quartzi runs two
business lines — **QCS (Quartzi Custom Solutions)**, custom agents and agentic
systems built for an organisation, and **QAL (Quartzi Agentic Learning)**,
agents for students, professors and institutions.

This control room came out of our own work: we needed frontier models to plan
and review while cheap workers did the bulk, and we needed to watch all of it in
one place. It runs entirely on your machine and is not a Quartzi product you
sign up for. If you want the hosted platform instead, that is
[quartzi.ai](https://quartzi.ai).

- Platform and docs: [quartzi.ai](https://quartzi.ai)
- Marketplace listing for this tool: [quartzi.ai/marketplace](https://quartzi.ai/marketplace/)

## License

MIT — see [LICENSE](LICENSE). Copyright Quartzi Inc. and contributors. Bundled
third-party material is credited in [NOTICE](NOTICE).
