/**
 * Native folder picker for the "New agent" form.
 *
 * The HTTP layer (server/index.js — owned by the root, not by this module) wires
 * `POST /api/directories/pick` to `pickDirectory()`. This module owns the
 * platform-specific work and is fully dependency-injectable so it can be tested
 * without ever opening a dialog:
 *
 *   pickDirectory({ initialPath, platform, spawnImpl, statImpl, timeoutMs, env })
 *     -> Promise<{ path: string } | { path: null, error: string, code: string }>
 *
 * Contract:
 *   - Only Windows (`platform === 'win32'`) is supported. Anything else resolves
 *     to `{ path: null, code: 'ENOTSUP' }` — never a rejected promise.
 *   - The dialog is shown interactively by `System.Windows.Forms.FolderBrowserDialog`
 *     and only ever because the operator explicitly pressed the button. There is
 *     no non-interactive / automated fallback: if the dialog cannot be shown the
 *     call fails with an error instead of guessing a directory.
 *   - Success is `{ path: <absolute existing directory> }`; cancel is `{ path: null }`
 *     with NO error. Failures resolve (never reject) with `{ path: null, error, code }`.
 *   - `initialPath` travels as data (an environment variable), never as command
 *     text, and is only used when it is an existing absolute directory. An
 *     unusable `initialPath` is IGNORED (the dialog opens at its default) rather
 *     than failing the request — a stale path in the form must not block picking
 *     a new one.
 *   - `powershell.exe` is always invoked as a fixed argument ARRAY with
 *     `shell: false`; no user input is ever interpolated into the command line
 *     or the script.
 *   - A module-level in-flight guard prevents two dialogs at once; the guard is
 *     released in every path (success, cancel, failure, timeout).
 *
 * Error codes: ENOTSUP (wrong platform), EBUSY (dialog already open),
 * ETIMEDOUT (picker did not answer in time), ESPAWN (powershell could not be
 * started), EFAILED (picker exited without a usable result), EINVALIDPATH
 * (answer was not an existing absolute directory).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/** How long to leave the dialog open before killing the child, in ms. */
export const DEFAULT_TIMEOUT_MS = 120000;

/**
 * The one fixed script we ever run. It is a constant: `initialPath` is read from
 * the `CR_PICKER_INITIAL` environment variable and is never concatenated in.
 * `-STA` is mandatory — WinForms dialogs need a single-threaded apartment.
 */
export const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = 'Choose a folder for the new agent'",
  '$dialog.ShowNewFolderButton = $true',
  '$initial = $env:CR_PICKER_INITIAL',
  'if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }',
  '$answer = $dialog.ShowDialog()',
  'if ($answer -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
  '  $payload = @{ path = $dialog.SelectedPath }',
  '} else {',
  '  $payload = @{ path = $null }',
  '}',
  '$dialog.Dispose()',
  '[Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))',
].join('\n');

/** The fixed argv shape; only the constant script ever appears here. */
export function pickerArgs() {
  return ['-NoProfile', '-STA', '-Command', POWERSHELL_SCRIPT];
}

/** True while a dialog started by this process is still open. */
let inFlight = false;

/** Test/health helper: whether the single-flight guard is currently held. */
export function isPickerBusy() {
  return inFlight;
}

/**
 * Is `value` an existing absolute directory? Uses win32 path semantics because
 * the picker only ever runs on Windows, so the check behaves the same on any
 * host the tests run on. Returns the usable path or null.
 */
export function existingDirectory(value, statImpl = fs.statSync) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!path.win32.isAbsolute(trimmed)) return null;
  try {
    if (!statImpl(trimmed).isDirectory()) return null;
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * Pull the picker's single JSON line out of stdout. Scans backwards so any
 * incidental PowerShell chatter cannot shadow the real answer.
 * Returns the parsed object or null.
 */
export function parsePickerStdout(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'path')) return parsed;
    } catch {
      // Not the JSON line (or a partial write) — keep looking.
    }
  }
  return null;
}

/** First non-empty line of stderr, capped, for a one-line error. */
function firstLine(text, max = 300) {
  const s = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Open the native folder picker and resolve with the chosen directory.
 *
 * Never rejects: every failure is `{ path: null, error, code }` so an HTTP
 * handler can map it to a status without a try/catch ladder.
 */
export function pickDirectory({
  initialPath = null,
  platform = process.platform,
  spawnImpl = nodeSpawn,
  statImpl = fs.statSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (platform !== 'win32') {
    return Promise.resolve({
      path: null,
      error: 'native folder picker is only supported on Windows; type the path instead',
      code: 'ENOTSUP',
    });
  }
  if (inFlight) {
    return Promise.resolve({
      path: null,
      error: 'a folder picker is already open — finish or cancel it before opening another',
      code: 'EBUSY',
    });
  }
  inFlight = true;

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    let stdout = '';
    let stderr = '';

    /** Release the guard exactly once, whatever the outcome. */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      inFlight = false;
      resolve(result);
    };

    // Validate the suggested start directory first: bad input degrades to the
    // dialog's default rather than becoming an error.
    const safeInitial = existingDirectory(initialPath, statImpl);
    const childEnv = { ...env };
    delete childEnv.CR_PICKER_INITIAL;
    if (safeInitial) childEnv.CR_PICKER_INITIAL = safeInitial;

    try {
      child = spawnImpl('powershell.exe', pickerArgs(), {
        env: childEnv,
        windowsHide: true,
        // shell is explicitly false: the args array is passed straight to
        // CreateProcess, so nothing here can be shell-interpreted.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ path: null, error: `could not start the folder picker: ${err && err.message ? err.message : err}`, code: 'ESPAWN' });
      return;
    }

    if (!child || typeof child.on !== 'function') {
      finish({ path: null, error: 'could not start the folder picker: spawn returned no child process', code: 'ESPAWN' });
      return;
    }

    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => {
      try { if (child && typeof child.kill === 'function') child.kill(); } catch { /* already gone */ }
      finish({
        path: null,
        error: `the folder picker did not answer within ${ms}ms`,
        code: 'ETIMEDOUT',
      });
    }, ms);

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    }

    child.on('error', (err) => {
      finish({ path: null, error: `the folder picker could not start: ${err && err.message ? err.message : err}`, code: 'ESPAWN' });
    });

    child.on('close', () => {
      const parsed = parsePickerStdout(stdout);
      if (!parsed) {
        const detail = firstLine(stderr);
        finish({
          path: null,
          error: detail
            ? `the folder picker failed: ${detail}`
            : 'the folder picker closed without returning a path',
          code: 'EFAILED',
        });
        return;
      }
      const raw = parsed.path;
      // Cancel / empty result is a normal outcome, not an error.
      if (raw === null || raw === undefined || raw === '') {
        finish({ path: null });
        return;
      }
      const chosen = existingDirectory(raw, statImpl);
      if (!chosen) {
        finish({
          path: null,
          error: `the folder picker returned a path that is not an existing directory: ${String(raw)}`,
          code: 'EINVALIDPATH',
        });
        return;
      }
      finish({ path: chosen });
    });
  });
}

export default pickDirectory;
