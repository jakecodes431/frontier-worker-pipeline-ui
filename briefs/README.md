# Briefs

A **brief** is one agent's complete instructions: everything it needs to do its job
without asking a follow-up question. Orchestrators get a brief; workers get a brief.
You write it as a plain Markdown file and hand it to the spawn command:

```
node bin/cr.js spawn --name "tags-api" --role worker --runtime deepseek \
  --repo /path/to/notes-app \
  --task "Add GET /api/notes?tag= filtering and the /api/tags routes" \
  --brief-file briefs/example-worker.md
```

(PowerShell: put it on one line, or use a backtick instead of `\` at line ends.)

For a native frontier session, use `--runtime claude` or `--runtime codex`; the
`deepseek` worker tier is optional. Frontier sessions are interactive and are
where orchestration and review belong.

Files in this folder are examples you can copy. Real briefs are usually written on
the fly by whoever is spawning the agent — an orchestrator writes its workers' briefs
into a scratch file and passes `--brief-file`.

## What the agent actually receives

The server composes the final prompt, in this order:

1. `config/protocol.md`, with `{id}`, `{role}`, `{parentId}` and `{crBin}` filled in —
   this is how the agent learns the `cr` commands and the reporting rules.
2. `# Task` followed by your `--task` one-liner.
3. Your brief file, verbatim.

The whole thing is written to `data/briefs/<agentId>.md`. If it is shorter than
`briefArgvLimit` in `config/runtimes.json` (6000 characters by default) it is passed
to the CLI as the prompt argument; if it is longer, the CLI is started with a short
prompt telling it to read that staged file and carry it out. So a long brief works
fine, but it has to be self-contained on disk — do not rely on anything you typed
into a chat window somewhere else.

Because the protocol is prepended for you, **do not repeat the `cr` command reference
in your brief**. Write only the task-specific part.

## The five things every brief must contain

| Section | Why |
| --- | --- |
| **Goal** | One paragraph. What will be true when this is finished, in user-visible terms. |
| **Files in scope** | Exact paths, repo-relative. The agent may create/edit these and nothing else. |
| **What not to touch** | Named files, directories, and activities (deploys, deps, formatting churn). |
| **Gate command** | One command line, judged by exit code only. The agent runs it; the reviewer re-runs it. |
| **Definition of done** | A checklist someone else can verify without trusting the agent's summary. |

An orchestrator brief adds two more: the **checkpoint format** it must report back, and
the **fan-out rules** it must obey when it spawns workers.

## Why briefs have to be this strict

- A worker runs in its **own git worktree** (`<repo>/.worktrees/<name>-<stamp>` on branch
  `cr/<name>-<stamp>`). It is created from a committed base, so uncommitted changes in
  the shared checkout are not copied into it. It cannot see other agents' work in
  progress, so "coordinate with the other agent" is not a thing it can do.
- A worktree isolates changed paths, not processes: it is **not** a security sandbox.
- A DeepSeek worker is **one-shot**: it gets the prompt, works, and exits. It cannot ask
  you a question. Every decision it would otherwise have to make must already be in the
  brief, or it will invent one.
- **Never put two agents in the same file.** Merges are the orchestrator's job and a
  file-level split is what keeps them trivial. If two tasks need the same file, either
  sequence them or keep that file for yourself.
- The gate command is the only claim that counts. A worker saying "all tests pass" is not
  evidence; the orchestrator re-runs the gate in its own worktree after integrating.

## Writing commands inside a brief

Every spawned terminal has `CR_AGENT_ID`, `CR_URL` and `CR_BIN` set, so a brief can
refer to the CLI portably:

```
node $CR_BIN report "gate green on tags-api; merged"     # bash / zsh
node $env:CR_BIN report "gate green on tags-api; merged" # PowerShell
```

Use repo-relative paths for everything inside the repo. If you must name a path outside
it, remember the agent's cwd is the worktree, not the repo root.

## Status and reporting, in one paragraph

An orchestrator (a native `claude` or `codex` session) ends its own life with
`node $CR_BIN status done --note "..."`, and uses `blocked` only for a genuine fork that
needs a human decision, with the exact question in the note. A one-shot worker does
**not** need to set a status: the server marks it `done` on exit code 0 and `failed`
otherwise, captures its last message as the result (`cr result <id>`), and posts an exit
line to its parent's inbox automatically. A worker should still send one
`node $CR_BIN report "..."` line at the end, because that is what the orchestrator reads
first.

If a frontier session is close to its provider limit, it should report that instead of
going quiet. Handing the role to the other native runtime
(`cr handoff <id> --runtime codex|claude`) is a manual action taken by whoever spawned
it; the successor receives the recovered task, this brief and the report log as context,
not the vendor's conversation or any quota.

## House rules for brief files

- No secrets, tokens, or credentials — briefs are checked into git and staged to disk.
- No absolute paths that only exist on your machine, if the brief is meant to be reused.
- One brief, one agent. If a brief needs a "meanwhile, the other worker..." sentence,
  it is two briefs.

## The examples here

- [`example-orchestrator.md`](example-orchestrator.md) — a frontier orchestrator adding a
  feature to an open-source web app: checkpoint format, fan-out rules, integration order.
- [`example-worker.md`](example-worker.md) — one bounded worker from that fan-out, with a
  single proof command.
- [`../examples/README.md`](../examples/README.md) — the same job run end to end from a
  terminal, command by command.
