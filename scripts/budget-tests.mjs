import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Point DATA_DIR at a throwaway directory BEFORE loading config.js, so this
// suite never touches the operator's real data/ tree. config already makes the
// directory on import.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-budget-test-'));
process.env.CR_DATA_DIR = tmp;

const { readBudget, saveBudget, summarizeBudget } = await import('../server/budget.js');
const { localDay } = await import('../server/config.js');

const file = path.join(tmp, 'budget.json');
const stored = () => JSON.parse(fs.readFileSync(file, 'utf8'));

try {
  // ---- unset --------------------------------------------------------------
  assert.equal(readBudget(), null, 'no file yet reads as unset');
  const unset = summarizeBudget(0, '2026-09-16');
  assert.deepEqual(unset, { dailyUsd: null, day: '2026-09-16', spentUsd: 0, remainingUsd: null, percentUsed: null },
    'unset budget has no remaining/percent to show');

  // ---- persistence --------------------------------------------------------
  assert.equal(saveBudget(10), 10);
  assert.equal(fs.existsSync(file), true, 'save writes data/budget.json');
  assert.equal(readBudget(), 10);
  assert.equal(stored().dailyUsd, 10);
  assert.match(stored().updatedAt, /^\d{4}-\d{2}-\d{2}T/, 'writes an observation timestamp');

  // A second save overwrites rather than appends, and the server process is a
  // fresh module graph every start — so prove the value is read back by code
  // that never saved it. The generated module is evaluated for the first time
  // here, so it can only see what is on disk.
  saveBudget(25.5);
  assert.equal(readBudget(), 25.5);
  const budgetUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'server', 'budget.js')).href;
  const outFile = path.join(tmp, 'cold-read.txt');
  const probeFile = path.join(tmp, 'cold-read.mjs');
  fs.writeFileSync(probeFile,
    `import { readBudget } from ${JSON.stringify(budgetUrl)};\n` +
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(${JSON.stringify(outFile)}, String(readBudget()));\n`, 'utf8');
  await import(pathToFileURL(probeFile).href);
  assert.equal(fs.readFileSync(outFile, 'utf8'), '25.5', 'a module that never saved the value reads it from disk');

  // ---- remaining / percent ------------------------------------------------
  const mid = summarizeBudget(4.25, '2026-09-16');
  assert.equal(mid.dailyUsd, 25.5);
  assert.equal(mid.remainingUsd, 21.25);
  assert.equal(mid.percentUsed, (4.25 / 25.5) * 100);

  const exact = summarizeBudget(25.5, '2026-09-16');
  assert.equal(exact.remainingUsd, 0, 'spending exactly the budget leaves 0, not a negative');
  assert.equal(exact.percentUsed, 100);

  const over = summarizeBudget(30, '2026-09-16');
  assert.equal(over.remainingUsd, -4.5, 'over budget is a negative remaining the UI can label');
  assert.ok(over.percentUsed > 100, 'over budget reports more than 100%');

  assert.deepEqual(summarizeBudget(0).day, localDay(), 'omitting the day uses the operator local day');
  assert.equal(summarizeBudget(NaN, '2026-09-16').spentUsd, 0, 'non-numeric spend reads as 0');

  // ---- rejection ----------------------------------------------------------
  for (const bad of [0, -1, NaN, Infinity, -Infinity, 1000000.01, '10', {}, [], true]) {
    assert.throws(() => saveBudget(bad), 'saveBudget rejects ' + JSON.stringify(bad));
  }
  assert.equal(readBudget(), 25.5, 'a rejected save leaves the previous value intact');
  assert.equal(stored().dailyUsd, 25.5);

  // ---- clearing -----------------------------------------------------------
  assert.equal(saveBudget(null), null);
  assert.equal(readBudget(), null, 'null unsets the budget');
  assert.equal(stored().dailyUsd, null);
  const cleared = summarizeBudget(3, '2026-09-16');
  assert.equal(cleared.dailyUsd, null);
  assert.equal(cleared.remainingUsd, null);
  assert.equal(cleared.percentUsed, null);
  assert.equal(cleared.spentUsd, 3, 'the day’s measured spend still shows when no budget is set');

  // ---- corruption never invents a limit -----------------------------------
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.equal(readBudget(), null, 'malformed JSON reads as unset');
  fs.writeFileSync(file, JSON.stringify({ dailyUsd: '10' }), 'utf8');
  assert.equal(readBudget(), null, 'a string value reads as unset');
  fs.writeFileSync(file, JSON.stringify({ dailyUsd: 0 }), 'utf8');
  assert.equal(readBudget(), null, 'a non-positive stored value reads as unset');
  fs.writeFileSync(file, JSON.stringify({ dailyUsd: 5000000 }), 'utf8');
  assert.equal(readBudget(), null, 'an out-of-range stored value reads as unset');

  assert.equal(saveBudget(1000000), 1000000, 'the documented maximum is accepted');
  assert.equal(summarizeBudget(1000000, '2026-09-16').percentUsed, 100);

  console.log('Budget tests passed: unset state, persistence read back by a fresh module, remaining/percent/over-budget, input rejection, clearing, and corrupt files.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
