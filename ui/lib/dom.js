// Tiny DOM helpers. No framework, no virtual DOM — just element construction
// plus a couple of utilities used by the in-place tree patcher.

/**
 * h('div', { class: 'x', onclick: fn, dataset: {...} }, ...children)
 * Children may be nodes, strings, numbers, arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) { if (dv != null) el.dataset[dk] = String(dv); }
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'hidden') el.hidden = Boolean(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/** Set textContent only when it actually changed (avoids layout churn). */
export function setText(node, text) {
  const s = String(text ?? '');
  if (node.textContent !== s) node.textContent = s;
}

/** Set an attribute only when it changed; null/undefined removes it. */
export function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const s = String(value);
  if (node.getAttribute(name) !== s) node.setAttribute(name, s);
}

/** Status chip element. */
export function chip(status) {
  const s = String(status || 'queued');
  return h('span', { class: 'chip', dataset: { status: s }, title: 'status: ' + s }, s);
}

/** Simple non-blocking toast. */
export function toast(message, kind = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: 'toast', dataset: { kind } }, String(message));
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Debounce helper for resize handlers. */
export function debounce(fn, ms) {
  let t = 0;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
