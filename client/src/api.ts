import { serverUrl } from "./socket";
import { loadAdminToken } from "./session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A JSON request to the app's server (path under serverUrl, so it works under /signup).
 * Sends the admin session when this tab has one; a guest's link rides on the box's cookie.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? loadAdminToken();
  const res = await fetch(`${serverUrl}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status);
  return body as T;
}
