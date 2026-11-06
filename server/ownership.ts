// Effective-dated ownership (db/migrations/002_effective_ownership.sql). The task's current assignee may change;
// work dated before the change stays credited to whoever owned the task on that date.
import type pg from "pg";
import type { Db } from "./db";
import { query } from "./db";
import { addDays, todayVN } from "../shared/dates";

export type Assignment = { assignee_id: string; effective_from: string };

/** Owner on a date: latest assignment effective on or before it; the first assignment for earlier dates. */
export function ownerOn(list: Assignment[], date: string, fallback: string): string {
  if (!list.length) return fallback;
  let owner = list[0].assignee_id;
  for (const a of list) if (a.effective_from <= date) owner = a.assignee_id; else break;
  return owner;
}

export async function loadAssignments(taskIds: string[], db?: Db): Promise<Map<string, Assignment[]>> {
  const map = new Map<string, Assignment[]>();
  if (!taskIds.length) return map;
  const rows = await query<{ task_id: string; assignee_id: string; effective_from: string }>(
    "select task_id, assignee_id, effective_from from task_assignments where task_id = any($1::uuid[]) order by task_id, effective_from", [taskIds], db);
  for (const r of rows) { if (!map.has(r.task_id)) map.set(r.task_id, []); map.get(r.task_id)!.push({ assignee_id: r.assignee_id, effective_from: r.effective_from }); }
  return map;
}

/**
 * Records a reassignment of a task (already locked by the caller). Effective from today (Vietnam), or from the
 * day after the latest completed work if that is later, so completed work never changes owner. Returns the date.
 */
export async function recordReassignment(c: pg.PoolClient, t: { id: string; recurrence: string | null; completed_on: string | null }, assigneeId: string, actorId: string | null) {
  let lastDone: string | null = t.completed_on;
  if (t.recurrence) lastDone = (await c.query("select max(occurrence_date)::text d from task_occurrences where task_id = $1", [t.id])).rows[0]?.d ?? null;
  let effective = todayVN();
  if (lastDone && lastDone >= effective) effective = addDays(lastDone, 1);
  await c.query(`insert into task_assignments (task_id, assignee_id, effective_from, assigned_by) values ($1,$2,$3,$4)
                 on conflict (task_id, effective_from) do update set assignee_id = excluded.assignee_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
    [t.id, assigneeId, effective, actorId]);
  // Any later-dated assignment (from an earlier reassignment) is superseded by this one.
  await c.query("delete from task_assignments where task_id = $1 and effective_from > $2", [t.id, effective]);
  return effective;
}

/** Who gets credit for a one-time task: the owner on its completion date, or the current assignee while open. */
export function oneTimeOwner(list: Assignment[], t: { assignee_id: string; completed_on: string | null }) {
  return t.completed_on ? ownerOn(list, t.completed_on, t.assignee_id) : t.assignee_id;
}
