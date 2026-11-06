// People and access (administrators only), plus the minimal directory other roles need for filters.
//
// Adding an approved email creates a pending membership; the first successful approved Google sign-in activates it.
// Archival revokes every session and blocks sign-in at once, independently of any task reassignment. Restoration
// needs the role and brand access confirmed again and a fresh sign-in. Only an unused pending invitation can be
// deleted. The last active administrator can never be archived, deleted or demoted.
import { z } from "zod";
import type pg from "pg";
import type { Router } from "../router";
import { ADMIN, ALL } from "../router";
import { query, one, tx } from "../db";
import { HttpError, badRequest, notFound, readJson } from "../http";
import { parse, uuid, version, line, role, email, qp, UUID_RE } from "../validate";
import { revokeAllSessions } from "../auth";
import { audit } from "../audit";
import { reassignTask } from "../tasks";
import { todayVN } from "../../shared/dates";

async function lockPerson(c: pg.PoolClient, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Person");
  const u = (await c.query("select * from users where id = $1 for update", [id])).rows[0];
  if (!u) throw notFound("Person");
  return u;
}

/** Throws unless at least one other active administrator remains. Locks all administrators first. */
async function assertNotLastAdmin(c: pg.PoolClient, userId: string) {
  const admins = (await c.query("select id from users where role = 'administrator' and status = 'active' order by id for update")).rows;
  if (!admins.some((a) => a.id !== userId))
    throw new HttpError(409, "last_administrator", "This is the last active administrator. Make someone else an administrator first.");
}

/** Validates staff brand access. New access to an archived brand is refused; access a person already has is kept. */
async function setBrandAccess(c: pg.PoolClient, actorId: string, userId: string, personRole: string, brandIds: string[]) {
  const before = (await c.query("select brand_id from user_brand_access where user_id = $1", [userId])).rows.map((r) => r.brand_id as string);
  const wanted = personRole === "staff" ? [...new Set(brandIds)] : [];
  if (personRole !== "staff" && brandIds.length) throw badRequest("Brand access applies to staff only. Administrators and Management read every brand.");
  const added = wanted.filter((b) => !before.includes(b)), removed = before.filter((b) => !wanted.includes(b));
  if (added.length) {
    const ok = (await c.query("select id from brands where id = any($1::uuid[]) and status = 'active'", [added])).rows.map((r) => r.id);
    if (ok.length !== added.length) throw new HttpError(409, "brand_unavailable", "Access can only be granted to existing, active brands.");
  }
  if (removed.length) await c.query("delete from user_brand_access where user_id = $1 and brand_id = any($2::uuid[])", [userId, removed]);
  for (const b of added) await c.query("insert into user_brand_access (user_id, brand_id, granted_by) values ($1,$2,$3)", [userId, b, actorId]);
  return { added, removed };
}

const personSelect = `
  select u.id, u.email, u.display_name, u.role, u.status, u.last_sign_in_at, u.created_at, u.archived_at, u.version,
         (u.google_sub is not null) as signed_in_before,
         coalesce((select array_agg(a.brand_id order by a.brand_id) from user_brand_access a where a.user_id = u.id), '{}') as brand_ids,
         (select count(*)::int from tasks t where t.assignee_id = u.id and t.deleted_at is null and t.completed_on is null
            and (t.recurrence is null or t.recurrence_until is null or t.recurrence_until >= $1::date)) as open_tasks,
         (select count(*)::int from sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as live_sessions
    from users u`;

