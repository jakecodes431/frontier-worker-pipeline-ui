# Security

## What this is

Frontier + Worker Pipeline & UI is a single-user, local developer tool. It
**binds `127.0.0.1`, is unauthenticated, and must not be exposed** to any other
machine, reverse proxy, port forward or tunnel. Anyone who can reach the port
can spawn real processes with your user's privileges.

The server refuses non-loopback bind addresses and cross-origin HTTP/WebSocket
requests. Those checks reduce browser exposure; they do not authenticate users,
and there are no accounts, sessions or authorization.

## What it touches on your machine

- **Managed agents are real processes** started in directories you name. A git
  worktree isolates changed paths, not processes; it is not a sandbox. Permission
  modes are whatever the underlying agent CLI supports, passed through from
  `config/runtimes.json`.
- **Environment scrubbing.** Before a managed agent starts, every inherited
  variable whose name contains `KEY`, `TOKEN` or `SECRET` is removed, except the
  names listed in that runtime's `keepEnv`. The shipped config applies this to
  all three managed runtimes (`claude`, `codex`, `deepseek`) and keeps only each
  CLI's own authentication variables. The control room never reads the values it
  passes on.
- **It reads CLI transcripts** (Claude Code, Codex, DeepSeek Harness session
  files under your home directory) to compute usage and render chat. Those files
  contain your prompts and model replies. They are read locally and sent nowhere.
- **It writes state to `data/`** (SQLite database, staged briefs, terminal
  scrollback). Treat that directory as sensitive; it is gitignored. `CR_DATA_DIR`
  moves it.
- **No credentials are stored.** Sign in to each agent CLI yourself; the control
  room does not handle provider keys.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting on
<https://github.com/jakecodes431/frontier-worker-pipeline-ui/security/advisories/new>.
Include the version (`git describe` or the `version` in `package.json`), your
OS, Node version, and steps to reproduce. You should hear back within 14 days.

## Scope

In scope: anything that lets a request from another origin or host reach the
API, a spawned agent receive a credential it should not, or the server write
outside `CR_DATA_DIR` and the worktrees it creates.

Out of scope: what an agent CLI does once it is running with your privileges
(that is the CLI's own permission model), and exposure that results from
deliberately binding a non-loopback address or forwarding the port.

## Supported versions

Only the latest release on `main` receives fixes.
