// Sign-in, sessions and request protection. Google is simulated: no network, fictional identities only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { freshDb, q, call, person, login, app, ORIGIN, closePool } from "./helpers";
import { _setIdTokenVerifierForTests, _setTokenFetchForTests } from "../server/auth";
import { getPool } from "../server/db";

let adminId: string;
beforeAll(async () => {
  await freshDb();
  adminId = await person("admin@example.test", "Admin One", "administrator");
});
afterAll(closePool);
afterEach(() => { _setIdTokenVerifierForTests(null); _setTokenFetchForTests(null); });

/** Runs /auth/login, then the callback with the given claims, and returns the callback response. */
async function signIn(claims: Record<string, unknown> | ((nonce: string) => Record<string, unknown>), opts: { tamperState?: boolean; dropBinding?: boolean; tokenStatus?: number } = {}) {
  const start = await app(new Request(`${ORIGIN}/api/auth/login`));
  expect(start.status).toBe(302);
  const google = new URL(start.headers.get("location")!);
  expect(google.origin).toBe("https://accounts.google.com");
  expect(google.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);
  expect(google.searchParams.get("code_challenge_method")).toBe("S256");
  const nonce = google.searchParams.get("nonce")!;
  let state = google.searchParams.get("state")!;
  if (opts.tamperState) state = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
  const binding = start.headers.get("set-cookie")!.split(";")[0];
  _setTokenFetchForTests((async () => new Response(JSON.stringify({ id_token: "fake.id.token" }), { status: opts.tokenStatus ?? 200 })) as any);
  _setIdTokenVerifierForTests(async () => (typeof claims === "function" ? claims(nonce) : { ...claims, nonce: "nonce" in claims ? claims.nonce : nonce }));
  return app(new Request(`${ORIGIN}/api/auth/callback?state=${encodeURIComponent(state)}&code=abc`, { headers: opts.dropBinding ? {} : { cookie: binding } }));
}
const sessionFrom = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("__Host-tt_session=") && !c.includes("Max-Age=0"));
const ok = (email: string, sub: string) => ({ sub, email, email_verified: true, aud: "fictional-client.apps.googleusercontent.com" });

describe("signed-out and unapproved users", () => {
  it("signed out: /me says nothing about the team, and business endpoints answer 401", async () => {
    const me = await call(null, "GET", "/me");
    expect(me.body).toEqual({ signed_in: false });
    for (const p of ["/tasks", "/brands", "/directory", "/people", "/kpis", "/summaries", "/imports"]) expect((await call(null, "GET", p)).status).toBe(401);
  });
  it("an unapproved Google account cannot sign in, and the failure is generic", async () => {
    const r = await signIn(ok("stranger@example.test", "g-stranger"));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
    expect(sessionFrom(r)).toBeUndefined();
    expect((await q("select count(*)::int n from users where email = 'stranger@example.test'"))[0].n).toBe(0);
  });
  it("no domain-based approval: an unknown address at an approved person's domain is refused", async () => {
    const r = await signIn(ok("other@example.test", "g-other"));
    expect(sessionFrom(r)).toBeUndefined();
  });
});

