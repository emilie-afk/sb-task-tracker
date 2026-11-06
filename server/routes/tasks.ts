// Tasks: list, detail, create (single and bulk), edit, brand changes, reassignment, completion and deletion.
// Permissions are checked here on the server for every operation (see server/policy.ts).
import { z } from "zod";
import type { Router, Ctx } from "../router";
import { ALL, EDITORS } from "../router";
import { query, one, tx } from "../db";
import { HttpError, badRequest, forbidden, readJson } from "../http";
import { isAdmin, taskReadScope, assertCanEditTask, STAFF_TASK_FIELDS, canReadBrand } from "../policy";
import { parse, uuid, isoDate, version, line, text, taskType, rule, qp, UUID_RE } from "../validate";
import { todayVN, addDays, isIsoDate } from "../../shared/dates";
import { isOccurrence, occurrences } from "../../shared/recurrence";
import {
  lockTask, assertReadable, assertAssignable, assertBrandOpen, kpiCompatible, history, reassignTask, currentOccurrence, permissionsFor, candidateOccurrenceDates, cardPerspective, occurrenceCompletion,
} from "../tasks";
import { loadAssignments, ownerOn, recordReassignment, type Assignment } from "../ownership";
import type { Session } from "../auth";

const SELECT = `
  select t.*, b.display_name brand_name, b.color brand_color, b.status brand_status,
         ua.display_name assignee_name, ua.status assignee_status, uc.display_name creator_name,
         k.metric kpi_metric, k.sub_metric kpi_sub_metric, k.archived_at kpi_archived_at
    from tasks t
    left join brands b on b.id = t.brand_id
    join users ua on ua.id = t.assignee_id
    join users uc on uc.id = t.creator_id
    left join kpi_definitions k on k.id = t.kpi_id`;

async function completionsFor(ids: string[], from: string) {
  const map = new Map<string, Map<string, string>>();
  if (!ids.length) return map;
  for (const o of await query<{ task_id: string; occurrence_date: string; completed_on: string }>(
    "select task_id, occurrence_date, completed_on from task_occurrences where task_id = any($1::uuid[]) and occurrence_date >= $2", [ids, from])) {
    if (!map.has(o.task_id)) map.set(o.task_id, new Map());
    map.get(o.task_id)!.set(o.occurrence_date, o.completed_on);
  }
  return map;
}

/** Per-card context: ownership periods, the viewer's occurrence perspective and owner names. */
export type CardContext = { asg: Map<string, Assignment[]>; names: Map<string, { name: string; archived: boolean }> };

export async function cardContext(rows: any[]): Promise<CardContext> {
  const asg = await loadAssignments(rows.filter((r) => r.recurrence).map((r) => r.id));
  const ids = new Set<string>();
  for (const list of asg.values()) for (const a of list) ids.add(a.assignee_id);
  const names = new Map((ids.size ? await query<{ id: string; display_name: string; status: string }>("select id, display_name, status from users where id = any($1::uuid[])", [[...ids]]) : [])
    .map((u) => [u.id, { name: u.display_name, archived: u.status === "archived" }]));
  return { asg, names };
}

/** Completions for exactly the occurrences a list or detail card can show (see candidateOccurrenceDates). */
async function completionsForCards(s: Session, rows: any[], today: string, ctx: CardContext) {
  const ids: string[] = [], dates: string[] = [];
  for (const r of rows) if (r.recurrence) {
    const eligible = cardPerspective(s, r, ctx.asg.get(r.id) ?? []);
    for (const d of candidateOccurrenceDates(r, today, eligible)) { ids.push(r.id); dates.push(d); }
  }
  const map = new Map<string, Map<string, string>>();
  if (!ids.length) return map;
  for (const o of await query<{ task_id: string; occurrence_date: string; completed_on: string }>(
    `select o.task_id, o.occurrence_date, o.completed_on from task_occurrences o
       join unnest($1::uuid[], $2::date[]) as c(task_id, d) on o.task_id = c.task_id and o.occurrence_date = c.d`, [ids, dates])) {
    if (!map.has(o.task_id)) map.set(o.task_id, new Map());
    map.get(o.task_id)!.set(o.occurrence_date, o.completed_on);
  }
  return map;
}

