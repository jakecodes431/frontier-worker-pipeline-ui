// Remove-agent contract for the hierarchy's context menu.
//
// This is the sibling of ui/lib/stop.js: the decision (may this agent be
// removed?), the confirmation copy and the refusal state machine are kept pure
// so they can be asserted without a browser. The DOM menu lives in
// ui/lib/contextmenu.js; the hierarchy wires both to the existing lifecycle
// endpoint:
//   DELETE /api/agents/:id
//
// The server refuses with HTTP 409 while the agent still has a live terminal
// and, on success, re-parents the deleted agent's children to its parent before
// deleting the record. Nothing here invents a second removal path, and a
// failure is returned, never swallowed: the caller keeps the previous state and
// surfaces the server's own message.

import { agentIsLive } from '../views/newagent.js';

/**
 * Whether the Remove action may run for this agent, and why not when it may not.
 * It mirrors the server's own refusal exactly: `DELETE /api/agents/:id` answers
 * 409 only while a live terminal still owns the record, so a finished, stopped,
 * queued or external agent is removable and a live one is not. The reason is the
 * server's sentence, so the disabled menu item and the 409 cannot disagree.
 */
export function removeAvailability(agent = {}) {
  if (!agent || !agent.id) return { disabled: true, reason: 'No agent selected.', live: false };
  if (agentIsLive(agent)) {
    return {
      disabled: true,
      reason: `"${agent.name || agent.id}" still has a live terminal — stop it first, then remove it.`,
      live: true,
    };
  }
  return { disabled: false, reason: null, live: false };
}

/**
 * The confirmation shown before a removal. It always names the agent, and it
 * says plainly what leaves and what does not: the record and its message
 * history go, while the children are re-parented — not removed — and the
 * worktree, branch and CLI transcript stay on disk. The word "remove" must never
 * imply the children go too.
 */
export function removeConfirmation(agent = {}) {
  const name = agent.name || agent.id || 'this agent';
  return `Remove "${name}" from the board?\n\nThis deletes the agent record and its message history. Its children are re-parented to its parent, not removed — they stay on the board. Its worktree, branch and CLI transcript are left on disk.`;
}

/**
 * Run the removal: confirm, then call DELETE /api/agents/:id. On success
 * `onSettled(agent, null)` runs so the caller can drop the row; on refusal
 * `onSettled(agent, error)` runs so the caller can show the server's message and
 * leave the record alone. A disabled or cancelled removal never calls the API,
 * and nothing is painted removed before the server confirms — success is only
 * ever claimed for a request that came back.
 *
 * `action` and `confirm` are injected so the whole branch — including the API
 * refusal — is testable without a DOM.
 */
export async function requestRemove(agent, { action, confirm, onSettled } = {}) {
  const availability = removeAvailability(agent);
  if (availability.disabled) return { ok: false, disabled: true, reason: availability.reason };
  if (typeof confirm === 'function' && !confirm(removeConfirmation(agent))) return { ok: false, cancelled: true };
  try {
    await action(agent.id);
    if (typeof onSettled === 'function') onSettled(agent, null);
    return { ok: true, agent };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    if (typeof onSettled === 'function') onSettled(agent, err);
    return { ok: false, error, agent };
  }
}
