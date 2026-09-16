import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// git diff --no-index needs the platform's null device; NUL only exists on Windows.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}

export function isRepo(dir) {
  try { git(dir, ['rev-parse', '--is-inside-work-tree']); return true; } catch { return false; }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

/** Create an isolated worktree for an agent. Returns { repo, branch, path, base }. */
export function createWorktree(repo, name, branch, base) {
  repo = path.resolve(repo);
  if (!isRepo(repo)) throw new Error(`${repo} is not a git repository`);
  const wtDir = path.join(repo, config.worktreeDir || '.worktrees');
  fs.mkdirSync(wtDir, { recursive: true });
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
  const leaf = `${slug(name)}-${stamp}`;
  const wtPath = path.join(wtDir, leaf);
  branch = branch || `${config.worktreeBranchPrefix || 'cr/'}${leaf}`;
  if (!base) {
    try { git(repo, ['rev-parse', '--verify', '--quiet', 'main']); base = 'main'; } catch { base = 'HEAD'; }
  }
  git(repo, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { repo, branch, path: wtPath, base };
}

export function diff(dir) {
  if (!isRepo(dir)) return { diff: '', stat: `${dir} is not a git repository` };
  let stat = '', d = '';
  try { stat = git(dir, ['status', '--short', '--branch']); } catch (e) { stat = String(e.message); }
  try {
    // Committed-on-branch + working tree, relative to the branch's merge base with main when possible.
    let base = null;
    try { base = git(dir, ['merge-base', 'HEAD', 'main']).trim(); } catch { /* no main */ }
    d = base ? git(dir, ['diff', base]) : git(dir, ['diff', 'HEAD']);
    const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
    for (const f of untracked.slice(0, 50)) {
      try { d += git(dir, ['diff', '--no-index', '--', NULL_DEVICE, f]); } catch (e) { if (e.stdout) d += e.stdout; }
    }
  } catch (e) { d = String(e.stdout || e.message); }
  return { diff: d, stat };
}

export function files(dir) {
  if (!fs.existsSync(dir)) return { changed: [], tree: [] };
  const changed = [];
  if (isRepo(dir)) {
    try {
      for (const line of git(dir, ['status', '--porcelain']).split(/\r?\n/)) {
        if (!line.trim()) continue;
        changed.push({ status: line.slice(0, 2).trim() || '??', path: line.slice(3).trim() });
      }
      let base = null;
      try { base = git(dir, ['merge-base', 'HEAD', 'main']).trim(); } catch { /* ignore */ }
      if (base) {
        for (const f of git(dir, ['diff', '--name-status', base]).split(/\r?\n/)) {
          if (!f.trim()) continue;
          const [st, p] = f.split(/\t/);
          if (!changed.find(c => c.path === p)) changed.push({ status: `${st} (committed)`, path: p });
        }
      }
    } catch { /* ignore */ }
  }
  const tree = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.worktrees', '.next', 'build']);
  const walk = (d, rel, depth) => {
    if (depth > 6 || tree.length > 3000) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else { let size = 0; try { size = fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ } tree.push({ path: r, size }); }
    }
  };
  walk(dir, '', 0);
  return { changed, tree };
}

export function readFile(dir, rel) {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir))) throw new Error('path escapes agent directory');
  const st = fs.statSync(abs);
  if (st.size > 2 * 1024 * 1024) return { path: rel, content: `(file is ${st.size} bytes; too large to display)` };
  return { path: rel, content: fs.readFileSync(abs, 'utf8') };
}

export function commitLog(dir, n = 20) {
  try { return git(dir, ['log', '--oneline', `-${n}`]); } catch { return ''; }
}

export function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } resolve(); }
  });
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