/**
 * Card data. Permission to edit the series (`can_edit`) is separate from permission to complete the occurrence
 * the card shows (`can_complete`, also on `occurrence`), which follows effective-dated ownership.
 */
export function dto(s: Session, r: any, today: string, done: Map<string, string> | undefined, ctx: CardContext) {
  const list = ctx.asg.get(r.id) ?? [];
  const sel = r.recurrence ? currentOccurrence(r, today, done ?? new Map(), cardPerspective(s, r, list)) : null;
  let occurrence: any = null;
  if (sel) {
    const ownerId = ownerOn(list, sel.date, r.assignee_id);
    const owner = ctx.names.get(ownerId) ?? (ownerId === r.assignee_id ? { name: r.assignee_name, archived: r.assignee_status === "archived" } : { name: "Unknown", archived: false });
    occurrence = { ...sel, owner: { id: ownerId, ...owner }, ...occurrenceCompletion(s, r, ownerId, sel.date, today) };
  }
  const isDone = r.recurrence ? !!occurrence?.done : r.completed_on !== null;
  const perms = permissionsFor(s, r);
  return {
    id: r.id, version: r.version, title: r.title, note: r.note, type: r.type,
    brand: r.brand_id ? { id: r.brand_id, name: r.brand_name, color: r.brand_color, archived: r.brand_status === "archived" } : null,
    assignee: { id: r.assignee_id, name: r.assignee_name, archived: r.assignee_status === "archived" },
    creator: { id: r.creator_id, name: r.creator_name },
    due_date: r.due_date, recurrence: r.recurrence, recurrence_until: r.recurrence_until, operational_date: r.operational_date,
    completed_on: r.completed_on,
    kpi: r.kpi_id ? { id: r.kpi_id, metric: r.kpi_metric, sub_metric: r.kpi_sub_metric, archived: !!r.kpi_archived_at } : null,
    legacy_kpi_label: r.legacy_kpi_label,
    status: isDone ? "done" : "open",
    overdue: r.recurrence ? !!occurrence?.overdue : !isDone && !!r.due_date && r.due_date < today,
    occurrence,
    ...perms,
    can_complete: r.recurrence ? !!occurrence?.can_complete : perms.can_edit,
  };
}

const createBase = {
  brand_id: uuid.nullable(),
  assignee_id: uuid.optional(),
  type: taskType.default("adhoc"),
  due_date: isoDate.nullable().optional(),
  recurrence: rule.nullable().optional(),
  recurrence_until: isoDate.nullable().optional(),
  note: text(2000).nullable().optional(),
  kpi_id: uuid.nullable().optional(),
};
const createSchema = z.object({ title: line(300), ...createBase }).strict();
const bulkSchema = z.object({ titles: z.array(line(300)).min(1).max(50), ...createBase }).strict();

/** Checks shared by single and bulk creation. Returns the resolved assignee. */
async function prepareCreate(c: any, s: Session, b: z.infer<typeof createSchema> | z.infer<typeof bulkSchema>) {
  let assignee = b.assignee_id ?? s.userId;
  if (!isAdmin(s)) {
    if (assignee !== s.userId) throw forbidden("Staff can create tasks only for themselves.");
    if (!b.brand_id || !s.brandIds.has(b.brand_id)) throw forbidden("Choose one of your assigned brands.");
  }
  if (b.brand_id) await assertBrandOpen(c, b.brand_id);
  await assertAssignable(c, assignee, b.brand_id);
  if (b.recurrence && !b.due_date) throw badRequest("A repeating task needs a first due date.");
  if (b.recurrence_until && (!b.recurrence || b.recurrence_until < b.due_date!)) throw badRequest("The end date must be on or after the first due date of a repeating task.");
  if (b.kpi_id && !(await kpiCompatible(c, b.kpi_id, b.brand_id, assignee))) throw badRequest("That KPI does not belong to this person's scorecard for this brand.");
  return assignee;
}

