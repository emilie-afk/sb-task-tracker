// The public repository and build: no private data, safe rendering only, no browser-held business data or
// identity, and only the built client is published.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const walk = (d: string, out: string[] = []) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
const client = walk(join(root, "src")).filter((f) => /\.(ts|html)$/.test(f)).map((f) => [f, readFileSync(f, "utf8")] as const);

describe("client code", () => {
  it("never parses strings as HTML", () => {
    for (const [f, text] of client) expect(text, f).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|new DOMParser|createContextualFragment/);
  });
  it("does not keep business data, sessions, roles, identity or brand access in browser storage", () => {
    for (const [f, text] of client) expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
  it("does not load scripts from other sites or use inline event handlers", () => {
    const html = readFileSync(join(root, "index.html"), "utf8") + readFileSync(join(root, "legacy-export.html"), "utf8");
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).not.toMatch(/<style|style="/);
  });
  it("has no hardcoded people, brands, KPI lists or demo login", () => {
    const all = client.map(([, t]) => t).join("\n") + readFileSync(join(root, "index.html"), "utf8");
    expect(all).not.toMatch(/defaultUsers|seedTasks|defaultKPIs|BRAND_LABELS|Demo mode|isManager/);
  });
  it("the legacy export helper reads only the known task, KPI, user and id keys and sends nothing", () => {
    const js = readFileSync(join(root, "public", "legacy-export.js"), "utf8");
    expect(js).toMatch(/\["tt_tasks", "tt_kpis", "tt_users", "tt_nid"\]/);
    expect(js).not.toMatch(/tt_perms|fetch\(|XMLHttpRequest|sendBeacon|removeItem|clear\(\)/);
  });
});

describe("published build", () => {
  it("publishes only dist/, never the repository root", () => {
    const toml = readFileSync(join(root, "netlify.toml"), "utf8");
    expect(toml).toMatch(/publish = "dist"/);
    expect(toml).toMatch(/Content-Security-Policy/);
  });
  it("dist contains only client assets (when built)", () => {
    const dist = join(root, "dist");
    if (!existsSync(dist)) return;
    for (const f of walk(dist)) {
      const rel = f.slice(dist.length + 1);
      expect(rel).toMatch(/^(index\.html|legacy-export\.(html|js|css)|assets\/[\w-]+\.(js|css))$/);
      expect(readFileSync(f, "utf8")).not.toMatch(/sourceMappingURL|APP_SECRET|GOOGLE_CLIENT_SECRET|DATABASE_URL|ttr_[A-Za-z0-9_-]{30}/);
    }
  });
  it("environment template holds names only", () => {
    for (const line of readFileSync(join(root, ".env.example"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))) expect(line, line).toMatch(/^[A-Z_]+=$/);
  });
});
