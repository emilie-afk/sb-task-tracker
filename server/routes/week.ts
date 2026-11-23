// Weekly timeline: the work of one Monday–Sunday week (Vietnam dates) as dated units, plus overdue, undated and
// upcoming work, week counts and team workload. One unit is a one-time task or one occurrence of a repeating task.
//
// Rules (docs/RECURRENCE.md, "Weekly timeline"):
//   - A one-time task belongs to its due date; one with no due date is "undated" while open.
//   - Each occurrence of a repeating task is its own unit with its own completion.
//   - Units are credited to their effective-dated owner (task_assignments), and the person filter follows that owner.
//   - Overdue: open units dated before today. One-time tasks have no look-back limit; occurrences are looked back
//     OVERDUE_LOOKBACK_DAYS (older ones stay visible in their own weeks).
//   - Upcoming: open one-time tasks due after the selected week, grouped by week. Repeating occurrences appear in
//     their own weeks.
//   - Closed: an unfinished unit whose owner is archived is closed. It is not open, not done and not counted
//     anywhere (lists, counts, workload, summaries, reporting). Finished work keeps its credit.
import type { Router } from "../router";
import { ALL } from "../router";
import { query } from "../db";
import { badRequest } from "../http";
import { qp, UUID_RE } from "../validate";
import { taskReadScope, canEditTask } from "../policy";
import type { Session } from "../auth";
import { todayVN, addDays, weekStart, isIsoDate } from "../../shared/dates";
import { seriesOccurrences, scheduleText } from "../../shared/recurrence";
import { loadAssignments, ownerOn, oneTimeOwner } from "../ownership";
import { occurrenceCompletion } from "../tasks";
import { TASK_SELECT, slackInfo } from "./tasks";

export const OVERDUE_LOOKBACK_DAYS = 14;
const MAX_TASKS = 3000;

type User = { id: string; display_name: string; status: string; role: string };
export type Unit = {
  key: string; task_id: string; kind: "task" | "occurrence"; date: string | null; status: "open" | "done";
  overdue: boolean; owner: { id: string; name: string; archived: boolean }; completed_on: string | null; completed_by: string | null;
  can_complete: boolean; completion_blocked: string | null; completable_from: string | null; task: any;
};

