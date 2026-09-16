// "New agent" modal — POST /api/agents.
//
// The form validates before it posts (so a typo does not cost a round trip)
// and, when the server refuses anyway, shows the server's own message inline
// above the fields AND against the field it names. Nothing here fails silently:
// every path ends in either a created agent or a visible reason.

import { h, clear, toast, setText, trapFocus } from '../lib/dom.js';
import { createDropdown, closeOpenDropdown } from '../lib/dropdown.js';
import api from '../lib/api.js';
import { getAgents, getConfig, upsertAgent, select, treeOrder } from '../lib/store.js';

const FALLBACK_RUNTIMES = ['claude', 'codex', 'deepseek', 'external'];
const EFFORTS_BY_RUNTIME = { claude: ['low', 'medium', 'high', 'max'], codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], deepseek: ['low', 'medium', 'high'] };
export function runtimeNames(cfg = {}) { return Object.keys(cfg.runtimes || {}).length ? Object.keys(cfg.runtimes) : FALLBACK_RUNTIMES; }
export function runtimeEfforts(cfg, runtime) { return cfg.runtimes?.[runtime]?.efforts || EFFORTS_BY_RUNTIME[runtime] || []; }
export function continuationProvider(agent, providers) {
  const source = agent.runtime === 'external' ? agent.transcriptRuntime : agent.runtime;
  return providers.find((runtime) => runtime !== source) || providers[0];
}

/** Roles that may ever hand a task to a successor; everyone else is hidden. */
const HANDOFF_ROLES = ['cto', 'orchestrator'];
/** Statuses where the session is already over, so nothing can be "live". */
const TERMINAL_STATUSES = ['stopped', 'blocked', 'done', 'failed'];
/** Managed statuses that mean a terminal/process is attached (or mid-stop). */
const LIVE_STATUSES = ['running', 'idle', 'paused', 'stopping'];

/**
 * The exact instruction the operator needs when a session still owns a live
 * terminal. It names the control in the panel and says plainly that nothing is
 * stopped for them: the server refuses the handoff, and this client must never
 * stop the source on the operator's behalf.
 */
export const LIVE_HANDOFF_NOTICE = 'This session still has a live terminal. Stop it from the panel’s Stop control first — nothing is stopped for you. You can still pick the provider and options here.';

/** True when the record describes a managed session that still owns a process. */
export function agentIsLive(agent = {}) {
  return agent.runtime !== 'external' && LIVE_STATUSES.includes(agent.status);
}

/**
 * The whole "Choose LLM" button decision, kept pure so it can be asserted
 * without a DOM. It decides only whether the chooser may open and what the
 * button/warning says — it never stops, restarts or switches anything. The
 * live-session refusal stays on the server and is surfaced verbatim by the
 * modal's error box.
 *
 * `live` may be passed explicitly (the caller knows whether a terminal is
 * attached); otherwise it is derived from the record.
 */
export function handoffButtonState(agent = {}, { live } = {}) {
  const hidden = !HANDOFF_ROLES.includes(agent.role);
  const successorId = agent.successorId || null;
  const status = agent.status || 'queued';
  const isLive = typeof live === 'boolean' ? live : agentIsLive(agent);
  const active = !TERMINAL_STATUSES.includes(status);
  const state = (disabled, title, warning) => ({
    hidden, disabled, openable: !hidden && !disabled,
    active, live: isLive, successorId, title, warning,
  });

  // At most one continuation: say so instead of silently refusing the click.
  if (successorId) {
    return state(true,
      `This task already continued as ${successorId} — open that continuation instead.`,
      `A continuation already exists (${successorId}). This session cannot create a second one; open the continuation instead.`);
  }
  // An active managed session is still openable; it just cannot be switched yet.
  if (isLive) {
    return state(false,
      'Choose the provider for a continuation. Stop this session from the panel first — nothing is stopped for you.',
      LIVE_HANDOFF_NOTICE);
  }
  if (active) {
    return state(false,
      'Choose the provider for a continuation.',
      'This session is not running a live managed terminal right now, so a continuation can be created. Nothing here stops or switches it automatically.');
  }
  return state(false, 'Create a successor with a recovery brief', null);
}

/**
 * The modal's submit decision. A live session keeps the dialog open — so the
 * operator can still compare providers and options — but cannot submit: the
 * server refuses a handoff while a PTY/pid is live, and stopping the source is
 * the operator's action, never this client's.
 */
