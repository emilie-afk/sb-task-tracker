// Server configuration. Every check fails closed: a missing or malformed setting disables the feature
// that needs it instead of falling back to something weaker.
import { HttpError } from "./http";

export function appSecret() {
  const s = process.env.APP_SECRET ?? "";
  if (s.length < 32) throw new HttpError(503, "misconfigured", "The service is not configured.");
  return s;
}

/** Exact https origin of the app (http only for local development on localhost). */
export function appOrigin(): string {
  const raw = (process.env.APP_BASE_URL ?? "").trim();
  try {
    const u = new URL(raw);
    const localDev = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && !isDeployed();
    if ((u.protocol !== "https:" && !localDev) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error();
    return u.origin;
  } catch {
    throw new HttpError(503, "misconfigured", "The service is not configured.");
  }
}

export const isDeployed = () => !!process.env.NETLIFY || process.env.CONTEXT === "production" || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

export function googleClient() {
  const id = process.env.GOOGLE_CLIENT_ID ?? "", secret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) || secret.length < 10) throw new HttpError(503, "misconfigured", "Sign-in is not configured.");
  return { id, secret };
}

export const redirectUri = () => `${appOrigin()}/api/auth/callback`;

export function instanceId() {
  const v = (process.env.TRACKER_INSTANCE_ID ?? "").trim();
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(v) ? v : null;
}

/** Dashboard business ids an administrator may map a brand to. Default: the dashboard's current businesses. */
export function supportedDashboardBusinesses(): string[] {
  const raw = (process.env.DASHBOARD_BUSINESS_IDS ?? "sb,p2s,perksradar").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set(raw.filter((s) => /^[a-z0-9_-]{1,40}$/.test(s)))];
}
