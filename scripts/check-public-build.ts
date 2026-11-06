// Fails if the built site or tracked files contain secrets, private links, real emails, business data
// markers or private terms. Runs in the Netlify build before publishing. PRIVATE_TERMS_FILE (local, git-ignored)
// adds confidential words (staff names, brand names, KPI wording) that must never appear in public files.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const RULES: [string, RegExp][] = [
  ["Google Sheets or Drive link", /(docs\.google\.com\/spreadsheets\/d\/|drive\.google\.com\/(file|drive)\/)[A-Za-z0-9_-]{20,}/],
  ["private Claude link", /claude\.ai\/(chat|code|artifact|project)/],
  ["email address", /\b(?!noreply@anthropic\.com)[\w.+-]+@(?!example\.(test|com)\b)(?!company\.example\b)[\w-]+\.[\w.-]+\b/i],
  ["connection string", /postgres(ql)?:\/\/[^\s"'`]*@/],
  ["reporting secret", /\bttr_[A-Za-z0-9_-]{30,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Google OAuth secret", /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ["source map", /sourceMappingURL=/],
  ["browser business-data storage", /localStorage\.(setItem|getItem)\(\s*["'`]tt_(tasks|kpis|users|perms|nid)/],
  ["password environment variable", /PASSWORD_[A-Z]{2,}/],
];
const extra = process.env.PRIVATE_TERMS_FILE && existsSync(process.env.PRIVATE_TERMS_FILE)
  ? readFileSync(process.env.PRIVATE_TERMS_FILE, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) : [];

const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
const dist = join(root, "dist");
if (existsSync(dist)) {
  walk(dist);
  // Only the built client may be published: never server code, migrations, scripts, docs or environment files.
  for (const f of files) {
    const rel = relative(dist, f);
    if (/(^|\/)(\.env|server|db|scripts|docs|tests|netlify|node_modules|private|exports|backups)(\/|$)|\.(sql|ts|map|md|bundle|patch)$/.test(rel)) {
      console.error(`Public build check failed: dist/${rel} must not be published`);
      process.exit(1);
    }
  }
}
try { files.push(...execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).map((f) => join(root, f))); } catch { /* not a git checkout */ }

// The checker itself and the legacy-export helper (which names the old storage keys in order to read them).
const ALLOW = new Set(["scripts/check-public-build.ts", "public/legacy-export.js", "dist/legacy-export.js"]);
const problems: string[] = [];
for (const f of files) {
  const rel = relative(root, f);
  if (ALLOW.has(rel) || /\.(png|jpe?g|webp|ico|woff2?)$/.test(f) || rel === "package-lock.json" || !existsSync(f)) continue;
  const text = readFileSync(f, "utf8");
  for (const [name, re] of RULES) { const m = re.exec(text); if (m) problems.push(`${rel}: ${name}`); }
  for (const t of extra) if (text.toLowerCase().includes(t.toLowerCase())) problems.push(`${rel}: private term`);
}
if (problems.length) { console.error("Public build check failed:\n" + [...new Set(problems)].join("\n")); process.exit(1); }
console.log(`Public build check passed (${files.length} files).`);
