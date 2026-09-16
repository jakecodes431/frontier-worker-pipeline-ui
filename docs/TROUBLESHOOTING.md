# Troubleshooting

Real failure modes, in the order people hit them. Every one of these has been
seen on a working install; none of them mean the control room is broken.

---

## `node:sqlite` is not available / the server exits immediately

```
Control Room could not load node:sqlite (running Node 20.11.1).
node:sqlite ships with Node 22 and later.
```

The database is the built-in `node:sqlite` module, which arrived in Node 22.
There is no fallback and no native dependency to install: upgrade Node.

```
node --version      # must be v22 or newer
```

`@lydell/node-pty` also ships prebuilt binaries per Node ABI, so switching Node
versions is a good moment to re-run `npm install`.

---

## `Port 4800 is already in use`

```
Port 4800 is already in use — another control room (or another app) is on it.
```

Usually it is your own control room, already running from another terminal —
open <http://127.0.0.1:4800> and see. If it is something else:

```powershell
# Windows: find the process holding the port
netstat -ano | findstr :4800
tasklist /fi "pid eq <pid>"
```

```bash
# macOS / Linux
lsof -iTCP:4800 -sTCP:LISTEN
```

Or just move: `CR_PORT=4801 npm start`. The UI reads its own address from the
page it was served from, so everything keeps working on the new port.

---

## The Claude or Codex CLI is not logged in

A spawned native agent goes `running` and then sits there, and its **Terminal**
tab shows a login prompt or an invalid-credentials message.

