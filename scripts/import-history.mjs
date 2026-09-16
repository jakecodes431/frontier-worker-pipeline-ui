#!/usr/bin/env node
// Explicit, additive recovery of a local Control Room database. Never publishes data.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) throw new Error('Usage: node scripts/import-history.mjs <source-data-dir> <destination-data-dir>');
const source = fs.realpathSync(sourceArg);
const destination = fs.realpathSync(destinationArg);
if (source === destination) throw new Error('Source and destination must differ');
if (!fs.existsSync(path.join(destination, 'control-room.sqlite'))) throw new Error('Destination must be an initialized Control Room data directory');
const src = new DatabaseSync(path.join(source, 'control-room.sqlite'), { readOnly: true });
const dst = new DatabaseSync(path.join(destination, 'control-room.sqlite'));
dst.exec('PRAGMA busy_timeout=10000');
const backupPath = path.join(destination, `before-history-import-${Date.now()}.sqlite`);
await backup(dst, backupPath);
const counts = {};
try {
  dst.exec('BEGIN IMMEDIATE');
  dst.exec('CREATE TABLE IF NOT EXISTS history_imports (source TEXT, table_name TEXT, row_key TEXT, PRIMARY KEY(source,table_name,row_key))');
  const imported = dst.prepare('SELECT 1 FROM history_imports WHERE source=? AND table_name=? AND row_key=?');
  const record = dst.prepare('INSERT INTO history_imports VALUES(?,?,?)');
  for (const table of ['agents', 'messages', 'events', 'usage_samples', 'usage_cursors']) {
    const targetColumns = new Set(dst.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    const sourceColumns = src.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!sourceColumns.length) continue;
    const columns = sourceColumns.filter(c => targetColumns.has(c) && !(['messages', 'events'].includes(table) && c === 'id'));
    const insert = dst.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    counts[table] = 0;
    for (const row of src.prepare(`SELECT rowid AS import_row_key,* FROM ${table}`).all()) {
      const key = String(row.import_row_key);
      if (imported.get(source, table, key)) continue;
      if (table === 'agents') {
        // A persisted running flag is not evidence of a live process in this server.
        if (!['done', 'failed', 'stopped'].includes(row.status)) {
          row.status = 'stopped';
          row.ended_at = new Date().toISOString();
          row.note = [row.note, 'Recovered history; previous process is not attached.'].filter(Boolean).join(' ');
        }
        row.pid = null;
      }
      counts[table] += Number(insert.run(...columns.map(c => row[c] ?? null)).changes);
      record.run(source, table, key);
    }
  }
  dst.exec('COMMIT');
} catch (error) { dst.exec('ROLLBACK'); throw error; }
finally { src.close(); dst.close(); }
// Preserve raw terminal logs and briefs. Existing destination files always win.
for (const directory of ['scrollback', 'briefs']) {
  const from = path.join(source, directory), to = path.join(destination, directory);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const input = path.join(from, name), output = path.join(to, name);
    if (fs.statSync(input).isFile() && !fs.existsSync(output)) fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
  }
}
console.log(JSON.stringify({ imported: counts, backup: backupPath }, null, 2));
