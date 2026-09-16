// An accessible listbox dropdown for the Choose LLM modal.
//
// `ui/styles.css` keeps the native <select> as the app's dropdown on purpose
// (the platform menu owns keyboard, touch and screen-reader behaviour), and
// that reasoning still stands for the forms. The Choose LLM modal asks for a
// popup that reads as one control with the modal's own plates, so this module
// implements the ARIA listbox pattern to the same bar instead of leaving
// appearance:none styling to guess at it:
//
//   label association, Up/Down, Home/End, Enter/Space, Escape, typeahead,
//   Tab out, click-outside close, :focus-visible, role="listbox" with
//   aria-selected + aria-activedescendant.
//
// The listbox is `tabindex="-1"`: it can take focus when opened, but it is
// never a tab stop, so it stays out of the modal's trapFocus() ring and a Tab
// press moves on to the next real control. Escape is layered: mountNewAgent's
// capture handler asks `closeOpenDropdown()` first, so one Escape closes the
// popup and a second closes the dialog.

import { h, clear, setText } from './dom.js';

let seq = 0;
const openStack = [];

/**
 * Pure listbox movement, exported so the keyboard contract can be asserted
 * without a DOM. `current` is -1 when nothing is active yet.
 */
export function nextActiveIndex(count, current, key) {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp': return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return current;
  }
}

/**
 * Pure typeahead: the next option at/after `from` whose label starts with the
 * buffer. A buffer of one repeated character ("ccc") cycles through the options
 * that start with that character rather than sticking on the same one.
 */
export function typeaheadIndex(labels, buffer, from) {
  const n = labels.length;
  if (n === 0) return -1;
  const text = String(buffer || '').toLowerCase();
  if (!text) return from < 0 ? 0 : from;
  const repeated = /^(.)\1+$/.test(text);
  const query = repeated ? text[0] : text;
  const start = from < 0 ? 0 : (repeated ? from + 1 : from);
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    if (String(labels[idx] ?? '').toLowerCase().startsWith(query)) return idx;
  }
  return from;
}

/**
 * Close the topmost open dropdown (the one the user just opened last).
 * mountNewAgent calls this from its Escape handler so Escape closes the popup
 * before it closes the dialog. Returns true when it actually closed one.
 */
export function closeOpenDropdown() {
  const top = openStack[openStack.length - 1];
  if (!top) return false;
  top.close(true);
  return true;
}

/**
 * Build a listbox dropdown.
 *
 * @param {object}   opts
 * @param {string}   [opts.id]        id for the trigger (the label's `for` target)
 * @param {Array}    [opts.options]   strings or { value, label }
 * @param {string}   [opts.value]     selected value
 * @param {Function} [opts.onChange]  called with the new value, only on change
 * @param {string}   [opts.ariaLabel] fallback name when no <label> is wired
 * @returns {{ el, trigger, list, value, setOptions, setValue, open, close, toggle,
 *             focus, setDisabled, setHidden, destroy, isOpen:boolean, disabled:boolean }}
 */
