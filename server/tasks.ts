// Task rules shared by the task routes, people archival and imports.
import type pg from "pg";
import type { Session } from "./auth";
import { HttpError, notFound } from "./http";
import { canEditTask, canReadBrand, isAdmin } from "./policy";
import { occurrences, nextOccurrence, type Rule } from "../shared/recurrence";
import { addDays } from "../shared/dates";
import { recordReassignment, ownerOn, type Assignment } from "./ownership";

export type TaskRow = {
  id: string; brand_id: string | null; assignee_id: string; creator_id: string; title: string; note: string | null; type: string;
  due_date: string | null; recurrence: Rule | null; recurrence_until: string | null; previous_series_id: string | null; kpi_id: string | null;
  legacy_kpi_label: string | null; operational_date: string; completed_on: string | null; completed_at: Date | null; completed_by: string | null;
  deleted_at: Date | null; version: number; created_at: Date; updated_at: Date;
};

export async function lockTask(c: pg.PoolClient, id: string): Promise<TaskRow> {
  const t = (await c.query<TaskRow>("select * from tasks where id = $1 and deleted_at is null for update", [id])).rows[0];
  if (!t) throw notFound("Task");
  return t;
}

/** Reading a task you may not see answers 404, so its existence is not revealed. */
export function assertReadable(s: Session, t: { brand_id: string | null }) {
  if (!canReadBrand(s, t.brand_id)) throw notFound("Task");
}

/**
 * Who may be assigned a task in a brand: a non-archived administrator, or a non-archived staff member with access
 * to that brand (any non-archived staff member for Unassigned-brand tasks, which only administrators handle).
 * Management cannot hold tasks. Access is never granted implicitly here.
 */
export async function assignability(c: pg.PoolClient | pg.Pool, assigneeId: string, brandId: string | null) {
  const u = (await c.query("select id, role, status, display_name from users where id = $1", [assigneeId])).rows[0];
  if (!u) return { ok: false as const, reason: "unknown_person", message: "That person does not exist." };
  if (u.status === "archived") return { ok: false as const, reason: "archived_person", message: `${u.display_name} is archived and cannot receive new assignments.` };
  if (u.role === "management") return { ok: false as const, reason: "management_role", message: "Management accounts are view-only and cannot hold tasks." };
  if (u.role === "staff" && brandId) {
    const a = (await c.query("select 1 from user_brand_access where user_id = $1 and brand_id = $2", [assigneeId, brandId])).rows[0];
    if (!a) return { ok: false as const, reason: "assignee_lacks_brand_access", message: `${u.display_name} does not have access to that brand. Reassign the task, or update their brand access first.` };
  }
  return { ok: true as const };
}
export async function assertAssignable(c: pg.PoolClient | pg.Pool, assigneeId: string, brandId: string | null) {
  const r = await assignability(c, assigneeId, brandId);
  if (!r.ok) throw new HttpError(409, r.reason, r.message);
}

export async function assertBrandOpen(c: pg.PoolClient | pg.Pool, brandId: string) {
  const b = (await c.query("select status from brands where id = $1", [brandId])).rows[0];
  if (!b) throw new HttpError(400, "invalid_request", "Unknown brand.");
  if (b.status !== "active") throw new HttpError(409, "brand_archived", "That brand is archived. New tasks and assignments cannot use it.");
}

/** A KPI link is compatible when the KPI belongs to the task's assignee and brand. */
export async function kpiCompatible(c: pg.PoolClient | pg.Pool, kpiId: string, brandId: string | null, assigneeId: string) {
  const k = (await c.query("select owner_id, brand_id from kpi_definitions where id = $1 and archived_at is null", [kpiId])).rows[0];
  return !!k && brandId !== null && k.brand_id === brandId && k.owner_id === assigneeId;
}

export async function history(c: pg.PoolClient | pg.Pool, taskId: string, actorId: string | null, action: string, changes: Record<string, unknown> = {}) {
  await c.query("insert into task_history (task_id, actor_id, action, changes) values ($1,$2,$3,$4)", [taskId, actorId, action, JSON.stringify(changes)]);
}

/**
 * Administrator reassignment (used by the task editor and by archival). Checks the destination person, keeps the
 * brand, clears an incompatible KPI link and records the change. Never grants brand access.
 */
export async function reassignTask(c: pg.PoolClient, actorId: string, taskId: string, assigneeId: string, expectedVersion?: number) {
  const t = await lockTask(c, taskId);
  if (expectedVersion !== undefined && t.version !== expectedVersion) throw new HttpError(409, "conflict", "This task was changed by someone else. Reload and try again.");
  if (t.assignee_id === assigneeId) return { task_id: taskId, changed: false, notices: [] as string[] };
  if (t.brand_id) {
    const b = (await c.query("select status from brands where id = $1", [t.brand_id])).rows[0];
    if (b?.status !== "active") throw new HttpError(409, "brand_archived", "The task's brand is archived. Move the task to an active brand before reassigning it.");
  }
  await assertAssignable(c, assigneeId, t.brand_id);
  const notices: string[] = [];
  let kpi = t.kpi_id;
  if (kpi && !(await kpiCompatible(c, kpi, t.brand_id, assigneeId))) { kpi = null; notices.push("The KPI link was removed because the KPI belongs to the previous assignee's scorecard."); }
  await c.query("update tasks set assignee_id = $2, kpi_id = $3, updated_at = now(), version = version + 1 where id = $1", [taskId, assigneeId, kpi]);
  // Effective-dated: completed and past work stays credited to the previous owner.
  const effective = await recordReassignment(c, t, assigneeId, actorId);
  await history(c, taskId, actorId, "reassigned", { assignee_id: { from: t.assignee_id, to: assigneeId }, effective_from: effective, ...(kpi !== t.kpi_id ? { kpi_id: { from: t.kpi_id, to: null } } : {}) });
  return { task_id: taskId, changed: true, effective_from: effective, notices };
}

