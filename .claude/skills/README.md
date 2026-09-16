# Skills

Agent skills shipped with **Frontier + Worker Pipeline & UI**. Claude Code picks
a skill up automatically from its `description` when it is relevant; you can
also ask for one by name. Everything here is plain Markdown — read them directly
if you just want the rules.

Nothing in this directory is required to run the control room. Delete what you
do not want.

## Project skills

| Skill | What it covers |
|---|---|
| [`cr-workflow`](cr-workflow/SKILL.md) | How to run work through this tool as a CTO or orchestrator: plan, prove the gate command before dispatch, split into file-disjoint worker briefs, spawn with `bin/cr.js`, review each worker diff in its own worktree, integrate one branch at a time, report, and escalate a real fork. Includes the git and verification rules every writer here follows, a worker-brief template, and an orchestrator checklist. |
| [`grafana-dashboards`](grafana-dashboards/SKILL.md) | Operator-dashboard design distilled from the Grafana source: the 24-column grid, which panel type answers which question, threshold and colour semantics, units and number formatting, and the sparkline-in-stat pattern. Read it before adding a panel to the UI. Long tables live in [`reference.md`](grafana-dashboards/reference.md). |

The matching subagent definition is [`../agents/cr-orchestrator.md`](../agents/cr-orchestrator.md).

## Ported development-lifecycle skills

`superpowers/SKILL.md` is the index: it maps a situation ("let's build X",
"here's the spec", "this test fails") to the skill that handles it and states
the three non-negotiable gates — approval, evidence, integration.

| Skill | Use when |
|---|---|
| [`superpowers`](superpowers/SKILL.md) | Start of any non-trivial change — the map of the set and the order to use it in |
| [`superpowers-using-superpowers`](superpowers-using-superpowers/SKILL.md) | You are not sure whether a skill applies |
| [`superpowers-brainstorming`](superpowers-brainstorming/SKILL.md) | Before any creative work — explore intent and design, get approval |
| [`superpowers-writing-plans`](superpowers-writing-plans/SKILL.md) | You have a spec for a multi-step task, before touching code |
| [`superpowers-executing-plans`](superpowers-executing-plans/SKILL.md) | Executing a written plan in a separate session with checkpoints |
| [`superpowers-subagent-driven-development`](superpowers-subagent-driven-development/SKILL.md) | Executing a plan's independent tasks in the current session |
| [`superpowers-dispatching-parallel-agents`](superpowers-dispatching-parallel-agents/SKILL.md) | 2+ independent tasks with no shared state — and when not to |
| [`superpowers-test-driven-development`](superpowers-test-driven-development/SKILL.md) | Implementing any feature or bugfix, before writing implementation code |
| [`superpowers-systematic-debugging`](superpowers-systematic-debugging/SKILL.md) | Any bug, test failure, or surprise — before proposing a fix |
| [`superpowers-verification-before-completion`](superpowers-verification-before-completion/SKILL.md) | About to claim something passes — evidence before assertions |
| [`superpowers-requesting-code-review`](superpowers-requesting-code-review/SKILL.md) | Finishing a feature or before merging |
| [`superpowers-receiving-code-review`](superpowers-receiving-code-review/SKILL.md) | Acting on review feedback without performative agreement |
| [`superpowers-using-git-worktrees`](superpowers-using-git-worktrees/SKILL.md) | Feature work that needs an isolated workspace |
| [`superpowers-finishing-a-development-branch`](superpowers-finishing-a-development-branch/SKILL.md) | Tests are green and the work needs integrating |
| [`superpowers-writing-skills`](superpowers-writing-skills/SKILL.md) | Creating or editing a skill, and testing it before you rely on it |

## Where these came from

- The `superpowers-*` skills and the `superpowers` index are ported from the
  **superpowers** skill collection by Jesse Vincent
  ([github.com/obra/superpowers](https://github.com/obra/superpowers)), MIT
  licensed. Each ported skill keeps its upstream `LICENSE` file next to its
  `SKILL.md`; cross-references were rewritten to the flat `superpowers-*` names
  used here, and the index adds a short map of the set. Do not strip those
  licence files.
- `grafana-dashboards` is written for this repo. Its numbers and tokens are
  copied from the Grafana source
  ([github.com/grafana/grafana](https://github.com/grafana/grafana), AGPL-3.0);
  every value cites the upstream file it came from so you can check it. No
  Grafana code is vendored here.
- `cr-workflow` and `agents/cr-orchestrator.md` are written for this repo and
  describe its own CLI (`bin/cr.js`) and protocol (`config/protocol.md`).
