// Private API under /api/*. Everything except sign-in and the reporting endpoint needs a valid server session.
// Order of checks for each request:
//   1. sign-in routes (no session) and the reporting endpoint (its own credential only)
//   2. session lookup (fails closed on database errors)
//   3. for every state-changing request: exact Origin, CSRF token, Management refused, write rate limits
//   4. route match with explicit allowed roles (default deny), then the route's own record-level checks
import { Router } from "./router";
import { HttpError, errorResponse, json } from "./http";
import { readSession, loginRedirect, handleCallback, logoutResponse, csrfToken, csrfValid } from "./auth";
import { appOrigin } from "./config";
import { hit, accountKey, RATE } from "./rateLimit";
import { handleReporting } from "./reporting";
import { registerTasks } from "./routes/tasks";
import { registerPeople } from "./routes/people";
import { registerBrands } from "./routes/brands";
import { registerKpis } from "./routes/kpis";
import { registerSummaries } from "./routes/summaries";
import { registerImports } from "./routes/imports";
import { registerIntegrations } from "./routes/integrations";
import { todayVN } from "../shared/dates";

const CSRF_HEADER = "x-csrf-token";

/** Every route of the API (exported so tests can check each mutation's protection). */
export function buildRouter() {
  const r = new Router();
  registerTasks(r);
  registerPeople(r);
  registerBrands(r);
  registerKpis(r);
  registerSummaries(r);
  registerImports(r);
  registerIntegrations(r);
  return r;
}

export function createApp() {
  const r = buildRouter();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    try {
      if (path === "/auth/login" && req.method === "GET") return await loginRedirect(req);
      if (path === "/auth/callback" && req.method === "GET") return await handleCallback(req);
      if (path.startsWith("/reporting/")) return await handleReporting(req, path);

      const session = await readSession(req);
      const mutation = !["GET", "HEAD"].includes(req.method);
      if (mutation) {
        // Cookie-authenticated changes must come from this app's own pages.
        if (req.headers.get("origin") !== appOrigin()) throw new HttpError(403, "bad_origin", "Cross-site request refused.");
        if (session && !csrfValid(session.sessionId, req.headers.get(CSRF_HEADER))) throw new HttpError(403, "bad_csrf", "Your page is out of date. Reload and try again.");
      }
      if (path === "/auth/logout" && req.method === "POST") return await logoutResponse(req, session);
      if (path === "/me" && req.method === "GET") {
        // Signed out: nothing about the team, brands or directory is returned.
        if (!session) return json({ signed_in: false });
        return json({
          signed_in: true, csrf: csrfToken(session.sessionId), today: todayVN(), timezone: "Asia/Ho_Chi_Minh",
          user: { id: session.userId, email: session.email, name: session.displayName, role: session.role },
        });
      }
      if (!session) throw new HttpError(401, "unauthorized", "Sign in to continue.");
      if (mutation) {
        if (session.role === "management") throw new HttpError(403, "forbidden", "Management access is view-only.");
        await hit({ bucket: `writes:${accountKey(session.userId)}`, ...RATE.writes });
      }
      const found = r.match(req.method, path);
      if (found === null) throw new HttpError(404, "not_found", "No such endpoint.");
      if (found === "method") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      if (!found.route.roles.includes(session.role)) throw new HttpError(403, "forbidden", "You do not have permission for this action.");
      if (found.route.sensitive) await hit({ bucket: `sens:${accountKey(session.userId)}`, ...RATE.sensitive });
      const out = await found.route.h({ req, url, params: found.params, session });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
