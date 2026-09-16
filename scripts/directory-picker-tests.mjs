#!/usr/bin/env node
/**
 * Isolated tests for server/directory-picker.js.
 *
 *   node scripts/directory-picker-tests.mjs
 *
 * These tests never open a real dialog: they inject a fake `spawnImpl` and a
 * fake `statImpl`, so nothing here depends on Windows, PowerShell or a human.
 * They exit non-zero on the first batch of failures and print a summary.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  pickDirectory,
  isPickerBusy,
  existingDirectory,
  parsePickerStdout,
  pickerArgs,
  DEFAULT_TIMEOUT_MS,
  POWERSHELL_SCRIPT,
} from '../server/directory-picker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/**
 * A spawnImpl that returns an EventEmitter fake shaped like a child process.
 * `emitResult: false` models a dialog that never answers (for timeout/busy
 * tests); its `kill()` only records, mirroring a real async kill.
 */
function makeFakeSpawn({ stdout = '', stderr = '', exitCode = 0, emitResult = true } = {}) {
  const spawnCalls = [];
  const state = { killed: 0 };
  let child = null;
  const spawnImpl = (command, args, options) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => { state.killed += 1; return true; };
    c.pid = 4242;
    spawnCalls.push({ command, args, options });
    child = c;
    if (emitResult) {
      setImmediate(() => {
        if (stdout) c.stdout.emit('data', Buffer.from(stdout, 'utf8'));
        if (stderr) c.stderr.emit('data', Buffer.from(stderr, 'utf8'));
        c.emit('close', exitCode, null);
      });
    }
    return c;
  };
  return { spawnImpl, spawnCalls, state, getChild: () => child };
}