export function handoffSubmitState(agent = {}, { live } = {}) {
  const button = handoffButtonState(agent, { live });
  return {
    disabled: Boolean(button.live),
    live: Boolean(button.live),
    notice: button.live ? LIVE_HANDOFF_NOTICE : (button.warning || null),
    title: button.live
      ? 'Still live: stop this session from the panel first, then create the continuation.'
      : '',
  };
}

/**
 * The exact POST /api/agents/:id/handoff body from `handoffAgent()` in
 * server/index.js: `runtime` is always required; `model` and `effort` are
 * optional and are only sent when one is actually chosen; `autoStart` is an
 * explicit boolean.
 */
export function handoffPayload({ runtime, model, effort, autoStart } = {}) {
  const payload = { runtime, autoStart: Boolean(autoStart) };
  if (model) payload.model = model;
  if (effort) payload.effort = effort;
  return payload;
}

const ROLES = ['cto', 'orchestrator', 'worker'];
const NAME_MAX = 200;
const TASK_MAX = 2000;

/**
 * Client for POST /api/directories/pick.
 *
 * It is deliberately a direct fetch rather than a method on ui/lib/api.js:
 * this file owns only the view, and the endpoint contract is a single call.
 * It lives on an exported object so tests/tools can swap the implementation
 * without touching the view.
 */
export const pickerClient = {
  async pick(initialPath) {
    const res = await fetch('/api/directories/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ initialPath: initialPath || null }),
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) {
      const message = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data || {};
  },
};

/** A Windows absolute path: drive-rooted (`C:\x`, `C:/x`) or UNC (`\\srv\share`). */
export function isAbsolutePath(value) {
  return typeof value === 'string' && (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value));
}

let modalRoot = null;
let releaseTrap = null;
let uid = 0;

export function mountNewAgent({ root, button, buttons }) {
  modalRoot = root;
  const triggers = (buttons || [button]).filter(Boolean);
  for (const b of triggers) b.addEventListener('click', openForm);
  modalRoot.addEventListener('click', (ev) => { if (ev.target === modalRoot) closeForm(); });
  // Capture phase, and preventDefault: the drawer's own Escape handler checks
  // defaultPrevented, so one Escape closes one thing — this dialog first.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modalRoot.hidden) {
      ev.preventDefault(); ev.stopPropagation();
      // One Escape closes one layer: an open listbox popup first, then the
      // dialog. Without this the popup could never be dismissed on its own.
      if (closeOpenDropdown()) return;
      closeForm();
    }
  }, true);
}

function closeForm() {
  if (!modalRoot) return;
  modalRoot.hidden = true;
  clear(modalRoot);
  if (releaseTrap) { releaseTrap(); releaseTrap = null; }
}

/**
 * The dialogs' close control: a real 32x32 square button with a glyph (never
 * the text "Esc"), named for assistive tech and focusable from the keyboard.
 * Escape still closes the dialog, so the title advertises it. Sizing is inline
 * so the hit area survives even if the scoped stylesheet is unavailable.
 */
function modalCloseButton() {
  return h('button', {
    class: 'btn btn-ghost modal-close-btn', type: 'button',
    'aria-label': 'Close this dialog (Escape)',
    title: 'Close (Escape)',
    onclick: closeForm,
    style: {
      width: '32px', height: '32px', minWidth: '32px', padding: '0',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      lineHeight: '1', fontSize: '15px',
    },
  }, h('span', { class: 'modal-close-glyph', 'aria-hidden': 'true' }, '✕'));
}

