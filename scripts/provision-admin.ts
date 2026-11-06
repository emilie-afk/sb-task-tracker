// Private, one-time setup: approves the first administrator. Run by an operator from a trusted machine with the
// production DATABASE_URL in the environment. The email is passed on the command line (or ADMIN_EMAIL) and is
// never written to the repository.
//
//   ADMIN_EMAIL='person@company.example' ADMIN_NAME='Display Name' npm run provision-admin
//
// It refuses to run when an active or pending administrator already exists (use the People screen instead),
// and it creates a pending membership: the person becomes active on their first approved Google sign-in.
import { getPool, closePool } from "../server/db";

const email = (process.env.ADMIN_EMAIL ?? process.argv[2] ?? "").trim().toLowerCase();
const name = (process.env.ADMIN_NAME ?? process.argv[3] ?? "").trim();

async function main() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new Error("Set ADMIN_EMAIL to the exact Google account email.");
  if (!name || name.length > 120) throw new Error("Set ADMIN_NAME to the display name (1-120 characters).");
  const c = await getPool().connect();
  try {
    await c.query("begin");
    await c.query("lock table users in share row exclusive mode");
    const existing = (await c.query("select count(*)::int n from users where role = 'administrator' and status <> 'archived'")).rows[0].n;
    if (existing > 0) throw new Error("An administrator already exists. Add people from the People screen.");
    const taken = (await c.query("select 1 from users where email = $1", [email])).rows[0];
    if (taken) throw new Error("That email already has a membership.");
    const u = (await c.query("insert into users (email, display_name, role, status) values ($1,$2,'administrator','pending') returning id", [email, name])).rows[0];
    await c.query("insert into audit_events (actor_id, actor_label, action, target_type, target_id) values (null, 'setup', 'person.initial_admin', 'user', $1)", [u.id]);
    await c.query("commit");
    console.log("Initial administrator approved (pending first sign-in).");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
main().then(closePool).catch(async (e) => { console.error((e as Error).message); await closePool(); process.exit(1); });
