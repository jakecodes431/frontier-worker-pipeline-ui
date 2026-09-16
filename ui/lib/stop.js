// Stop-agent contract for the hierarchy's context menu.
//
// The decision (may this agent be stopped?), the confirmation copy and the
// optimistic/failure state machine are kept pure so they can be asserted
// without a browser. The DOM menu lives in ui/lib/contextmenu.js; the
// hierarchy wires both to the existing lifecycle endpoint:
//   POST /api/agents/:id/action { action: "stop" }
//
// This module also owns `agentMenuItems`, the menu's single item list, which
// puts Stop beside the Remove action defined in ui/lib/remove.js.
//
// Nothing here invents a second stop path. A failure is returned, never
// swallowed: the caller keeps the previous state and surfaces the error.

import { agentIsLive } from '../views/newagent.js';
import { removeAvailability } from './remove.js';

const TERMINAL = new Set(['done', 'failed', 'stopped']);

/**
 * Whether the Stop action may run for this agent, and why not when it may not.
 * `live` is the record's own terminal state; an external registration never has
 * one, so it can never be stopped here.
 */
export function stopAvailability(agent = {}) {
  if (!agent || !agent.id) return { disabled: true, reason: 'No agent selected.', live: false };
  if (agent.runtime === 'external') {
    return { disabled: true, reason: 'External sessions have no terminal or process to stop.', live: false };
  }
  if (agent.successorId) {
    return { disabled: true, reason: `This task already continued as ${agent.successorId}; stop that agent instead.`, live: false };
  }
  const live = agentIsLive(agent);
  const hasProcess = agent.pid != null;
  if (!live && TERMINAL.has(agent.status) && !hasProcess) {
    return { disabled: true, reason: `Nothing is running (status: ${agent.status}).`, live: false };
  }
  return { disabled: false, reason: null, live };
}

/**
 * The confirmation shown before a stop. A live/running agent gets the explicit
 * "this kills the terminal and process tree" wording the task requires; a
 * merely-recorded surviving process and an idle record get honest, smaller
 * copy instead of one alarming sentence for every case.
 */
export function stopConfirmation(agent = {}) {
  const name = agent.name || agent.id || 'this agent';
  if (agentIsLive(agent)) {
    return `Stop "${name}" now?\n\nThis kills its live terminal and process tree. Work in progress stops immediately and the agent is marked stopped. You can start it again from the panel, but unsaved work is lost.`;
  }
  if (agent.pid != null) {
    return `Stop "${name}"?\n\nIts recorded process is no longer attached to a terminal, so the control room will kill the surviving process tree and mark the agent stopped.`;
  }
  return `Stop "${name}"?\n\nThe agent is marked stopped. Nothing is running right now.`;
}

/**
 * The context-menu items for one agent: Stop first, then Remove beside it. Both
 * are destructive and both carry the honest reason when they are disabled, so
 * the menu never offers an action the server would refuse without saying why.
 */
export function agentMenuItems(agent = {}) {
  const stop = stopAvailability(agent);
  const remove = removeAvailability(agent);
  return [
    {
      id: 'stop',
      action: 'stop',
      label: 'Stop agent',
      danger: true,
      disabled: stop.disabled,
      reason: stop.reason,
    },
    {
      id: 'remove',
      action: 'remove',
      label: 'Remove from board',
      danger: true,
      disabled: remove.disabled,
      reason: remove.reason,
    },
  ];
}

/**
 * Run the stop: confirm, paint "stopping" immediately, then call the lifecycle
 * endpoint. On success `onSettled(stoppedAgent)` runs; on failure
 * `onSettled(originalAgent, error)` runs so the caller can put the old state
 * back and tell the operator. A disabled or cancelled stop never calls the API.
 *
 * `action`, `confirm` and the two callbacks are injected so the whole branch —
 * including the API failure — is testable without a DOM.
 */
export async function requestStop(agent, { action, confirm, onOptimistic, onSettled } = {}) {
  const availability = stopAvailability(agent);
  if (availability.disabled) return { ok: false, disabled: true, reason: availability.reason };
  if (typeof confirm === 'function' && !confirm(stopConfirmation(agent))) return { ok: false, cancelled: true };
  if (typeof onOptimistic === 'function') onOptimistic({ ...agent, status: 'stopping' });
  try {
    const updated = await action(agent.id, 'stop');
    const settled = updated && updated.id ? updated : { ...agent, status: 'stopped', endedAt: new Date().toISOString(), pid: null };
    if (typeof onSettled === 'function') onSettled(settled, null);
    return { ok: true, agent: settled };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    if (typeof onSettled === 'function') onSettled(agent, err);
    return { ok: false, error, agent };
  }
}
