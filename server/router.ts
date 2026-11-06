import type { Session, Role } from "./auth";

export type Ctx = { req: Request; url: URL; params: Record<string, string>; session: Session };
export type Handler = (ctx: Ctx) => Promise<Response | unknown>;
type Route = { method: string; re: RegExp; keys: string[]; roles: Role[]; sensitive: boolean; h: Handler };

export const ALL: Role[] = ["administrator", "staff", "management"];
export const ADMIN: Role[] = ["administrator"];
/** Roles that may change business data. Management is deliberately absent. */
export const EDITORS: Role[] = ["administrator", "staff"];

/** Default deny: a route answers only the roles it lists. */
export class Router {
  routes: Route[] = [];
  add(method: string, path: string, roles: Role[], h: Handler, sensitive = false) {
    if (method !== "GET" && roles.includes("management")) throw new Error(`management may not mutate: ${method} ${path}`);
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, roles, sensitive, h });
  }
  get = (p: string, roles: Role[], h: Handler) => this.add("GET", p, roles, h);
  post = (p: string, roles: Role[], h: Handler, sensitive = false) => this.add("POST", p, roles, h, sensitive);
  patch = (p: string, roles: Role[], h: Handler, sensitive = false) => this.add("PATCH", p, roles, h, sensitive);
  put = (p: string, roles: Role[], h: Handler, sensitive = false) => this.add("PUT", p, roles, h, sensitive);
  delete = (p: string, roles: Role[], h: Handler, sensitive = false) => this.add("DELETE", p, roles, h, sensitive);
  match(method: string, path: string) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return null; }
      return { route: r, params };
    }
    return pathMatched ? ("method" as const) : null;
  }
}
