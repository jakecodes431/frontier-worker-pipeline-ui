# Example orchestrator brief: add tags to an open-source web app

> This is a template. It is written against a made-up app, `notes-app`, so that every
> section is concrete. Swap the repo facts, the gate command and the feature for your own
> and the shape still works. Spawn it with:
>
> ```
> node bin/cr.js spawn --name "tags" --role orchestrator --runtime claude \
>   --repo /path/to/notes-app \
>   --task "Ship tag support in notes-app: create, assign, and filter by tag" \
>   --brief-file briefs/example-orchestrator.md
> ```

You are the orchestrator for one feature in `notes-app`. You plan it, split it into
bounded worker tasks, spawn workers, review their diffs, integrate their branches, and
report up. You implement the parts that need judgement yourself. You do not write
planning documents nobody asked for: the checkpoint below is the plan.

## The feature

Notes can be tagged. A user can add a tag to a note, remove it, see a note's tags, and
filter the note list by one tag. Tags are per-user, lowercase, and created implicitly the
first time they are used. No tag renaming, no colours, no tag management screen — those
are out of scope and stay out of scope unless a human says otherwise.

## Repo facts

- Your cwd is a worktree of `notes-app` on a `cr/` branch. Work there. Never edit the
  shared checkout the worktree came from.
- Node + Express API in `server/`, SQLite schema in `server/db/migrations/`, a small React
  UI in `ui/src/`, docs in `docs/`.
- Tests are `node --test`; there is one migration runner (`npm run migrate`) that applies
  everything in `server/db/migrations/` in filename order.
- The gate, judged by exit code only:
  ```
  npm run lint && npm test && npm run build
  ```
  Run `npm install` once in your worktree first if `node_modules` is missing.
- Conventions live in `CONTRIBUTING.md`. Read it before you write a line; workers will
  not read it for you, so anything that matters goes into their briefs.

## First checkpoint

Before you spawn anything: read the code, run the gate, and click through the running app.
Do this yourself — do not delegate the audit. Then report it with
`node $CR_BIN report "..."` in exactly this shape, and keep going without waiting for a
reply:

```
CURRENT STATE      how notes are stored and rendered today; what already exists that helps
DATA MODEL         the tables/columns you will add, and the migration filename
INTERFACES         the exact function signatures and route shapes other tasks will build on
FILE MAP           every file the feature touches, grouped by the worker that will own it
WORKER SPLIT       ordered rounds; which tasks run in parallel and which must wait
RISKS              what could break existing behaviour, and how the gate would catch it
```

`INTERFACES` is the load-bearing one. Decide the storage functions and route shapes
yourself and paste them verbatim into every worker brief that depends on them. That is
what lets the UI worker and the API worker run at the same time without talking.

## Fan-out rules

1. **File-disjoint or nothing.** Two workers never touch the same file, including test
   files, snapshots and generated output. If a file needs edits from two tasks, you make
   that edit yourself after both land.
2. **Rounds, not a free-for-all.** Anything that defines an interface goes in an earlier
   round than its consumers. Integrate and gate a round before starting the next.
3. **At most 3 workers at once.** More than that and reviewing becomes the bottleneck.
4. **Mechanical work goes to `--runtime deepseek`; taste goes to you.** Schema, routes
   against a signature you wrote, a component against a spec you wrote, docs, and test
   fixtures are worker work. Layout, copy, error semantics, and anything you would argue
   about in review, you do yourself (or on `--runtime claude --model claude-opus-5` if you
   need a second pair of hands).
5. **Every worker brief has the five sections**: goal, files in scope, what not to touch,
   the gate command, definition of done. A worker cannot ask you a question — it is
   one-shot — so a brief with an open question in it is a bug.
6. **A worker's claim is not a result.** Read the diff (`git -C <worktree> diff`) and run
   the gate yourself before you integrate.

Spawn with:

```
node $CR_BIN spawn --name "tags-api" --role worker --runtime deepseek \
  --repo /path/to/notes-app \
  --task "Add the tags routes and ?tag= filtering to the notes list" \
  --brief-file /path/to/tags-api-brief.md
```

Then `node $CR_BIN list` for status and cost, `node $CR_BIN wait <id...> --timeout 1800`
to block, `node $CR_BIN result <id>` for its final answer, `node $CR_BIN logs <id>` if it
went quiet or failed, and `node $CR_BIN inbox` for what your children reported. Each
worker exits into its own branch; you get an exit line in your inbox automatically.

A worked split for this feature:

- **Round 1** — `tags-storage`: the migration and `server/db/tags.js` against the
  signatures from your checkpoint, with `server/db/tags.test.js`.
- **Round 2, in parallel** — `tags-api` (`server/routes/tags.js`,
  `server/routes/index.js`, `server/routes/tags.test.js`), `tags-ui`
  (`ui/src/components/TagFilter.jsx`, `ui/src/pages/NotesList.jsx`,
  `ui/src/styles/tags.css`), `tags-docs` (`docs/api.md`, `docs/tags.md`).
- **Yours** — the interfaces, `README.md`, anything in `CONTRIBUTING.md`'s way, all
  integration, and the final report.

## Integration

Merge one worker branch at a time into your worktree (`git merge` or `git cherry-pick`),
run the gate after each, and fix small conflicts yourself rather than sending a worker
back into a file someone else has since changed. Commit in your worktree with a
WHAT / WHY / PROOF body. Do not push, do not deploy, do not add dependencies that were not
in the plan, do not touch CI config or release tooling.

## Reporting and blocking

Report at every checkpoint: after the audit, after each round is integrated and green, and
when you are done. Never go silent for a long stretch.

Use `node $CR_BIN status blocked --note "<question, the options, your recommendation>"`
only for a real fork — two defensible designs with different consequences, a fact only a
human has, or a scope or cost change. Keep the rest of the work moving while you wait.

## Definition of done

- `npm run lint && npm test && npm run build` exits 0 in your worktree.
- A note can be tagged, untagged, and the list filters by tag in the running app.
- New tests cover the storage layer, the routes, and the filter component.
- `docs/api.md` documents the new routes and `docs/tags.md` explains the model.
- No changes outside the file map, no new dependencies, no unrelated reformatting.
- Your branch is committed and clean, and your final report names the branch, the commit
  list, the gate output, and anything you deliberately left undone.
