// Test harness: a disposable PostgreSQL database (TEST_DATABASE_URL), rebuilt from the migrations for each file.
// All people, brands and records here are fictional.
import { getPool, closePool } from "../server/db";
import { createApp } from "../server/app";
import { sessionCookieFor, csrfToken } from "../server/auth";

export const ORIGIN = "https://tracker.example.test";

export async function freshDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to a disposable database (its schema is dropped).");
  Object.assign(process.env, {
    DATABASE_URL: url, APP_BASE_URL: ORIGIN, APP_SECRET: "test-app-secret-test-app-secret-0123456789",
    GOOGLE_CLIENT_ID: "fictional-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fictional-client-secret", TRACKER_INSTANCE_ID: "tracker-test",
  });
  delete process.env.DASHBOARD_BUSINESS_IDS;
  await closePool();
  await getPool().query("drop schema public cascade; create schema public;");
  const { migrate } = await import("../scripts/migrate");
  await migrate(() => {});
}

export const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;
export const app = createApp();

export type Who = { id: string; cookie: string; csrf: string; sessionId: string };

export async function person(email: string, name: string, role: "administrator" | "staff" | "management", status: "active" | "pending" | "archived" = "active", brands: string[] = []) {
  const [u] = await q(`insert into users (email, display_name, role, status, google_sub, archived_at) values ($1,$2,$3,$4,$5,$6) returning id`,
    [email, name, role, status, status === "pending" ? null : `sub-${email}`, status === "archived" ? new Date() : null]);
  for (const b of brands) await q("insert into user_brand_access (user_id, brand_id) values ($1,$2)", [u.id, b]);
  return u.id as string;
}
export async function brand(name: string, extra: Record<string, unknown> = {}) {
  const [b] = await q("insert into brands (display_name, name_key, color, reporting_enabled, dashboard_business_id) values ($1, lower($1), $2, $3, $4) returning id",
    [name, extra.color ?? null, extra.reporting_enabled ?? false, extra.dashboard_business_id ?? null]);
  return b.id as string;
}
export async function login(userId: string): Promise<Who> {
  const s = await sessionCookieFor(userId, new Request(`${ORIGIN}/`));
  return { id: userId, cookie: s.cookie, csrf: csrfToken(s.sessionId), sessionId: s.sessionId };
}

export async function call(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (who) h.cookie = who.cookie;
  if (method !== "GET") {
    if (!("origin" in h)) h.origin = ORIGIN;
    if (who && !("x-csrf-token" in h)) h["x-csrf-token"] = who.csrf;
  }
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] ??= "application/json"; }
  const r = await app(new Request(`${ORIGIN}/api${path}`, { method, headers: h, body: payload }));
  const ct = r.headers.get("content-type") ?? "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text(), headers: r.headers };
}

export async function task(who: Who, fields: Record<string, unknown>) {
  const r = await call(who, "POST", "/tasks", { type: "adhoc", ...fields });
  if (r.status !== 200) throw new Error(`task create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.task as any;
}
export { closePool };
