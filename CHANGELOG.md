# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-16

First public release: a local control room that runs a shallow hierarchy of
coding agents (frontier CTO and orchestrators on Claude Code or OpenAI Codex,
optional DeepSeek workers) as real CLI processes in real pseudo-terminals.

### Added
- Native Claude Code and OpenAI Codex runtimes for the CTO and orchestrator tiers, interchangeable, with `cr handoff` to move a role between them.
- Optional headless DeepSeek Harness worker runtime; one task, one worktree, then exit.
- External registration (`cr register`) for a session the control room did not start: tracked by session id, messages queued to its inbox.
- Dashboard, Hierarchy board, and per-agent Chat / Terminal / Diff / Files / Logs tabs, all vanilla ES modules with no build step.
- Cost tracking from local CLI transcripts against an editable price sheet (`config/pricing.json`); every row is flagged `estimated`, unknown models are shown as unpriced rather than free.
- Observed account limits from Codex rollouts, Claude plan usage via a status-line hook, and a daily DeepSeek budget as a tracking aid.
- Queued delivery of local messages to one-shot workers, and a stop action on the hierarchy board.
- Remove action on the agent right-click menu.
- Windows folder picker for the New-agent form.
- History import script (`scripts/import-history.mjs`) for merging a previous data directory.
- `--add-dir` staging so managed Claude sessions can read their brief without a permission prompt.
- An offline gate (`npm run check`): the smoke test plus focused suites, none of which spawn a CLI or spend tokens.
- `.env.example`, `CONTRIBUTING.md`, `docs/API.md`, `docs/TROUBLESHOOTING.md`, `SECURITY.md`, `LICENSE` (MIT) and `NOTICE` (third-party credits).

### Changed
- Spend windows are priced from banked tokens at read time rather than from stored cost deltas.
- The Codex `gpt-reserve` fallback is priced with an explicitly inferred row; deliberate transcript markers are reported separately from unpriced models.
- Provider continuation defaults and price-estimate labels were corrected so estimates are never presented as invoices.
- Hub branding removed; agent controls refined; first-run and empty states for every view.
- `docs/API.md` UsageSummary section regenerated from the live `/api/usage` shape.

### Fixed
- A Claude transcript is found by session id when the working-directory slug misses.
- Credential-looking environment variables (`KEY`, `TOKEN`, `SECRET` in the name) are scrubbed from `claude` and `codex` spawns by default, not only from `deepseek` workers.
- Private provenance scrubbed; portability and licence fixes.

### Security
- Binds `127.0.0.1` only, refuses non-loopback binds and cross-origin requests, and has no authentication. Do not expose the port. See `SECURITY.md`.

[1.0.0]: https://github.com/jakecodes431/frontier-worker-pipeline-ui/releases/tag/v1.0.0