function openForm() {
  const cfg = getConfig() || {};
  const agents = treeOrder(getAgents()).map((e) => e.agent);

  const parentSel = field('Parent', h('select', { name: 'parentId', class: 'select' },
    h('option', { value: '' }, '— none (root / CTO) —'),
    ...agents.map((a) => h('option', { value: a.id }, `${a.role || '?'} · ${a.name || a.id}`))),
    'Leave empty to create a root agent.', true);

  const name = field('Name', h('input', { type: 'text', name: 'name', maxlength: String(NAME_MAX), placeholder: 'tags orchestrator', autocomplete: 'off' }), null, false, true);
  const role = field('Role', h('select', { name: 'role', class: 'select' }, ...ROLES.map((r) => h('option', { value: r }, r))));
  const runtime = field('Runtime', h('select', { name: 'runtime', class: 'select' }, ...runtimeNames(cfg).map((r) => h('option', { value: r }, cfg.runtimes?.[r]?.label || r))),
    'Claude, Codex and DeepSeek launch local CLI processes. External registers an existing session.');
  const model = field('Model', h('input', { type: 'text', name: 'model', placeholder: cfg.defaultModel || 'runtime default', autocomplete: 'off' }));
  const effort = field('Effort', h('select', { name: 'effort', class: 'select' }));
  const provider = field('Session provider', h('select', { name: 'transcriptRuntime', class: 'select' }, h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex')));
  const session = field('Session ID', h('input', { name: 'sessionId', type: 'text', autocomplete: 'off', placeholder: 'Existing CLI session ID' }), 'Links the existing local transcript and usage. External sessions do not have a terminal here.', true);
  const task = field('Task', h('input', { type: 'text', name: 'task', maxlength: String(TASK_MAX), placeholder: 'one-line task', autocomplete: 'off' }), null, true, true);
  // The value (not just the placeholder) starts at the configured default, so
  // the field is honestly pre-filled: a placeholder that is not a value makes
  // the required check fail even though a default exists.
  const cwdInput = h('input', {
    type: 'text', name: 'cwd',
    value: cfg.defaultCwd || '',
    placeholder: cfg.defaultCwd || 'absolute path to the folder the agent runs in',
    autocomplete: 'off',
    style: { flex: '1 1 auto', minWidth: '0' },
  });
  const chooseBtn = h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button',
    'aria-label': 'Choose a folder with the Windows folder picker',
    title: 'Choose a folder on this machine',
    style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
  }, 'Choose folder…');
  const cwd = field('Working directory', cwdInput,
    'Ignored when a repo is given below: the agent then runs in a fresh worktree of it.', true, true, chooseBtn);
  const brief = field('Brief', h('textarea', { name: 'brief', rows: '5', placeholder: 'Full brief handed to the agent on start (optional).' }), null, true);
  const repo = field('Repo', h('input', { type: 'text', name: 'repo', placeholder: 'path to a git repo (optional)', autocomplete: 'off' }));
  const branch = field('Branch', h('input', { type: 'text', name: 'branch', placeholder: 'cr/<name>-<stamp> (optional)', autocomplete: 'off' }));

  role.input.value = 'worker';
  runtime.input.value = runtimeNames(cfg).includes('deepseek') ? 'deepseek' : runtimeNames(cfg)[0];

  const autoStart = h('input', { type: 'checkbox', name: 'autoStart', id: 'na-autostart-' + (++uid) });
  autoStart.checked = true;

  const errEl = h('div', { class: 'error-box', role: 'alert', hidden: true, style: { margin: '0 0 14px' } });
  const submitBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create agent');
  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeForm }, 'Cancel');

  const fields = [parentSel, name, role, runtime, provider, session, model, effort, task, cwd, brief];
  function syncRuntime() {
    const rt = runtime.input.value;
    const external = rt === 'external';
    const defaults = cfg.runtimes?.[rt]?.defaults || {};
    model.input.value = '';
    model.input.placeholder = defaults.model || 'runtime default';
    clear(effort.input);
    effort.input.append(h('option', { value: '' }, defaults.effort ? `default (${defaults.effort})` : '— default —'), ...runtimeEfforts(cfg, rt).map((v) => h('option', { value: v }, v)));
    effort.el.hidden = external || !runtimeEfforts(cfg, rt).length;
    provider.el.hidden = session.el.hidden = !external;
    autoStart.disabled = external;
    repo.input.disabled = branch.input.disabled = external;
  }
  runtime.input.addEventListener('change', syncRuntime);
  syncRuntime();
  role.input.addEventListener('change', () => {
    const wanted = role.input.value === 'worker' ? 'deepseek' : cfg.defaultRuntime || 'codex';
    if (runtimeNames(cfg).includes(wanted)) { runtime.input.value = wanted; syncRuntime(); }
  });

  const form = h('form', {
    class: 'modal-body', novalidate: true, id: 'new-agent-form',
    // Inline layout scoped to this modal: the body scrolls, so the footer with
    // Create/Cancel is always on screen. CSS files are owned elsewhere.
    style: { overflowY: 'auto', flex: '1 1 auto', minHeight: '0' },
  },
    errEl,
    h('div', { class: 'form-grid' },
      ...fields.map((f) => f.el),
      h('fieldset', { class: 'fieldset-sub' },
        h('legend', null, 'Worktree (optional)'),
        repo.el, branch.el),
      h('div', { class: 'field field-full' },
        h('label', { class: 'check-label form-check', for: autoStart.id },
          autoStart,
          h('span', { class: 'check-copy' },
            h('span', { class: 'check-text' }, 'Start immediately (autoStart)'),
            h('span', { class: 'check-hint' }, 'Launch the CLI as soon as the agent is created.'))))));

  form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
  // Re-validating as the operator types is the difference between "the form is
  // broken" and "this field is wrong".
  for (const f of [name, task, cwd]) f.input.addEventListener('input', () => f.setError(null));
  chooseBtn.addEventListener('click', chooseFolder);

  /**
   * Surface a picker problem where the operator is looking: the cwd field's own
   * error line plus the form-level alert. Nothing here fails silently.
   */
  function showPickerError(message) {
    cwd.setError(message);
    errEl.hidden = false;
    setText(errEl, message);
    cwdInput.focus();
  }

  /**
   * Ask the server for a native folder picker. Cancel is a normal outcome: it
   * leaves whatever the operator typed in the field untouched.
   */
  async function chooseFolder() {
    if (chooseBtn.disabled) return;
    chooseBtn.disabled = true;
    chooseBtn.textContent = 'Choosing…';
    cwd.setError(null);
    try {
      const result = await pickerClient.pick(cwdInput.value.trim());
      if (result && result.error) { showPickerError(result.error); return; }
      // An explicit null is Cancel (keep the value, no error); a MISSING path
      // is a broken response and must be reported, not swallowed as a cancel.
      const hasPath = result && Object.prototype.hasOwnProperty.call(result, 'path');
      const picked = hasPath ? result.path : undefined;
      if (picked === null) return;
      if (picked === undefined) {
        showPickerError('The folder picker returned no path.');
        return;
      }
      if (!isAbsolutePath(picked)) {
        showPickerError(`The folder picker returned a path that is not absolute: ${String(picked)}`);
        return;
      }
      cwdInput.value = picked;
      cwd.setError(null);
      errEl.hidden = true;
      cwdInput.focus();
    } catch (err) {
      showPickerError(err && err.message ? err.message : String(err));
    } finally {
      chooseBtn.disabled = false;
      chooseBtn.textContent = 'Choose folder…';
    }
  }

  const modal = h('div', {
    class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'new-agent-title',
    // Flex column + a cap on height keeps the header and footer pinned while
    // only the body scrolls.
    style: { display: 'flex', flexDirection: 'column', maxHeight: '86vh' },
  },
    h('div', { class: 'modal-head', style: { flex: '0 0 auto' } },
      h('h2', { class: 'modal-title', id: 'new-agent-title' }, 'New agent'),
      modalCloseButton()),
    form,
    h('div', { class: 'modal-foot', style: { flex: '0 0 auto' } }, cancelBtn, submitBtn));

  // The submit button lives in the footer, outside the <form> element, so it is
  // wired to the form explicitly rather than relying on implicit submission.
  submitBtn.setAttribute('form', 'new-agent-form');

  clear(modalRoot);
  modalRoot.appendChild(modal);
  modalRoot.hidden = false;
  releaseTrap = trapFocus(modal, name.input);

  function validate() {
    let first = null;
    const check = (f, message) => {
      f.setError(message);
      if (message && !first) first = f;
    };
    check(name, !name.input.value.trim() ? 'A name is required — it is how you will find this agent in the tree.' : null);
    check(task, !task.input.value.trim() ? 'A one-line task is required.' : null);
    const needsCwd = runtime.input.value === 'external' || !repo.input.value.trim();
    check(cwd, needsCwd && !cwd.input.value.trim()
      ? 'Give a working directory, or a repo below to create a worktree from.'
      : null);
    if (first) {
      errEl.hidden = false;
      setText(errEl, 'Fix the highlighted field' + (first === name ? '' : 's') + ' and try again.');
      first.input.focus();
      return false;
    }
    errEl.hidden = true;
    return true;
  }

  /** Point the server's message at the field it is about, when it names one. */
  function blame(message) {
    const m = String(message || '').toLowerCase();
    if (m.includes('name')) return name;
    if (m.includes('task')) return task;
    if (m.includes('repo') || m.includes('worktree') || m.includes('git')) return repo;
    if (m.includes('cwd') || m.includes('working directory') || m.includes('folder')) return cwd;
    if (m.includes('parent')) return parentSel;
    if (m.includes('runtime') || m.includes('harness')) return runtime;
    if (m.includes('role')) return role;
    return null;
  }

  async function submit() {
    if (submitBtn.disabled || !validate()) return;
    const payload = {
      name: name.input.value.trim(),
      role: role.input.value,
      runtime: runtime.input.value,
      task: task.input.value.trim(),
      autoStart: runtime.input.value !== 'external' && autoStart.checked,
    };
    if (cwd.input.value.trim()) payload.cwd = cwd.input.value.trim();
    if (parentSel.input.value) payload.parentId = parentSel.input.value;
    if (model.input.value.trim()) payload.model = model.input.value.trim();
    if (!effort.el.hidden && effort.input.value) payload.effort = effort.input.value;
    if (runtime.input.value === 'external') {
      payload.transcriptRuntime = provider.input.value;
      if (session.input.value.trim()) payload.sessionId = session.input.value.trim();
    }
    if (brief.input.value.trim()) payload.brief = brief.input.value.trim();
    if (runtime.input.value !== 'external' && repo.input.value.trim()) {
      payload.worktree = { repo: repo.input.value.trim() };
      if (branch.input.value.trim()) payload.worktree.branch = branch.input.value.trim();
    }

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
    errEl.hidden = true;
    try {
      const agent = await api.createAgent(payload);
      if (agent && agent.id) {
        upsertAgent(agent);
        closeForm();
        toast(`Agent "${agent.name || agent.id}" created.`, 'ok');
        select(agent.id);
      } else {
        closeForm();
        toast('Agent created.', 'ok');
      }
    } catch (err) {
      // The server's own words, verbatim, where the operator is looking.
      const message = err && err.message ? err.message : String(err);
      errEl.hidden = false;
      setText(errEl, err && err.status ? `The server refused this (${err.status}): ${message}` : message);
      const f = blame(message);
      if (f) { f.setError(message); f.input.focus(); }
      else errEl.scrollIntoView({ block: 'nearest' });
    } finally {
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = 'Create agent';
    }
  }
}

