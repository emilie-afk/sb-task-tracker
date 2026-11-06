import { logServerError } from "./redact";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "invalid_request", msg, details);
export const notFound = (what = "Record") => new HttpError(404, "not_found", `${what} not found.`);
export const forbidden = (msg = "You do not have permission for this action.") => new HttpError(403, "forbidden", msg);
export const conflict = (msg = "This record was changed by someone else. Reload, then re-apply your edit.", details?: unknown) =>
  new HttpError(409, "conflict", msg, details);

/** Headers on every API response: private, never cached, never framed or sniffed. */
export const API_HEADERS: Record<string, string> = {
  "cache-control": "no-store, private",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...API_HEADERS, ...headers } });
}

/** Generic client errors. Database and internal error text never reaches the client. */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const retry = (e as any).retryAfter;
    return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status, retry ? { "retry-after": String(retry) } : {});
  }
  const pg = e as { code?: string };
  if (pg?.code === "23505") return json({ error: { code: "duplicate", message: "A matching record already exists." } }, 409);
  if (pg?.code === "40001" || pg?.code === "40P01") return json({ error: { code: "conflict", message: "Another change happened at the same time. Try again." } }, 409);
  if (["23514", "23503", "22P02", "22007", "22008", "22001"].includes(pg?.code ?? ""))
    return json({ error: { code: "constraint", message: "The data did not pass validation." } }, 422);
  logServerError("api", e);
  return json({ error: { code: "server_error", message: "Something went wrong on the server. Nothing was saved." } }, 500);
}

export const LIMITS = { jsonBytes: 256 * 1024, importJsonBytes: 5 * 1024 * 1024, uploadBytes: 1024 * 1024 };

async function readLimitedText(req: Request, maxBytes: number) {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "too_large", "Request body is too large.");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new HttpError(413, "too_large", "Request body is too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a JSON object body (content-type must be JSON, size bounded). */
export async function readJson(req: Request, maxBytes = LIMITS.jsonBytes): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Send JSON.");
  const text = await readLimitedText(req, maxBytes);
  let v: unknown;
  try { v = text ? JSON.parse(text) : {}; } catch { throw badRequest("Body must be valid JSON."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw badRequest("Body must be a JSON object.");
  return v as Record<string, unknown>;
}

/** Reads one uploaded file from a multipart body, bounded by size. */
export async function readUpload(req: Request, maxBytes = LIMITS.uploadBytes): Promise<{ name: string; bytes: Buffer }> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new HttpError(415, "unsupported_media_type", "Send the file as multipart form data.");
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) throw new HttpError(413, "too_large", "The file is too large.");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw badRequest("Send one file in the 'file' field.");
  if (file.size > maxBytes) throw new HttpError(413, "too_large", "The file is too large.");
  return { name: file.name.slice(0, 120), bytes: Buffer.from(await file.arrayBuffer()) };
}
