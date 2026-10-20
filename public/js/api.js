/** API client — every mutating request carries the CSRF header; 401 kicks back to login. */

let onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "x-companion": "companion" },
    credentials: "same-origin",
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (err) {
    if (onUnauthorized) onUnauthorized(err);
    throw new Error("network error — is the companion server running?");
  }

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error("logged out");
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty */ }

  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request("GET", p),
  post: (p, body) => request("POST", p, body ?? {}),
  put: (p, body) => request("PUT", p, body),
  del: (p, body) => request("DELETE", p, body ?? {}),
};

export default api;
