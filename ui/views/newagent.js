// "New agent" modal — POST /api/agents.

import { h, clear, toast } from '../lib/dom.js';
import api from '../lib/api.js';
import { getAgents, getConfig, upsertAgent, select, treeOrder } from '../lib/store.js';

const RUNTIMES = ['claude', 'deepseek', 'external'];
const ROLES = ['cto', 'orchestrator', 'worker'];
const EFFORTS = ['', 'low', 'medium', 'high', 'max'];

let modalRoot = null;

export function mountNewAgent({ root, button, buttons }) {
  modalRoot = root;
  const triggers = (buttons || [button]).filter(Boolean);
  for (const b of triggers) b.addEventListener('click', openForm);
  modalRoot.addEventListener('click', (ev) => { if (ev.target === modalRoot) closeForm(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modalRoot.hidden) { ev.preventDefault(); closeForm(); }
  });
}

function closeForm() {
  if (!modalRoot) return;
  modalRoot.hidden = true;
  clear(modalRoot);
}

function openForm() {
  const cfg = getConfig() || {};
  const agents = treeOrder(getAgents()).map((e) => e.agent);

  const parentSel = h('select', { name: 'parentId' },
    h('option', { value: '' }, '— none (root / CTO) —'),
    ...agents.map((a) => h('option', { value: a.id }, `${a.role || '?'} · ${a.name || a.id}`)));

  const nameIn = h('input', { type: 'text', name: 'name', placeholder: 'quartzi-site orchestrator', required: true });
  const roleSel = h('select', { name: 'role' }, ...ROLES.map((r) => h('option', { value: r }, r)));
  roleSel.value = 'worker';
  const runtimeSel = h('select', { name: 'runtime' }, ...RUNTIMES.map((r) => h('option', { value: r }, r)));
  runtimeSel.value = 'claude';
  const modelIn = h('input', { type: 'text', name: 'model', placeholder: cfg.defaultModel || 'claude-fable-5-1' });
  const effortSel = h('select', { name: 'effort' },
    ...EFFORTS.map((e) => h('option', { value: e }, e || '— default —')));
  const taskIn = h('input', { type: 'text', name: 'task', placeholder: 'one-line task', required: true });
  const cwdIn = h('input', { type: 'text', name: 'cwd', placeholder: cfg.defaultCwd || '/path/to/your/project', required: true });
  const briefIn = h('textarea', { name: 'brief', rows: '5', placeholder: 'Full brief handed to the agent on start (optional).' });
  const repoIn = h('input', { type: 'text', name: 'repo', placeholder: 'C:/repo (optional)' });
  const branchIn = h('input', { type: 'text', name: 'branch', placeholder: 'cr/name (optional)' });
  const autoStart = h('input', { type: 'checkbox', name: 'autoStart' });
  autoStart.checked = true;

  const errEl = h('div', { class: 'error-box', hidden: true, style: { margin: '0 0 12px' } });
  const submitBtn = h('button', { class: 'btn btn-primary' }, 'Create agent');
  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeForm }, 'Cancel');

  const form = h('form', { class: 'modal-body', novalidate: true },
    errEl,
    h('div', { class: 'form-grid' },
      field('Parent', parentSel, 'Leave empty to create a root agent.', true),
      field('Name', nameIn),
      field('Role', roleSel),
      field('Runtime', runtimeSel, 'external agents are registered but not spawned.'),
      field('Model', modelIn),
      field('Effort', effortSel),
      field('Task', taskIn, null, true),
      field('Working directory', cwdIn, null, true),
      field('Brief', briefIn, null, true),
      h('fieldset', { class: 'fieldset-sub' },
        h('legend', null, 'Worktree (optional)'),
        field('Repo', repoIn),
        field('Branch', branchIn)),
      h('div', { class: 'field field-full' },
        h('label', { class: 'check-label' }, autoStart, 'Start immediately (autoStart)'))));

  form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });

  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Create a new agent' },
    h('div', { class: 'modal-head' },
      h('h2', { class: 'modal-title' }, 'New agent'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: closeForm }, 'Esc')),
    form,
    h('div', { class: 'modal-foot' }, cancelBtn, submitBtn));

  submitBtn.addEventListener('click', () => submit());

  clear(modalRoot);
  modalRoot.appendChild(modal);
  modalRoot.hidden = false;
  nameIn.focus();

  async function submit() {
    const name = nameIn.value.trim();
    const task = taskIn.value.trim();
    const cwd = cwdIn.value.trim();
    if (!name || !task || !cwd) {
      errEl.hidden = false;
      errEl.textContent = 'name, task and cwd are required.';
      return;
    }
    const payload = {
      name,
      role: roleSel.value,
      runtime: runtimeSel.value,
      task,
      cwd,
      autoStart: autoStart.checked,
    };
    if (parentSel.value) payload.parentId = parentSel.value;
    if (modelIn.value.trim()) payload.model = modelIn.value.trim();
    if (effortSel.value) payload.effort = effortSel.value;
    if (briefIn.value.trim()) payload.brief = briefIn.value.trim();
    if (repoIn.value.trim()) {
      payload.worktree = { repo: repoIn.value.trim() };
      if (branchIn.value.trim()) payload.worktree.branch = branchIn.value.trim();
    }

    submitBtn.disabled = true;
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
      errEl.hidden = false;
      errEl.textContent = 'Create failed: ' + err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create agent';
    }
  }
}

function field(label, input, hint, full) {
  return h('div', { class: 'field' + (full ? ' field-full' : '') },
    h('label', null, label),
    input,
    hint ? h('span', { class: 'hint' }, hint) : null);
}
