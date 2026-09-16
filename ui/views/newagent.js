// "New agent" modal — POST /api/agents.
//
// The form validates before it posts (so a typo does not cost a round trip)
// and, when the server refuses anyway, shows the server's own message inline
// above the fields AND against the field it names. Nothing here fails silently:
// every path ends in either a created agent or a visible reason.

import { h, clear, toast, setText, trapFocus } from '../lib/dom.js';
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
const ROLES = ['cto', 'orchestrator', 'worker'];
const NAME_MAX = 200;
const TASK_MAX = 2000;

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
    if (ev.key === 'Escape' && !modalRoot.hidden) { ev.preventDefault(); ev.stopPropagation(); closeForm(); }
  }, true);
}

function closeForm() {
  if (!modalRoot) return;
  modalRoot.hidden = true;
  clear(modalRoot);
  if (releaseTrap) { releaseTrap(); releaseTrap = null; }
}

function openForm() {
  const cfg = getConfig() || {};
  const agents = treeOrder(getAgents()).map((e) => e.agent);

  const parentSel = field('Parent', h('select', { name: 'parentId' },
    h('option', { value: '' }, '— none (root / CTO) —'),
    ...agents.map((a) => h('option', { value: a.id }, `${a.role || '?'} · ${a.name || a.id}`))),
    'Leave empty to create a root agent.', true);

  const name = field('Name', h('input', { type: 'text', name: 'name', maxlength: String(NAME_MAX), placeholder: 'tags orchestrator', autocomplete: 'off' }), null, false, true);
  const role = field('Role', h('select', { name: 'role' }, ...ROLES.map((r) => h('option', { value: r }, r))));
  const runtime = field('Runtime', h('select', { name: 'runtime' }, ...runtimeNames(cfg).map((r) => h('option', { value: r }, cfg.runtimes?.[r]?.label || r))),
    'Claude, Codex and DeepSeek launch local CLI processes. External registers an existing session.');
  const model = field('Model', h('input', { type: 'text', name: 'model', placeholder: cfg.defaultModel || 'runtime default', autocomplete: 'off' }));
  const effort = field('Effort', h('select', { name: 'effort' }));
  const provider = field('Session provider', h('select', { name: 'transcriptRuntime' }, h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex')));
  const session = field('Session ID', h('input', { name: 'sessionId', type: 'text', autocomplete: 'off', placeholder: 'Existing CLI session ID' }), 'Links the existing local transcript and usage. External sessions do not have a terminal here.', true);
  const task = field('Task', h('input', { type: 'text', name: 'task', maxlength: String(TASK_MAX), placeholder: 'one-line task', autocomplete: 'off' }), null, true, true);
  const cwd = field('Working directory', h('input', { type: 'text', name: 'cwd', placeholder: cfg.defaultCwd || 'absolute path to the folder the agent runs in', autocomplete: 'off' }),
    'Ignored when a repo is given below: the agent then runs in a fresh worktree of it.', true, true);
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

  const form = h('form', { class: 'modal-body', novalidate: true, id: 'new-agent-form' },
    errEl,
    h('div', { class: 'form-grid' },
      ...fields.map((f) => f.el),
      h('fieldset', { class: 'fieldset-sub' },
        h('legend', null, 'Worktree (optional)'),
        repo.el, branch.el),
      h('div', { class: 'field field-full' },
        h('label', { class: 'check-label', for: autoStart.id }, autoStart, 'Start immediately (autoStart)'))));

  form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
  // Re-validating as the operator types is the difference between "the form is
  // broken" and "this field is wrong".
  for (const f of [name, task, cwd]) f.input.addEventListener('input', () => f.setError(null));

  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'new-agent-title' },
    h('div', { class: 'modal-head' },
      h('h2', { class: 'modal-title', id: 'new-agent-title' }, 'New agent'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': 'Close this dialog (Escape)', onclick: closeForm }, 'Esc')),
    form,
    h('div', { class: 'modal-foot' }, cancelBtn, submitBtn));

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
 */
function field(label, input, hint, full, required) {
  const id = 'na-' + (++uid);
  input.id = id;
  if (required) input.setAttribute('aria-required', 'true');
  const hintEl = hint ? h('span', { class: 'hint', id: id + '-hint' }, hint) : null;
  const errEl = h('span', { class: 'field-error', id: id + '-err', hidden: true });
  const describedBy = [hintEl ? id + '-hint' : null].filter(Boolean);
  if (describedBy.length) input.setAttribute('aria-describedby', describedBy.join(' '));
  const el = h('div', { class: 'field' + (full ? ' field-full' : '') },
    h('label', { for: id }, label, required ? h('span', { class: 'req', title: 'required' }, ' *') : null),
    input, hintEl, errEl);
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

/** A provider change creates a successor; it never rewrites a transcript. */
export function openHandoff(agent) {
  if (!modalRoot) return;
  const cfg = getConfig() || {};
  const providers = runtimeNames(cfg).filter((r) => ['claude', 'codex'].includes(r));
  const runtime = field('Continue with', h('select', { name: 'runtime' }, ...providers.map((r) => h('option', { value: r }, cfg.runtimes?.[r]?.label || r))));
  runtime.input.value = continuationProvider(agent, providers);
  const model = field('Model', h('input', { name: 'model', type: 'text', autocomplete: 'off' }));
  const effort = field('Effort', h('select', { name: 'effort' }));
  const start = h('input', { type: 'checkbox', id: 'handoff-start' });
  const error = h('div', { class: 'error-box', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create continuation');
  const sync = () => {
    const defaults = cfg.runtimes?.[runtime.input.value]?.defaults || {};
    model.input.value = '';
    model.input.placeholder = defaults.model || 'runtime default';
    clear(effort.input);
    effort.input.append(h('option', { value: '' }, '— default —'), ...runtimeEfforts(cfg, runtime.input.value).map((v) => h('option', { value: v }, v)));
  };
  runtime.input.addEventListener('change', sync); sync();
  const form = h('form', { class: 'modal-body' },
    h('p', { class: 'hint' }, `Continue “${agent.name || agent.id}” in a new agent with the same task and working directory. Its recovery brief includes prior reports. The original history stays available. Stop any live terminal first.`),
    error, h('div', { class: 'form-grid' }, runtime.el, model.el, effort.el),
    h('label', { class: 'check-label', for: start.id }, start, 'Start the new agent immediately'),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeForm }, 'Cancel'), submit));
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'handoff-title' }, h('div', { class: 'modal-head' }, h('h2', { id: 'handoff-title', class: 'modal-title' }, 'Continue with another provider')), form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true; error.hidden = true;
    const payload = { runtime: runtime.input.value, autoStart: start.checked };
    if (model.input.value.trim()) payload.model = model.input.value.trim();
    if (effort.input.value) payload.effort = effort.input.value;
    try {
      const next = await api.handoff(agent.id, payload);
      if (!next?.id) throw new Error('The server did not return the continuation agent.');
      upsertAgent(next); closeForm(); select(next.id);
      toast(start.checked ? 'Continuation started.' : 'Continuation created. Use Restart in Extra when ready.', 'ok');
    } catch (err) { setText(error, err.message); error.hidden = false; }
    finally { submit.disabled = false; }
  });
  closeForm(); clear(modalRoot); modalRoot.appendChild(modal); modalRoot.hidden = false;
  releaseTrap = trapFocus(modal, runtime.input);
}
