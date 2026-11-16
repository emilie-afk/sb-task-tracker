// Marketing planning integration (Marketing Dashboard -> Task Tracker). Server-to-server only.
//
//   GET   /api/planning/v1/directory                    brands and people a plan may assign
//   POST  /api/planning/v1/tasks                        create one assigned task (idempotent)
//   GET   /api/planning/v1/tasks?keys=<k1>,<k2>          current state of tasks created from plans
//   PATCH /api/planning/v1/tasks/<key>/due-date          change one task's due date (optimistic version)
//   Header: x-tracker-planning-key: <dedicated planning secret>
//
// - Its own random credential (stored hashed, compared in constant time), separate from the reporting credential.
//   Human sessions are never accepted here, and this credential reaches nothing else.
// - Tasks are created on behalf of the credential's acting administrator, through the SAME validation as the
//   task editor (prepareCreate: open brand, assignable person, dates). The credential stops working if that person
//   is archived or no longer an administrator.
// - Scope: only active brands that are mapped to a dashboard business the credential allows AND have reporting
//   enabled (so the dashboard sees the task's status through the normal reporting sync).
// - Idempotency: the caller's stable assignment id is the key. Repeating a creation (double click, timeout,
//   retry) returns the original task as it is now, with any edits made here, and never creates a second task.
// - The tracker owns the task. The only later change offered is the due date, applied only when the task's version
//   still matches the version the caller last read; otherwise 409 with the current state.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { one, query, tx } from "./db";
import { HttpError, json, readJson, badRequest } from "./http";
import { hit, clientKey, RATE } from "./rateLimit";
import { parse, uuid, isoDate, line, text, version } from "./validate";
import { assignability, history } from "./tasks";
import { prepareCreate, insertTask } from "./routes/tasks";
import { appOrigin, dashboardOrigin } from "./config";
import type { Session } from "./auth";

export const PLANNING_HEADER = "x-tracker-planning-key";
const KEY_RE = /^[A-Za-z0-9_.:-]{8,120}$/;
const hashKey = (k: string) => createHash("sha256").update(k).digest();

type Cred = { id: string; acting_user_id: string; allowed_business_ids: string[] };

async function authenticate(req: Request): Promise<{ cred: Cred; actor: Session }> {
  const presented = req.headers.get(PLANNING_HEADER) ?? "";
  const cred = await one<Cred & { key_hash: Buffer }>("select id, key_hash, acting_user_id, allowed_business_ids from planning_credentials where revoked_at is null");
  if (!cred) throw new HttpError(503, "planning_disabled", "Marketing planning is not configured.");
  const ok = presented.length >= 32 && presented.length <= 200 && timingSafeEqual(hashKey(presented), Buffer.from(cred.key_hash));
  if (!ok) {
    await hit({ bucket: `plan-fail:${clientKey(req)}`, ...RATE.reportingAuthFail });
    throw new HttpError(401, "unauthorized", "Invalid planning credential.");
  }
  const u = await one<any>("select id, email, display_name, role, status from users where id = $1", [cred.acting_user_id]);
  if (!u || u.status === "archived" || u.role !== "administrator")
    throw new HttpError(503, "planning_disabled", "The planning credential's acting administrator is no longer an active administrator.");
  if (Math.random() < 0.2) await query("update planning_credentials set last_used_at = now() where id = $1", [cred.id]);
  // The acting administrator's own permissions, exactly as if they used the task editor.
  const actor: Session = { sessionId: "planning", userId: u.id, email: u.email, displayName: u.display_name, role: "administrator", brandIds: new Set(), allBrands: true };
  return { cred, actor };
}

/** Brands a plan may use: active, reporting enabled, mapped to an allowed business. */
async function scopeBrands(allowed: string[]) {
  return query<{ id: string; name: string; business_id: string }>(
    `select id, display_name name, dashboard_business_id business_id from brands
      where status = 'active' and reporting_enabled and dashboard_business_id = any($1::text[]) order by lower(display_name)`, [allowed]);
}