/** A statImpl that reports exactly the directories in `dirs` as existing. */
function statStub(dirs) {
  const set = new Set(dirs);
  return (p) => {
    if (!set.has(p)) {
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return { isDirectory: () => true };
  };
}

const WIN = { platform: 'win32' };
const jsonLine = (obj) => JSON.stringify(obj) + '\n';

/** A free loopback port, the same way scripts/smoke.mjs takes one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Poll /api/health until the spawned server answers, dies, or time runs out. */
async function waitForHealth(port, childState) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (childState.spawnError) throw new Error(`server could not start: ${childState.spawnError}`);
    if (childState.exitCode !== null) throw new Error(`server exited early (code ${childState.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      // Not listening yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy within 20s');
}

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => { tests.push({ name, fn }); };

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('happy path: a selected Windows directory resolves to { path }', async () => {
  const chosen = 'C:\\some\\dir';
  const fake = makeFakeSpawn({ stdout: jsonLine({ path: chosen }) });
  const result = await pickDirectory({
    ...WIN,
    spawnImpl: fake.spawnImpl,
    statImpl: statStub([chosen]),
    initialPath: null,
  });

  assert.deepEqual(result, { path: chosen });
  assert.equal(fake.spawnCalls.length, 1);

  const call = fake.spawnCalls[0];
  assert.equal(call.command, 'powershell.exe', 'must invoke powershell.exe');
  assert.ok(Array.isArray(call.args), 'args must be an argument array, never a shell string');
  assert.ok(call.args.includes('-NoProfile'), '-NoProfile is required');
  assert.ok(call.args.includes('-STA'), '-STA is required for a WinForms dialog');
  assert.ok(call.args.includes('-Command'), 'the fixed script is passed with -Command');
  assert.equal(call.args[3], POWERSHELL_SCRIPT, 'the script is the module constant, unmodified');
  assert.notEqual(call.options.shell, true, 'shell must not be enabled');
  assert.equal(call.options.shell, false);
  assert.ok(!('CR_PICKER_INITIAL' in call.options.env), 'no initial path means no env value');
});

test('cancel: {"path":null} is not an error and releases the guard', async () => {
  const fake = makeFakeSpawn({ stdout: jsonLine({ path: null }) });
  const result = await pickDirectory({ ...WIN, spawnImpl: fake.spawnImpl, statImpl: statStub([]) });
  assert.deepEqual(result, { path: null });
  assert.equal(result.error, undefined, 'cancel must not carry an error');
  assert.equal(result.code, undefined);
  assert.equal(isPickerBusy(), false, 'the in-flight guard must be released');

  // A following pick still works: further proof the guard was released.
  const next = 'C:\\other';
  const fake2 = makeFakeSpawn({ stdout: jsonLine({ path: next }) });
  const result2 = await pickDirectory({ ...WIN, spawnImpl: fake2.spawnImpl, statImpl: statStub([next]) });
  assert.deepEqual(result2, { path: next });
  assert.equal(fake2.spawnCalls.length, 1);
});

test('empty selected path is treated as cancel, not an error', async () => {
  const fake = makeFakeSpawn({ stdout: jsonLine({ path: '' }) });
  const result = await pickDirectory({ ...WIN, spawnImpl: fake.spawnImpl, statImpl: statStub([]) });
  assert.deepEqual(result, { path: null });
  assert.equal(result.error, undefined);
});

test('concurrency: a second call while one is open is EBUSY and only one spawn happens', async () => {
  const fake = makeFakeSpawn({ emitResult: false });
  const spec = { ...WIN, spawnImpl: fake.spawnImpl, statImpl: statStub([]) };

  const first = pickDirectory(spec);
  assert.equal(isPickerBusy(), true, 'the guard is held while the dialog is open');

  const second = pickDirectory(spec);
  let busy;
  let firstResult;
  try {
    busy = await second;
  } finally {
    // Always unblock the first call so a failed assertion cannot leak the guard
    // into later tests.
    const child = fake.getChild();
    if (child) {
      child.stdout.emit('data', Buffer.from(jsonLine({ path: null }), 'utf8'));
      child.emit('close', 0, null);
    }
    firstResult = await first;
  }

  assert.equal(busy.path, null);
  assert.equal(busy.code, 'EBUSY');
  assert.match(busy.error, /already open/i);
  assert.equal(fake.spawnCalls.length, 1, 'a second dialog must not be spawned');
  assert.deepEqual(firstResult, { path: null });
  assert.equal(isPickerBusy(), false, 'the guard is released once the first call settles');
});

test('timeout: a dialog that never answers is killed and resolves ETIMEDOUT', async () => {
  const fake = makeFakeSpawn({ emitResult: false });
  const result = await pickDirectory({
    ...WIN,
    spawnImpl: fake.spawnImpl,
    statImpl: statStub([]),
    timeoutMs: 30,
  });

  assert.equal(result.path, null);
  assert.equal(result.code, 'ETIMEDOUT');
  assert.match(result.error, /did not answer/i);
  assert.equal(fake.state.killed, 1, 'the child process is killed on timeout');
  assert.equal(isPickerBusy(), false, 'the guard is released after a timeout');
});

test('unsupported platform: ENOTSUP without spawning anything', async () => {
  for (const platform of ['linux', 'darwin']) {
    let spawned = 0;
    const result = await pickDirectory({
      platform,
      spawnImpl: () => { spawned += 1; throw new Error('must not spawn'); },
    });
    assert.equal(result.path, null);
    assert.equal(result.code, 'ENOTSUP');
    assert.match(result.error, /Windows/i);
    assert.match(result.error, /type the path instead/i);
    assert.equal(spawned, 0, `no process may be spawned on ${platform}`);
  }
});

test('initialPath travels as env data, never as command text', async () => {
  const chosen = 'C:\\some\\dir';
  const start = 'C:\\start here';
  const fake = makeFakeSpawn({ stdout: jsonLine({ path: chosen }) });
  const result = await pickDirectory({
    ...WIN,
    spawnImpl: fake.spawnImpl,
    statImpl: statStub([chosen, start]),
    initialPath: start,
  });

  assert.deepEqual(result, { path: chosen });
  const call = fake.spawnCalls[0];
  assert.equal(call.options.env.CR_PICKER_INITIAL, start, 'the path is passed via the environment');

  const commandLine = call.args.join(' ');
  assert.ok(!commandLine.includes(start), 'the raw path must not appear in argv');
  assert.ok(!commandLine.includes('start here'), 'no fragment of the path may appear in argv');
  assert.ok(!POWERSHELL_SCRIPT.includes(start), 'the fixed script must not contain the path');
  assert.ok(!POWERSHELL_SCRIPT.includes('C:\\'), 'the fixed script is data-free');
  assert.ok(Array.isArray(call.args));
  assert.notEqual(call.options.shell, true);
});

test('unusable initialPath is ignored (starts at the default), not an error', async () => {
  // A *string* initialPath is deliberately NOT rejected by the HTTP type guard
  // in server/index.js: only a present-and-not-a-string value is a 400. A string
  // that is stale, relative or missing is data for this layer, which ignores it
  // and still opens the dialog at its default — a path left over in the form
  // must never block picking a new folder. (The HTTP route's non-string refusal
  // is exercised by the route test below.)
  for (const bad of ['relative\\dir', 'dir\\x', 'C:\\does\\not\\exist', '', null, 42]) {
    const fake = makeFakeSpawn({ stdout: jsonLine({ path: null }) });
    const result = await pickDirectory({
      ...WIN,
      spawnImpl: fake.spawnImpl,
      statImpl: statStub([]),
      initialPath: bad,
    });
    assert.deepEqual(result, { path: null }, `initialPath ${JSON.stringify(bad)} must degrade to cancel`);
    assert.equal(result.error, undefined);
    assert.equal(fake.spawnCalls.length, 1, 'the dialog is still opened');
    assert.ok(
      !('CR_PICKER_INITIAL' in fake.spawnCalls[0].options.env),
      `initialPath ${JSON.stringify(bad)} must not be forwarded`,
    );
  }
});

// ---------------------------------------------------------------------------
// The type guard for a non-string `initialPath` lives in the HTTP route
// (server/index.js), not in this module, so it is only observable over HTTP.
// This test boots the real server on a free port with a scratch data/config
// dir. To guarantee it can never open a real dialog — even if the guard
// regressed — the child runs with an empty PATH, so `powershell.exe` cannot be
// resolved. A regressed guard then answers 500/501 (picker attempted) instead
// of 400 (guard refused), which still fails the assertion.
// ---------------------------------------------------------------------------
test('HTTP: a non-string initialPath is 400 before the picker, and null is not rejected', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-picker-data-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-picker-config-'));
  const noExeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-picker-path-'));

  // Scrub PATH case-insensitively: no powershell.exe, therefore no dialog.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = noExeDir;

  const childState = { exitCode: null, spawnError: null };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...env, CR_PORT: String(port), CR_HOST: '127.0.0.1', CR_DATA_DIR: dataDir, CR_CONFIG_DIR: configDir },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => { childState.spawnError = err.message; });
  child.on('exit', (code) => { childState.exitCode = code; });

  const postPick = (body) => fetch(`http://127.0.0.1:${port}/api/directories/pick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    await waitForHealth(port, childState);

    // A present, non-string initialPath is a client error with a JSON error,
    // and never reaches pickDirectory()/powershell.exe.
    for (const bad of [42, true, {}, []]) {
      const res = await postPick({ initialPath: bad });
      const body = await res.json();
      assert.equal(res.status, 400, `initialPath ${JSON.stringify(bad)} must be rejected with 400`);
      assert.equal(typeof body.error, 'string', 'the 400 must carry a JSON error string');
      assert.match(body.error, /initialPath must be a directory path/);
    }

    // `null` and an omitted field are valid for the type guard: they are not a
    // client error. The picker layer is then reached (unsupported platform, or a
    // spawn failure when powershell.exe is unreachable), which is exactly why
    // the guard must distinguish null from a non-string.
    for (const body of [{ initialPath: null }, {}]) {
      const res = await postPick(body);
      const json = await res.json();
      assert.notEqual(res.status, 400, `${JSON.stringify(body)} must not be a client error`);
      assert.doesNotMatch(String(json.error || ''), /initialPath must be a directory path/);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (childState.exitCode !== null || childState.spawnError) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    for (const dir of [dataDir, configDir, noExeDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ }
    }
  }
});

