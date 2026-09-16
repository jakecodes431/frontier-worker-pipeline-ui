---
name: superpowers
description: Use at the start of any non-trivial development work in this repo - the map of the ported superpowers skills and the order to use them. Routes "let's build X" to brainstorming, "here's the spec" to writing-plans, "execute the plan" to subagent-driven-development, "is it done?" to verification-before-completion, and "ship it" to finishing-a-development-branch. Read this when you are unsure which superpowers-* skill applies.
---

# Superpowers (ported into this project)

The fourteen skills from [obra/superpowers](https://github.com/obra/superpowers)
are vendored here as native project skills so Claude Code loads them without a
plugin. This file is the map; the real content lives in the `superpowers-*`
folders next to it.

**Naming:** upstream writes `superpowers:brainstorming`. Here the skill is
`superpowers-brainstorming`, in `.claude/skills/superpowers-brainstorming/`. All
cross-references inside the ported skills were rewritten to match.

**License:** MIT, Copyright (c) 2025 Jesse Vincent. Each ported folder carries a
`LICENSE` copy.

**Control room:** for how this lifecycle maps onto CTO → orchestrator → worker
dispatch in this repo (`node bin/cr.js spawn/report/status/wait`, worktrees,
proof commands, briefs), read `cr-workflow` — it composes these skills with this
repo's mechanics. Use `cr-workflow` instead of `superpowers-dispatching-parallel-agents`
when the parallel units are control-room agents rather than in-session subagents.

## The lifecycle

```
idea
 └─> superpowers-brainstorming          design + human approval (HARD GATE)
      └─> superpowers-writing-plans     spec -> bite-sized tasks with tests
           └─> superpowers-using-git-worktrees      isolated workspace
                └─> superpowers-subagent-driven-development
                    |    fresh subagent per task, review after each
                    |    (fallback: superpowers-executing-plans, no subagents)
                    └─> superpowers-test-driven-development   inside each task
                    └─> superpowers-requesting-code-review    after each task
                    └─> superpowers-receiving-code-review     how to answer it
                         └─> superpowers-verification-before-completion
                              └─> superpowers-finishing-a-development-branch
```

Two skills sit off the main line and are invoked on symptom, not on phase:

- `superpowers-systematic-debugging` — any bug, test failure, or unexpected
  behavior, **before** proposing a fix.
- `superpowers-dispatching-parallel-agents` — 2+ genuinely independent problems
  with no shared state.

And two are meta:

- `superpowers-using-superpowers` — the discipline of invoking a skill before
  responding, and the rationalization table that stops you skipping one.
- `superpowers-writing-skills` — creating or editing skills (including these).

## Which skill at which step

| You are here | Read | It gives you |
|---|---|---|
| "Let's build X", "add a feature", "change how Y works" | `superpowers-brainstorming` | Spike / Bounded / Architectural classification, then a design you must get approved before writing any code |
| You have an approved spec for a multi-step change | `superpowers-writing-plans` | Plan doc with a Global Constraints header, file structure, and 2-5 minute steps; saved under `docs/superpowers/plans/YYYY-MM-DD-<name>.md` |
| About to start implementing | `superpowers-using-git-worktrees` | Detect existing isolation first (`git rev-parse --git-dir` vs `--git-common-dir`), then create one; never nest worktrees |
| Executing a plan in this session with subagents | `superpowers-subagent-driven-development` | One fresh implementer per task, task review (spec + quality) after each, broad final review, a ledger, and the rule that you make rulings rather than stalling |
| Executing a plan with no subagents available | `superpowers-executing-plans` | The simpler sequential loop, and when to stop and ask |
| Writing the code inside a task | `superpowers-test-driven-development` | RED-GREEN-REFACTOR; the failing test comes first and you watch it fail |
| Task done, want it checked | `superpowers-requesting-code-review` | The `code-reviewer.md` template, BASE_SHA/HEAD_SHA, and severity triage |
| Someone reviewed you | `superpowers-receiving-code-review` | How to verify a finding instead of performatively agreeing or blindly implementing |
| A bug, a red test, something surprising | `superpowers-systematic-debugging` | Root-cause discipline before any fix; the four phases |
| About to say "done", "fixed", "passing" | `superpowers-verification-before-completion` | The Iron Law: no completion claim without fresh evidence from a command you ran in this message |
| Green suite, ready to integrate | `superpowers-finishing-a-development-branch` | Environment detection, merge/PR/leave menu, and worktree cleanup |
| 2+ independent problems | `superpowers-dispatching-parallel-agents` | One agent per problem domain; when NOT to (shared state, related failures) |
| Writing or editing a skill | `superpowers-writing-skills` | Frontmatter rules, token budgets, REQUIRED SUB-SKILL wording, subagent testing |
| Not sure a skill applies | `superpowers-using-superpowers` | "If there is a 1% chance a skill applies, invoke it", plus the red-flag table |

## The three gates that are not negotiable

1. **Approval gate** (`superpowers-brainstorming`) — no implementation action
   until the human says yes to your stated intent. The artifact scales with
   simplicity; the approval never does.
2. **Evidence gate** (`superpowers-verification-before-completion`) — you may not
   claim a thing passes unless you ran the command in this message and read the
   output. `.claude/skills/cr-workflow/SKILL.md` states the same rule in a
   stricter form for this repo: prove a gate can fail before you trust it, and
   assert that the change landed rather than that the command ran.
3. **Integration gate** (`superpowers-finishing-a-development-branch`) — a green
   full suite before the merge menu, not after.

## Anti-patterns this set exists to stop

| Thought | What the skills say |
|---|---|
| "It's simple, I'll just write it" | Brainstorming's approval gate applies to every path, including two-sentence designs. |
| "I'll plan while I code" | The plan is written before touching code, from the approved spec. |
| "The subagent said it passed" | A worker's claim is not a result. You run the proof yourself. |
| "Tests passed earlier" | Fresh evidence, in this message, or no claim. |
| "I'll fix the bug I can see" | Systematic debugging first; the visible symptom is rarely the root cause. |
| "I'll ask the human about this conflict" | While a plan is running, make a ruling, record it, keep going. Only irreversible/destructive/security/outside-worktree actions stop you. |

## Sources

Ported (with cross-reference paths rewritten to the `superpowers-*` skill names
used here) from the upstream `superpowers` skill collection by Jesse Vincent,
`github.com/obra/superpowers`, at the commit checked out when they were copied.
Each ported skill keeps its upstream `LICENSE` file next to its `SKILL.md`.
