// Applies pending SQL migrations in order, each in its own transaction. Run by an operator only; the build never
// runs it. Migrations create structure only and never insert business data.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool } from "../server/db";

export async function migrate(log = console.log) {
  const pool = getPool();
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const dir = join(import.meta.dirname, "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await pool.query("select name from schema_migrations")).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("insert into schema_migrations (name) values ($1)", [f]);
      await c.query("commit");
      log(`applied ${f}`);
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(closePool).catch(async (e) => { console.error("migration failed:", e.message); await closePool(); process.exit(1); });
}