test('validation: a relative or non-existent selected path is rejected', async () => {
  const cases = [
    { stdout: jsonLine({ path: 'sub\\dir' }), stat: statStub(['sub\\dir']), why: 'relative path' },
    { stdout: jsonLine({ path: 'C:\\ghost' }), stat: statStub([]), why: 'non-existent directory' },
    { stdout: jsonLine({ path: 42 }), stat: statStub([]), why: 'non-string path' },
  ];
  for (const c of cases) {
    const fake = makeFakeSpawn({ stdout: c.stdout });
    const result = await pickDirectory({ ...WIN, spawnImpl: fake.spawnImpl, statImpl: c.stat });
    assert.equal(result.path, null, `${c.why}: must not be returned as a success`);
    assert.ok(result.error, `${c.why}: must carry a visible error`);
    assert.equal(result.code, 'EINVALIDPATH', `${c.why}: expected EINVALIDPATH`);
    assert.equal(isPickerBusy(), false);
  }
});

test('picker failure with no JSON line reports the stderr first line', async () => {
  const fake = makeFakeSpawn({ stdout: '', stderr: 'powershell.exe : Access is denied\r\nat line:1 char:1\n', exitCode: 1 });
  const result = await pickDirectory({ ...WIN, spawnImpl: fake.spawnImpl, statImpl: statStub([]) });
  assert.equal(result.path, null);
  assert.equal(result.code, 'EFAILED');
  assert.match(result.error, /Access is denied/);
  assert.equal(isPickerBusy(), false);
});