export type OccurrenceView = { date: string; done: boolean; completed_on: string | null; overdue: boolean; upcoming: boolean };
type Series = Pick<TaskRow, "recurrence" | "due_date" | "recurrence_until">;
export type Eligible = (date: string) => boolean;
const everyDate: Eligible = () => true;

const eligibleNext = (t: Series, today: string, eligible: Eligible) =>
  occurrences(t.recurrence!, t.due_date!, addDays(today, 1), addDays(today, 366), t.recurrence_until).find(eligible) ?? null;
const eligibleLast = (t: Series, today: string, eligible: Eligible) =>
  occurrences(t.recurrence!, t.due_date!, addDays(today, -400), today, t.recurrence_until).filter(eligible).pop() ?? null;

/**
 * The occurrence a recurring task card shows today, among the occurrences `eligible` allows (for staff: their
 * own ownership period; see cardPerspective): the earliest unfinished one in the last 7 days (overdue when before
 * today); otherwise today's if it is done; otherwise the next upcoming one; otherwise (series or period ended)
 * the last one.
 */
export function currentOccurrence(t: Series, today: string, done: Map<string, string>, eligible: Eligible = everyDate): OccurrenceView | null {
  if (!t.recurrence || !t.due_date) return null;
  const recent = occurrences(t.recurrence, t.due_date, addDays(today, -7), today, t.recurrence_until).filter(eligible);
  const open = recent.find((d) => !done.has(d));
  if (open) return { date: open, done: false, completed_on: null, overdue: open < today, upcoming: false };
  if (recent.includes(today)) return { date: today, done: true, completed_on: done.get(today) ?? null, overdue: false, upcoming: false };
  const next = eligibleNext(t, today, eligible);
  if (next) return { date: next, done: done.has(next), completed_on: done.get(next) ?? null, overdue: false, upcoming: true };
  const last = eligibleLast(t, today, eligible);
  return last ? { date: last, done: done.has(last), completed_on: done.get(last) ?? null, overdue: !done.has(last) && last < today, upcoming: false } : null;
}

/**
 * Exactly the occurrence dates currentOccurrence() can show today for the same `eligible` rule. List and detail
 * load completions for exactly these, so both always agree.
 */
export function candidateOccurrenceDates(t: Series, today: string, eligible: Eligible = everyDate): string[] {
  if (!t.recurrence || !t.due_date) return [];
  const set = new Set(occurrences(t.recurrence, t.due_date, addDays(today, -7), today, t.recurrence_until).filter(eligible));
  const next = eligibleNext(t, today, eligible);
  if (next) set.add(next);
  const last = eligibleLast(t, today, eligible);
  if (last) set.add(last);
  return [...set];
}

/**
 * Which occurrences a card picks from, for this viewer. Staff who have owned the task see their own ownership
 * period, so a replacement's card shows their own work, never the previous owner's backlog. Everyone else
 * (administrators, Management, staff only reading a colleague's card) sees the whole series.
 */
export function cardPerspective(s: Session, t: { assignee_id: string }, list: Assignment[]): Eligible {
  if (s.role !== "staff" || !list.some((a) => a.assignee_id === s.userId)) return everyDate;
  return (d) => ownerOn(list, d, t.assignee_id) === s.userId;
}

/** Occurrences can be completed up to this many days ahead (Vietnam dates). */
export const COMPLETION_WINDOW_DAYS = 31;

export type CompletionBlock = "view_only" | "other_owner" | "too_far_ahead";
export type OccurrenceCompletion = { can_complete: boolean; completion_blocked: CompletionBlock | null; completable_from: string | null };

/**
 * The one rule for completing or reopening one occurrence, used by cards, the occurrence list and the completion
 * endpoint: administrators any occurrence; staff only their own (effective-dated owner) in an assigned brand; and
 * for everyone, no further ahead than COMPLETION_WINDOW_DAYS. Ownership is checked first.
 */
export function occurrenceCompletion(s: Session, t: { brand_id: string | null }, ownerId: string, date: string, today: string): OccurrenceCompletion {
  const block = (b: CompletionBlock, from: string | null = null) => ({ can_complete: false, completion_blocked: b, completable_from: from });
  if (!isAdmin(s)) {
    if (s.role !== "staff" || t.brand_id === null || !s.brandIds.has(t.brand_id)) return block("view_only");
    if (ownerId !== s.userId) return block("other_owner");
  }
  if (date > addDays(today, COMPLETION_WINDOW_DAYS)) return block("too_far_ahead", addDays(date, -COMPLETION_WINDOW_DAYS));
  return { can_complete: true, completion_blocked: null, completable_from: null };
}

export function permissionsFor(s: Session, t: { assignee_id: string; brand_id: string | null }) {
  return { can_edit: canEditTask(s, t), can_admin: isAdmin(s) };
}