The control room spawns the same `claude` / `codex` binary you use by hand and
inherits its credentials; it never logs in for you. Fix it in a plain terminal
with that CLI's own login flow (for Claude Code, `claude` then `/login`; for
Codex, follow its [docs](https://developers.openai.com/codex/cli/)). Then
**Restart** the agent from its drawer (Extra → Restart). Native sessions that
support resume-by-id pick up where they left off.

---

## The folder-trust prompt (and other one-time prompts)

The first time Claude Code runs in a folder it asks whether you trust it. A
freshly created worktree is a new folder, so the *first* agent in every worktree
gets that question. The agent will wait on it forever and report nothing.

Open the agent's **Terminal** tab and answer it. Typing into that terminal is a
real keystroke into the real process.

The control room deliberately does not auto-answer trust prompts: doing so would
mean silently granting file access on your behalf.

---

## No DeepSeek harness installed

Creating a `deepseek` worker fails immediately with:

```
The worker CLI was not found at <home>/deepseek-harness/apps/cli/lib/bin.js. Clone the
DeepSeek Harness (or whatever CLI you run workers with), then point DSH_REPO at it —
see .env.example — or edit runtimes.deepseek.args in config/runtimes.json.
```

The DeepSeek runtime shells out to the DeepSeek Harness CLI; it is a separate
tool and is not bundled here. `config/runtimes.json` spells its entry point as
`${DSH_REPO}/apps/cli/lib/bin.js`, and `DSH_REPO` defaults to
`~/deepseek-harness`. Either clone the harness there, or point the variable at
wherever it already is:

```bash
# path to the harness checkout, not to the entry script
DSH_REPO=/path/to/deepseek-harness npm start
```

`.env.example` lists that variable with the rest. You can also replace
`runtimes.deepseek.args` in `config/runtimes.json` with any other CLI that takes
the prompt as its last argument. With no harness installed, the rest of the
control room works normally — use `--runtime claude` or `external` agents.

DeepSeek workers also need `DEEPSEEK_API_KEY` in the environment. It is the one
credential-looking variable the spawner keeps (see `keepEnv`); the control room
never reads or logs its value.

---

## A worker cannot write the repo's `.git`

A DeepSeek worker reports something like `unable to write .git/index` or
`fatal: not a git repository` even though its folder plainly is one.

Worktrees share the parent repository's object store: `<repo>/.worktrees/<name>`
contains a `.git` **file** pointing back at `<repo>/.git/worktrees/<name>`. A
worker sandboxed to its own directory can read that pointer and then fail to
write outside it.

Do not widen the worker's sandbox to the parent repo just so it can commit. The
worker's job ends at the edit, and integration is the frontier orchestrator's
job: have the worker report what it changed, then let the **orchestrator** read
the diff (Diff tab, or `git -C <worktree> diff`) and commit from its own
terminal, which already has the repo. That keeps the write boundary where it
belongs instead of granting broader access.

Check what the worker can actually see from its own cwd:

```bash
git -C <worktree> status
git -C <worktree> rev-parse --git-dir
```

A git worktree isolates **changed paths**, not processes. It is not a security
sandbox, and it is not a reason to grant a worker broader filesystem access.

---

## An agent's folder was deleted under it

Rows with a missing working directory carry an amber `!`; the drawer says
*Working directory is gone*, and Files, Diff and Restart are disabled for it.

This is normal after `git worktree remove` or a manual cleanup. The agent's
transcript, events and terminal scrollback are still readable. Remove the record
with **Extra → Remove from tree** when you are done with it; that leaves the
branch and the transcript alone.

---

## "process exited" in the Terminal tab

The tab goes read-only and says `process exited (exit code N)`. The scrollback
is kept on disk (`data/scrollback/<id>.log`), so this is a full record of the
run, not a truncated one. **Restart** puts a live process back in the same tab.

Exit code `1` from a DeepSeek worker usually means the harness itself refused
the task — read the tail of the terminal, not just the status.

---

## Restarting the control room "loses" agents

It does not lose the records. Agent state and history live in SQLite
(`data/control-room.sqlite`) and come straight back. What can be lost is the
terminal attachment:

- On a **graceful** shutdown the server stops the managed processes it started.
- On a **hard crash** (power loss, `SIGKILL`) their ptys are gone and there is
  **no auto-reattach**. On the next start those agents are marked `stopped` with a
  note and need an explicit **stop** or **restart**.
- A native session that supports resume-by-id restarts into its conversation; a
  one-shot DeepSeek worker is re-run from its brief.
- An **external registration** has no process to lose — it stays a record plus a
  transcript read.

---

## Handoff was refused, or I am near a provider limit

`cr handoff <id> --runtime codex` (or `claude`) is the manual way to continue a
frontier role on the other native runtime when a provider limit is close. It is
**not** automatic and does **not** transfer quota between providers.

- If it fails with `409`, the source still has a **live terminal**. Run
  `cr stop <id>` first, then hand off. The successor starts in the same
  cwd/worktree with the same role and parent.
- The successor's context is the recovered **task, brief and reports** — not the
  vendor's native conversation. Expect a new CLI conversation that has read the
  same brief; do not expect the old chat history or the old plan's quota to carry
  over.
- The old agent stays in the tree with its history, now carrying `successorId`;
  the successor carries `continuedFromId`. The source's children and report
  routing are re-parented to the successor.
- Quota itself is unknown to the control room unless a transcript carries real
  usage data. The UI cannot tell you how much of a plan remains.

---

## The offline banner will not clear

The banner tracks the WebSocket. If it stays up while the server is running:

- Check the address in the rail's footer — it is the host the page was served
  from. Opening the UI from the filesystem (`file://`) cannot reach the socket.
- Something between the browser and `127.0.0.1` (a proxy, a VPN client, an
  aggressive extension) may be blocking WebSocket upgrades. `curl
  http://127.0.0.1:4800/api/health` isolates the HTTP side from the socket.

**Retry now** in the banner forces an immediate reconnect and a fresh
`/api/state`.

---

## Spend numbers look wrong

- All displayed costs are price-sheet estimates from recorded tokens, not
  invoices. Subscription sessions need not incur a per-token bill at all.
- Missing model prices produce `pricingKnown: false` and `unpricedModels`.
  Tokens still count; an aggregate numeric zero is not proof of free use.
  Add a verified rate in `config/pricing.json` to price an unsupported model.
- Codex limits, when available, come from the last local rollout observation
  of account-level `rate_limits`. They may be stale. Missing limits are unknown,
  not zero remaining and not unlimited. Claude and DeepSeek limits are unknown.
- Spend is banked on the local day the increment was measured, not entirely on
  the day the session started. Registering the same session twice can count it
  twice; remove accidental duplicate registrations.

---

## `npm test` fails

`npm test` runs the offline gate: it parses every shipped JavaScript file, boots
a server on a free port the OS hands out (set `CR_SMOKE_PORT` to pin one) with a
scratch database and a scratch `CR_CONFIG_DIR`, and exercises the API contract.
It does **not** spawn a real Claude Code or Codex process, so a green run is not
proof that your provider account, plan or quota works — only that the control
room's own contract holds. Common causes:

- **the smoke server exited** — usually a pinned `CR_SMOKE_PORT` that is busy;
  the boot assertion names the exit code.
- **`node --check` failure** — a syntax error; the file and line are printed.
- **a home-directory path in the source** — the portability check refuses any
  absolute path that points inside somebody's home directory, in the Windows,
  Linux and macOS spellings alike, in shipped source. Put the path in
  `config/runtimes.json`, an environment variable, or a CLI flag instead; a
  leading `~` is fine anywhere, because it is expanded at runtime.