/** Filters shared by the timeline and the workload panel (the person filter is applied to units afterwards). */
function taskFilters(url: URL, s: Session, params: unknown[]) {
  const where = ["t.deleted_at is null", taskReadScope(s, params)];
  const brand = qp(url, "brand", /^(all|unassigned|[0-9a-f-]{36})$/, "all")!;
  if (brand === "unassigned") where.push(s.allBrands ? "t.brand_id is null" : "false");
  else if (brand !== "all") { if (!UUID_RE.test(brand)) throw badRequest("Invalid brand."); params.push(brand); where.push(`t.brand_id = $${params.length}`); }
  const brandStatus = qp(url, "brand_status", /^(active|archived|all)$/, "active")!;
  if (brandStatus === "active") where.push("(t.brand_id is null or b.status = 'active')");
  else if (brandStatus === "archived") where.push("b.status = 'archived'");
  const type = qp(url, "type", /^(all|routine|adhoc|video)$/, "all")!;
  if (type !== "all") { params.push(type); where.push(`t.type = $${params.length}`); }
  const search = url.searchParams.get("q")?.trim() ?? "";
  if (search) {
    if (search.length > 100) throw badRequest("Search is too long.");
    params.push(`%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
    where.push(`(t.title ilike $${params.length} or coalesce(t.note,'') ilike $${params.length})`);
  }
  return where;
}

function taskInfo(s: Session, r: any) {
  return {
    id: r.id, version: r.version, title: r.title, note: r.note, type: r.type,
    brand: r.brand_id ? { id: r.brand_id, name: r.brand_name, color: r.brand_color, archived: r.brand_status === "archived" } : null,
    assignee: { id: r.assignee_id, name: r.assignee_name, archived: r.assignee_status === "archived" },
    due_date: r.due_date, recurrence: r.recurrence, recurrence_days: r.recurrence_days, recurrence_until: r.recurrence_until, schedule: scheduleText(r),
    kpi: r.kpi_id ? { id: r.kpi_id, metric: r.kpi_metric, sub_metric: r.kpi_sub_metric, archived: !!r.kpi_archived_at } : null,
    legacy_kpi_label: r.legacy_kpi_label, can_edit: canEditTask(s, r), slack: slackInfo(r),
  };
}

/**
 * Every unit of the readable, filtered tasks dated in [from, to], plus open one-time tasks outside it (undated,
 * overdue or upcoming). Closed units are dropped here, so no caller can count them.
 */
export async function loadUnits(s: Session, url: URL, from: string, to: string, today: string) {
  const params: unknown[] = [];
  const where = taskFilters(url, s, params);
  params.push(from, to);
  const pf = params.length - 1, pt = params.length;
  const rows = await query<any>(`${TASK_SELECT}
     where ${where.join(" and ")}
       and ((t.recurrence is null and (t.completed_on is null or t.completed_on between $${pf} and $${pt} or t.due_date between $${pf} and $${pt}))
         or (t.recurrence is not null and t.due_date <= $${pt} and (t.recurrence_until is null or t.recurrence_until >= $${pf})))
     order by t.due_date nulls last, t.created_at, t.id limit ${MAX_TASKS + 1}`, params);
  if (rows.length > MAX_TASKS) throw badRequest("Too many tasks match. Choose a brand or person to narrow the view.");
  const asg = await loadAssignments(rows.map((r) => r.id));
  const rec = rows.filter((r) => r.recurrence).map((r) => r.id);
  const done = new Map<string, { completed_on: string; completed_by: string | null }>();
  if (rec.length) for (const o of await query<any>(
    "select task_id, occurrence_date::text d, completed_on::text completed_on, completed_by from task_occurrences where task_id = any($1::uuid[]) and occurrence_date between $2 and $3",
    [rec, from, to])) done.set(`${o.task_id}:${o.d}`, { completed_on: o.completed_on, completed_by: o.completed_by });
  const ids = new Set<string>();
  for (const r of rows) { ids.add(r.assignee_id); if (r.completed_by) ids.add(r.completed_by); }
  for (const list of asg.values()) for (const a of list) ids.add(a.assignee_id);
  for (const v of done.values()) if (v.completed_by) ids.add(v.completed_by);
  const users = new Map((ids.size ? await query<User>("select id, display_name, status, role from users where id = any($1::uuid[])", [[...ids]]) : []).map((u) => [u.id, u]));
  const who = (id: string) => ({ id, name: users.get(id)?.display_name ?? "Unknown", archived: users.get(id)?.status === "archived" });

  const units: Unit[] = [];
  for (const r of rows) {
    const list = asg.get(r.id) ?? [];
    const info = taskInfo(s, r);
    if (!r.recurrence) {
      const owner = who(oneTimeOwner(list, r));
      const isDone = r.completed_on !== null;
      if (!isDone && owner.archived) continue;                                    // closed
      units.push({ key: `task:${r.id}`, task_id: r.id, kind: "task", date: r.due_date, status: isDone ? "done" : "open",
        overdue: !isDone && !!r.due_date && r.due_date < today, owner, completed_on: r.completed_on, completed_by: r.completed_by ? who(r.completed_by).name : null,
        can_complete: info.can_edit, completion_blocked: info.can_edit ? null : "view_only", completable_from: null, task: info });
      continue;
    }
    for (const d of seriesOccurrences(r, from, to)) {
      const o = done.get(`${r.id}:${d}`);
      const owner = who(ownerOn(list, d, r.assignee_id));
      if (!o && owner.archived) continue;                                         // closed
      units.push({ key: `occ:${r.id}:${d}`, task_id: r.id, kind: "occurrence", date: d, status: o ? "done" : "open", overdue: !o && d < today, owner,
        completed_on: o?.completed_on ?? null, completed_by: o?.completed_by ? who(o.completed_by).name : null,
        ...occurrenceCompletion(s, r, owner.id, d, today), task: info });
    }
  }
  return units;
}

const counts = (xs: Unit[]) => ({ total: xs.length, done: xs.filter((u) => u.status === "done").length, pending: xs.filter((u) => u.status === "open").length });

export function registerWeek(r: Router) {
  r.get("/tasks/week", ALL, async ({ url, session: s }) => {
    const today = todayVN();
    const asked = url.searchParams.get("start");
    if (asked !== null && !isIsoDate(asked)) throw badRequest("start must be a date (YYYY-MM-DD).");
    const ws = weekStart(asked ?? today), we = addDays(ws, 6);
    const lookback = addDays(today, -OVERDUE_LOOKBACK_DAYS);
    const from = ws < lookback ? ws : lookback;
    let person = qp(url, "person", /^(all|[0-9a-f-]{36})$/, "all")!;
    const all = await loadUnits(s, url, from, we, today);
    const mine = person === "all" ? all : all.filter((u) => u.owner.id === person);

    const inWeek = (u: Unit) => u.date !== null && u.date >= ws && u.date <= we;
    const weekUnits = mine.filter((u) => (u.kind === "task" && u.status === "done" && u.completed_on! >= ws && u.completed_on! <= we) || inWeek(u));
    const overdue = mine.filter((u) => u.status === "open" && u.overdue && (u.kind === "task" || u.date! >= lookback || inWeek(u)));
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).map((date) => ({
      date, items: mine.filter((u) => u.status === "open" && !u.overdue && u.date === date),
    }));
    const undated = mine.filter((u) => u.status === "open" && u.date === null);
    const upcomingUnits = mine.filter((u) => u.kind === "task" && u.status === "open" && u.date !== null && u.date > we);
    const upcoming: { week_start: string; items: Unit[] }[] = [];
    for (const u of upcomingUnits) {
      const k = weekStart(u.date!);
      let g = upcoming.find((x) => x.week_start === k);
      if (!g) upcoming.push(g = { week_start: k, items: [] });
      g.items.push(u);
    }
    upcoming.sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
    const completed = weekUnits.filter((u) => u.status === "done");

    // Workload: every active staff member, including those with nothing this week, for the selected week and the
    // brand, type and search filters (not the person filter). Administrators and Management only.
    let workload: any[] | null = null;
    if (s.allBrands) {
      const staff = await query<User>("select id, display_name, status, role from users where role = 'staff' and status <> 'archived' order by lower(display_name)");
      const wk = all.filter((u) => (u.kind === "task" && u.status === "done" && u.completed_on! >= ws && u.completed_on! <= we) || inWeek(u));
      workload = staff.map((p) => {
        const own = wk.filter((u) => u.owner.id === p.id);
        return { id: p.id, name: p.display_name, invited: p.status === "pending", ...counts(own),
          overdue: all.filter((u) => u.owner.id === p.id && u.status === "open" && u.overdue && (u.kind === "task" || u.date! >= lookback || inWeek(u))).length };
      });
    }
    return {
      today, week: { start: ws, end: we, is_current: ws === weekStart(today) },
      summary: { ...counts(weekUnits), overdue: overdue.length, undated: undated.length,
        routine: counts(weekUnits.filter((u) => u.kind === "occurrence" || u.task.type === "routine")),
        one_time: counts(weekUnits.filter((u) => !(u.kind === "occurrence" || u.task.type === "routine"))) },
      overdue: overdue.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? -1 : 1)), days, undated, upcoming, completed, workload,
      overdue_lookback_days: OVERDUE_LOOKBACK_DAYS,
    };
  });
}
