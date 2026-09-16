// The hierarchy's agent context menu: one small, app-wide menu, opened by
// right-click or by the keyboard (ContextMenu key / Shift+F10) on a row or
// card. It is a real ARIA menu — roving focus with Up/Down/Home/End,
// Enter/Space to activate, Escape/Tab to close, and click-outside to dismiss —
// and it is portal'd to <body> so a scrolling column can never clip it.
//
// It renders the items from ui/lib/stop.js and calls back with (action, agent).
// It never performs an action itself; the hierarchy owns the API call.

import { h } from './dom.js';
import { agentMenuItems } from './stop.js';

let open = null;

/** Pure roving-index math for the menu, so the keyboard contract is testable. */
export function nextMenuIndex(count, current, key) {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp': return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return current;
  }
}

export function isAgentMenuOpen() { return Boolean(open); }

function close(restoreFocus) {
  if (!open) return false;
  const { el, anchor, onKey, onPointer, onDismiss } = open;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onPointer, true);
  window.removeEventListener('resize', onDismiss);
  window.removeEventListener('blur', onDismiss);
  el.remove();
  open = null;
  if (restoreFocus && anchor && anchor.isConnected && typeof anchor.focus === 'function') {
    try { anchor.focus(); } catch { /* the row is gone */ }
  }
  return true;
}

/** Close the open menu. `restoreFocus` returns focus to the row that opened it. */
export function closeAgentMenu({ restoreFocus = false } = {}) { return close(restoreFocus); }

/**
 * Open the menu for one agent at a viewport position (a pointer position, or the
 * anchor's own box for a keyboard open). Returns the menu element, or null when
 * there is nothing to show.
 */
export function openAgentMenu({ x = 0, y = 0, anchor = null, agent, onSelect } = {}) {
  close(false);
  if (!agent || !agent.id) return null;
  const items = agentMenuItems(agent);
  if (!items.length) return null;

  const el = h('div', {
    class: 'agent-menu', role: 'menu', tabindex: '-1',
    'aria-label': `Actions for ${agent.name || agent.id}`,
  });

  for (const item of items) {
    const button = h('button', {
      type: 'button',
      class: 'agent-menu-item' + (item.danger ? ' is-danger' : ''),
      role: 'menuitem',
      disabled: item.disabled ? true : null,
      title: item.reason || null,
      onclick: () => {
        if (item.disabled) return;
        close(true);
        if (typeof onSelect === 'function') onSelect(item.action, agent);
      },
    }, h('span', { class: 'agent-menu-label' }, item.label));
    el.appendChild(button);
  }
  document.body.appendChild(el);

  // getBoundingClientRect needs the element in the document; clamp to the viewport.
  const box = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const enabled = () => Array.from(el.querySelectorAll('.agent-menu-item:not([disabled])'));
  let active = -1;
  const paint = () => {
    const list = enabled();
    for (const b of list) b.dataset.active = b === list[active] ? 'true' : 'false';
    const current = list[active];
    if (current) current.focus();
  };

  const onKey = (ev) => {
    if (!open) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); return; }
    if (ev.key === 'Tab') { close(true); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      active = nextMenuIndex(enabled().length, active, ev.key);
      paint();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      const current = enabled()[active];
      if (current) { ev.preventDefault(); current.click(); }
    }
  };
  const onPointer = (ev) => { if (!el.contains(ev.target)) close(false); };
  const onDismiss = () => close(false);

  open = { el, anchor, onKey, onPointer, onDismiss };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('blur', onDismiss);

  // Focus the first enabled item so the menu is keyboard-usable the moment it opens.
  const first = enabled()[0];
  if (first) { active = 0; first.dataset.active = 'true'; first.focus(); }
  else el.focus();
  return el;
}
