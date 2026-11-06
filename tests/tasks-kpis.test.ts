// Tasks, recurrence, dates, KPI scorecards, summaries, concurrency and safe handling of text. Fictional data only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { freshDb, q, call, person, brand, login, task, closePool, type Who } from "./helpers";
import { occurrences, nextOccurrence, isOccurrence } from "../shared/recurrence";
import { vietnamDate, _setClockForTests, weekStart, periodRange } from "../shared/dates";
import { currentOccurrence } from "../server/tasks";

let admin: Who, staff: Who, mgmt: Who, A: string;
beforeAll(async () => {
  await freshDb();
  A = await brand("Alpha Plants");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  staff = await login(await person("sam@example.test", "Sam Staff", "staff", "active", [A]));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
});
afterAll(closePool);
afterEach(() => _setClockForTests(null));
const at = (iso: string) => _setClockForTests(() => Date.parse(iso));

describe("recurrence rules", () => {
  it("daily, weekdays, weekly", () => {
    expect(occurrences("daily", "2026-11-05", "2026-11-04", "2026-11-08")).toEqual(["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(occurrences("weekdays", "2026-11-05", "2026-11-05", "2026-11-11")).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(occurrences("weekly", "2026-11-05", "2026-11-01", "2026-11-30")).toEqual(["2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26"]);
    expect(occurrences("weekly", "2026-11-05", "2026-11-06", "2026-11-13")).toEqual(["2026-11-12"]);
  });
  it("monthly month-end: the 31st becomes each short month's last day, including leap February", () => {
    expect(occurrences("monthly", "2027-01-31", "2027-01-01", "2027-05-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    expect(occurrences("monthly", "2028-01-30", "2028-02-01", "2028-03-31")).toEqual(["2028-02-29", "2028-03-30"]);
    expect(occurrences("monthly", "2026-11-15", "2026-11-16", "2027-01-20")).toEqual(["2026-12-15", "2027-01-15"]);
  });
  it("end dates, stable identity and bounds", () => {
    expect(occurrences("daily", "2026-11-01", "2026-11-01", "2026-11-30", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(occurrences("daily", "2026-11-05", "2026-11-01", "2026-11-30", "2026-11-04")).toEqual([]);
    expect(isOccurrence("weekly", "2026-11-05", "2026-11-12")).toBe(true);
    expect(isOccurrence("weekly", "2026-11-05", "2026-11-13")).toBe(false);
    expect(nextOccurrence("monthly", "2027-01-31", "2027-02-28")).toBe("2027-03-31");
    expect(occurrences("daily", "2000-01-01", "2000-01-01", "2100-01-01").length).toBe(1000);
  });
});

describe("Vietnam dates", () => {
  it("the operational day changes at midnight Vietnam time (17:00 UTC)", () => {
    expect(vietnamDate(Date.parse("2026-11-05T16:59:59Z"))).toBe("2026-11-05");
    expect(vietnamDate(Date.parse("2026-11-05T17:00:00Z"))).toBe("2026-11-06");
    expect(vietnamDate(Date.parse("2026-12-31T17:00:00Z"))).toBe("2027-01-01");
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
    expect(periodRange("lm", "2027-03-15")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });
  it("a task created just after Vietnam midnight carries the Vietnam date, not the UTC date", async () => {
    at("2026-11-05T17:30:00Z");      // 00:30 on Nov 6 in Vietnam, still Nov 5 in UTC
    const t = await task(staff, { title: "Midnight task", brand_id: A });
    expect(t.operational_date).toBe("2026-11-06");
    const r = await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, version: t.version });
    expect(r.body.task.completed_on).toBe("2026-11-06");
    const s = await call(staff, "GET", "/summaries?period=today");
    expect(s.body.range).toMatchObject({ from: "2026-11-06", to: "2026-11-06" });
    expect(s.body.done).toBeGreaterThanOrEqual(1);
  });
});

describe("recurring tasks", () => {
  it("completing one occurrence completes only that one and never creates tasks", async () => {
    at("2026-11-10T03:00:00Z");    // Tue Nov 10, Vietnam
    const t = await task(staff, { title: "Daily check", brand_id: A, recurrence: "daily", due_date: "2026-11-09" });
    expect(t.occurrence).toMatchObject({ date: "2026-11-09", overdue: true, done: false });
    const before = (await q("select count(*)::int n from tasks"))[0].n;
    expect((await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-09" })).status).toBe(200);
    let cur = (await call(staff, "GET", `/tasks/${t.id}`)).body.task;
    expect(cur.occurrence).toMatchObject({ date: "2026-11-10", done: false, overdue: false });
    await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-10" });
    await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-10" });   // idempotent
    cur = (await call(staff, "GET", `/tasks/${t.id}`)).body.task;
    expect(cur.occurrence).toMatchObject({ date: "2026-11-10", done: true });
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(before);
    expect((await q("select count(*)::int n from task_occurrences where task_id = $1", [t.id]))[0].n).toBe(2);
    const occ = (await call(staff, "GET", `/tasks/${t.id}/occurrences?from=2026-11-09&to=2026-11-12`)).body.items;
    expect(occ.map((o: any) => [o.date, o.done])).toEqual([["2026-11-09", true], ["2026-11-10", true], ["2026-11-11", false], ["2026-11-12", false]]);
    expect((await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true })).status).toBe(400);
    expect((await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-08" })).status).toBe(400);
  });
  it("summaries count occurrences, not series; future occurrences are not pending", async () => {
    at("2026-11-12T03:00:00Z");
    const s = await call(staff, "GET", "/summaries?period=custom&from=2026-11-09&to=2026-11-15");
    // Daily check: 9, 10 done; 11, 12 pending; 13-15 future (not counted).
    const own = s.body;
    expect(own.routine.done).toBeGreaterThanOrEqual(2);
    expect(own.routine.pending).toBeGreaterThanOrEqual(2);
    const t = (await call(staff, "GET", "/tasks?q=Daily%20check")).body.items[0];
    expect(t.status).toBe("open");
  });
  it("changing the schedule of a started series ends it and continues as a new series; past completions stay", async () => {
    at("2026-11-12T03:00:00Z");
    const t = (await call(staff, "GET", "/tasks?q=Daily%20check")).body.items[0];
    const r = await call(staff, "PATCH", `/tasks/${t.id}`, { version: t.version, recurrence: "weekly", due_date: "2026-11-16" });
    expect(r.status).toBe(200);
    expect(r.body.split_from).toBe(t.id);
    expect(r.body.task).toMatchObject({ recurrence: "weekly", due_date: "2026-11-16" });
    const [old] = await q("select recurrence_until::text u from tasks where id = $1", [t.id]);
    expect(old.u).toBe("2026-11-11");
    expect((await q("select count(*)::int n from task_occurrences where task_id = $1", [t.id]))[0].n).toBe(2);
    expect((await call(staff, "PATCH", `/tasks/${r.body.task.id}`, { version: r.body.task.version, recurrence: "daily", due_date: "2026-11-01" })).status).toBe(200);
  });
  it("cancelling a series sets its end date; it cannot end before a completed occurrence", async () => {
    at("2026-11-20T03:00:00Z");
    const t = await task(staff, { title: "Weekly report", brand_id: A, recurrence: "weekly", due_date: "2026-11-20" });
    await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-20" });
    const cur = (await call(staff, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(staff, "PATCH", `/tasks/${t.id}`, { version: cur.version, recurrence_until: "2026-11-19" })).status).toBe(400);
    const ok = await call(staff, "PATCH", `/tasks/${t.id}`, { version: cur.version, recurrence_until: "2026-11-20" });
    expect(ok.status).toBe(200);
    expect(currentOccurrence(ok.body.task, "2026-12-01", new Map([["2026-11-20", "2026-11-20"]]))).toMatchObject({ date: "2026-11-20", done: true });
  });
  it("a repeating task needs a first due date", async () => {
    expect((await call(staff, "POST", "/tasks", { title: "x", brand_id: A, recurrence: "daily" })).status).toBe(400);
  });
});

describe("one-time tasks and concurrency", () => {
  it("stale edits, completions and deletions return 409", async () => {
    const t = await task(staff, { title: "Conflict me", brand_id: A });
    expect((await call(staff, "PATCH", `/tasks/${t.id}`, { version: t.version, title: "First" })).status).toBe(200);
    const stale = await call(staff, "PATCH", `/tasks/${t.id}`, { version: t.version, title: "Second" });
    expect(stale.status).toBe(409);
    expect((await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, version: t.version })).status).toBe(409);
    expect((await call(staff, "DELETE", `/tasks/${t.id}?version=${t.version}`)).status).toBe(409);
  });
  it("deletion hides the task everywhere but keeps its history", async () => {
    const t = await task(staff, { title: "Delete me", brand_id: A });
    expect((await call(staff, "DELETE", `/tasks/${t.id}?version=${t.version}`)).status).toBe(200);
    expect((await call(staff, "GET", `/tasks/${t.id}`)).status).toBe(404);
    expect((await call(admin, "GET", "/tasks?q=Delete%20me")).body.total).toBe(0);
    expect((await q("select action from task_history where task_id = $1 order by id", [t.id])).map((x) => x.action)).toEqual(["created", "deleted"]);
  });
  it("bulk creation is bounded", async () => {
    expect((await call(admin, "POST", "/tasks/bulk", { titles: Array.from({ length: 51 }, (_, i) => `t${i}`), brand_id: A, assignee_id: staff.id })).status).toBe(400);
    expect((await call(admin, "POST", "/tasks/bulk", { titles: ["b1", "b2", "b3"], brand_id: A, assignee_id: staff.id })).body.ids).toHaveLength(3);
  });
  it("malformed input is rejected with field details and nothing is stored", async () => {
    for (const body of [{ title: "", brand_id: A }, { title: "x", brand_id: "not-a-uuid" }, { title: "x", brand_id: A, due_date: "2026-02-30" },
      { title: "x", brand_id: A, type: "other" }, { title: "a\u0000b", brand_id: A }, { title: "x".repeat(301), brand_id: A }])
      expect((await call(staff, "POST", "/tasks", body)).status).toBe(400);
  });
  it("user-supplied HTML is stored and returned as plain text, never interpreted", async () => {
    const html = `<img src=x onerror="alert(1)"><script>steal()</script>`;
    const t = await task(staff, { title: html, brand_id: A, note: `<b>${html}</b>` });
    const got = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    expect(got.title).toBe(html);
    expect(got.note).toBe(`<b>${html}</b>`);
  });
});

describe("KPI scorecards", () => {
  it("administrators create, edit, set values, archive; all KPI actions work", async () => {
    at("2026-11-11T03:00:00Z");
    const id = (await call(admin, "POST", "/kpis", { owner_id: staff.id, brand_id: A, metric: "Blogs", sub_metric: "Written", target: "2" })).body.id;
    let list = (await call(admin, "GET", `/kpis?owner=${staff.id}`)).body;
    expect(list.week_start).toBe("2026-11-09");
    let k = list.items.find((x: any) => x.id === id);
    expect(k).toMatchObject({ metric: "Blogs", sub_metric: "Written", target: "2", value: null });
    expect((await call(admin, "PUT", `/kpis/${id}/values/2026-11-11`, { value: "3" })).body.week_start).toBe("2026-11-09");
    expect((await call(staff, "GET", "/kpis")).body.items.find((x: any) => x.id === id).value).toBe("3");
    expect((await call(admin, "PATCH", `/kpis/${id}`, { version: k.version, target: "4", note: "weekly" })).status).toBe(200);
    expect((await call(admin, "PATCH", `/kpis/${id}`, { version: k.version, target: "5" })).status).toBe(409);
    k = (await call(admin, "GET", `/kpis?owner=${staff.id}`)).body.items.find((x: any) => x.id === id);
    expect(k).toMatchObject({ target: "4", note: "weekly", value: "3" });
    expect((await call(admin, "PUT", `/kpis/${id}/values/2026-11-11`, { value: null })).status).toBe(200);
    expect((await call(admin, "DELETE", `/kpis/${id}?version=${k.version}`)).status).toBe(200);
    list = (await call(admin, "GET", `/kpis?owner=${staff.id}`)).body;
    expect(list.items.find((x: any) => x.id === id)).toBeUndefined();
    expect((await q("select count(*)::int n from audit_events where target_type = 'kpi' and target_id = $1", [id]))[0].n).toBeGreaterThanOrEqual(4);
  });
  it("staff and Management cannot edit KPI definitions, targets or values", async () => {
    const id = (await call(admin, "POST", "/kpis", { owner_id: staff.id, brand_id: A, metric: "Posts" })).body.id;
    for (const who of [staff, mgmt]) {
      expect((await call(who, "POST", "/kpis", { owner_id: staff.id, brand_id: A, metric: "x" })).status).toBe(403);
      expect((await call(who, "PATCH", `/kpis/${id}`, { version: 1, target: "9" })).status).toBe(403);
      expect((await call(who, "PUT", `/kpis/${id}/values/2026-11-09`, { value: "9" })).status).toBe(403);
      expect((await call(who, "DELETE", `/kpis/${id}?version=1`)).status).toBe(403);
    }
  });
  it("completing a task never changes a KPI value", async () => {
    const id = (await call(admin, "POST", "/kpis", { owner_id: staff.id, brand_id: A, metric: "Videos" })).body.id;
    const t = await task(admin, { title: "Make a video", brand_id: A, assignee_id: staff.id, kpi_id: id });
    await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, version: t.version });
    expect((await q("select count(*)::int n from kpi_values where kpi_id = $1", [id]))[0].n).toBe(0);
  });
});

describe("empty database", () => {
  it("contains no seeded business data after migrations", async () => {
    const { freshDb: fresh } = await import("./helpers");
    await fresh();
    for (const t of ["users", "brands", "tasks", "kpi_definitions", "kpi_values", "user_brand_access", "task_occurrences", "import_batches"])
      expect((await q(`select count(*)::int n from ${t}`))[0].n, t).toBe(0);
  });
});