/**
 * A labelled field. The label is bound to its control with for/id (clicking the
 * label focuses the input, and a screen reader announces it), and each field
 * owns its own error line, wired through aria-describedby.
 *
 * `extra` is an optional trailing control (used for the folder-picker button);
 * it is laid out beside the input in a flex row without becoming the labelled
 * control itself.
 */
function field(label, input, hint, full, required, extra) {
  const id = 'na-' + (++uid);
  input.id = id;
  if (required) input.setAttribute('aria-required', 'true');
  const hintEl = hint ? h('span', { class: 'hint', id: id + '-hint' }, hint) : null;
  const errEl = h('span', { class: 'field-error', id: id + '-err', hidden: true });
  const describedBy = [hintEl ? id + '-hint' : null].filter(Boolean);
  if (describedBy.length) input.setAttribute('aria-describedby', describedBy.join(' '));
  const control = extra
    ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'stretch' } }, input, extra)
    : input;
  const el = h('div', { class: 'field' + (full ? ' field-full' : '') },
    h('label', { for: id }, label, required ? h('span', { class: 'req', title: 'required' }, ' *') : null),
    control, hintEl, errEl);
  return {
    el, input,
    setError(message) {
      errEl.hidden = !message;
      setText(errEl, message || '');
      if (message) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', [id + '-err'].concat(describedBy).join(' '));
        el.dataset.invalid = '1';
      } else {
        input.removeAttribute('aria-invalid');
        if (describedBy.length) input.setAttribute('aria-describedby', describedBy.join(' '));
        else input.removeAttribute('aria-describedby');
        delete el.dataset.invalid;
      }
    },
  };
}