export function createDropdown({ id, options = [], value = '', onChange, ariaLabel, className = '' } = {}) {
  const base = id || `dd-${++seq}`;
  const listId = `${base}-list`;

  const valueEl = h('span', { class: 'dd-value' });
  const arrowEl = h('span', { class: 'dd-arrow', 'aria-hidden': 'true' });
  const trigger = h('button', {
    type: 'button', class: 'dd-trigger', id: base,
    'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId,
  }, valueEl, arrowEl);
  if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

  const list = h('ul', {
    class: 'dd-list', role: 'listbox', id: listId, tabindex: '-1', hidden: true,
    'aria-label': ariaLabel || undefined,
  });

  const el = h('div', { class: 'dd' + (className ? ` ${className}` : '') }, trigger, list);

  let items = [];        // [{ value, label, el }]
  let selected = -1;
  let active = -1;
  let isOpen = false;
  let isDisabled = false;
  let typed = '';
  let typedAt = 0;

  const optionId = (i) => `${base}-opt-${i}`;

  /** Paint selection and the active (focused) option. */
  function paint() {
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      it.el.setAttribute('aria-selected', k === selected ? 'true' : 'false');
      it.el.setAttribute('data-active', isOpen && k === active ? 'true' : 'false');
    }
    if (isOpen && active >= 0 && items[active]) {
      list.setAttribute('aria-activedescendant', optionId(active));
      const node = items[active].el;
      if (typeof node.scrollIntoView === 'function') {
        try { node.scrollIntoView({ block: 'nearest' }); } catch { /* older engines want no options */ }
      }
    } else {
      list.removeAttribute('aria-activedescendant');
    }
  }

  /** Point the closed control at `value` (or the first option when unknown). */
  function syncValue() {
    selected = items.findIndex((it) => it.value === String(value));
    setText(valueEl, selected >= 0 ? items[selected].label : '—');
    if (!isOpen) active = selected;
  }

  /**
   * Replace the option list (the effort list changes with the provider). An
   * unknown current value falls back to the first option, so the control can
   * never be blank.
   */
  function setOptions(next, nextValue) {
    items = (next || []).map((opt, i) => {
      const isString = typeof opt === 'string';
      const v = String(isString ? opt : opt.value);
      const label = String(isString ? opt : (opt.label ?? opt.value));
      const oel = h('li', { class: 'dd-option', role: 'option', id: optionId(i), 'aria-selected': 'false' });
      setText(oel, label);
      // Keep focus on the listbox (and the active descendant) when the option
      // is clicked; the click still fires and chooses it. Both events are
      // covered so a mouse, a trackpad and a touch tap all behave the same.
      oel.addEventListener('pointerdown', (ev) => ev.preventDefault());
      oel.addEventListener('mousedown', (ev) => ev.preventDefault());
      oel.addEventListener('click', () => choose(i));
      return { value: v, label, el: oel };
    });
    clear(list);
    for (const it of items) list.appendChild(it.el);
    if (nextValue !== undefined) value = nextValue;
    if (!items.some((it) => it.value === String(value))) value = items[0] ? items[0].value : '';
    syncValue();
    paint();
    return api;
  }

  function setValue(next) {
    value = next === undefined || next === null ? '' : next;
    if (!items.some((it) => it.value === String(value))) value = items[0] ? items[0].value : '';
    syncValue();
    paint();
    return api;
  }

  function setActive(index) {
    if (!items.length) { active = -1; paint(); return; }
    active = Math.max(0, Math.min(items.length - 1, index));
    paint();
  }

  function typeahead(ch) {
    const now = Date.now();
    typed = now - typedAt > 700 ? ch : typed + ch;
    typedAt = now;
    const idx = typeaheadIndex(items.map((it) => it.label), typed, active >= 0 ? active : selected);
    if (idx < 0) return;
    if (isOpen) setActive(idx);
    else open(idx);
  }

  function choose(index) {
    if (index < 0 || !items[index]) return;
    const changed = items[index].value !== String(value);
    setValue(items[index].value);
    close(true);
    if (changed && typeof onChange === 'function') onChange(String(value));
  }

  function onDocPointerDown(ev) {
    if (!el.contains(ev.target)) close(false);
  }

  function open(initialActive) {
    if (isDisabled || isOpen || items.length === 0) return;
    isOpen = true;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    openStack.push(api);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    active = typeof initialActive === 'number'
      ? Math.max(0, Math.min(items.length - 1, initialActive))
      : (selected >= 0 ? selected : 0);
    paint();
    list.focus();
  }

  function close(refocus = true) {
    if (!isOpen) return;
    isOpen = false;
    // Move focus off the listbox *before* hiding it: hiding the focused node
    // would otherwise drop focus to <body>.
    if (refocus && !isDisabled) trigger.focus();
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    const at = openStack.indexOf(api);
    if (at >= 0) openStack.splice(at, 1);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    active = selected;
    paint();
  }

  function toggle() { if (isOpen) close(true); else open(); }

  function setDisabled(next) {
    isDisabled = Boolean(next);
    trigger.disabled = isDisabled;
    trigger.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
    if (isDisabled) close(false);
  }

  function setHidden(next) {
    el.hidden = Boolean(next);
    if (el.hidden) close(false);
  }

  trigger.addEventListener('click', (ev) => { ev.preventDefault(); toggle(); });
  trigger.addEventListener('keydown', (ev) => {
    if (isDisabled) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      if (isOpen) setActive(nextActiveIndex(items.length, active, ev.key));
      else if (ev.key === 'Home') open(0);
      else if (ev.key === 'End') open(items.length - 1);
      else if (ev.key === 'ArrowUp') open(selected < 0 ? items.length - 1 : selected);
      else open(selected < 0 ? 0 : selected);
      return;
    }
    if (ev.key === 'Escape' && isOpen) { ev.preventDefault(); close(true); return; }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      typeahead(ev.key);
    }
  });

  list.addEventListener('keydown', (ev) => {
    if (isDisabled || !isOpen) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      setActive(nextActiveIndex(items.length, active, ev.key));
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      choose(active);
      return;
    }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); return; }
    // Tab out: return focus to the trigger, then let the browser move on from
    // there (the trapFocus ring picks up the wrap at either end).
    if (ev.key === 'Tab') { close(true); return; }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      typeahead(ev.key);
    }
  });

  // If focus leaves the widget for another control, close. A null relatedTarget
  // means focus went to <body> (a click on inert space): the click-outside
  // handler below decides in that case, so a tap on an option is not lost.
  el.addEventListener('focusout', (ev) => {
    if (!isOpen) return;
    if (!ev.relatedTarget) return;
    if (el.contains(ev.relatedTarget)) return;
    close(false);
  });

  const api = {
    el, trigger, list,
    get value() { return String(value); },
    set value(next) { setValue(next); },
    get isOpen() { return isOpen; },
    get disabled() { return isDisabled; },
    setOptions, setValue, open, close, toggle,
    focus() { trigger.focus(); },
    setDisabled, setHidden,
    destroy() { close(false); },
  };

  setOptions(options, value);
  return api;
}

export default createDropdown;
