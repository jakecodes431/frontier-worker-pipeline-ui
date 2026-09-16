// HTTP client for the Control Room contract (docs/API.md).
// Every call resolves to parsed JSON or throws an ApiError carrying the status.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { body, headers } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...(headers || {}) } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(`network error: ${err && err.message ? err.message : err}`, 0, null);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  state:        ()            => request('GET', '/api/state'),
  usage:        ()            => request('GET', '/api/usage'),

  createAgent:  (payload)     => request('POST', '/api/agents', { body: payload }),
  agent:        (id)          => request('GET', `/api/agents/${enc(id)}`),
  deleteAgent:  (id)          => request('DELETE', `/api/agents/${enc(id)}`),

  send:         (id, text, sender = 'human') =>
                  request('POST', `/api/agents/${enc(id)}/send`, { body: { text }, headers: { 'X-Sender': sender } }),
  input:        (id, data)    => request('POST', `/api/agents/${enc(id)}/input`, { body: { data } }),
  control:      (id, holder)  => request('POST', `/api/agents/${enc(id)}/control`, { body: { holder } }),
  action:       (id, action)  => request('POST', `/api/agents/${enc(id)}/action`, { body: { action } }),
  status:       (id, status, note) =>
                  request('POST', `/api/agents/${enc(id)}/status`, { body: note ? { status, note } : { status } }),
  report:       (id, text)    => request('POST', `/api/agents/${enc(id)}/report`, { body: { text } }),

  inbox:        (id)          => request('GET', `/api/agents/${enc(id)}/inbox`),
  messages:     (id)          => request('GET', `/api/agents/${enc(id)}/messages`),
  chat:         (id)          => request('GET', `/api/agents/${enc(id)}/chat`),
  diff:         (id)          => request('GET', `/api/agents/${enc(id)}/diff`),
  files:        (id)          => request('GET', `/api/agents/${enc(id)}/files`),
  file:         (id, path)    => request('GET', `/api/agents/${enc(id)}/file?path=${enc(path)}`),
  logs:         (id)          => request('GET', `/api/agents/${enc(id)}/logs`),
  scrollback:   (id)          => request('GET', `/api/agents/${enc(id)}/scrollback`),
};

export default api;