/**
 * A labelled control for the handoff dialog. `control` is either an element or
 * a dropdown from ui/lib/dropdown.js; the label points at the real focusable
 * node either way, so clicking the label focuses the control and a screen
 * reader announces the field name together with it.
 */
function labelledField(label, control) {
  const labelId = 'na-' + (++uid);
  const input = control.trigger || control;
  if (!input.id) input.id = 'na-' + (++uid);
  const el = h('div', { class: 'field' },
    h('label', { id: labelId, for: input.id }, label),
    control.el || control);
  if (control.list) control.list.setAttribute('aria-labelledby', labelId);
  return { el, input };
}

/** A provider change creates a successor; it never rewrites a transcript. */
export function openHandoff(agent, { live } = {}) {
  if (!modalRoot) return;
  const cfg = getConfig() || {};
  const submitState = handoffSubmitState(agent, { live });
  const providers = runtimeNames(cfg).filter((r) => ['claude', 'codex'].includes(r));

  // Provider and effort are real listbox popups (ui/lib/dropdown.js) so they
  // read as the modal's own controls and still carry the full keyboard
  // contract. The provider change rebuilds the effort list, exactly as the
  // new-agent form does for its runtimes.
  const runtime = createDropdown({
    options: providers.map((r) => ({ value: r, label: cfg.runtimes?.[r]?.label || r })),
    value: continuationProvider(agent, providers),
    ariaLabel: 'Continue with',
    onChange: () => sync(),
  });
  const modelInput = h('input', { name: 'model', type: 'text', autocomplete: 'off' });
  const effort = createDropdown({ options: [], value: '', ariaLabel: 'Effort' });

  const start = h('input', { type: 'checkbox', id: 'handoff-start' });
  const error = h('div', { class: 'error-box', role: 'alert', hidden: true });
  // The live-session state is not just a server secret: say it up front, name
  // the control that fixes it, and say that nothing here stops it for you.
  const noticeId = 'na-' + (++uid);
  const notice = h('div', {
    class: 'panel-warn handoff-notice', id: noticeId, role: 'note',
    hidden: !submitState.notice,
  }, submitState.notice || '');
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create continuation');
  if (submitState.disabled) {
    submit.disabled = true;
    submit.setAttribute('aria-disabled', 'true');
    submit.title = submitState.title;
    submit.setAttribute('aria-describedby', noticeId);
  }

  /** Point the model default and the effort list at the chosen provider. */
  function sync() {
    const defaults = cfg.runtimes?.[runtime.value]?.defaults || {};
    modelInput.value = '';
    modelInput.placeholder = defaults.model || 'runtime default';
    effort.setOptions([
      { value: '', label: '— default —' },
      ...runtimeEfforts(cfg, runtime.value).map((v) => ({ value: v, label: v })),
    ], '');
  }
  sync();

  const formId = 'handoff-form';
  const form = h('form', {
    class: 'modal-body', id: formId, novalidate: true,
    // Flex column with a capped height: the head and the action row stay
    // pinned while only the body scrolls, matching the New agent dialog.
    style: { overflowY: 'auto', flex: '1 1 auto', minHeight: '0' },
  },
    h('p', { class: 'hint' }, `Continue “${agent.name || agent.id}” in a new agent with the same task and working directory. Its recovery brief includes prior reports. The original history stays available. Stop any live terminal first.`),
    notice,
    error,
    h('div', { class: 'form-grid' },
      labelledField('Continue with', runtime).el,
      labelledField('Model', modelInput).el,
      labelledField('Effort', effort).el),
    h('div', { class: 'field field-full' },
      h('label', { class: 'check-label handoff-check', for: start.id },
        start,
        h('span', { class: 'check-copy' },
          h('span', { class: 'check-text' }, 'Start the new agent immediately'),
          h('span', { class: 'check-hint' }, 'The continuation is created either way; this only launches it now.')))));

  const foot = h('div', { class: 'modal-foot handoff-foot', style: { flex: '0 0 auto' } },
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeForm }, 'Cancel'),
    submit);

  const modal = h('div', {
    class: 'modal handoff-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'handoff-title',
    style: { display: 'flex', flexDirection: 'column', maxHeight: '86vh' },
  },
    h('div', { class: 'modal-head', style: { flex: '0 0 auto' } },
      h('h2', { id: 'handoff-title', class: 'modal-title' }, 'Choose LLM'),
      modalCloseButton()),
    form, foot);
  if (submitState.notice) modal.setAttribute('aria-describedby', noticeId);
  // The action row sits outside the <form>, so the submit is wired to it.
  submit.setAttribute('form', formId);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    const payload = handoffPayload({
      runtime: runtime.value,
      model: modelInput.value.trim(),
      effort: effort.value,
      autoStart: start.checked,
    });
    try {
      const next = await api.handoff(agent.id, payload);
      if (!next?.id) throw new Error('The server did not return the continuation agent.');
      upsertAgent(next); closeForm(); select(next.id);
      toast(start.checked ? 'Continuation started.' : 'Continuation created. Use Restart in Extra when ready.', 'ok');
    } catch (err) {
      // The server's own words, verbatim: a 409 that beats the disabled state
      // must never be replaced by a friendlier client-side paraphrase.
      setText(error, err && err.message ? err.message : String(err));
      error.hidden = false;
    } finally {
      // Re-apply the live rule rather than blindly re-enabling the button.
      submit.disabled = submitState.disabled;
    }
  });

  closeForm(); clear(modalRoot); modalRoot.appendChild(modal); modalRoot.hidden = false;
  releaseTrap = trapFocus(modal, runtime.trigger);
}