const planUrl = (planId: string) => { const o = dashboardOrigin(); return o ? `${o}/#/planning/${planId}` : null; };

/** The task as the planning caller sees it: enough to show status and detect later changes. No notes or emails. */
/**
 * A task created from a plan, only if its brand is CURRENTLY mapped to a business this credential covers.
 * Every path that reads or changes such a task (lookup, replay, due date) goes through this scope, so a narrower
 * or replaced credential cannot reach tasks of other businesses created under an earlier one.
 */
const IN_SCOPE = "b.dashboard_business_id = any($2::text[])";
async function taskState(key: string, allowed: string[]) {
  const r = await one<any>(
    `select t.id, t.title, t.due_date::text due_date, t.completed_on::text completed_on, t.deleted_at, t.version, t.updated_at, t.recurrence,
            t.brand_id, b.display_name brand_name, t.assignee_id, u.display_name assignee_name, l.plan_id, l.idempotency_key
       from task_plan_links l join tasks t on t.id = l.task_id left join brands b on b.id = t.brand_id join users u on u.id = t.assignee_id
      where l.idempotency_key = $1 and ${IN_SCOPE}`, [key, allowed]);
  if (!r) return null;
  return {
    idempotency_key: r.idempotency_key, plan_id: r.plan_id, task_id: r.id, title: r.title, due_date: r.due_date,
    status: r.deleted_at ? "deleted" : r.completed_on ? "done" : "open", completed_on: r.completed_on, recurring: !!r.recurrence,
    brand: r.brand_id ? { id: r.brand_id, name: r.brand_name } : null, assignee: { id: r.assignee_id, name: r.assignee_name },
    version: r.version, updated_at: new Date(r.updated_at).toISOString(), open_url: `${appOrigin()}/#/tasks/${r.id}`,
  };
}

const createSchema = z.object({
  idempotency_key: z.string().regex(KEY_RE),
  plan_id: uuid,
  brand_id: uuid,
  assignee_id: uuid,
  title: line(300),
  brief: text(2000).nullable().optional(),
  due_date: isoDate,
  // When the caller sent this request. A request older than CREATE_MAX_AGE_MS is refused without creating anything,
  // so an attempt delayed in transit can never create a task after a later attempt was told none exists.
  sent_at: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be a time"),
  // The sent_at of the caller's latest earlier attempt whose answer it never received. If this request confirms that no
  // task exists, the fence covers that attempt too, even if it was sent from a machine whose clock ran ahead.
  supersedes_sent_at: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be a time").nullable().optional(),
}).strict();
export const CREATE_MAX_AGE_MS = 60_000;

// Test hooks: a pause before the key lock, and the clock used for request freshness.
let hooks: { beforeLock?: (key: string) => Promise<void> } = {};
let clock: (() => number) | null = null;
export function _setPlanningHooksForTests(h: typeof hooks | null) { hooks = h ?? {}; }
export function _setPlanningClockForTests(f: (() => number) | null) { clock = f; }
const planningNow = () => (clock ? clock() : Date.now());