describe("approved sign-in", () => {
  it("a pending invitation becomes active and is bound to the Google subject on first sign-in", async () => {
    const id = await person("newstaff@example.test", "New Staff", "staff", "pending");
    const r = await signIn(ok("NewStaff@Example.test", "g-newstaff"));
    expect(r.headers.get("location")).toBe(`${ORIGIN}/`);
    const cookie = sessionFrom(r)!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    const [u] = await q("select status, google_sub, last_sign_in_at from users where id = $1", [id]);
    expect(u).toMatchObject({ status: "active", google_sub: "g-newstaff" });
    expect(u.last_sign_in_at).not.toBeNull();
    const me = await app(new Request(`${ORIGIN}/api/me`, { headers: { cookie: cookie.split(";")[0] } }));
    expect((await me.json()).user).toMatchObject({ id, role: "staff" });
    // Only a hash of the session token is stored.
    const token = cookie.split(";")[0].split("=")[1];
    expect((await q("select count(*)::int n from sessions where encode(token_hash,'escape') like '%' || $1 || '%'", [token]))[0].n).toBe(0);
  });
  it("a bound membership refuses a different Google account with the same email", async () => {
    const r = await signIn(ok("newstaff@example.test", "g-impostor"));
    expect(sessionFrom(r)).toBeUndefined();
  });
  it.each([
    ["unverified email", (n: string) => ({ ...ok("admin@example.test", "sub-admin@example.test"), email_verified: false, nonce: n })],
    ["email_verified as a string", (n: string) => ({ ...ok("admin@example.test", "sub-admin@example.test"), email_verified: "true", nonce: n })],
    ["wrong nonce", () => ({ ...ok("admin@example.test", "sub-admin@example.test"), nonce: "not-the-nonce" })],
    ["missing subject", (n: string) => ({ email: "admin@example.test", email_verified: true, nonce: n })],
    ["foreign authorized party", (n: string) => ({ ...ok("admin@example.test", "sub-admin@example.test"), azp: "someone-else.apps.googleusercontent.com", nonce: n })],
  ])("rejects invalid claims: %s", async (_name, claims) => {
    const r = await signIn(claims as any);
    expect(sessionFrom(r)).toBeUndefined();
    expect(r.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
  });
  it("rejects an invalid signature, issuer, audience or expiry (verifier throws)", async () => {
    const r = await signIn((() => { throw new Error("JWTExpired"); }) as any);
    expect(sessionFrom(r)).toBeUndefined();
  });
  it("rejects a tampered state, a missing browser binding, a reused state and a failed code exchange", async () => {
    expect(sessionFrom(await signIn(ok("admin@example.test", "sub-admin@example.test"), { tamperState: true }))).toBeUndefined();
    expect(sessionFrom(await signIn(ok("admin@example.test", "sub-admin@example.test"), { dropBinding: true }))).toBeUndefined();
    expect(sessionFrom(await signIn(ok("admin@example.test", "sub-admin@example.test"), { tokenStatus: 400 }))).toBeUndefined();
    // Reuse: run a full successful sign-in, then replay the same callback.
    const start = await app(new Request(`${ORIGIN}/api/auth/login`));
    const g = new URL(start.headers.get("location")!);
    const binding = start.headers.get("set-cookie")!.split(";")[0];
    _setTokenFetchForTests((async () => new Response(JSON.stringify({ id_token: "x" }))) as any);
    _setIdTokenVerifierForTests(async () => ({ ...ok("admin@example.test", "sub-admin@example.test"), nonce: g.searchParams.get("nonce") }));
    const cb = `${ORIGIN}/api/auth/callback?state=${g.searchParams.get("state")}&code=abc`;
    expect(sessionFrom(await app(new Request(cb, { headers: { cookie: binding } })))).toBeDefined();
    expect(sessionFrom(await app(new Request(cb, { headers: { cookie: binding } })))).toBeUndefined();
  });
  it("an archived person cannot sign in", async () => {
    await person("gone@example.test", "Gone Person", "staff", "archived");
    expect(sessionFrom(await signIn(ok("gone@example.test", "sub-gone@example.test")))).toBeUndefined();
  });
  it("configuration problems fail closed", async () => {
    const saved = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect((await app(new Request(`${ORIGIN}/api/auth/login`))).status).toBe(503);
    process.env.GOOGLE_CLIENT_SECRET = saved;
    const savedBase = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "http://tracker.example.test";      // not https
    expect((await app(new Request(`${ORIGIN}/api/auth/login`))).status).toBe(503);
    process.env.APP_BASE_URL = savedBase;
  });
  it("a database failure during sign-in or session lookup never signs anyone in", async () => {
    const who = await login(adminId);
    const pool = getPool();
    const orig = pool.query.bind(pool), origConnect = pool.connect.bind(pool);
    const fail = async () => { throw Object.assign(new Error("connection terminated"), { code: "57P01" }); };
    // Start a sign-in while the database works, then break it before the callback.
    const start = await app(new Request(`${ORIGIN}/api/auth/login`));
    const g = new URL(start.headers.get("location")!);
    const binding = start.headers.get("set-cookie")!.split(";")[0];
    _setTokenFetchForTests((async () => new Response(JSON.stringify({ id_token: "x" }))) as any);
    _setIdTokenVerifierForTests(async () => ({ ...ok("admin@example.test", "sub-admin@example.test"), nonce: g.searchParams.get("nonce") }));
    (pool as any).query = fail; (pool as any).connect = fail;
    try {
      const r = await call(who, "GET", "/tasks");
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/connection terminated/);
      expect((await app(new Request(`${ORIGIN}/api/auth/login`))).status).toBe(503);
      const cb = await app(new Request(`${ORIGIN}/api/auth/callback?state=${g.searchParams.get("state")}&code=abc`, { headers: { cookie: binding } }));
      expect(cb.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
      expect(sessionFrom(cb)).toBeUndefined();
    } finally {
      (pool as any).query = orig; (pool as any).connect = origConnect;
    }
  });
});

describe("sessions", () => {
  it("sign-out revokes the server session", async () => {
    const who = await login(adminId);
    expect((await call(who, "GET", "/tasks")).status).toBe(200);
    expect((await call(who, "POST", "/auth/logout")).status).toBe(200);
    expect((await call(who, "GET", "/tasks")).status).toBe(401);
  });
  it("expired and revoked sessions are rejected", async () => {
    const who = await login(adminId);
    await q("update sessions set expires_at = now() - interval '1 minute' where id = $1", [who.sessionId]);
    expect((await call(who, "GET", "/tasks")).status).toBe(401);
    const two = await login(adminId);
    await q("update sessions set revoked_at = now() where id = $1", [two.sessionId]);
    expect((await call(two, "GET", "/tasks")).status).toBe(401);
  });
  it("revoking all sessions of a user ends every one of them", async () => {
    const staff = await person("multi@example.test", "Multi Session", "staff");
    const a = await login(staff), b = await login(staff);
    const admin = await login(adminId);
    const r = await call(admin, "POST", `/people/${staff}/revoke-sessions`);
    expect(r.body.sessions_revoked).toBe(2);
    expect((await call(a, "GET", "/tasks")).status).toBe(401);
    expect((await call(b, "GET", "/tasks")).status).toBe(401);
  });
  it("a forged or malformed session cookie is ignored", async () => {
    const r = await app(new Request(`${ORIGIN}/api/tasks`, { headers: { cookie: "__Host-tt_session=" + "A".repeat(43) } }));
    expect(r.status).toBe(401);
  });
});

describe("request protection", () => {
  it("changes need this app's exact origin and the session's CSRF token", async () => {
    const who = await login(adminId);
    expect((await call(who, "POST", "/brands", { display_name: "Fiction Co" }, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await call(who, "POST", "/brands", { display_name: "Fiction Co" }, { origin: "" })).status).toBe(403);
    expect((await call(who, "POST", "/brands", { display_name: "Fiction Co" }, { "x-csrf-token": "wrong" })).status).toBe(403);
    const other = await login(adminId);
    expect((await call(who, "POST", "/brands", { display_name: "Fiction Co" }, { "x-csrf-token": other.csrf })).status).toBe(403);
    expect((await call(who, "POST", "/brands", { display_name: "Fiction Co" })).status).toBe(200);
  });
  it("JSON endpoints refuse form posts and oversized bodies", async () => {
    const who = await login(adminId);
    expect((await call(who, "POST", "/brands", "display_name=x", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await call(who, "POST", "/tasks", { title: "x".repeat(300_000), brand_id: null })).status).toBe(413);
  });
  it("authenticated responses are private and never cached", async () => {
    const r = await call(await login(adminId), "GET", "/tasks");
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("browser-supplied identity, role or brand values grant nothing", async () => {
    const b = (await q("insert into brands (display_name, name_key) values ('Hidden Co','hidden co') returning id"))[0].id;
    const staff = await person("plain@example.test", "Plain Staff", "staff");
    const who = await login(staff);
    // Extra headers, query values and body fields claiming other identities are ignored or refused.
    const r = await call(who, "GET", `/tasks?brand=${b}&role=administrator`, undefined, { "x-user": adminId, "x-role": "administrator" });
    expect(r.body.items).toEqual([]);
    expect((await call(who, "POST", "/tasks", { title: "Sneak", brand_id: b, role: "administrator" })).status).toBe(400);
    expect((await call(who, "POST", "/tasks", { title: "Sneak", brand_id: b })).status).toBe(403);
    expect((await call(who, "POST", "/tasks", { title: "Sneak", brand_id: b, assignee_id: adminId })).status).toBe(403);
    expect((await call(who, "GET", "/people")).status).toBe(403);
  });
  it("there is no password login or demo fallback endpoint", async () => {
    for (const p of ["/auth", "/login", "/auth/password"]) expect((await call(null, "POST", p, { user: "admin", password: "x" })).status).toBeGreaterThanOrEqual(401);
    expect((await app(new Request(`${ORIGIN}/.netlify/functions/auth`, { method: "POST" }))).status).not.toBe(200);
  });
  it("sign-in is rate limited per client address", async () => {
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await app(new Request(`${ORIGIN}/api/auth/login`, { headers: { "x-nf-client-connection-ip": "203.0.113.9" } }))).status;
    expect(last).toBe(429);
  });
});
