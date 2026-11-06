// Approved Google sign-in with server-side, revocable sessions.
//
// - No registration: only an exact email an administrator approved (a `users` row) can sign in. There is no
//   domain-based approval.
// - The Google ID token's signature (Google JWKS), issuer, audience, expiry, issue time, authorized party,
//   verified email and nonce are checked; state is single-use and bound to the browser that started sign-in;
//   PKCE protects the code exchange; the callback address is exactly APP_BASE_URL/api/auth/callback.
// - On first successful sign-in the membership is bound to Google's stable subject; afterwards only that
//   subject can use it.
// - Sessions are random tokens in a Secure, HttpOnly, SameSite=Lax cookie. Only the token's hash is stored.
//   Every request re-checks the session, the membership status and current permissions in the database.
// - Any configuration, network or database problem fails closed: nobody is signed in.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type pg from "pg";
import { getPool, one, query, tx } from "./db";
import { HttpError } from "./http";
import { appOrigin, appSecret, googleClient, redirectUri, isDeployed } from "./config";
import { hit, clientKey, RATE } from "./rateLimit";
import { audit } from "./audit";
import { logServerError } from "./redact";

export type Role = "administrator" | "staff" | "management";
export type Session = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  /** Brands this person may read. Administrators and Management: every brand (`all`). Staff: assigned only. */
  brandIds: Set<string>;
  allBrands: boolean;
};

export const SESSION_HOURS = 12;
const STATE_MINUTES = 10;
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const sha256 = (v: string) => createHash("sha256").update(v).digest();
const b64url = (b: Buffer) => b.toString("base64url");

// ------------------------------------------------------------ cookies
function secureContext(req: Request) {
  const u = new URL(req.url);
  return !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && !isDeployed());
}
/** `__Host-` prefix (Secure, Path=/, no Domain) everywhere except plain-http local previews. */
export const sessionCookieName = (req: Request) => (secureContext(req) ? "__Host-tt_session" : "tt_session");
const bindingCookieName = (req: Request) => (secureContext(req) ? "__Host-tt_signin" : "tt_signin");

function cookie(req: Request, name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureContext(req) ? "; Secure" : ""}`;
}
export function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ------------------------------------------------------------ sessions
export async function createSession(userId: string, db: pg.PoolClient | pg.Pool = getPool()) {
  const token = b64url(randomBytes(32));
  const row = (await db.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(hours => $3)) returning id`,
    [sha256(token), userId, SESSION_HOURS])).rows[0];
  return { token, sessionId: row.id as string };
}

/** CSRF token for a session: an HMAC of the session id, so it is never stored and changes with every session. */
export const csrfToken = (sessionId: string) => createHmac("sha256", appSecret()).update(`csrf:${sessionId}`).digest("base64url");
export function csrfValid(sessionId: string, presented: string | null) {
  if (!presented || presented.length > 100) return false;
  const want = Buffer.from(csrfToken(sessionId));
  const got = Buffer.from(presented);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * The signed-in session, or null. Fails closed: a database error is raised (the request fails) rather than
 * treated as a sign-in. Only active memberships with an unexpired, unrevoked session qualify, and brand access
 * is read fresh, so archival, disabling and permission changes take effect on the next request.
 */
export async function readSession(req: Request): Promise<Session | null> {
  const token = readCookies(req)[sessionCookieName(req)];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await one<any>(
    `select s.id session_id, u.id user_id, u.email, u.display_name, u.role, s.last_seen_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`, [sha256(token)]);
  if (!row) return null;
  const allBrands = row.role === "administrator" || row.role === "management";
  const brandIds = new Set<string>();
  if (!allBrands) for (const b of await query<{ brand_id: string }>("select brand_id from user_brand_access where user_id = $1", [row.user_id])) brandIds.add(b.brand_id);
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) await query("update sessions set last_seen_at = now() where id = $1", [row.session_id]);
  return { sessionId: row.session_id, userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role, brandIds, allBrands };
}

export async function revokeSession(sessionId: string, reason: string) {
  await query("update sessions set revoked_at = now(), revoke_reason = $2 where id = $1 and revoked_at is null", [sessionId, reason]);
}
export async function revokeAllSessions(userId: string, reason: string, db: pg.PoolClient | pg.Pool = getPool()) {
  const r = await db.query("update sessions set revoked_at = now(), revoke_reason = $2 where user_id = $1 and revoked_at is null", [userId, reason]);
  return r.rowCount ?? 0;
}

// ------------------------------------------------------------ Google sign-in
function pkceChallenge(verifier: string) { return b64url(createHash("sha256").update(verifier).digest()); }

