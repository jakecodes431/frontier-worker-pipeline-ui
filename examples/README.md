# Worked example: one orchestrator, three workers

This runs the feature described in [`../briefs/example-orchestrator.md`](../briefs/example-orchestrator.md)
end to end, from a terminal, against a repo of your own. Nothing here is specific to that
feature — it is the shape of every run.

Paths are written with forward slashes, which work on macOS, Linux and Windows alike;
substitute your own (`~/code/notes-app`, `C:/code/notes-app`, ...).

## 0. Before you start

- The target repo is a git repo, committed and clean. Agents get worktrees of it, and a
  dirty checkout makes the first `git worktree add` fail.
- The CLI you are going to spawn is installed and logged in (`claude` for orchestrators,
  the DeepSeek Harness for workers — see `config/runtimes.json`).
- You have a gate command for that repo that exits 0 today. If it is red before the run,
  nobody can tell you anything useful about the run.

## 1. Start the control room

```
npm install
npm start
```

Open http://127.0.0.1:4800 and leave it open — that is where you watch the terminals.
Check the server from another shell:

```
node bin/cr.js health
```

## 2. Write the orchestrator's brief

Copy `briefs/example-orchestrator.md` next to your project and edit the repo facts, the
gate command and the feature. Keep the checkpoint block and the fan-out rules as they are:
those are what make the run reviewable.

## 3. Spawn the orchestrator

```
node bin/cr.js spawn --name "tags" --role orchestrator --runtime claude \
  --repo /path/to/notes-app \
  --task "Ship tag support in notes-app: create, assign, and filter by tag" \
  --brief-file ./my-tags-orchestrator.md
```

(PowerShell: one line, or backticks instead of `\`.)

It prints the new agent id and, on stderr, the worktree it created —
`/path/to/notes-app/.worktrees/tags-<stamp>` on branch `cr/tags-<stamp>`. The shared
checkout is untouched.

The first time a CLI runs in a new folder it may ask its own trust or onboarding question.
Answer it in that agent's **Terminal** tab in the UI; the control room deliberately does
not auto-accept those prompts.

## 4. Watch

```
node bin/cr.js tree                 # the whole hierarchy, with tokens and cost
node bin/cr.js list --all           # flat view
node bin/cr.js agent <id>           # the full record as JSON
node bin/cr.js logs <id> --tail 4000
node bin/cr.js inbox --agent <id>   # what this agent's children reported to it
node bin/cr.js usage                # spend by tier
```

As a human you have no `CR_AGENT_ID`, so `inbox`, `report` and `status` need `--agent <id>`
to say whose they are. Agents spawned by the control room have it set already and can drop
the flag.

The orchestrator's first report arrives in its parent's inbox — and since this
orchestrator is top-level, you read it in the UI's Chat tab, or in the terminal it is
running in. Expect the `CURRENT STATE / DATA MODEL / INTERFACES / FILE MAP / WORKER SPLIT
/ RISKS` block from the brief before any worker is spawned.

## 5. Let it fan out

The orchestrator writes each worker's brief to a file and spawns it exactly the way you
spawned the orchestrator, with `--runtime deepseek` and its own `--repo`:

```
node $CR_BIN spawn --name "tags-api" --role worker --runtime deepseek \
  --repo /path/to/notes-app \
  --task "Add the /api/tags routes and ?tag= filtering to GET /api/notes" \
  --brief-file /path/to/tags-api-brief.md
```

Each worker gets its own worktree and branch, does the one task, and exits. A one-shot
worker is marked `done` on exit code 0 and `failed` otherwise; its last message is its
result:

```
node bin/cr.js wait <workerId> --timeout 1800   # 0 = all done, 1 = failed/blocked, 124 = timed out
node bin/cr.js result <workerId>
```

Then the orchestrator reads the diff, runs the gate itself, and merges one branch at a
time. That review step is not optional and not delegable: a worker's summary is a claim,
the gate's exit code is evidence.

## 6. Talk to a running agent

```
node bin/cr.js send <id> "skip the tag colour work, it is out of scope"
```

This types into the agent's real terminal. If a human has taken control of that terminal
in the UI, the send is refused and queued to the agent's inbox instead (`cr` exits 3 and
says so) — take control, type, return control.

`stop <id>` and `restart <id>` do what they say; a restarted Claude session resumes by
session id, and the hierarchy survives a server restart because it is all in SQLite.

## 7. Land the work

When the orchestrator reports done, you have a branch in your own repo. Review it like any
other branch:

```
git -C /path/to/notes-app log --oneline main..cr/tags-<stamp>
git -C /path/to/notes-app diff main...cr/tags-<stamp>
```

Run the gate once more yourself, merge it, and clean up the worktrees you no longer need:

```
git -C /path/to/notes-app worktree list
git -C /path/to/notes-app worktree remove .worktrees/tags-api-<stamp>
```

Nothing in the control room pushes, deploys, or deletes branches for you. The last step is
always yours.

## What a good run looks like

- One checkpoint report before any worker exists, and one after every integration.
- Workers that never appear in each other's files.
- A gate command that was run by the worker, then again by the orchestrator, then again by
  you.
- A final report that names the branch, the commits, the gate output, and what was left
  undone — nothing said to be "verified" that nobody ran.
