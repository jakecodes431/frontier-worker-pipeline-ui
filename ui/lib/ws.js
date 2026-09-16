// WebSocket transport with exponential-backoff reconnect (capped at 10s).
// Frame handlers are registered by type; `pty` frames are routed to whoever
// is currently attached (the terminal pane).

const MAX_BACKOFF_MS = 10000;
const BASE_BACKOFF_MS = 400;

export class Conn {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.state = 'connecting';       // connecting | open | closed
    this.attempt = 0;
    this.timer = 0;
    this.handlers = new Map();       // frame type -> Set<fn>
    this.stateHandlers = new Set();
    this.queue = [];                 // frames queued while not open
    this.closedByUs = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  onState(fn) {
    this.stateHandlers.add(fn);
    fn(this.state, this.attempt);
    return () => this.stateHandlers.delete(fn);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateHandlers) {
      try { fn(s, this.attempt); } catch (err) { console.error('[ws] state handler failed', err); }
    }
  }

  connect() {
    clearTimeout(this.timer);
    this.closedByUs = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.error('[ws] construction failed', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      const pending = this.queue.splice(0);
      for (const frame of pending) this.send(frame);
      this.emit('open', null);
    };

    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
      } catch (err) {
        console.warn('[ws] unparseable frame', err);
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      this.emit(frame.type, frame);
      this.emit('*', frame);
    };

    ws.onerror = () => { /* onclose always follows; nothing useful to surface here */ };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setState('closed');
      this.emit('close', null);
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    this.attempt += 1;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, this.attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(300, backoff * 0.25));
    const wait = Math.min(MAX_BACKOFF_MS, backoff + jitter);
    this.nextRetryMs = wait;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  emit(type, frame) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(frame); } catch (err) { console.error(`[ws] handler for "${type}" failed`, err); }
    }
  }

  /** Send a frame; queued (deduped by type+id for attach/resize) when offline. */
  send(frame) {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(frame));
        return true;
      } catch (err) {
        console.error('[ws] send failed', err);
      }
    }
    if (frame && (frame.type === 'attach' || frame.type === 'resize')) {
      this.queue = this.queue.filter((f) => !(f.type === frame.type && f.id === frame.id));
      this.queue.push(frame);
      if (this.queue.length > 32) this.queue.shift();
    }
    return false;
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
  }
}

export function wsUrl() {
  if (location.protocol === 'file:') return 'ws://127.0.0.1:4800/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
