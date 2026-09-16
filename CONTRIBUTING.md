# Contributing

Small project, few rules. Issues and pull requests are welcome; if you are
planning something large, open an issue first so we can agree on the shape.

## Running it

```sh
npm install
npm start          # http://127.0.0.1:4800
npm run dev        # same, with node --watch
```

Node >= 22 is required (the server uses `node:sqlite` and global `fetch`). You
need `git` on your `PATH`, and at least one agent CLI configured in
`config/runtimes.json` if you want to spawn anything real.

State lives in `data/` (SQLite, terminal scrollback, staged briefs). It is
gitignored. Deleting it resets the control room; live agent processes are not
affected, but they lose their place in the tree.

For a throwaway run that cannot touch your real state:

```sh
CR_PORT=4899 CR_DATA_DIR=/tmp/cr-scratch npm start
```

## Checks

```sh
npm run check
```

That is `node --check` on the server and the agent CLI, then
`scripts/smoke.mjs`: it boots the server on port 4899 with a temporary data
directory and asserts the static UI and the xterm vendor files are served, then
creates an `external` agent — so no CLI is spawned and no tokens are spent —
and exercises `/api/state`, status, control, the 409 when a parent sends to a
human-controlled agent, the failure path for a missing `cwd`, and the diff and
files endpoints. It exits non-zero if any assertion fails, and cleans up its
temporary directory.

Run it before opening a pull request. If you change the HTTP or WebSocket
surface, update [`docs/API.md`](docs/API.md) in the same change and add an
assertion to the smoke script.

There is no linter and no formatter config. Match the surrounding style: ES
modules, two-space indent, single quotes, semicolons, no build step, and
comments that explain *why* rather than restating the code.

## Adding a runtime adapter

A "runtime" is a CLI the control room can spawn and then read usage from. There
are two halves, and both are small.

**1. A config entry** in `config/runtimes.json`:

```json
"myagent": {
  "label": "My Agent CLI",
  "command": "myagent",
  "args": ["--model", "{model}", "--prompt", "{prompt}"],
  "defaults": { "model": "some-model", "effort": "medium" },
  "sessionStore": "${MYAGENT_HOME:-~/.myagent}/sessions",
  "oneShot": true
}
```

Per-agent placeholders (`{model}`, `{effort}`, `{permissionMode}`,
`{sessionId}`, `{name}`, `{prompt}`) are filled at spawn time; a lone
placeholder with no value is dropped together with the flag before it.
`${VAR}` and `${VAR:-fallback}` are expanded from the environment when the
config is loaded — use them instead of hard-coding paths, and add a sensible
fallback to `ENV_DEFAULTS` in `server/config.js` if your runtime needs one.

**2. An adapter** in `server/adapters/index.js`, keyed by the same name:

| Member | Required | Contract |
|---|---|---|
| `oneShot` | yes | `true` if the CLI runs one task and exits. |
| `build(agent, port, { resume })` | yes | Return `{ command, args, env }`. Start from `baseEnv(agent, port)` so the child gets `CR_AGENT_ID`, `CR_URL`, `CR_BIN`, `CR_PARENT_ID`. Scrub credential-looking variables you do not need. |
| `usage(agent)` | yes | Return `{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, ... }` (and optionally `sessionId`) read from the CLI's own session file, or `null` if there is nothing yet. Add the parser to `server/usage.js`. |
| `chat(agent, scrollback)` | no | `[{ role, text, ts }]` for the Chat tab. If the CLI writes no transcript, fall back to the terminal scrollback like the headless worker adapter does. |
| `result(agent, scrollback)` | no | The agent's final answer, used by `cr result` and `cr spawn --wait`. |

Then add a pricing row for the model in `config/pricing.json` (and an alias if
the CLI reports a different name) so cost and tier roll-ups work, and mark the
row `"estimated": true` unless those are prices you are really billed.

Nothing else needs to know about your runtime: the tree, terminal attach,
worktrees, diffs and the dashboard are all runtime-agnostic.

## The UI

`ui/` is plain ES modules loaded straight by the browser — **no build step, no
bundler, no framework, no TypeScript**. Edit a file, reload the page.

```
ui/index.html       the shell
ui/app.js           router and top-level wiring
ui/lib/             api (fetch), ws (live frames), store, dom helpers, formatters
ui/views/           dashboard, hierarchy, agent panel, new-agent form, cto view
ui/views/tabs/      chat, terminal, diff, files, logs
ui/styles.css       all styling, plain CSS with custom properties
```

The only third-party code in the browser is xterm.js, served by the server from
`node_modules` at `/vendor/xterm/...` — do not vendor a copy into `ui/`, and do
not add a CDN tag.

Live data arrives over the WebSocket at `/ws` (`state`, `agent`, `pty`,
`message`, `event` frames, documented in `docs/API.md`); `ui/lib/store.js` is
the single place that applies them. Views render from the store rather than
fetching on their own, except for the per-tab endpoints (diff, files, logs,
chat, scrollback).

`ui/mock.js` is an in-page fake server: load the UI with `?mock=1` and it
replaces `fetch` and `WebSocket` before any module issues a request, so you can
work on the interface with a populated hierarchy and no processes running. It
is developer scaffolding — if you touch it, keep its shapes in step with
`docs/API.md`.

## Pull requests

- One topic per PR; a short description of what changes behaviourally.
- `npm run check` passes.
- No absolute paths from your machine, no personal or company identifiers, and
  no credentials in code, config or fixtures.
- Third-party material keeps its license notice, and anything new gets an entry
  in [`NOTICE`](NOTICE).
