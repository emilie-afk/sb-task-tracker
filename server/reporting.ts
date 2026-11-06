// Read-only reporting API for the marketing dashboard (Task Tracker → Marketing Dashboard, one way).
// Contract: docs/REPORTING_API.md.
//
//   GET /api/reporting/v1/tasks[?snapshot=<id>&cursor=<c>&limit=<n>]
//   Header: x-tracker-reporting-key: <dedicated reporting secret>
//
// - Its own random credential (stored hashed, compared in constant time). Human sessions, OAuth secrets and
//   administrator access are never accepted here, and this credential reaches nothing else.
// - Scope: only brands an administrator enabled for reporting AND mapped to a dashboard business that the
//   credential allows (Succulents Box only by default). New brands are never included automatically.
// - Snapshot identity: every page carries the same snapshot id. A page asked for with a snapshot id that no longer
//   matches the current state answers 409 `snapshot_changed`, so a reader can never combine pages of two states.
// - Records: one-time tasks, and occurrences (not series) of recurring tasks within a bounded window. No emails,
//   notes, account lists or administrative fields are included.
// - Records are credited to the task's owner on the record's date (effective-dated ownership).
// - Reconciliation: the last page lists every task currently in scope (in_scope_tasks) with the date span of its
//   occurrences. That list is authoritative and does not expire, so a reader reconnecting after any gap removes
//   copies of deleted, unassigned or out-of-scope tasks, including old occurrences outside the window. Removal
//   markers (last 180 days) only add the reason.
// - Disabled (503) when the credential or instance id is not configured.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { one, query, tx } from "./db";
import { HttpError, json } from "./http";
import { appSecret, instanceId, appOrigin } from "./config";
import { hit, clientKey, RATE } from "./rateLimit";
import { todayVN, addDays } from "../shared/dates";
import { occurrences } from "../shared/recurrence";
import { loadAssignments, ownerOn, oneTimeOwner } from "./ownership";

export const REPORTING_HEADER = "x-tracker-reporting-key";
export const REPORT_LIMITS = { defaultPage: 200, maxPage: 500, windowBackDays: 60, windowAheadDays: 60, removalDays: 180, maxScopeTasks: 20_000 };
const SCHEMA_VERSION = 2;

const hashKey = (k: string) => createHash("sha256").update(k).digest();

async function authenticate(req: Request) {
  const presented = req.headers.get(REPORTING_HEADER) ?? "";
  const cred = await one<{ id: string; key_hash: Buffer; allowed_business_ids: string[] }>(
    "select id, key_hash, allowed_business_ids from reporting_credentials where revoked_at is null");
  if (!cred || !instanceId()) throw new HttpError(503, "reporting_disabled", "Reporting is not configured.");
  const ok = presented.length >= 32 && presented.length <= 200 && timingSafeEqual(hashKey(presented), Buffer.from(cred.key_hash));
  if (!ok) {
    await hit({ bucket: `report-fail:${clientKey(req)}`, ...RATE.reportingAuthFail });
    throw new HttpError(401, "unauthorized", "Invalid reporting credential.");
  }
  if (Math.random() < 0.2) await query("update reporting_credentials set last_used_at = now() where id = $1", [cred.id]);
  return cred;
}

type Item = Record<string, unknown> & { record_id: string };

