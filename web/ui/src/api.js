const BASE = '/dashboard/api';

export function getToken() {
  return localStorage.getItem('openclaw_task_token') || '';
}

export function setToken(token) {
  localStorage.setItem('openclaw_task_token', token);
}

export function clearToken() {
  localStorage.removeItem('openclaw_task_token');
}

async function request(path, opts = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get:    (path) => request(path),
  post:   (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
  put:    (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch:  (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path) => request(path, { method: 'DELETE' }),
};