export async function loginRedirect(req: Request): Promise<Response> {
  await hit({ bucket: `login:${clientKey(req)}`, ...RATE.login });
  const client = googleClient();
  const callback = redirectUri();
  const state = b64url(randomBytes(32)), nonce = b64url(randomBytes(24)), verifier = b64url(randomBytes(48)), binding = b64url(randomBytes(32));
  await query("delete from oauth_states where expires_at < now()");
  await query(`insert into oauth_states (state_hash, nonce, code_verifier, browser_hash, expires_at) values ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
    [sha256(state), nonce, verifier, sha256(binding), STATE_MINUTES]);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", client.id);
  u.searchParams.set("redirect_uri", callback);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return new Response(null, { status: 302, headers: { location: u.toString(), "set-cookie": cookie(req, bindingCookieName(req), binding, STATE_MINUTES * 60), "cache-control": "no-store" } });
}

type IdClaims = { sub?: unknown; email?: unknown; email_verified?: unknown; nonce?: unknown; azp?: unknown; name?: unknown };

/** Verifies a Google ID token. Overridable in tests (no network). */
let verifyIdToken = async (idToken: string, clientId: string): Promise<IdClaims> =>
  (await jwtVerify(idToken, GOOGLE_JWKS, { issuer: GOOGLE_ISSUERS, audience: clientId, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "iss", "aud"], clockTolerance: 60 })).payload as IdClaims;
export function _setIdTokenVerifierForTests(f: typeof verifyIdToken | null) {
  verifyIdToken = f ?? (async (t, c) => (await jwtVerify(t, GOOGLE_JWKS, { issuer: GOOGLE_ISSUERS, audience: c, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "iss", "aud"], clockTolerance: 60 })).payload as IdClaims);
}
let tokenFetch: typeof fetch = (u, i) => fetch(u, i);
export function _setTokenFetchForTests(f: typeof fetch | null) { tokenFetch = f ?? ((u, i) => fetch(u, i)); }

/** Generic outcome only: the browser never learns whether an email is approved, archived or unknown. */
function signinFailed(req: Request, origin: string | null) {
  const headers = new Headers({ location: `${origin ?? ""}/?signin=failed`, "cache-control": "no-store" });
  headers.append("set-cookie", cookie(req, bindingCookieName(req), "", 0));
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(req: Request): Promise<Response> {
  let origin: string | null = null;
  try {
    origin = appOrigin();
    await hit({ bucket: `callback:${clientKey(req)}`, ...RATE.callback });
    const client = googleClient();
    const url = new URL(req.url);
    const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 2048) return signinFailed(req, origin);
    // Single use: the state row is deleted as it is read.
    const st = await one<{ nonce: string; code_verifier: string; browser_hash: Buffer }>(
      "delete from oauth_states where state_hash = $1 and expires_at > now() returning nonce, code_verifier, browser_hash", [sha256(state)]);
    const binding = readCookies(req)[bindingCookieName(req)] ?? "";
    if (!st || !binding || !timingSafeEqual(sha256(binding), Buffer.from(st.browser_hash))) return signinFailed(req, origin);

    const tokenRes = await tokenFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: st.code_verifier }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return signinFailed(req, origin);
    const tok = (await tokenRes.json()) as { id_token?: unknown };
    if (typeof tok.id_token !== "string") return signinFailed(req, origin);
    const claims = await verifyIdToken(tok.id_token, client.id);
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (claims.nonce !== st.nonce || claims.email_verified !== true || !email || !sub || sub.length > 255) return signinFailed(req, origin);
    if (claims.azp !== undefined && claims.azp !== client.id) return signinFailed(req, origin);

    const session = await tx(async (c) => {
      const u = (await c.query("select id, status, google_sub from users where email = $1 for update", [email])).rows[0];
      if (!u || u.status === "archived") return null;
      if (u.google_sub && u.google_sub !== sub) return null;              // bound to another Google account
      if (!u.google_sub) {
        const taken = (await c.query("select 1 from users where google_sub = $1 and id <> $2", [sub, u.id])).rows[0];
        if (taken) return null;
      }
      await c.query(`update users set google_sub = $2, status = 'active', last_sign_in_at = now(), updated_at = now(),
                       version = version + case when status = 'pending' then 1 else 0 end where id = $1`, [u.id, sub]);
      const s = await createSession(u.id, c);
      await audit(c, u.id, u.status === "pending" ? "auth.first_sign_in" : "auth.sign_in", "user", u.id);
      return s;
    });
    if (!session) return signinFailed(req, origin);
    const headers = new Headers({ location: `${origin}/`, "cache-control": "no-store" });
    headers.append("set-cookie", cookie(req, sessionCookieName(req), session.token, SESSION_HOURS * 3600));
    headers.append("set-cookie", cookie(req, bindingCookieName(req), "", 0));
    return new Response(null, { status: 302, headers });
  } catch (e) {
    if (!(e instanceof HttpError)) logServerError("auth-callback", e);
    return signinFailed(req, origin);
  }
}

export async function logoutResponse(req: Request, session: Session | null): Promise<Response> {
  if (session) {
    await revokeSession(session.sessionId, "sign_out");
    await audit(null, session.userId, "auth.sign_out", "user", session.userId);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store, private", "set-cookie": cookie(req, sessionCookieName(req), "", 0) },
  });
}

/** Test and local-development helper: a session cookie header for a user id. Never routed in the deployed app. */
export async function sessionCookieFor(userId: string, req = new Request("http://localhost/")) {
  const s = await createSession(userId);
  return { cookie: `${sessionCookieName(req)}=${s.token}`, sessionId: s.sessionId };
}