/** Builds the complete, ordered record list for the current state, inside one repeatable-read transaction. */
async function buildSnapshot(allowed: string[]) {
  return tx(async (c) => {
    const epoch = Number((await c.query("select epoch from reporting_state where id = 1")).rows[0].epoch);
    const today = todayVN();
    const from = addDays(today, -REPORT_LIMITS.windowBackDays), to = addDays(today, REPORT_LIMITS.windowAheadDays);
    const inScope = `b.reporting_enabled and b.dashboard_business_id = any($1::text[])`;
    const rows = (await c.query(
      `select t.id, t.title, t.type, t.due_date, t.recurrence, t.recurrence_until, t.completed_on, t.completed_at, t.updated_at, t.operational_date,
              b.id brand_id, b.display_name brand_name, b.status brand_status, b.dashboard_business_id business_id, t.assignee_id
         from tasks t join brands b on b.id = t.brand_id
        where t.deleted_at is null and ${inScope}
          and (t.recurrence is null or (t.due_date <= $3 and (t.recurrence_until is null or t.recurrence_until >= $2)))
        order by t.id`, [allowed, from, to])).rows;
    const recurring = rows.filter((r) => r.recurrence).map((r) => r.id);
    const done = new Map<string, any>();
    if (recurring.length) for (const o of (await c.query(
      "select task_id, occurrence_date, completed_on, completed_at from task_occurrences where task_id = any($1::uuid[]) and occurrence_date between $2 and $3", [recurring, from, to])).rows)
      done.set(`${o.task_id}:${o.occurrence_date}`, o);
    const origin = appOrigin();
    // Each record is credited to the person who owned the task on that record's date (effective-dated ownership),
    // never to the series' current assignee for all history.
    const asg = await loadAssignments(rows.map((r) => r.id), c);
    const userIds = new Set<string>(rows.map((r) => r.assignee_id));
    for (const list of asg.values()) for (const a of list) userIds.add(a.assignee_id);
    const users = new Map((await c.query("select id, display_name, status from users where id = any($1::uuid[])", [[...userIds]])).rows.map((u) => [u.id, u]));
    const person = (id: string) => ({ id, name: users.get(id)?.display_name ?? "Unknown", archived: users.get(id)?.status === "archived" });
    const items: Item[] = [];
    for (const r of rows) {
      const list = asg.get(r.id) ?? [];
      const base = {
        task_id: r.id, title: r.title, type: r.type, business_id: r.business_id,
        brand: { id: r.brand_id, name: r.brand_name, archived: r.brand_status === "archived" },
        recurrence: r.recurrence, source_updated_at: new Date(r.updated_at).toISOString(), open_url: `${origin}/#/tasks/${r.id}`,
      };
      if (!r.recurrence) {
        items.push({ record_id: `task:${r.id}`, kind: "task", ...base, assignee: person(oneTimeOwner(list, r)), occurrence_date: null, due_date: r.due_date,
          status: r.completed_on ? "done" : "open", completed_on: r.completed_on, created_on: r.operational_date });
        continue;
      }
      for (const d of occurrences(r.recurrence, r.due_date, from, to, r.recurrence_until)) {
        const o = done.get(`${r.id}:${d}`);
        items.push({ record_id: `occ:${r.id}:${d}`, kind: "occurrence", ...base, assignee: person(ownerOn(list, d, r.assignee_id)), occurrence_date: d, due_date: d,
          status: o ? "done" : "open", completed_on: o?.completed_on ?? null, created_on: r.operational_date });
      }
    }
    // Authoritative scope: EVERY task currently in the reported scope, whatever its dates, with the date span its
    // occurrences can have. A reader removes any copy whose task is not listed (however long ago it was synced)
    // and any occurrence outside its task's span, and keeps the rest as history.
    const scopeTasks = (await c.query(
      `select t.id task_id, t.recurrence is not null recurring, t.due_date::text first_due, t.recurrence_until::text until
         from tasks t join brands b on b.id = t.brand_id where t.deleted_at is null and ${inScope} order by t.id`, [allowed])).rows
      .map((x) => ({ task_id: x.task_id, recurring: x.recurring, first_due: x.recurring ? x.first_due : null, until: x.recurring ? x.until : null }));
    items.sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
    // Remember which tasks have ever been reported, so removal markers name only those (never tasks of
    // unrelated brands), and list the ones that recently left the reported set, with the reason.
    const reportedIds = [...new Set(rows.map((r) => r.id))];
    if (reportedIds.length) await c.query("insert into reporting_exposures (task_id) select unnest($1::uuid[]) on conflict do nothing", [reportedIds]);
    const removed = (await c.query(
      `select t.id, case when t.deleted_at is not null then 'deleted' when t.brand_id is null then 'brand_unassigned'
                         when not b.reporting_enabled or b.dashboard_business_id is null then 'brand_not_reported'
                         else 'out_of_scope' end reason
         from reporting_exposures x join tasks t on t.id = x.task_id left join brands b on b.id = t.brand_id
        where (t.updated_at > now() - make_interval(days => $2) or b.updated_at > now() - make_interval(days => $2))
          and (t.deleted_at is not null or t.brand_id is null or not (b.reporting_enabled and b.dashboard_business_id = any($1::text[])))`,
      [allowed, REPORT_LIMITS.removalDays])).rows;
    const reported = new Set(rows.map((r) => r.id));
    const removals = removed.filter((x) => !reported.has(x.id)).map((x) => ({ task_id: x.id, reason: x.reason })).sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
    if (scopeTasks.length > REPORT_LIMITS.maxScopeTasks) throw new HttpError(503, "reporting_too_large", "Too many tasks in the reporting scope.");
    const id = "snp_" + createHmac("sha256", appSecret()).update(`${epoch}|${today}|${allowed.join(",")}`).digest("hex").slice(0, 32);
    return { id, epoch, today, window: { from, to }, items, removals, scopeTasks };
  }, "repeatable read");
}

export async function handleReporting(req: Request, path: string): Promise<Response> {
  if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "Reporting is read-only.");
  if (path !== "/reporting/v1/tasks") throw new HttpError(404, "not_found", "No such endpoint.");
  await hit({ bucket: `report:${clientKey(req)}`, ...RATE.reporting });
  const cred = await authenticate(req);
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? REPORT_LIMITS.defaultPage : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_LIMITS.maxPage) throw new HttpError(400, "invalid_request", "limit must be 1-500.");
  const cursor = url.searchParams.get("cursor");
  const askedSnapshot = url.searchParams.get("snapshot");
  if (cursor !== null && !/^\d{1,7}$/.test(cursor)) throw new HttpError(400, "invalid_request", "Invalid cursor.");
  if (askedSnapshot !== null && !/^snp_[0-9a-f]{32}$/.test(askedSnapshot)) throw new HttpError(400, "invalid_request", "Invalid snapshot.");
  if (cursor !== null && askedSnapshot === null) throw new HttpError(400, "invalid_request", "A cursor needs its snapshot.");

  const allowed = cred.allowed_business_ids;
  const snap = await buildSnapshot(allowed);
  if (askedSnapshot !== null && askedSnapshot !== snap.id)
    throw new HttpError(409, "snapshot_changed", "The data changed while paging. Start again from the first page.");
  const offset = cursor === null ? 0 : Number(cursor);
  if (offset > snap.items.length) throw new HttpError(400, "invalid_request", "Cursor is past the end.");
  const page = snap.items.slice(offset, offset + limit);
  const next = offset + limit < snap.items.length ? String(offset + limit) : null;
  return json({
    schema_version: SCHEMA_VERSION,
    source_instance: instanceId(),
    snapshot: { id: snap.id, generated_at: new Date().toISOString(), operational_date: snap.today, timezone: "Asia/Ho_Chi_Minh", window: snap.window, total_items: snap.items.length },
    scope: { business_ids: allowed },
    items: page,
    // Sent complete on the last page: the authoritative in-scope task list (reconciliation after any gap) and
    // removal markers with reasons for tasks that left the scope in the last 180 days (informational).
    in_scope_tasks: next === null ? snap.scopeTasks : null,
    removals: next === null ? snap.removals : [],
    page: { offset, limit, count: page.length },
    next_cursor: next,
  });
}