export function registerPeople(r: Router) {
  r.get("/people", ADMIN, async ({ url }) => {
    const include = qp(url, "include_archived", /^(0|1)$/, "1") === "1";
    return { items: await query(`${personSelect} ${include ? "" : "where u.status <> 'archived'"} order by u.status = 'archived', lower(u.display_name)`, [todayVN()]) };
  });

  r.get("/people/:id", ADMIN, async ({ params }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Person");
    const p = await one(`${personSelect} where u.id = $2`, [todayVN(), params.id]);
    if (!p) throw notFound("Person");
    const hist = await query(`select e.at, e.action, e.details, a.display_name actor from audit_events e left join users a on a.id = e.actor_id
                               where e.target_type = 'user' and e.target_id = $1 order by e.at desc, e.id desc limit 200`, [params.id]);
    return { person: p, history: hist };
  });

  r.get("/people/:id/open-tasks", ADMIN, async ({ params }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Person");
    return { items: await query(
      `select t.id, t.title, t.version, t.due_date, t.recurrence, t.brand_id, b.display_name brand_name, b.status brand_status
         from tasks t left join brands b on b.id = t.brand_id
        where t.assignee_id = $1 and t.deleted_at is null and t.completed_on is null
          and (t.recurrence is null or t.recurrence_until is null or t.recurrence_until >= $2::date)
        order by t.due_date nulls last, t.created_at`, [params.id, todayVN()]) };
  });

  /** People who may hold a task in a brand (administrators, and staff with access). Archived people never appear. */
  r.get("/people-assignable", ADMIN, async ({ url }) => {
    const brand = qp(url, "brand", /^(none|[0-9a-f-]{36})$/, "none")!;
    return { items: await query(
      `select u.id, u.display_name, u.role, u.status from users u
        where u.status <> 'archived' and (u.role = 'administrator' or (u.role = 'staff' and ($1::uuid is null
              or exists (select 1 from user_brand_access a where a.user_id = u.id and a.brand_id = $1::uuid))))
        order by lower(u.display_name)`, [brand === "none" ? null : brand]) };
  });

  r.post("/people", ADMIN, async ({ req, session: s }) => {
    const b = parse(z.object({ email, display_name: line(120), role, brand_ids: z.array(uuid).max(100).default([]) }).strict(), await readJson(req));
    const id = await tx(async (c) => {
      const dup = (await c.query("select status from users where email = $1", [b.email])).rows[0];
      if (dup) throw new HttpError(409, "duplicate", dup.status === "archived" ? "That email belongs to an archived person. Restore them instead." : "That email is already approved.");
      const u = (await c.query("insert into users (email, display_name, role, status, created_by) values ($1,$2,$3,'pending',$4) returning id", [b.email, b.display_name, b.role, s.userId])).rows[0];
      const access = await setBrandAccess(c, s.userId, u.id, b.role, b.brand_ids);
      await audit(c, s.userId, "person.added", "user", u.id, { role: b.role, brands_added: access.added });
      return u.id as string;
    });
    return { id };
  }, true);

  r.patch("/people/:id", ADMIN, async ({ req, params, session: s }) => {
    const b = parse(z.object({ version, display_name: line(120).optional(), role: role.optional(), brand_ids: z.array(uuid).max(100).optional() }).strict(), await readJson(req));
    await tx(async (c) => {
      const u = await lockPerson(c, params.id);
      if (u.version !== b.version) throw new HttpError(409, "conflict", "This person was changed by someone else. Reload and try again.");
      if (u.status === "archived") throw new HttpError(409, "archived", "Restore this person before changing their access.");
      const newRole = b.role ?? u.role;
      if (u.role === "administrator" && newRole !== "administrator") await assertNotLastAdmin(c, u.id);
      const brandIds = b.brand_ids ?? (newRole === "staff" ? (await c.query("select brand_id from user_brand_access where user_id = $1", [u.id])).rows.map((x) => x.brand_id) : []);
      const access = await setBrandAccess(c, s.userId, u.id, newRole, brandIds);
      await c.query("update users set display_name = $2, role = $3, updated_at = now(), version = version + 1 where id = $1", [u.id, b.display_name ?? u.display_name, newRole]);
      const details: Record<string, unknown> = {};
      if (newRole !== u.role) details.role = { from: u.role, to: newRole };
      if (b.display_name && b.display_name !== u.display_name) details.display_name_changed = true;
      if (access.added.length) details.brands_added = access.added;
      if (access.removed.length) details.brands_removed = access.removed;
      if (Object.keys(details).length) await audit(c, s.userId, "person.access_changed", "user", u.id, details);
    });
    return { ok: true };
  }, true);

  r.post("/people/:id/archive", ADMIN, async ({ req, params, session: s }) => {
    const b = parse(z.object({ version, reassign: z.array(z.object({ task_id: uuid, assignee_id: uuid }).strict()).max(500).default([]) }).strict(), await readJson(req));
    // Step 1, in its own transaction: archive and revoke access. This never depends on task reassignment.
    const revoked = await tx(async (c) => {
      const u = await lockPerson(c, params.id);
      if (u.version !== b.version) throw new HttpError(409, "conflict", "This person was changed by someone else. Reload and try again.");
      if (u.status === "archived") throw new HttpError(409, "archived", "This person is already archived.");
      if (u.role === "administrator") await assertNotLastAdmin(c, u.id);
      await c.query("update users set status = 'archived', archived_at = now(), archived_by = $2, updated_at = now(), version = version + 1 where id = $1", [u.id, s.userId]);
      const n = await revokeAllSessions(u.id, "archived", c);
      await audit(c, s.userId, "person.archived", "user", u.id, { sessions_revoked: n });
      return n;
    });
    // Step 2: optional reassignment of selected open tasks, each on its own. Failures leave those tasks with the
    // archived person for later review; the account stays archived either way.
    const results: { task_id: string; ok: boolean; message?: string; notices?: string[] }[] = [];
    for (const item of b.reassign) {
      try {
        const own = await one("select 1 from tasks where id = $1 and assignee_id = $2", [item.task_id, params.id]);
        if (!own) { results.push({ task_id: item.task_id, ok: false, message: "Not one of this person's tasks." }); continue; }
        const out = await tx((c) => reassignTask(c, s.userId, item.task_id, item.assignee_id));
        results.push({ task_id: item.task_id, ok: true, notices: out.notices });
      } catch (e) {
        results.push({ task_id: item.task_id, ok: false, message: e instanceof HttpError ? e.message : "Could not reassign this task." });
      }
    }
    return { archived: true, sessions_revoked: revoked, reassigned: results };
  }, true);

  r.post("/people/:id/restore", ADMIN, async ({ req, params, session: s }) => {
    const b = parse(z.object({ version, role, brand_ids: z.array(uuid).max(100).default([]), confirm: z.literal(true) }).strict(), await readJson(req));
    await tx(async (c) => {
      const u = await lockPerson(c, params.id);
      if (u.version !== b.version) throw new HttpError(409, "conflict", "This person was changed by someone else. Reload and try again.");
      if (u.status !== "archived") throw new HttpError(409, "not_archived", "This person is not archived.");
      // Old sessions were revoked at archival and are never revived: the person must sign in again.
      await revokeAllSessions(u.id, "restored", c);
      const status = u.google_sub ? "active" : "pending";
      await c.query("update users set status = $2, role = $3, archived_at = null, archived_by = null, updated_at = now(), version = version + 1 where id = $1", [u.id, status, b.role]);
      const access = await setBrandAccess(c, s.userId, u.id, b.role, b.brand_ids);
      await audit(c, s.userId, "person.restored", "user", u.id, { role: b.role, brands: b.role === "staff" ? b.brand_ids : [], brands_removed: access.removed });
    });
    return { ok: true };
  }, true);

  r.post("/people/:id/revoke-sessions", ADMIN, async ({ params, session: s }) => {
    const n = await tx(async (c) => {
      const u = await lockPerson(c, params.id);
      const count = await revokeAllSessions(u.id, "revoked_by_admin", c);
      await audit(c, s.userId, "person.sessions_revoked", "user", u.id, { sessions_revoked: count });
      return count;
    });
    return { sessions_revoked: n };
  }, true);

  r.delete("/people/:id", ADMIN, async ({ url, params, session: s }) => {
    const v = Number(qp(url, "version", /^\d{1,10}$/));
    await tx(async (c) => {
      const u = await lockPerson(c, params.id);
      if (u.version !== v) throw new HttpError(409, "conflict", "This person was changed by someone else. Reload and try again.");
      if (u.status !== "pending" || u.google_sub || u.last_sign_in_at) throw new HttpError(409, "in_use", "Only an unused invitation can be deleted. Archive this person instead.");
      const deps = (await c.query(`select
          (select count(*) from tasks where assignee_id = $1 or creator_id = $1 or completed_by = $1 or deleted_by = $1)
        + (select count(*) from kpi_definitions where owner_id = $1 or created_by = $1)
        + (select count(*) from task_history where actor_id = $1)
        + (select count(*) from task_occurrences where completed_by = $1)
        + (select count(*) from task_assignments where assignee_id = $1 or assigned_by = $1)
        + (select count(*) from audit_events where actor_id = $1)
        + (select count(*) from import_batches where created_by = $1 or committed_by = $1) as n`, [u.id])).rows[0].n;
      if (Number(deps) > 0) throw new HttpError(409, "in_use", "This invitation already has records attached. Archive the person instead.");
      await c.query("delete from user_brand_access where user_id = $1", [u.id]);
      await c.query("delete from sessions where user_id = $1", [u.id]);
      await c.query("delete from users where id = $1", [u.id]);
      await audit(c, s.userId, "person.invitation_deleted", "user", u.id);
    });
    return { ok: true };
  }, true);

  /**
   * Names for filters and task cards. Administrators and Management: everyone (archived people labelled).
   * Staff: themselves and people who share one of their brands. Never emails.
   */
  r.get("/directory", ALL, async ({ session: s }) => {
    if (s.allBrands)
      return { items: await query("select id, display_name, role, status = 'archived' archived from users order by status = 'archived', lower(display_name)") };
    return { items: await query(
      `select distinct u.id, u.display_name, u.role, u.status = 'archived' archived, lower(u.display_name) k from users u
        where u.id = $1 or exists (select 1 from user_brand_access a where a.user_id = u.id and a.brand_id = any($2::uuid[]))
        order by archived, k`, [s.userId, [...s.brandIds]]) };
  });
}