export async function handlePlanning(req: Request, path: string): Promise<Response> {
  await hit({ bucket: `plan:${clientKey(req)}`, ...RATE.reporting });
  const { cred, actor } = await authenticate(req);
  const url = new URL(req.url);

  if (path === "/planning/v1/directory" && req.method === "GET") {
    const brands = await scopeBrands(cred.allowed_business_ids);
    const ids = brands.map((b) => b.id);
    // People who could be assigned in at least one of these brands (the same rule the task editor applies).
    const people = await query<any>(
      `select u.id, u.display_name name, u.role,
              case when u.role = 'administrator' then $1::uuid[] else coalesce(array_agg(a.brand_id) filter (where a.brand_id = any($1::uuid[])), '{}') end brand_ids
         from users u left join user_brand_access a on a.user_id = u.id
        where u.status <> 'archived' and u.role in ('administrator', 'staff')
        group by u.id order by lower(u.display_name)`, [ids]);
    return json({ brands, people: people.filter((p) => p.brand_ids.length).map((p) => ({ id: p.id, name: p.name, brand_ids: p.brand_ids })) });
  }

  if (path === "/planning/v1/tasks" && req.method === "GET") {
    const keys = (url.searchParams.get("keys") ?? "").split(",").filter(Boolean);
    if (!keys.length || keys.length > 100 || keys.some((k) => !KEY_RE.test(k))) throw badRequest("keys must list 1 to 100 assignment ids.");
    const out = [];
    for (const k of keys) { const s = await taskState(k, cred.allowed_business_ids); if (s) out.push(s); }
    return json({ items: out });
  }

  if (path === "/planning/v1/tasks" && req.method === "POST") {
    const b = parse(createSchema, await readJson(req));
    const sentAt = Date.parse(b.sent_at);
    const result = await tx(async (c) => {
      await hooks.beforeLock?.(b.idempotency_key);
      // Serialize creations for one key, so two concurrent attempts can never both create a task.
      await c.query("select pg_advisory_xact_lock(hashtextextended($1, 7))", [b.idempotency_key]);
      // 1. The key's fence, stored in the database when an earlier request confirmed that no task exists: every request
      //    sent at or before it is refused, whichever server instance handles it and whatever that instance's clock says.
      const fence = (await c.query("select fenced_through from task_plan_fences where idempotency_key = $1", [b.idempotency_key])).rows[0];
      if (fence && sentAt <= new Date(fence.fenced_through).getTime())
        throw new HttpError(409, "stale_request", "A later request for this assignment already confirmed that no task exists; nothing was created. Send it again.");
      // 2. Freshness under the same lock (an extra guard; the fence above is what callers rely on).
      const checkedAt = planningNow();
      const age = checkedAt - sentAt;
      if (age > CREATE_MAX_AGE_MS || age < -CREATE_MAX_AGE_MS) throw new HttpError(409, "stale_request", "This request is too old (or its clock is wrong); nothing was created. Send it again.");
      const existing = (await c.query(
        `select l.task_id, l.plan_id, coalesce(b.dashboard_business_id = any($2::text[]), false) in_scope
           from task_plan_links l join tasks t on t.id = l.task_id left join brands b on b.id = t.brand_id where l.idempotency_key = $1`,
        [b.idempotency_key, cred.allowed_business_ids])).rows[0];
      if (existing) {
        // Replaying a key returns its task only within this credential's businesses; nothing about it is sent otherwise.
        if (!existing.in_scope) throw new HttpError(409, "key_unavailable", "That assignment id is already used outside this credential's businesses.");
        if (existing.plan_id !== b.plan_id) throw new HttpError(409, "key_in_use", "That assignment id already belongs to another plan.");
        return { created: false as const };
      }
      // From here on no task exists for this key (checked under the key's lock, whatever its business).
      await c.query("savepoint plan_create");
      try {
        const brand = (await c.query("select status, reporting_enabled, dashboard_business_id from brands where id = $1", [b.brand_id])).rows[0];
        if (!brand || !brand.reporting_enabled || !cred.allowed_business_ids.includes(brand.dashboard_business_id))
          throw new HttpError(422, "brand_not_allowed", "That brand is not available to marketing plans (it must be mapped to an allowed dashboard business with reporting on).");
        const check = await assignability(c, b.assignee_id, b.brand_id);
        if (!check.ok) throw new HttpError(422, check.reason, check.message);
        // Same rules as the task editor, applied as the acting administrator.
        const fields = { brand_id: b.brand_id, assignee_id: b.assignee_id, type: "adhoc" as const, due_date: b.due_date, recurrence: null, recurrence_until: null, note: b.brief ?? null, kpi_id: null, title: b.title };
        const assignee = await prepareCreate(c, actor, fields);
        const id = await insertTask(c, actor, b.title, assignee, fields);
        await c.query("insert into task_plan_links (task_id, idempotency_key, plan_id) values ($1,$2,$3)", [id, b.idempotency_key, b.plan_id]);
        await history(c, id, actor.userId, "linked_to_plan", { source: "marketing_planning", plan_id: b.plan_id });
        return { created: true as const };
      } catch (e) {
        if (!(e instanceof HttpError) || e.status < 400 || e.status >= 500) throw e;
        // Refused with no task for this key: fence off this request and every earlier one (its own sent_at, and the
        // caller's earlier unanswered attempt, `supersedes_sent_at`), in the same transaction, under the same lock.
        await c.query("rollback to savepoint plan_create");
        const through = new Date(Math.max(sentAt, b.supersedes_sent_at ? Date.parse(b.supersedes_sent_at) : 0)).toISOString();
        const row = (await c.query(
          `insert into task_plan_fences (idempotency_key, fenced_through) values ($1, $2)
           on conflict (idempotency_key) do update set fenced_through = greatest(task_plan_fences.fenced_through, excluded.fenced_through), updated_at = now()
           returning fenced_through`, [b.idempotency_key, through])).rows[0];
        return { refused: new HttpError(e.status, e.code, e.message, { ...(typeof e.details === "object" && e.details ? e.details as object : {}),
          task_exists: false, fenced_through: new Date(row.fenced_through).toISOString(), checked_at: new Date(checkedAt).toISOString() }) };
      }
    });
    if ("refused" in result) throw result.refused;   // the fence is committed before the refusal is answered
    const state = await taskState(b.idempotency_key, cred.allowed_business_ids);
    return json({ created: result.created, task: state }, result.created ? 201 : 200);
  }

  const m = /^\/planning\/v1\/tasks\/([A-Za-z0-9_.:-]{8,120})\/due-date$/.exec(path);
  if (m && req.method === "PATCH") {
    const b = parse(z.object({ due_date: isoDate, expected_version: version }).strict(), await readJson(req));
    await tx(async (c) => {
      const t = (await c.query(
        `select t.id, t.version, t.due_date::text due_date, t.recurrence, t.deleted_at, t.completed_on from task_plan_links l join tasks t on t.id = l.task_id
           join brands b on b.id = t.brand_id where l.idempotency_key = $1 and ${IN_SCOPE} for update of t`, [m[1], cred.allowed_business_ids])).rows[0];
      if (!t || t.deleted_at) throw new HttpError(404, "not_found", "Task not found.");
      if (t.version !== b.expected_version) throw new HttpError(409, "conflict", "The task was changed in Task Tracker since it was last read.");
      if (t.recurrence) throw new HttpError(409, "recurring", "The task now repeats; change its schedule in Task Tracker.");
      if (t.due_date === b.due_date) return;
      await c.query("update tasks set due_date = $2, updated_at = now(), version = version + 1 where id = $1", [t.id, b.due_date]);
      await history(c, t.id, actor.userId, "edited", { due_date: { from: t.due_date, to: b.due_date }, source: "marketing_planning" });
    }).catch(async (e) => {
      if (e instanceof HttpError && e.status === 409) throw new HttpError(409, e.code, e.message, { task: await taskState(m[1], cred.allowed_business_ids) });
      throw e;
    });
    return json({ task: await taskState(m[1], cred.allowed_business_ids) });
  }

  const known = path === "/planning/v1/directory" || path === "/planning/v1/tasks" || !!m;
  throw known ? new HttpError(405, "method_not_allowed", "Method not allowed.") : new HttpError(404, "not_found", "No such endpoint.");
}

/** For the task detail screen: the plan this task came from, as a link into the dashboard (which enforces access). */
export async function planLinkFor(taskId: string) {
  const r = await one<{ plan_id: string }>("select plan_id from task_plan_links where task_id = $1", [taskId]);
  return r ? planUrl(r.plan_id) : null;
}
