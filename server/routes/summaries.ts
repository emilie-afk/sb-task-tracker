// Daily and period summaries. Counting rules (documented in docs/RECURRENCE.md):
//   - One-time task: done in a period when its completion date (Vietnam) falls in the period; pending when it is
//     open now, was created on or before the period end, and is due on or before the period end (or has no date).
//   - Recurring task: each occurrence dated inside the period, up to today, counts once; done if that occurrence
//     was completed, pending otherwise. A series is never counted as completed work, and future occurrences are
//     not pending yet.
//   - Task completion is not KPI performance; KPI values are reported separately.
// Staff summaries are always their own; administrators and Management see the team.
import type { Router } from "../router";
import { ALL } from "../router";
import { query } from "../db";
import { badRequest, forbidden } from "../http";
import { qp, UUID_RE } from "../validate";
import { taskReadScope } from "../policy";
import { todayVN, periodRange, isIsoDate, dayDiff } from "../../shared/dates";
import { occurrences } from "../../shared/recurrence";
import { loadAssignments, ownerOn, oneTimeOwner } from "../ownership";

type Unit = { assignee_id: string; routine: boolean; done: boolean };

export function registerSummaries(r: Router) {
  r.get("/summaries", ALL, async ({ url, session: s }) => {
    const today = todayVN();
    const period = qp(url, "period", /^(today|yesterday|mtd|lm|custom)$/, "today")!;
    let range = periodRange(period, today);
    if (period === "custom") {
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      if (!isIsoDate(from) || !isIsoDate(to) || to < from || dayDiff(from, to) > 400) throw badRequest("Choose a valid date range of up to 400 days.");
      range = { from, to };
    }
    const { from, to } = range!;
    let person = qp(url, "person", /^(all|[0-9a-f-]{36})$/, "all")!;
    if (s.role === "staff") {
      if (person !== "all" && person !== s.userId) throw forbidden("Staff summaries show your own work only.");
      person = s.userId;
    }
    const brand = qp(url, "brand", /^(all|unassigned|[0-9a-f-]{36})$/, "all")!;
    const includeArchived = qp(url, "include_archived", /^(0|1)$/, "0") === "1";

    const params: unknown[] = [];
    const where = ["t.deleted_at is null", taskReadScope(s, params)];
    if (brand === "unassigned") where.push(s.allBrands ? "t.brand_id is null" : "false");
    else if (brand !== "all") { if (!UUID_RE.test(brand)) throw badRequest("Invalid brand."); params.push(brand); where.push(`t.brand_id = $${params.length}`); }
    // Credit follows effective-dated ownership (task_assignments): a person's work includes tasks they owned on
    // the dated units, not only tasks currently assigned to them.
    if (person !== "all") { params.push(person); where.push(`exists (select 1 from task_assignments a where a.task_id = t.id and a.assignee_id = $${params.length})`); }
    params.push(from, to);
    const pf = params.length - 1, pt = params.length;
    const tasks = await query<any>(
      `select t.id, t.assignee_id, t.type, t.recurrence, t.due_date, t.recurrence_until, t.operational_date, t.completed_on
         from tasks t where ${where.join(" and ")}
          and ((t.recurrence is null and ((t.completed_on between $${pf} and $${pt})
                 or (t.completed_on is null and t.operational_date <= $${pt} and (t.due_date is null or t.due_date <= $${pt}))))
            or (t.recurrence is not null and t.due_date <= $${pt} and (t.recurrence_until is null or t.recurrence_until >= $${pf})))`, params);

    const recurringIds = tasks.filter((t) => t.recurrence).map((t) => t.id);
    const doneOcc = new Set((recurringIds.length ? await query<{ k: string }>(
      "select task_id || ':' || occurrence_date k from task_occurrences where task_id = any($1::uuid[]) and occurrence_date between $2 and $3", [recurringIds, from, to]) : []).map((x) => x.k));
    const asg = await loadAssignments(tasks.map((t) => t.id));
    let units: Unit[] = [];
    const last = to < today ? to : today;
    for (const t of tasks) {
      const list = asg.get(t.id) ?? [];
      if (!t.recurrence) { units.push({ assignee_id: oneTimeOwner(list, t), routine: t.type === "routine", done: t.completed_on !== null && t.completed_on >= from && t.completed_on <= to }); continue; }
      if (last < from) continue;
      for (const d of occurrences(t.recurrence, t.due_date, from, last, t.recurrence_until)) units.push({ assignee_id: ownerOn(list, d, t.assignee_id), routine: true, done: doneOcc.has(`${t.id}:${d}`) });
    }
    if (person !== "all") units = units.filter((u) => u.assignee_id === person);
    else if (!includeArchived) {
      // Default team summaries cover the active team; archived people's work is included only when asked for.
      const archived = new Set((await query<{ id: string }>("select id from users where status = 'archived'")).map((u) => u.id));
      units = units.filter((u) => !archived.has(u.assignee_id));
    }
    const count = (xs: Unit[]) => ({
      done: xs.filter((u) => u.done).length, pending: xs.filter((u) => !u.done).length,
      routine: { done: xs.filter((u) => u.routine && u.done).length, pending: xs.filter((u) => u.routine && !u.done).length },
      one_time: { done: xs.filter((u) => !u.routine && u.done).length, pending: xs.filter((u) => !u.routine && !u.done).length },
    });

    let byPerson: any[] | undefined;
    if (s.allBrands && person === "all") {
      const people = await query<{ id: string; display_name: string; archived: boolean }>(
        `select id, display_name, status = 'archived' archived from users where role <> 'management' ${includeArchived ? "" : "and status <> 'archived'"} order by archived, lower(display_name)`);
      byPerson = people.map((p) => ({ id: p.id, name: p.display_name, archived: p.archived, ...count(units.filter((u) => u.assignee_id === p.id)) }))
        .filter((p) => p.done + p.pending > 0 || !p.archived);
    }
    return { range: { from, to, period }, today, ...count(units), by_person: byPerson };
  });
}