async function insertTask(c: any, s: Session, title: string, assignee: string, b: any) {
  const row = (await c.query(
    `insert into tasks (brand_id, assignee_id, creator_id, title, note, type, due_date, recurrence, recurrence_until, kpi_id, operational_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [b.brand_id, assignee, s.userId, title, b.note || null, b.type, b.due_date ?? null, b.recurrence ?? null, b.recurrence_until ?? null, b.kpi_id ?? null, todayVN()])).rows[0];
  await history(c, row.id, s.userId, "created", { title, brand_id: b.brand_id, assignee_id: assignee });
  return row.id as string;
}

export async function loadTask(s: Session, id: string) {
  const r = await one<any>(`${SELECT} where t.id = $1 and t.deleted_at is null`, [id]);
  if (!r) throw new HttpError(404, "not_found", "Task not found.");
  assertReadable(s, r);
  const today = todayVN();
  const ctx = await cardContext([r]);
  const done = (await completionsForCards(s, [r], today, ctx)).get(r.id);
  return dto(s, r, today, done, ctx);
}

export function registerTasks(r: Router) {
  r.get("/tasks", ALL, async ({ url, session: s }: Ctx) => {
    const params: unknown[] = [];
    const where = ["t.deleted_at is null", taskReadScope(s, params)];
    const brand = qp(url, "brand", /^(all|unassigned|[0-9a-f-]{36})$/, "all")!;
    if (brand === "unassigned") { if (!s.allBrands) return { items: [], total: 0, today: todayVN() }; where.push("t.brand_id is null"); }
    else if (brand !== "all") { if (!UUID_RE.test(brand)) throw badRequest("Invalid brand."); params.push(brand); where.push(`t.brand_id = $${params.length}`); }
    const brandStatus = qp(url, "brand_status", /^(active|archived|all)$/, "active")!;
    if (brandStatus === "active") where.push("(t.brand_id is null or b.status = 'active')");
    else if (brandStatus === "archived") where.push("b.status = 'archived'");
    const person = qp(url, "person", /^(all|[0-9a-f-]{36})$/, "all")!;
    if (person !== "all") { params.push(person); where.push(`t.assignee_id = $${params.length}`); }
    const type = qp(url, "type", /^(all|routine|adhoc|video)$/, "all")!;
    if (type !== "all") { params.push(type); where.push(`t.type = $${params.length}`); }
    const search = url.searchParams.get("q")?.trim() ?? "";
    if (search) {
      if (search.length > 100) throw badRequest("Search is too long.");
      params.push(`%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
      where.push(`(t.title ilike $${params.length} or coalesce(t.note,'') ilike $${params.length})`);
    }
    const limit = Math.min(Number(qp(url, "limit", /^\d{1,3}$/, "200")), 200);
    const offset = Math.min(Number(qp(url, "offset", /^\d{1,6}$/, "0")), 100_000);
    params.push(limit, offset);
    // Authorization and filters are in WHERE, so pagination and the total only ever count readable records.
    const rows = await query<any>(`${SELECT} where ${where.join(" and ")}
      order by t.created_at desc, t.id limit $${params.length - 1} offset $${params.length}`, params);
    const total = (await one<{ n: number }>(`select count(*)::int n from tasks t left join brands b on b.id = t.brand_id where ${where.join(" and ")}`, params.slice(0, -2)))!.n;
    const today = todayVN();
    const ctx = await cardContext(rows);
    const done = await completionsForCards(s, rows, today, ctx);
    return { items: rows.map((x) => dto(s, x, today, done.get(x.id), ctx)), total, today };
  });

  r.get("/tasks/:id", ALL, async ({ params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw new HttpError(404, "not_found", "Task not found.");
    const task = await loadTask(s, params.id);
    const hist = await query(`select h.at, h.action, h.changes, u.display_name actor from task_history h left join users u on u.id = h.actor_id
                               where h.task_id = $1 order by h.at desc, h.id desc limit 100`, [params.id]);
    // effective_from is null for the original owner ("from the start").
    const assignments = await query(`select case when row_number() over (order by a.effective_from) = 1 then null else a.effective_from::text end effective_from,
                                            u.id assignee_id, u.display_name assignee_name, u.status = 'archived' archived
                                       from task_assignments a join users u on u.id = a.assignee_id where a.task_id = $1 order by a.effective_from`, [params.id]);
    return { task, history: hist, assignments };
  });

  r.post("/tasks", EDITORS, async ({ req, session: s }) => {
    const b = parse(createSchema, await readJson(req));
    const id = await tx(async (c) => insertTask(c, s, b.title, await prepareCreate(c, s, b), b));
    return { id, task: await loadTask(s, id) };
  });

  r.post("/tasks/bulk", EDITORS, async ({ req, session: s }) => {
    const b = parse(bulkSchema, await readJson(req));
    const ids = await tx(async (c) => {
      const assignee = await prepareCreate(c, s, b);
      const out: string[] = [];
      for (const title of b.titles) out.push(await insertTask(c, s, title, assignee, b));
      return out;
    });
    return { ids };
  });

  const patchSchema = z.object({
    version,
    title: line(300).optional(), note: text(2000).nullable().optional(), type: taskType.optional(),
    due_date: isoDate.nullable().optional(), recurrence: rule.nullable().optional(), recurrence_until: isoDate.nullable().optional(),
    assignee_id: uuid.optional(), brand_id: uuid.nullable().optional(), kpi_id: uuid.nullable().optional(),
  }).strict();

  r.patch("/tasks/:id", EDITORS, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw new HttpError(404, "not_found", "Task not found.");
    const b = parse(patchSchema, await readJson(req));
    const { version: expected, ...fields } = b;
    if (!isAdmin(s)) {
      const extra = Object.keys(fields).filter((k) => !STAFF_TASK_FIELDS.has(k));
      if (extra.length) throw forbidden(`Only an administrator can change: ${extra.join(", ")}.`);
    }
    const result = await tx(async (c) => {
      const t = await lockTask(c, params.id);
      assertReadable(s, t);
      assertCanEditTask(s, t);
      if (t.version !== expected) throw new HttpError(409, "conflict", "This task was changed by someone else. Reload, then re-apply your edit.");
      const notices: string[] = [];
      const today = todayVN();

      // ---- brand and assignee (administrators only; enforced above)
      const brandChanging = "brand_id" in fields && fields.brand_id !== t.brand_id;
      const newBrand = brandChanging ? (fields.brand_id ?? null) : t.brand_id;
      const newAssignee = fields.assignee_id ?? t.assignee_id;
      if (brandChanging && newBrand) await assertBrandOpen(c, newBrand);
      if (!brandChanging && newAssignee !== t.assignee_id && t.brand_id) await assertBrandOpen(c, t.brand_id);
      if (brandChanging || newAssignee !== t.assignee_id) await assertAssignable(c, newAssignee, newBrand);
      let kpi = "kpi_id" in fields ? (fields.kpi_id ?? null) : t.kpi_id;
      if (kpi && !(await kpiCompatible(c, kpi, newBrand, newAssignee))) {
        if ("kpi_id" in fields && fields.kpi_id) throw badRequest("That KPI does not belong to the assignee's scorecard for this brand.");
        kpi = null;
        notices.push(brandChanging ? "The KPI link was removed because the KPI belongs to a different brand." : "The KPI link was removed because the KPI belongs to another person's scorecard.");
      }

      // ---- recurrence
      const rec = "recurrence" in fields ? (fields.recurrence ?? null) : t.recurrence;
      const due = "due_date" in fields ? (fields.due_date ?? null) : t.due_date;
      let until = "recurrence_until" in fields ? (fields.recurrence_until ?? null) : t.recurrence_until;
      if (!rec) until = null;
      if (rec && !due) throw badRequest("A repeating task needs a first due date.");
      if (until && due && until < addDays(due, -1)) throw badRequest("The end date cannot be before the first due date.");
      if (rec && t.completed_on) throw badRequest("Mark the task as not done before making it repeat.");
      const scheduleChanging = t.recurrence !== null && (rec !== t.recurrence || due !== t.due_date);
      const seriesStarted = t.recurrence !== null && t.due_date! < today;
      const done = await c.query<{ d: string }>("select max(occurrence_date)::text d from task_occurrences where task_id = $1", [t.id]);
      const lastDone = done.rows[0]?.d ?? null;

      if (scheduleChanging && seriesStarted) {
        // Changing the rule or anchor of a running series never rewrites past occurrences: the current series
        // ends yesterday (keeping its completions) and a new series (or one-time task) continues from the new date.
        if (rec && due! < today) throw badRequest("For a series that has already started, the new first due date must be today or later.");
        const endOld = addDays(today, -1);
        if (lastDone && lastDone > endOld) throw badRequest("A future occurrence of this series is already marked done. Unmark it first.");
        await c.query("update tasks set recurrence_until = $2, updated_at = now(), version = version + 1 where id = $1", [t.id, endOld]);
        const nt = (await c.query(
          `insert into tasks (brand_id, assignee_id, creator_id, title, note, type, due_date, recurrence, recurrence_until, previous_series_id, kpi_id, operational_date)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [newBrand, newAssignee, s.userId, fields.title ?? t.title, "note" in fields ? fields.note || null : t.note, fields.type ?? t.type,
            due ?? today, rec, rec ? until : null, t.id, kpi, today])).rows[0];
        await history(c, t.id, s.userId, "series_ended", { recurrence_until: { from: t.recurrence_until, to: endOld }, continued_as: nt.id });
        await history(c, nt.id, s.userId, "created", { continues_series: t.id, recurrence: rec, due_date: due ?? today });
        return { id: nt.id, split_from: t.id, notices };
      }
      if (until && lastDone && until < lastDone) throw badRequest("The end date is before an occurrence that is already marked done.");
      if (scheduleChanging && lastDone) throw badRequest("An occurrence of this series is already marked done. Unmark it before changing the schedule.");

      const next: Record<string, unknown> = {
        title: fields.title ?? t.title, note: "note" in fields ? fields.note || null : t.note, type: fields.type ?? t.type,
        due_date: due, recurrence: rec, recurrence_until: until, assignee_id: newAssignee, brand_id: newBrand, kpi_id: kpi,
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, v] of Object.entries(next)) if (((t as any)[k] ?? null) !== (v ?? null)) changes[k] = { from: (t as any)[k] ?? null, to: v ?? null };
      // The old series' completions of occurrences that no longer exist after an edit before it started are kept but unused.
      if (Object.keys(changes).length) {
        const keys = Object.keys(changes);
        await c.query(`update tasks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now(), version = version + 1 where id = $1`,
          [t.id, ...keys.map((k) => changes[k].to)]);
        const action = brandChanging ? (newBrand ? "brand_changed" : "brand_cleared") : newAssignee !== t.assignee_id ? "reassigned" : "edited";
        // Reassignment is effective-dated: past and completed work keeps its owner.
        const effective = newAssignee !== t.assignee_id ? await recordReassignment(c, { ...t, recurrence: rec }, newAssignee, s.userId) : null;
        await history(c, t.id, s.userId, action, { ...changes, ...(effective ? { effective_from: effective } : {}), ...(notices.length ? { notices } : {}) });
      }
      return { id: t.id, notices };
    });
    return { ...result, task: await loadTask(s, result.id) };
  });

  // Administrator reassignment as its own action (also used from the archival dialog).
  r.post("/tasks/:id/reassign", ["administrator"], async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw new HttpError(404, "not_found", "Task not found.");
    const b = parse(z.object({ assignee_id: uuid, version: version.optional() }).strict(), await readJson(req));
    const out = await tx((c) => reassignTask(c, s.userId, params.id, b.assignee_id, b.version));
    return { ...out, task: await loadTask(s, params.id) };
  });

  r.post("/tasks/:id/completion", EDITORS, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw new HttpError(404, "not_found", "Task not found.");
    const b = parse(z.object({ done: z.boolean(), occurrence_date: isoDate.optional(), version: version.optional() }).strict(), await readJson(req));
    const today = todayVN();
    await tx(async (c) => {
      const t = await lockTask(c, params.id);
      assertReadable(s, t);
      if (t.recurrence) {
        // One occurrence at a time; completing it never completes the series or another occurrence.
        if (!b.occurrence_date || !isOccurrence(t.recurrence, t.due_date!, b.occurrence_date, t.recurrence_until)) throw badRequest("Choose an occurrence of this repeating task.");
        // Staff complete only occurrences they own (effective-dated), in brands they are assigned to.
        // Same rule as cards and the occurrence list (occurrenceCompletion).
        const owner = ownerOn((await loadAssignments([t.id], c)).get(t.id) ?? [], b.occurrence_date, t.assignee_id);
        const rule = occurrenceCompletion(s, t, owner, b.occurrence_date, today);
        if (rule.completion_blocked === "view_only" || rule.completion_blocked === "other_owner")
          throw forbidden("This occurrence belongs to someone else's period of the task.");
        if (rule.completion_blocked === "too_far_ahead") throw badRequest("Occurrences more than a month ahead cannot be completed yet.");
        if (b.done) {
          const ins = await c.query(`insert into task_occurrences (task_id, occurrence_date, completed_on, completed_at, completed_by) values ($1,$2,$3, now(), $4)
                                     on conflict (task_id, occurrence_date) do nothing`, [t.id, b.occurrence_date, today, s.userId]);
          if (ins.rowCount) await history(c, t.id, s.userId, "occurrence_completed", { occurrence_date: b.occurrence_date });
        } else {
          const del = await c.query("delete from task_occurrences where task_id = $1 and occurrence_date = $2", [t.id, b.occurrence_date]);
          if (del.rowCount) await history(c, t.id, s.userId, "occurrence_reopened", { occurrence_date: b.occurrence_date });
        }
        return;
      }
      assertCanEditTask(s, t);
      if (b.version === undefined) throw badRequest("version is required.");
      if (t.version !== b.version) throw new HttpError(409, "conflict", "This task was changed by someone else. Reload and try again.");
      if (b.done === (t.completed_on !== null)) return;
      if (b.done) await c.query("update tasks set completed_on = $2, completed_at = now(), completed_by = $3, updated_at = now(), version = version + 1 where id = $1", [t.id, today, s.userId]);
      else await c.query("update tasks set completed_on = null, completed_at = null, completed_by = null, updated_at = now(), version = version + 1 where id = $1", [t.id]);
      await history(c, t.id, s.userId, b.done ? "completed" : "reopened");
    });
    return { task: await loadTask(s, params.id) };
  });

  r.delete("/tasks/:id", EDITORS, async ({ url, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw new HttpError(404, "not_found", "Task not found.");
    const v = Number(qp(url, "version", /^\d{1,10}$/));
    await tx(async (c) => {
      const t = await lockTask(c, params.id);
      assertReadable(s, t);
      assertCanEditTask(s, t);
      if (t.version !== v) throw new HttpError(409, "conflict", "This task was changed by someone else. Reload and try again.");
      // Soft delete: hidden everywhere, kept for history, audit and the reporting removal marker.
      await c.query("update tasks set deleted_at = now(), deleted_by = $2, updated_at = now(), version = version + 1 where id = $1", [t.id, s.userId]);
      await history(c, t.id, s.userId, "deleted");
    });
    return { ok: true };
  });

  /** Recurring occurrence calendar for one task (detail view). */
  r.get("/tasks/:id/occurrences", ALL, async ({ url, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw new HttpError(404, "not_found", "Task not found.");
    const t = await one<any>("select id, brand_id, assignee_id, recurrence, due_date, recurrence_until from tasks where id = $1 and deleted_at is null", [params.id]);
    if (!t || !canReadBrand(s, t.brand_id)) throw new HttpError(404, "not_found", "Task not found.");
    if (!t.recurrence) return { items: [] };
    const today = todayVN();
    const from = qp(url, "from", /^\d{4}-\d{2}-\d{2}$/, addDays(today, -30))!, to = qp(url, "to", /^\d{4}-\d{2}-\d{2}$/, addDays(today, 30))!;
    if (!isIsoDate(from) || !isIsoDate(to) || to < from || to > addDays(from, 400)) throw badRequest("Invalid range.");
    const done = (await completionsFor([t.id], from)).get(t.id) ?? new Map();
    const asg = (await loadAssignments([t.id])).get(t.id) ?? [];
    const users = new Map((await query<{ id: string; display_name: string; status: string }>("select id, display_name, status from users where id = any($1::uuid[])", [[...new Set([t.assignee_id, ...asg.map((a) => a.assignee_id)])]])).map((u) => [u.id, u]));
    return { items: occurrences(t.recurrence, t.due_date, from, to, t.recurrence_until).map((d) => {
      const owner = ownerOn(asg, d, t.assignee_id);
      return { date: d, done: done.has(d), completed_on: done.get(d) ?? null, overdue: !done.has(d) && d < today,
        owner: { id: owner, name: users.get(owner)?.display_name ?? null, archived: users.get(owner)?.status === "archived" },
        ...occurrenceCompletion(s, t, owner, d, today) };
    }) };
  });
}