test('a spawn that throws releases the guard and reports ESPAWN', async () => {
  const result = await pickDirectory({
    ...WIN,
    spawnImpl: () => { throw new Error('EPERM: spawn powershell.exe'); },
    statImpl: statStub([]),
  });
  assert.equal(result.path, null);
  assert.equal(result.code, 'ESPAWN');
  assert.match(result.error, /EPERM/);
  assert.equal(isPickerBusy(), false);
});

test('helpers: existingDirectory, parsePickerStdout, pickerArgs', () => {
  const stat = statStub(['C:\\a']);
  assert.equal(existingDirectory('C:\\a', stat), 'C:\\a');
  assert.equal(existingDirectory(' C:\\a ', stat), 'C:\\a', 'surrounding whitespace is trimmed');
  assert.equal(existingDirectory('C:\\b', stat), null, 'non-existent path');
  assert.equal(existingDirectory('a\\b', stat), null, 'relative path');
  assert.equal(existingDirectory('', stat), null);
  assert.equal(existingDirectory(null, stat), null);
  assert.equal(existingDirectory('\\\\srv\\share', statStub(['\\\\srv\\share'])), '\\\\srv\\share', 'UNC paths are absolute');

  assert.deepEqual(parsePickerStdout('noise\n{"path":"C:\\\\x"}\n'), { path: 'C:\\x' });
  assert.deepEqual(parsePickerStdout('{"path":null}'), { path: null });
  assert.equal(parsePickerStdout('not json at all'), null);
  assert.equal(parsePickerStdout(''), null);

  const args = pickerArgs();
  assert.ok(Array.isArray(args));
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-STA', '-Command']);
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${t.name}`);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

if (!isPickerBusy()) console.log('ok   no picker left in flight');
else { failures += 1; console.error('FAIL a picker was left in flight (guard leaked)'); }

const total = tests.length + 1;
console.log(`\n${Math.max(0, total - failures)}/${total} passed`);
if (failures) {
  console.error(`${failures} directory-picker test(s) failed`);
  process.exit(1);
}
console.log('directory-picker: all tests passed');
