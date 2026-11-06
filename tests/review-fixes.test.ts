// Regression tests for review findings: historical ownership of recurring work (1), authoritative reporting
// scope after long gaps (3, tracker side) and list/detail agreement for recurring tasks (5). Fictional data only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { freshDb, q, call, person, brand, login, task, app, ORIGIN, closePool, type Who } from "./helpers";
import { _setClockForTests } from "../shared/dates";
import { getPool } from "../server/db";

let admin: Who, a: Who, b: Who, SB: string, secret = "";
const at = (iso: string) => _setClockForTests(() => Date.parse(iso));
const readAll = async () => {
  const first = await (await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500`, { headers: { "x-tracker-reporting-key": secret } }))).json();
  expect(first.next_cursor).toBeNull();
  return first;
};

beforeAll(async () => {
  await freshDb();
  SB = await brand("Alpha Plants", { reporting_enabled: true, dashboard_business_id: "sb" });
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  a = await login(await person("ann@example.test", "Ann Original", "staff", "active", [SB]));
  b = await login(await person("ben@example.test", "Ben Replacement", "staff", "active", [SB]));
  secret = (await call(admin, "POST", "/integrations/reporting/credential", {})).body.secret;
});
afterAll(async () => { _setClockForTests(null); await closePool(); });
afterEach(() => _setClockForTests(null));

describe("1. reassignment keeps historical ownership of recurring work", () => {
  let daily: any, doneOnce: any;
  it("archiving A and reassigning the series to B keeps yesterday's completed occurrence credited to A", async () => {
    at("2026-11-10T03:00:00Z");                                       // Tue 10 Nov, Vietnam
    daily = await task(admin, { title: "Daily inbox", brand_id: SB, assignee_id: a.id, recurrence: "daily", due_date: "2026-11-01" });
    doneOnce = await task(a, { title: "One-off by Ann", brand_id: SB });
    expect((await call(a, "POST", `/tasks/${daily.id}/completion`, { done: true, occurrence_date: "2026-11-09" })).status).toBe(200);
    at("2026-11-09T03:00:00Z");
    expect((await call(a, "POST", `/tasks/${doneOnce.id}/completion`, { done: true, version: doneOnce.version })).status).toBe(200);   // completed 9 Nov
    at("2026-11-10T03:00:00Z");
    const pa = (await call(admin, "GET", `/people/${a.id}`)).body.person;
    const r = await call(admin, "POST", `/people/${a.id}/archive`, { version: pa.version, reassign: [{ task_id: daily.id, assignee_id: b.id }, { task_id: doneOnce.id, assignee_id: b.id }] });
    expect(r.body.reassigned.every((x: any) => x.ok)).toBe(true);

    // Summaries: yesterday belongs to A, not B.
    const y = await call(admin, "GET", "/summaries?period=yesterday&include_archived=1");
    const byId = Object.fromEntries(y.body.by_person.map((p: any) => [p.id, p]));
    expect(byId[a.id]).toMatchObject({ done: 2, archived: true });       // the occurrence and the one-time task
    expect(byId[b.id]).toMatchObject({ done: 0, pending: 0 });
    expect((await call(b, "GET", "/summaries?period=yesterday")).body).toMatchObject({ done: 0, pending: 0 });
    // Today's occurrence is B's.
    const t = await call(b, "GET", "/summaries?period=today");
    expect(t.body.routine.pending).toBe(1);
    // Default team summary (archived excluded) does not move A's work to B.
    const def = await call(admin, "GET", "/summaries?period=yesterday");
    expect(def.body.by_person.find((p: any) => p.id === b.id).done).toBe(0);
    expect(def.body.done).toBe(0);
  });
  it("task detail, occurrence list and history show effective-dated ownership", async () => {
    at("2026-11-10T03:00:00Z");
    const d = await call(admin, "GET", `/tasks/${daily.id}`);
    expect(d.body.assignments.map((x: any) => [x.assignee_name, x.effective_from])).toEqual([["Ann Original", null], ["Ben Replacement", "2026-11-10"]]);
    expect(d.body.history.find((h: any) => h.action === "reassigned").changes.effective_from).toBe("2026-11-10");
    const occ = (await call(admin, "GET", `/tasks/${daily.id}/occurrences?from=2026-11-08&to=2026-11-11`)).body.items;
    expect(occ.map((o: any) => [o.date, o.owner.name, o.done])).toEqual([
      ["2026-11-08", "Ann Original", false], ["2026-11-09", "Ann Original", true], ["2026-11-10", "Ben Replacement", false], ["2026-11-11", "Ben Replacement", false]]);
    // B cannot rewrite A's period; an administrator can.
    expect((await call(b, "POST", `/tasks/${daily.id}/completion`, { done: false, occurrence_date: "2026-11-09" })).status).toBe(403);
    expect((await call(b, "POST", `/tasks/${daily.id}/completion`, { done: true, occurrence_date: "2026-11-10" })).status).toBe(200);
    // Completion actors and dates are untouched.
    const [o] = await q("select completed_by, completed_on::text c from task_occurrences where task_id = $1 and occurrence_date = '2026-11-09'", [daily.id]);
    expect(o).toMatchObject({ completed_by: a.id, c: "2026-11-10" });
  });
  it("reporting credits each record to its owner on that date", async () => {
    at("2026-11-10T03:00:00Z");
    const snap = await readAll();
    const rec = (id: string) => snap.items.find((i: any) => i.record_id === id);
    expect(rec(`occ:${daily.id}:2026-11-09`).assignee).toMatchObject({ id: a.id, name: "Ann Original", archived: true });
    expect(rec(`occ:${daily.id}:2026-11-10`).assignee).toMatchObject({ id: b.id, name: "Ben Replacement" });
    expect(rec(`task:${doneOnce.id}`).assignee.id).toBe(a.id);          // completed before the reassignment
  });
  it("work already completed for today or ahead stays with the previous owner; the new owner starts after it", async () => {
    at("2026-11-10T03:00:00Z");
    const c = await login(await person("cat@example.test", "Cat Staff", "staff", "active", [SB]));
    const t = await task(admin, { title: "Weekly sync", brand_id: SB, assignee_id: c.id, recurrence: "daily", due_date: "2026-11-10" });
    await call(c, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-11" });
    const cur = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    const r = await call(admin, "POST", `/tasks/${t.id}/reassign`, { assignee_id: b.id, version: cur.version });
    expect(r.body.effective_from).toBe("2026-11-12");
    const occ = (await call(admin, "GET", `/tasks/${t.id}/occurrences?from=2026-11-10&to=2026-11-12`)).body.items;
    expect(occ.map((o: any) => o.owner.id)).toEqual([c.id, c.id, b.id]);
  });
  it("reassigning through the task editor is effective-dated too", async () => {
    at("2026-11-10T03:00:00Z");
    const t = await task(admin, { title: "Editor reassign", brand_id: SB, assignee_id: b.id, recurrence: "weekdays", due_date: "2026-11-02" });
    await call(b, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-06" });
    const cur = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(admin, "PATCH", `/tasks/${t.id}`, { version: cur.version, assignee_id: admin.id })).status).toBe(200);
    const occ = (await call(admin, "GET", `/tasks/${t.id}/occurrences?from=2026-11-06&to=2026-11-10`)).body.items;
    expect(occ.map((o: any) => [o.date, o.owner.id])).toEqual([["2026-11-06", b.id], ["2026-11-09", b.id], ["2026-11-10", admin.id]]);
  });
});

describe("3. authoritative reporting scope survives long gaps (tracker side)", () => {
  it("lists every in-scope task with its occurrence span, and omits removed tasks even after removal markers expire", async () => {
    at("2026-11-10T03:00:00Z");
    const old = await task(admin, { title: "Ended long ago", brand_id: SB, assignee_id: admin.id, recurrence: "weekly", due_date: "2026-01-05" });
    const oc = (await call(admin, "GET", `/tasks/${old.id}`)).body.task;
    await call(admin, "PATCH", `/tasks/${old.id}`, { version: oc.version, recurrence_until: "2026-03-30" });
    const gone = await task(admin, { title: "Deleted long ago", brand_id: SB, assignee_id: admin.id });
    await readAll();
    await call(admin, "DELETE", `/tasks/${gone.id}?version=${gone.version}`);
    // Simulate the change happening more than 180 days before the next read.
    await q("update tasks set updated_at = now() - interval '200 days' where id = $1", [gone.id]);
    await q("update brands set updated_at = now() - interval '200 days' where id = $1", [SB]);
    const snap = await readAll();
    expect(snap.removals.map((r: any) => r.task_id)).not.toContain(gone.id);       // marker expired
    const scope = new Map(snap.in_scope_tasks.map((t: any) => [t.task_id, t]));
    expect(scope.has(gone.id)).toBe(false);                                         // but scope is authoritative
    expect(scope.get(old.id)).toEqual({ task_id: old.id, recurring: true, first_due: "2026-01-05", until: "2026-03-30" });
    expect(snap.items.some((i: any) => i.task_id === old.id)).toBe(false);          // outside the window, yet in scope
    // Out-of-scope brands are never listed.
    const other = await brand("Beta Prints");
    const t = await task(admin, { title: "Unreported brand", brand_id: other, assignee_id: admin.id });
    expect((await readAll()).in_scope_tasks.map((x: any) => x.task_id)).not.toContain(t.id);
  });
});

describe("5. recurring list and detail status agree", () => {
  it("an ended monthly series completed more than seven days ago shows done in both list and detail", async () => {
    at("2026-11-10T03:00:00Z");
    const t = await task(admin, { title: "Monthly close", brand_id: SB, assignee_id: admin.id, recurrence: "monthly", due_date: "2026-08-15", recurrence_until: "2026-10-15" });
    expect((await call(admin, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-10-15" })).status).toBe(200);
    const list = (await call(admin, "GET", "/tasks?q=Monthly%20close")).body.items[0];
    const detail = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    for (const x of [list, detail]) expect(x).toMatchObject({ status: "done", overdue: false, occurrence: { date: "2026-10-15", done: true } });
  });
  it("an older unfinished occurrence stays open and overdue in both", async () => {
    at("2026-11-10T03:00:00Z");
    const t = await task(admin, { title: "Old weekly", brand_id: SB, assignee_id: admin.id, recurrence: "weekly", due_date: "2026-09-01", recurrence_until: "2026-10-20" });
    const list = (await call(admin, "GET", "/tasks?q=Old%20weekly")).body.items[0];
    const detail = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    for (const x of [list, detail]) expect(x).toMatchObject({ status: "open", overdue: true, occurrence: { date: "2026-10-20", done: false, overdue: true } });
    // Completing an older occurrence than the one shown does not mark the card done.
    await call(admin, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-10-13" });
    expect((await call(admin, "GET", "/tasks?q=Old%20weekly")).body.items[0].status).toBe("open");
  });
});

describe("2. sign-out is confirmed only when the server revoked the session", () => {
  it("a database failure while revoking answers an error, keeps the cookie, and the session is not reported revoked", async () => {
    const who = await login(b.id);
    const pool = getPool();
    const orig = pool.query.bind(pool);
    (pool as any).query = async (text: any, params?: any) => {
      if (typeof text === "string" && text.includes("update sessions set revoked_at")) throw Object.assign(new Error("connection terminated"), { code: "57P01" });
      return orig(text, params);
    };
    try {
      const r = await call(who, "POST", "/auth/logout");
      expect(r.status).toBe(500);
      expect(r.body.ok).toBeUndefined();
      expect(r.headers.get("set-cookie")).toBeNull();
    } finally { (pool as any).query = orig; }
    // The client was told sign-out failed; the session indeed still exists, and a retry revokes it.
    expect((await call(who, "GET", "/tasks")).status).toBe(200);
    const ok = await call(who, "POST", "/auth/logout");
    expect(ok.body).toEqual({ ok: true });
    expect(ok.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await call(who, "GET", "/tasks")).status).toBe(401);
    expect((await q("select revoked_at is not null r, revoke_reason from sessions where id = $1", [who.sessionId]))[0]).toEqual({ r: true, revoke_reason: "sign_out" });
  });
});
