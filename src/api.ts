// API client. Cookies carry the session (HttpOnly; never readable here). The CSRF token lives in memory only.
// Nothing about identity, roles, brands or business data is stored in the browser.
//
// Session generations: every signed-in session in this page gets a generation number. Ending it (confirmed
// sign-out, or the server reporting the session gone) bumps the generation, so requests still in flight from the
// old session are discarded and can never repopulate authenticated views, and no new request is sent until a
// new session starts.
let csrf = "";
let generation = 0;
let active = false;
export function startClientSession(token: string) { csrf = token; generation++; active = true; }
/** Forget all session state held in memory (the CSRF token) and invalidate in-flight requests. */
export function endClientSession() { csrf = ""; generation++; active = false; }
export const clientSessionActive = () => active;

/** A response that belongs to a session that has since ended. Callers ignore it. */
export class StaleSessionError extends Error { constructor() { super("The session ended."); } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

let onSignedOut: () => void = () => {};
export function whenSignedOut(f: () => void) { onSignedOut = f; }

export async function api<T = any>(path: string, opts: { method?: string; json?: unknown; body?: FormData } = {}): Promise<T> {
  const gen = generation;
  if (!active && path !== "/me") throw new StaleSessionError();
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-csrf-token"] = csrf;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.json); }
  else if (opts.body) body = opts.body;
  const r = await fetch(`/api${path}`, { method, headers, body, credentials: "same-origin", cache: "no-store", redirect: "error" });
  let data: any = null;
  try { data = await r.json(); } catch { /* empty or non-JSON */ }
  if (gen !== generation) throw new StaleSessionError();
  if (r.status === 401 && path !== "/me") { onSignedOut(); throw new ApiError(401, "unauthorized", "Your session ended. Sign in again."); }
  if (!r.ok) throw new ApiError(r.status, data?.error?.code ?? "error", data?.error?.message ?? "Something went wrong.", data?.error?.details);
  return data as T;
}

/** Human-readable error text, including field-level details when present. */
export function errorText(e: unknown) {
  if (e instanceof StaleSessionError) return "Signed out.";
  if (e instanceof ApiError) {
    const d = Array.isArray(e.details) ? e.details.map((x: any) => (typeof x === "string" ? x : x?.field ? `${x.field}: ${x.message}` : x?.message)).filter(Boolean) : [];
    return d.length ? `${e.message} ${d.join("; ")}` : e.message;
  }
  return "Something went wrong.";
}
