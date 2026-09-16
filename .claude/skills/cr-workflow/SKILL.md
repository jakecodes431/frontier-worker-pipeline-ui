---
name: cr-workflow
description: Use when running work through the control room as a CTO or orchestrator - planning with the operator, splitting a plan into file-disjoint worker briefs, spawning workers with `node bin/cr.js spawn --repo ... --brief-file ...`, proving the gate command before dispatch, reviewing worker diffs in their worktrees, integrating one branch at a time, reporting with `cr report`, escalating a real fork with `cr status blocked --note`, and finishing the branch. Also use when writing a worker brief or when asked to delegate, fan out, or orchestrate here.
---

# Control room workflow

The control room runs a shallow hierarchy: **frontier CTO → frontier
orchestrators → cheap workers** (DeepSeek Harness by default), each a real CLI
process in its own PTY, each writer in its own git worktree. See `README.md`,
`docs/API.md`, and `config/protocol.md` (which is prepended to every spawned
agent's brief).

This skill composes the `superpowers` lifecycle with those mechanics. Read
`superpowers/SKILL.md` for the lifecycle map; read the individual
`superpowers-*` skills at the steps below.

**Authority:** where this skill and a superpowers skill differ, this one wins.
It is stricter, and every rule in it is a failure that has already happened to
someone running agents this way.

Throughout, **the operator** is the human this session reports to. If you are an
orchestrator, your operator is your parent agent's inbox.

---

## The loop

```
1  Brainstorm with the operator   superpowers-brainstorming   (HARD GATE: approval)
2  Write the plan                 superpowers-writing-plans
3  Prove the gate command         plant a failure, watch it refuse, revert
4  Split into file-disjoint briefs
5  Spawn workers                  node bin/cr.js spawn --repo … --brief-file …
6  Review each diff yourself      git -C <worktree> diff
7  Integrate one branch at a time, run the gate after EACH
8  Report at every checkpoint     node bin/cr.js report "…"
9  Finish                         superpowers-finishing-a-development-branch
                                  node bin/cr.js report "…" && node bin/cr.js status done
```

Real forks go up as `cr status blocked --note "<question, options, your
recommendation>"` — and you keep other work moving while you wait.

All `node bin/cr.js …` commands below assume you are in the control-room repo.
Spawned agents have `CR_BIN` in their environment and can use
`node "$CR_BIN" …` (PowerShell: `node "$env:CR_BIN" …`) from anywhere.

---

## 1. Brainstorm with the operator

Read `superpowers-brainstorming`. Classify the request out loud (Spike /
Bounded / Architectural), ask the questions that matter, present the design, and
**stop until the operator says yes**. A control-room dispatch is an
implementation action: do not spawn anything before approval.

If you are an orchestrator, a design you were briefed on is already approved —
but do the audit yourself (never delegate the audit) and report it with
`cr report` before building. Send scope questions up to your parent.

## 2. Write the plan

Read `superpowers-writing-plans`. The plan's **File Structure** section is what
makes the rest of this work: it is where you decide the disjoint file sets that
become worker briefs. If two tasks touch one file, they are one task or they are
sequential — never two concurrent workers.

## 3. Prove the gate command before you dispatch

The gate is the repo's proof command — `npm test`, or a chain like
`npm run build && npm test`. It is the only thing that makes a worker's claim
checkable. Before you rely on it:

```
plant a failure  ->  run the gate  ->  confirm it exits non-zero  ->  revert the plant
```

A guard nobody has seen fail is a guard nobody has tested. Check `git diff` after
an interrupted gate run — a programmatic kill may run no signal handler (this is
normal on Windows), so a plant can leak and later look like a real defect.

Put the exact gate command, verbatim, in every brief.

## 4. Split into file-disjoint briefs

| Route to | When |
|---|---|
| **A cheap worker** (`--runtime deepseek`, the default) | Mechanical and fully specified: pages from a spec you wrote, content, metadata, a change confined to one file, CSS token work, migrations, bulk edits, tests from a named list |
| **A frontier worker** (`--runtime claude --model claude-opus-5`) | Taste: user-facing copy, design judgment, API shape, anything where the brief would have to describe the answer to be precise |
| **Yourself** | Audits, integration, the final review, and any decision you would have had to explain twice |

Cap concurrency at 3 cheap workers unless told otherwise. Workers see their
brief plus the repo's `CLAUDE.md` — nothing else. Anything you know that they
need goes in the brief.

## 5. Spawn

```bash
node bin/cr.js spawn \
  --name "nav-simplify" \
  --role worker \
  --runtime deepseek \
  --repo ../example-app \
  --task "one line: simplify the top nav to the six approved routes" \
  --brief-file ./briefs/nav-simplify.md
```

- `--repo` creates the worker a fresh worktree at `<repo>/.worktrees/<name>-<stamp>`
  on branch `cr/<name>-<stamp>`. Add `--base <ref>` to branch from something other
  than the default, `--branch <name>` to name it yourself.
- `--runtime claude --model claude-opus-5 [--effort high]` for a taste worker.
- `--wait [--timeout 1800]` blocks and prints the result; usually better to spawn
  several and `wait` on the set.
- The command prints the child id on stdout. Keep it.

Watching them:

```bash
node bin/cr.js list                 # your children, status, tokens, cost
node bin/cr.js tree                 # the whole hierarchy
node bin/cr.js wait <id...> [--timeout 1800]
node bin/cr.js result <id>          # final answer / last assistant message
node bin/cr.js logs <id> [--tail 4000]
node bin/cr.js agent <id>           # JSON, including worktree.path and worktree.branch
node bin/cr.js send <id> "text"     # type into its real CLI (refused if a human holds control)
node bin/cr.js inbox                # reports your children sent you
```

## 6. Review the diff yourself

**A worker's claim is not a result.** For each finished worker:

```bash
W=$(node bin/cr.js agent <id> | python -c "import json,sys;print(json.load(sys.stdin)['agent']['worktree']['path'])")
git -C "$W" status
git -C "$W" diff <base>...HEAD
git -C "$W" log --oneline <base>..HEAD
```

Read every hunk. Then run the gate **in that worktree yourself** before you
believe anything. Reject on: files outside the brief's scope, a line-number fix
inside a generated file (find the source), a check that "returned" without
asserting the change landed, or a green run whose command you did not see.

Worker runtimes are sandboxed and may not be able to write the repo's `.git`. If
a worker left its work uncommitted, you commit it in its worktree after you have
read the diff — under the staging rules below.

## 7. Integrate one branch at a time

In **your own** worktree, never the shared checkout:

```bash
git -C <your-worktree> merge --no-ff cr/<worker-branch>
# run the FULL gate command here, read the exit code
# only then merge the next one
```

Re-measure at merge time, not only at branch time: a suite that passed at the
worker's branch point is evidence about a tree nobody is going to merge. If an
unrelated change landed in a file the worker edited, rebase and re-run the whole
gate against the rebased tree.

On conflicts in generated files, **regenerate** — do not take ours or theirs.

## 8. Report at every checkpoint

```bash
node bin/cr.js report "INTEGRATED nav-simplify (cr/nav-simplify-…, 3 commits). Gate: exit 0. Next: blog templates."
```

After the audit, after each integration, and when done. Never go silent for long
stretches. Reports are what the parent's `inbox` and the UI show.

## 9. Escalate real forks, do not stall

```bash
node bin/cr.js status blocked --note "Two defensible route maps. (A) guides and reference as top-level sections — clearer, 7 nav items. (B) both under /docs — 5 nav items, one extra click. I recommend A. Which?"
```

`blocked` is for a **real** fork only: two defensible designs with different
consequences, a fact only the operator has, or a scope/cost change. Everything
else you decide yourself and record the decision in your report. Keep other work
moving while blocked.

## 10. Finish

Read `superpowers-verification-before-completion`, then
`superpowers-finishing-a-development-branch`. Then:

```bash
node bin/cr.js report "<what changed, what was verified with what output, what is left>"
node bin/cr.js status done
```

Do not push, deploy, spend money beyond the configured model usage, or handle
credentials. The operator and the CTO decide deployment.

---

## Git rules that apply to every writer here

- **Worktree per writer.** Never commit where you stand in a shared checkout. A
  branch left checked out there collects every lane's commits and its name stops
  describing its contents. `--repo` already gives workers one; make yourself one
  too.
- **The worktree holding the default branch is a merge target only.** Nobody
  edits in it.
- **Never `git add -A`, `git add <dir>`, or `commit -a`.**
- **Per-path staging is not sufficient.** `git add <file>` stages the *whole
  file*, including hunks another session left uncommitted in it. Before staging,
  run `git diff -- <file>` and confirm every hunk is yours. If it is not, stage
  only yours:
  ```bash
  git add -p -- <file>                 # interactive: answer y/n per hunk
  # non-interactive fallback:
  git diff -- <file> > mine.patch      # delete the hunks that are not yours
  git apply --cached mine.patch
  ```
  If you cannot tell which hunks are yours, do not stage the file — say so in
  your report and leave it to whoever owns it.
- **`git add` → `git commit` is not atomic here.** Check `git diff --cached --stat`
  immediately before committing.
- **Never `git checkout` / `clean` / `stash` a path you do not own.**
- **A push reporting "everything up-to-date" right after you committed** means
  you are not on the branch you think you are.
- **Commit bodies carry WHAT / WHY / PROOF:**
  ```
  <subject: imperative, <=72 chars>

  WHAT:  the change, in the terms of the files it touches
  WHY:   the reason, or the brief/plan line it satisfies
  PROOF: the exact command run and its result, e.g.
         `npm run build && npm test` -> exit 0
  ```

## Verification rules that apply to every claim here

- A check that returned is not a check that answered. **Assert the change
  landed**, never that the command ran.
- `$?` after a pipeline reports the last command's exit. Read `${PIPESTATUS[0]}`
  or do not pipe the thing whose exit code you are about to believe.
- A grep piped through `head` truncates silently; a NUL byte makes a file get
  skipped as binary with no warning.
- A line number in a **generated** file is not a location. Find and fix the
  source; name it in the report.
- Re-read the evidence hardest when the result is the one you wanted.
- "I could not check this from here" is a fact to report, not a gap to reason
  across.

---

## Worker brief template

Save to a file and pass it with `--brief-file`. `config/protocol.md` is prepended
automatically, so do not repeat the CLI docs.

````markdown
# <worker name>

## Goal
<One paragraph. What must be true when you are done. Written so someone who has
never seen this repo could tell whether it happened.>

## Files in scope
- path/to/a.ts          <what changes in it>
- path/to/b.css         <what changes in it>

## Do not touch
- everything else in the repo, including <the files another worker holds right now>
- generated output: <list>. Change the generator, never the built file.

## Context you need
<Facts the worker cannot discover cheaply: conventions, the repo trap list, the
exact tokens/copy/route names to use, what "done well" looks like here. Paste the
values verbatim — do not point at a document the worker cannot read.>

## Gate command (judged by exit code only)
```
<the exact command chain>
```
Run `npm install` first if node_modules is missing. The gate may print warnings
on success; only the exit code counts.

## Definition of done
- [ ] <observable thing 1>
- [ ] <observable thing 2>
- [ ] gate exits 0
- [ ] worktree is committed and clean, commit bodies carry WHAT/WHY/PROOF
- [ ] you reported the branch name, the commit list, and the gate output

## Rules
- Work only in your worktree. Never `git add -A`; stage only your own hunks.
- Do not push, deploy, or touch credentials.
- If you hit a real fork, `cr status blocked --note "<question + options + your
  recommendation>"` and keep other work moving.
- Report with `cr report` at your midpoint and when you finish, then
  `cr status done`.
````

---

## Orchestrator checklist

Copy this into your todos.

**Before dispatch**
- [ ] Design classified and approved (`superpowers-brainstorming`), or the brief I was given is the approval
- [ ] I did the audit myself — read the code, built it, looked at the output
- [ ] Plan written with a file map (`superpowers-writing-plans`)
- [ ] Gate command **proved**: plant → refuse → revert; tree clean afterwards
- [ ] Tasks are file-disjoint; no file appears in two concurrent briefs
- [ ] Each brief has: goal, files in scope, do-not-touch, context, exact gate, definition of done
- [ ] Routing decided per task (cheap worker / frontier worker / me), ≤3 cheap workers at once
- [ ] I am in my own worktree, not the shared checkout

**Per worker**
- [ ] Spawned with `--repo` and `--brief-file`; child id recorded
- [ ] On finish: read the full diff in its worktree
- [ ] Ran the gate in its worktree myself and read the exit code
- [ ] Nothing outside scope; no edits to generated artifacts
- [ ] Merged into my worktree alone, then ran the full gate again
- [ ] Reported the integration with `cr report`

**Before done**
- [ ] Full gate green in my worktree, from a run I did in this message
- [ ] Every definition-of-done item observably true, not assumed
- [ ] Worktree committed and clean; `git status` read
- [ ] `superpowers-finishing-a-development-branch` followed
- [ ] `cr report` names what changed, what was verified with what output, what is left
- [ ] `cr status done`

---

## Sources

In this repo:

- `README.md` — what the control room is and how to run it
- `docs/API.md` — HTTP and WebSocket surface
- `config/protocol.md` — the text prepended to every spawned agent's brief
- `config/runtimes.json` — how each CLI is invoked
- `bin/cr.js` — the CLI and its flag list

Upstream: the `superpowers-*` skills next to this one are ported from
`github.com/obra/superpowers` and keep their `LICENSE` files.
