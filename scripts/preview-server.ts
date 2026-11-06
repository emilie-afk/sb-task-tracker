// Local preview server: the built client (dist/) plus the same API handler as the Netlify function, with the
// production Content Security Policy. Used by scripts/dev-server.ts and the browser regression tests.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { createApp } from "../server/app";
import { sessionCookieFor } from "../server/auth";
import { isDeployed } from "../server/config";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
// Same policy as netlify.toml, so local previews catch Content Security Policy problems.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export function createPreviewServer(opts: { port: number; devLogin?: boolean; dist?: string }): Server {
  if (isDeployed()) throw new Error("the preview server is for local use only");
  const app = createApp();
  const dist = opts.dist ?? join(import.meta.dirname, "..", "dist");
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
    if (opts.devLogin && url.pathname === "/dev/login") {
      const id = url.searchParams.get("user") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) { res.writeHead(400); return res.end("user=<uuid> required"); }
      const { cookie } = await sessionCookieFor(id, new Request(url));
      res.writeHead(302, { location: "/", "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }
    if (url.pathname.startsWith("/api/")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await app(new Request(url, { method: req.method, headers: req.headers as Record<string, string>,
        body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks), duplex: "half" } as RequestInit));
      const headers: Record<string, string | string[]> = {};
      r.headers.forEach((v, k) => { headers[k] = k === "set-cookie" ? r.headers.getSetCookie() : v; });
      res.writeHead(r.status, headers);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(dist, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
}
