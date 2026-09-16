/**
 * PTY manager: one real pseudo-terminal per spawned agent. Output is fanned out
 * to attached websockets and appended to data/scrollback/<id>.log so a restart
 * of the control room keeps the terminal history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as nodePty from '@lydell/node-pty';
import { SCROLLBACK_DIR } from './config.js';

const SCROLLBACK_BYTES = 200 * 1024;

export class PtyManager extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map(); // id -> { pty, lastOutputAt, cols, rows, stream }
  }

  spawn(id, { command, args, cwd, env, cols = 120, rows = 36 }) {
    if (this.procs.has(id)) throw new Error(`agent ${id} already has a pty`);
    const p = nodePty.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true });
    const logPath = path.join(SCROLLBACK_DIR, `${id}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const rec = { pty: p, lastOutputAt: Date.now(), cols, rows, stream, logPath };
    this.procs.set(id, rec);
    p.onData(data => {
      rec.lastOutputAt = Date.now();
      stream.write(data);
      this.emit('data', id, data);
    });
    p.onExit(({ exitCode, signal }) => {
      stream.end();
      this.procs.delete(id);
      this.emit('exit', id, { exitCode, signal });
    });
    return { pid: p.pid, logPath };
  }

  has(id) { return this.procs.has(id); }
  pid(id) { return this.procs.get(id)?.pty.pid ?? null; }
  lastOutputAt(id) { return this.procs.get(id)?.lastOutputAt ?? null; }

  write(id, data) {
    const r = this.procs.get(id);
    if (!r) throw new Error(`agent ${id} has no live terminal`);
    r.pty.write(data);
  }

  resize(id, cols, rows) {
    const r = this.procs.get(id);
    if (!r || !cols || !rows) return;
    if (r.cols === cols && r.rows === rows) return;
    r.cols = cols; r.rows = rows;
    try { r.pty.resize(cols, rows); } catch { /* process may be exiting */ }
  }

  kill(id) {
    const r = this.procs.get(id);
    if (!r) return false;
    try { r.pty.kill(); } catch { /* already gone */ }
    return true;
  }

  scrollback(id) {
    const file = path.join(SCROLLBACK_DIR, `${id}.log`);
    if (!fs.existsSync(file)) return '';
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, SCROLLBACK_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  killAll() {
    for (const id of [...this.procs.keys()]) this.kill(id);
  }
}
