// Administrator, Staff and Management roles; the weekly timeline; weekly routines on chosen weekdays; completion
// ownership; and closing the unfinished work of archived people. Fictional people, brands and records only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { freshDb, q, call, person, brand, login, app, ORIGIN, closePool, type Who } from "./helpers";
import { _setClockForTests } from "../shared/dates";

let admin: Who, admin2: Who, sam: Who, kim: Who, mgmt: Who;
let A: string, B: string, secret = "";
const at = (iso: string) => _setClockForTests(() => Date.parse(iso));
// Vietnam is UTC+7: 03:00Z is 10:00 in Vietnam on the same date.
const vn = (date: string, time = "10:00") => at(new Date(`${date}T${time}:00+07:00`).toISOString());

const mk = async (who: Who, body: Record<string, unknown>) => {
  const r = await call(who, "POST", "/tasks", { type: "adhoc", ...body });
  if (r.status !== 200) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.task as any;
};
const week = async (who: Who, query = "") => (await call(who, "GET", `/tasks/week${query}`)).body;
const titlesIn = (list: any[]) => list.map((u: any) => u.task.title);
const report = async () => {
  const items: any[] = [];
  let first: any = null, next: string | null = null;
  do {
    const r = await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500${first ? `&snapshot=${first.snapshot.id}&cursor=${next}` : ""}`, { headers: { "x-tracker-reporting-key": secret } }));
    const body = await r.json();
    first ??= body;
    items.push(...body.items);
    next = body.next_cursor;
  } while (next);
  return items;
};

beforeAll(async () => {
  await freshDb();
  vn("2026-11-18");                                                   // Wednesday
  A = await brand("Alpha Plants", { reporting_enabled: true, dashboard_business_id: "sb" });
  B = await brand("Beta Prints");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  admin2 = await login(await person("ben@example.test", "Ben Admin", "administrator"));
  sam = await login(await person("sam@example.test", "Sam Staff", "staff", "active", [A, B]));
  kim = await login(await person("kim@example.test", "Kim Staff", "staff", "active", [A]));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
  await person("zoe@example.test", "Zoe Idle", "staff", "active", [A]);   // active staff with no tasks
  secret = (await call(admin, "POST", "/integrations/reporting/credential", {})).body.secret;
});
afterAll(async () => { _setClockForTests(null); await closePool(); });
afterEach(() => vn("2026-11-18"));

describe("administrators manage the team's work", () => {
  it("cannot be given a new task: assignment, reassignment, the assignee picker and the planning rule exclude them", async () => {
    const r = await call(admin, "POST", "/tasks", { title: "For myself", brand_id: A, assignee_id: admin.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("administrator_not_assignable");
    expect((await call(admin, "POST", "/tasks", { title: "No assignee", brand_id: A })).status).toBe(400);
    expect((await call(admin, "POST", "/tasks", { title: "Other admin", brand_id: A, assignee_id: admin2.id })).status).toBe(409);
    const t = await mk(admin, { title: "Reassign me", brand_id: A, assignee_id: sam.id });
    expect((await call(admin, "POST", `/tasks/${t.id}/reassign`, { assignee_id: admin.id })).status).toBe(409);
    expect((await call(admin, "PATCH", `/tasks/${t.id}`, { version: t.version, assignee_id: admin2.id })).status).toBe(409);
    const picker = (await call(admin, "GET", `/people-assignable?brand=${A}`)).body.items.map((p: any) => p.display_name);
    expect(picker).toEqual(["Kim Staff", "Sam Staff", "Zoe Idle"]);
  });
  it("create, edit, assign, reassign, complete, reopen and delete anyone's task", async () => {
    const t = await mk(admin, { title: "Admin managed", brand_id: A, assignee_id: sam.id, due_date: "2026-11-19" });
    const e = await call(admin, "PATCH", `/tasks/${t.id}`, { version: t.version, title: "Admin managed (edited)", assignee_id: kim.id });
    expect(e.status).toBe(200);
    expect(e.body.task.assignee.id).toBe(kim.id);
    const done = await call(admin, "POST", `/tasks/${t.id}/completion`, { done: true, version: e.body.task.version });
    expect(done.status).toBe(200);
    const reopened = await call(admin, "POST", `/tasks/${t.id}/completion`, { done: false, version: done.body.task.version });
    expect(reopened.body.task.status).toBe("open");
    expect((await call(admin, "DELETE", `/tasks/${t.id}?version=${reopened.body.task.version}`)).status).toBe(200);
  });
  it("tasks an administrator already held keep their history and stay readable for review", async () => {
    const t = await mk(admin, { title: "Old admin task", brand_id: A, assignee_id: sam.id });
    // Simulate a record from before this rule: held by an administrator.
    await q("update tasks set assignee_id = $1 where id = $2", [admin.id, t.id]);
    await q("update task_assignments set assignee_id = $1 where task_id = $2", [admin.id, t.id]);
    const d = (await call(mgmt, "GET", `/tasks/${t.id}`)).body.task;
    expect(d.assignee).toMatchObject({ id: admin.id, name: "Ada Admin" });
    // Editing other fields works without reassigning; moving it to staff works.
    expect((await call(admin, "PATCH", `/tasks/${t.id}`, { version: d.version, note: "kept" })).status).toBe(200);
    const cur = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(admin, "POST", `/tasks/${t.id}/reassign`, { assignee_id: kim.id, version: cur.version })).status).toBe(200);
    await call(admin, "DELETE", `/tasks/${t.id}?version=${(await call(admin, "GET", `/tasks/${t.id}`)).body.task.version}`);
  });
  it("the last active administrator cannot be archived, deleted or demoted", async () => {
    await q("update users set status = 'archived', archived_at = now() where id = $1", [admin2.id]);
    const me = (await call(admin, "GET", `/people/${admin.id}`)).body.person;
    expect((await call(admin, "PATCH", `/people/${admin.id}`, { version: me.version, role: "staff" })).status).toBe(409);
    expect((await call(admin, "POST", `/people/${admin.id}/archive`, { version: me.version })).status).toBe(409);
    expect((await call(admin, "DELETE", `/people/${admin.id}?version=${me.version}`)).status).toBe(409);
    await q("update users set status = 'active', archived_at = null where id = $1", [admin2.id]);
  });
});

describe("Management is view-only", () => {
  it("reads every brand and task but every mutation is refused on the server", async () => {
    const t = await mk(admin, { title: "Visible to management", brand_id: B, assignee_id: sam.id });
    expect((await call(mgmt, "GET", `/tasks/${t.id}`)).status).toBe(200);
    expect(titlesIn((await week(mgmt)).days.flatMap((d: any) => d.items).concat((await week(mgmt)).undated))).toContain("Visible to management");
    const refusals: [string, string, unknown?][] = [
      ["POST", "/tasks", { title: "x", brand_id: A, assignee_id: sam.id }], ["POST", "/tasks/bulk", { titles: ["x"], brand_id: A, assignee_id: sam.id }],
      ["PATCH", `/tasks/${t.id}`, { version: t.version, title: "y" }], ["POST", `/tasks/${t.id}/completion`, { done: true, version: t.version }],
      ["POST", `/tasks/${t.id}/reassign`, { assignee_id: kim.id }], ["DELETE", `/tasks/${t.id}?version=${t.version}`],
      ["POST", "/kpis", { owner_id: sam.id, brand_id: A, metric: "x" }], ["POST", "/brands", { display_name: "New" }],
      ["POST", "/people", { email: "n@example.test", display_name: "N", role: "staff" }], ["POST", "/imports/kpi-xlsx/preview", {}],
      ["POST", "/integrations/reporting/credential", {}], ["DELETE", "/integrations/planning/credential"],
    ];
    for (const [m, p, b] of refusals) expect((await call(mgmt, m, p, b)).status, `${m} ${p}`).toBe(403);
    expect((await call(admin, "GET", `/tasks/${t.id}`)).body.task.title).toBe("Visible to management");
    const card = (await week(mgmt)).undated.find((u: any) => u.task.id === t.id);
    expect(card).toMatchObject({ can_complete: false, task: { can_edit: false } });
  });
});

describe("staff carry out their own tasks", () => {
  it("cannot create for others, complete or reopen a colleague's work, or edit it", async () => {
    expect((await call(sam, "POST", "/tasks", { title: "For Kim", brand_id: A, assignee_id: kim.id })).status).toBe(403);
    const kt = await mk(admin, { title: "Kim's task", brand_id: A, assignee_id: kim.id, due_date: "2026-11-19" });
    expect((await call(sam, "POST", `/tasks/${kt.id}/completion`, { done: true, version: kt.version })).status).toBe(403);
    expect((await call(sam, "PATCH", `/tasks/${kt.id}`, { version: kt.version, title: "mine now" })).status).toBe(403);
    const u = (await week(sam)).days.flatMap((d: any) => d.items).find((x: any) => x.task.id === kt.id);
    expect(u).toMatchObject({ can_complete: false, task: { can_edit: false }, owner: { id: kim.id } });
    const own = await mk(sam, { title: "Sam's own", brand_id: A, due_date: "2026-11-19" });
    const d = await call(sam, "POST", `/tasks/${own.id}/completion`, { done: true, version: own.version });
    expect(d.status).toBe(200);
    expect((await call(sam, "POST", `/tasks/${own.id}/completion`, { done: false, version: d.body.task.version })).status).toBe(200);
  });
});

describe("weekly routines on chosen weekdays", () => {
  let series: any;
  it("default to the start date's weekday; several weekdays can be chosen; weekdays only apply to weekly repeats", async () => {
    const one = await mk(sam, { title: "Weekly default", brand_id: A, type: "routine", recurrence: "weekly", due_date: "2026-11-18" });
    expect(one).toMatchObject({ recurrence_days: [3], schedule: "Weekly on Wed" });
    series = await mk(admin, { title: "Mon and Thu routine", brand_id: A, assignee_id: sam.id, type: "routine", recurrence: "weekly", recurrence_days: [4, 1], due_date: "2026-11-16" });
    expect(series).toMatchObject({ recurrence_days: [1, 4], schedule: "Weekly on Mon, Thu" });
    expect((await call(sam, "POST", "/tasks", { title: "bad", brand_id: A, recurrence: "daily", recurrence_days: [1], due_date: "2026-11-16" })).status).toBe(400);
    expect((await call(sam, "POST", "/tasks", { title: "bad", brand_id: A, recurrence: "weekly", recurrence_days: [8], due_date: "2026-11-16" })).status).toBe(400);
    const occ = (await call(sam, "GET", `/tasks/${series.id}/occurrences?from=2026-11-16&to=2026-11-29`)).body.items.map((o: any) => o.date);
    expect(occ).toEqual(["2026-11-16", "2026-11-19", "2026-11-23", "2026-11-26"]);
  });
  it("each occurrence has its own completion: completing one week leaves the next pending", async () => {
    expect((await call(sam, "POST", `/tasks/${series.id}/completion`, { done: true, occurrence_date: "2026-11-16" })).status).toBe(200);
    expect((await call(sam, "POST", `/tasks/${series.id}/completion`, { done: true, occurrence_date: "2026-11-17" })).status).toBe(400);   // not an occurrence
    const thisWeek = await week(sam, `?q=Mon%20and%20Thu&person=${sam.id}`);
    expect(thisWeek.completed.map((u: any) => u.date)).toEqual(["2026-11-16"]);
    expect(thisWeek.days.find((d: any) => d.date === "2026-11-19").items.map((u: any) => u.status)).toEqual(["open"]);
    const next = await week(sam, `?q=Mon%20and%20Thu&start=2026-11-23`);
    expect(next.days.flatMap((d: any) => d.items).map((u: any) => [u.date, u.status])).toEqual([["2026-11-23", "open"], ["2026-11-26", "open"]]);
    expect(next.summary).toMatchObject({ total: 2, done: 0, pending: 2 });
  });
  it("changing a running routine to new weekdays takes effect from a chosen date and keeps history", async () => {
    vn("2026-11-20");                                                 // Friday
    const cur = (await call(admin, "GET", `/tasks/${series.id}`)).body.task;
    // Earlier than today is refused.
    expect((await call(admin, "PATCH", `/tasks/${series.id}`, { version: cur.version, recurrence: "weekly", recurrence_days: [2], due_date: "2026-11-19" })).status).toBe(400);
    const r = await call(admin, "PATCH", `/tasks/${series.id}`, { version: cur.version, recurrence: "weekly", recurrence_days: [2], due_date: "2026-11-23" });
    expect(r.status).toBe(200);
    expect(r.body.split_from).toBe(series.id);
    expect(r.body.task).toMatchObject({ recurrence_days: [2], due_date: "2026-11-23", schedule: "Weekly on Tue", assignee: { id: sam.id } });
    const [old] = await q("select recurrence_until::text u, recurrence_days from tasks where id = $1", [series.id]);
    expect(old).toEqual({ u: "2026-11-22", recurrence_days: [1, 4] });
    expect((await q("select occurrence_date::text d from task_occurrences where task_id = $1", [series.id])).map((x) => x.d)).toEqual(["2026-11-16"]);
    const [nt] = await q("select previous_series_id from tasks where id = $1", [r.body.task.id]);
    expect(nt.previous_series_id).toBe(series.id);
    const both = await week(admin, `?q=Mon%20and%20Thu&start=2026-11-16`);
    expect(both.completed.map((u: any) => u.date)).toEqual(["2026-11-16"]);
    expect(both.overdue.map((u: any) => u.date)).toEqual(["2026-11-19"]);   // the old schedule's Thursday stays
    const next = await week(admin, `?q=Mon%20and%20Thu&start=2026-11-23`);
    expect(next.days.flatMap((d: any) => d.items).map((u: any) => u.date)).toEqual(["2026-11-24"]);
  });
});

describe("weekly timeline", () => {
  let C: string, pat: Who;
  beforeAll(async () => {
    vn("2026-11-18");
    C = await brand("Gamma Goods");
    pat = await login(await person("pat@example.test", "Pat Staff", "staff", "active", [C]));
    await mk(pat, { title: "G overdue", brand_id: C, due_date: "2026-11-10" });
    await mk(pat, { title: "G monday", brand_id: C, due_date: "2026-11-16" });
    await mk(pat, { title: "G sunday", brand_id: C, due_date: "2026-11-22", type: "video" });
    await mk(pat, { title: "G next monday", brand_id: C, due_date: "2026-11-23" });
    await mk(pat, { title: "G far", brand_id: C, due_date: "2027-01-05" });
    await mk(pat, { title: "G undated", brand_id: C });
    const d = await mk(pat, { title: "G done tuesday", brand_id: C, due_date: "2026-11-17" });
    vn("2026-11-17");
    await call(pat, "POST", `/tasks/${d.id}/completion`, { done: true, version: d.version });
    await mk(admin, { title: "G daily", brand_id: C, assignee_id: pat.id, type: "routine", recurrence: "daily", due_date: "2026-11-01" });
  });
  it("covers Monday to Sunday in Vietnam time, from any date in the week", async () => {
    for (const start of ["2026-11-16", "2026-11-19", "2026-11-22"]) {
      const w = await week(pat, `?brand=${C}&start=${start}`);
      expect(w.week).toMatchObject({ start: "2026-11-16", end: "2026-11-22", is_current: true });
      expect(w.days.map((d: any) => d.date)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
    }
    vn("2026-11-22", "23:30");                                        // Sunday night in Vietnam (16:30 UTC)
    expect((await week(pat)).week.start).toBe("2026-11-16");
    vn("2026-11-23", "00:10");                                        // Monday just after midnight (Sunday 17:10 UTC)
    expect((await week(pat)).week.start).toBe("2026-11-23");
  });
  it("sections: overdue, days, no due date, upcoming by week and completed; counts follow the week", async () => {
    const w = await week(pat, `?brand=${C}&q=G%20`);
    expect(titlesIn(w.overdue).filter((t: string) => t !== "G daily")).toEqual(["G overdue", "G monday"]);
    expect(w.overdue.filter((u: any) => u.task.title === "G daily").map((u: any) => u.date)).toEqual(
      ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
    const day = (d: string) => titlesIn(w.days.find((x: any) => x.date === d).items);
    expect(day("2026-11-18")).toEqual(["G daily"]);
    expect(day("2026-11-22").sort()).toEqual(["G daily", "G sunday"]);
    expect(titlesIn(w.undated)).toEqual(["G undated"]);
    expect(w.upcoming.map((g: any) => [g.week_start, titlesIn(g.items)])).toEqual([["2026-11-23", ["G next monday"]], ["2027-01-04", ["G far"]]]);
    expect(titlesIn(w.completed)).toEqual(["G done tuesday"]);
    // Week units: 7 daily occurrences + Monday, Sunday and the done Tuesday task. Occurrences count individually.
    expect(w.summary).toMatchObject({ total: 10, done: 1, pending: 9, undated: 1 });
    expect(w.summary.overdue).toBe(w.overdue.length);
    const last = await week(pat, `?brand=${C}&q=G%20&start=2026-11-09`);
    expect(last.summary).toMatchObject({ total: 8, done: 0 });        // 7 daily + "G overdue" (due 10 Nov)
    expect(last.week.is_current).toBe(false);
  });
  it("brand, staff, type and search filters work together", async () => {
    expect(titlesIn((await week(admin, `?brand=${C}&type=video`)).days.flatMap((d: any) => d.items))).toEqual(["G sunday"]);
    expect((await week(admin, `?brand=${C}&person=${sam.id}`)).summary.total).toBe(0);
    expect(titlesIn((await week(admin, `?brand=${C}&person=${pat.id}&q=undated`)).undated)).toEqual(["G undated"]);
    expect((await week(sam, `?brand=${C}`)).summary.total).toBe(0);  // staff without the brand read nothing
  });
  it("team workload lists every active staff member (none with zero work hidden), never administrators or Management", async () => {
    const w = await week(admin, `?brand=${C}`);
    const names = w.workload.map((p: any) => p.name);
    expect(names).toEqual(["Kim Staff", "Pat Staff", "Sam Staff", "Zoe Idle"]);
    expect(w.workload.find((p: any) => p.name === "Pat Staff")).toMatchObject({ total: 10, done: 1, pending: 9 });
    expect(w.workload.find((p: any) => p.name === "Zoe Idle")).toMatchObject({ total: 0, overdue: 0 });
    expect((await week(mgmt, `?brand=${C}`)).workload.map((p: any) => p.name)).toEqual(names);
    expect((await week(pat)).workload).toBeNull();
  });
});

describe("completion ownership and reporting", () => {
  it("an administrator's tick is recorded as theirs and credited to the occurrence's owner, in summaries and reporting", async () => {
    vn("2026-11-18");
    const t = await mk(admin, { title: "Reported weekly", brand_id: A, assignee_id: kim.id, type: "routine", recurrence: "weekly", recurrence_days: [1, 3], due_date: "2026-11-16" });
    expect((await call(admin, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-16" })).status).toBe(200);
    expect((await q("select completed_by from task_occurrences where task_id = $1", [t.id]))[0].completed_by).toBe(admin.id);
    const occ = (await call(admin, "GET", `/tasks/${t.id}/occurrences?from=2026-11-16&to=2026-11-18`)).body.items;
    expect(occ.map((o: any) => [o.date, o.done, o.owner.id, o.completed_by])).toEqual([["2026-11-16", true, kim.id, "Ada Admin"], ["2026-11-18", false, kim.id, null]]);
    const items = (await report()).filter((i: any) => i.task_id === t.id && i.occurrence_date <= "2026-11-25");
    expect(items.map((i: any) => [i.occurrence_date, i.status, i.assignee.name])).toEqual([
      ["2026-11-16", "done", "Kim Staff"], ["2026-11-18", "open", "Kim Staff"], ["2026-11-23", "open", "Kim Staff"], ["2026-11-25", "open", "Kim Staff"]]);
    const s = (await call(admin, "GET", `/summaries?period=custom&from=2026-11-16&to=2026-11-16&brand=${A}`)).body;
    expect(s.by_person.find((p: any) => p.name === "Kim Staff").done).toBeGreaterThanOrEqual(1);
    expect(s.by_person.some((p: any) => p.name === "Ada Admin")).toBe(false);
  });
});

describe("archiving closes unfinished work", () => {
  it("open work of an archived person leaves lists, counts, workload and reporting; finished work keeps its credit", async () => {
    vn("2026-11-18");
    const lee = await login(await person("lee@example.test", "Lee Leaving", "staff", "active", [A]));
    const open = await mk(admin, { title: "Lee open", brand_id: A, assignee_id: lee.id, due_date: "2026-11-19" });
    const done = await mk(lee, { title: "Lee finished", brand_id: A, due_date: "2026-11-17" });
    await call(lee, "POST", `/tasks/${done.id}/completion`, { done: true, version: done.version });
    const rt = await mk(admin, { title: "Lee routine", brand_id: A, assignee_id: lee.id, type: "routine", recurrence: "weekly", recurrence_days: [1, 3, 5], due_date: "2026-11-09" });
    await call(lee, "POST", `/tasks/${rt.id}/completion`, { done: true, occurrence_date: "2026-11-16" });
    const before = await week(admin, `?q=Lee`);
    expect(before.summary).toMatchObject({ total: 5, done: 2 });
    const p = (await call(admin, "GET", `/people/${lee.id}`)).body.person;
    const r = await call(admin, "POST", `/people/${lee.id}/archive`, { version: p.version });
    expect(r.body).toMatchObject({ archived: true, closed_tasks: 2 });
    const after = await week(admin, `?q=Lee`);
    expect(after.summary).toMatchObject({ total: 2, done: 2, pending: 0, overdue: 0 });
    expect(titlesIn(after.completed).sort()).toEqual(["Lee finished", "Lee routine"]);
    expect([...after.overdue, ...after.days.flatMap((d: any) => d.items), ...after.undated]).toEqual([]);
    expect(after.workload.some((x: any) => x.name === "Lee Leaving")).toBe(false);
    const card = (await call(admin, "GET", `/tasks/${open.id}`)).body.task;
    expect(card).toMatchObject({ status: "closed", closed: true, overdue: false, can_complete: false });
    const s = (await call(admin, "GET", `/summaries?period=custom&from=2026-11-16&to=2026-11-22&include_archived=1`)).body;
    const lp = s.by_person.find((x: any) => x.name === "Lee Leaving");
    expect(lp).toMatchObject({ done: 2, pending: 0 });
    const reported = (await report()).filter((i: any) => [open.id, done.id, rt.id].includes(i.task_id));
    expect(reported.map((i: any) => [i.title, i.occurrence_date, i.status])).toEqual(
      expect.arrayContaining([["Lee finished", null, "done"], ["Lee routine", "2026-11-16", "done"]]));
    expect(reported.every((i: any) => i.status === "done")).toBe(true);
    // Reassigning a closed task to an active staff member reopens it from today for them.
    const cur = (await call(admin, "GET", `/tasks/${open.id}`)).body.task;
    expect((await call(admin, "POST", `/tasks/${open.id}/reassign`, { assignee_id: kim.id, version: cur.version })).status).toBe(200);
    expect((await call(admin, "GET", `/tasks/${open.id}`)).body.task).toMatchObject({ status: "open", closed: false });
  });
});

describe("restarting and continuing series never creates work in the gap", () => {
  it("restarting an ended series keeps its original end date and creates no occurrences between", async () => {
    vn("2026-11-20");
    const t = await mk(sam, { title: "Ended weekly", brand_id: A, type: "routine", recurrence: "weekly", due_date: "2026-08-03", recurrence_until: "2026-09-28" });
    await call(sam, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-09-28" });
    const cur = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    // As the API was used in review: new weekday and start, end date left out.
    const r = await call(sam, "PATCH", `/tasks/${t.id}`, { version: cur.version, recurrence: "weekly", recurrence_days: [1], due_date: "2026-11-23" });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ due_date: "2026-11-23", recurrence_until: null });
    const [old] = await q("select recurrence_until::text u, version from tasks where id = $1", [t.id]);
    expect(old.u).toBe("2026-09-28");                                  // not extended to 22 Nov
    expect(old.version).toBe(cur.version);                             // the ended series itself is untouched
    const gap = (await call(sam, "GET", `/tasks/${t.id}/occurrences?from=2026-09-29&to=2026-11-22`)).body.items;
    expect(gap).toEqual([]);
    const w = await week(sam, `?q=Ended%20weekly&start=2026-11-16`);
    expect(w.overdue).toEqual([]);
    expect(w.summary.total).toBe(0);
    expect((await week(sam, `?q=Ended%20weekly&start=2026-11-23`)).days.flatMap((d: any) => d.items).map((u: any) => u.date)).toEqual(["2026-11-23"]);
    const hist = (await call(sam, "GET", `/tasks/${t.id}`)).body.history.map((h: any) => h.action);
    expect(hist).toContain("series_continued");
    expect(hist).not.toContain("series_ended");
  });
  it("an end date sent with a restart must not be before the new start", async () => {
    const t = await mk(sam, { title: "Ended daily", brand_id: A, recurrence: "daily", due_date: "2026-08-03", recurrence_until: "2026-08-31" });
    const cur = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(sam, "PATCH", `/tasks/${t.id}`, { version: cur.version, recurrence: "weekly", due_date: "2026-11-23", recurrence_until: "2026-08-31" })).status).toBe(400);
    expect((await q("select recurrence_until::text u from tasks where id = $1", [t.id]))[0].u).toBe("2026-08-31");
  });
  it("a series that already has a continuation cannot be continued again; editing its text still works", async () => {
    vn("2026-11-20");
    const t = await mk(sam, { title: "Twice continued", brand_id: A, type: "routine", recurrence: "weekly", due_date: "2026-11-02" });
    const v1 = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    const first = await call(sam, "PATCH", `/tasks/${t.id}`, { version: v1.version, recurrence: "weekly", recurrence_days: [2], due_date: "2026-11-24" });
    expect(first.status).toBe(200);
    const [old] = await q("select recurrence_until::text u from tasks where id = $1", [t.id]);
    expect(old.u).toBe("2026-11-23");
    const v2 = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    const again = await call(sam, "PATCH", `/tasks/${t.id}`, { version: v2.version, recurrence: "weekly", recurrence_days: [4], due_date: "2026-12-01" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_continued");
    expect((await q("select recurrence_until::text u from tasks where id = $1", [t.id]))[0].u).toBe("2026-11-23");
    expect((await q("select count(*)::int n from tasks where previous_series_id = $1", [t.id]))[0].n).toBe(1);
    expect((await call(sam, "PATCH", `/tasks/${t.id}`, { version: v2.version, title: "Twice continued (renamed)" })).status).toBe(200);
    // The continuation itself can still change, from its own date.
    const c1 = (await call(sam, "GET", `/tasks/${first.body.task.id}`)).body.task;
    expect((await call(sam, "PATCH", `/tasks/${c1.id}`, { version: c1.version, recurrence_days: [2, 4] })).status).toBe(200);
  });
});

describe("closed history after a long sync gap (tracker side)", () => {
  it("the scope list names the closed periods of archived owners across the whole series", async () => {
    vn("2026-11-20");
    const ola = await login(await person("ola@example.test", "Ola Old", "staff", "active", [A]));
    const pip = await person("pip@example.test", "Pip Next", "staff", "active", [A]);
    const t = await mk(admin, { title: "Long history", brand_id: A, assignee_id: ola.id, type: "routine", recurrence: "weekly", recurrence_days: [1], due_date: "2026-05-04" });
    await call(ola, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-05-04" });   // finished, outside the window
    // Pip takes over on 1 June (simulated earlier reassignment), Ola is archived later.
    await q("insert into task_assignments (task_id, assignee_id, effective_from, assigned_by) values ($1, $2, '2026-06-01', $3)", [t.id, pip, admin.id]);
    await q("update tasks set assignee_id = $1 where id = $2", [pip, t.id]);
    const p = (await call(admin, "GET", `/people/${ola.id}`)).body.person;
    await call(admin, "POST", `/people/${ola.id}/archive`, { version: p.version });
    const r = await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500`, { headers: { "x-tracker-reporting-key": secret } }));
    const body = await r.json();
    let last = body;
    while (last.next_cursor) last = await (await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500&snapshot=${body.snapshot.id}&cursor=${last.next_cursor}`, { headers: { "x-tracker-reporting-key": secret } }))).json();
    const entry = last.in_scope_tasks.find((x: any) => x.task_id === t.id);
    expect(entry).toEqual({ task_id: t.id, recurring: true, first_due: "2026-05-04", until: null, closed_periods: [{ from: "2026-05-04", to: "2026-05-31" }] });
    // A series still held by an archived person is closed from its start, open-ended.
    const held = await mk(admin, { title: "Still held", brand_id: A, assignee_id: kim.id, type: "routine", recurrence: "weekly", due_date: "2026-11-02" });
    const kp = (await call(admin, "GET", `/people/${kim.id}`)).body.person;
    await call(admin, "POST", `/people/${kim.id}/archive`, { version: kp.version });
    const r2 = await (await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500`, { headers: { "x-tracker-reporting-key": secret } }))).json();
    let l2 = r2;
    while (l2.next_cursor) l2 = await (await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500&snapshot=${r2.snapshot.id}&cursor=${l2.next_cursor}`, { headers: { "x-tracker-reporting-key": secret } }))).json();
    expect(l2.in_scope_tasks.find((x: any) => x.task_id === held.id).closed_periods).toEqual([{ from: "2026-11-02", to: null }]);
    expect(l2.in_scope_tasks.filter((x: any) => !x.recurring).every((x: any) => !("closed_periods" in x))).toBe(true);
  });
});

describe("a series and its continuation never overlap", () => {
  it("the original's end date cannot be moved onto or past the continuation, nor cleared", async () => {
    vn("2026-11-20");
    const t = await mk(sam, { title: "Overlap guard", brand_id: A, type: "routine", recurrence: "weekly", recurrence_days: [1], due_date: "2026-10-05" });
    const v1 = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    const split = await call(sam, "PATCH", `/tasks/${t.id}`, { version: v1.version, recurrence: "weekly", recurrence_days: [1], due_date: "2026-11-23", recurrence_until: null });
    // Same weekday, so only the start changed: still a split of a started series.
    expect(split.status).toBe(200);
    const cont = split.body.task;
    const v2 = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    expect(v2.recurrence_until).toBe("2026-11-22");
    for (const until of ["2026-12-31", "2026-11-23", null]) {
      const r = await call(sam, "PATCH", `/tasks/${t.id}`, { version: v2.version, recurrence_until: until });
      expect(r.status, String(until)).toBe(409);
      expect(r.body.error.code).toBe("overlaps_continuation");
    }
    expect((await q("select recurrence_until::text u from tasks where id = $1", [t.id]))[0].u).toBe("2026-11-22");
    // Ending it earlier is fine.
    expect((await call(sam, "PATCH", `/tasks/${t.id}`, { version: v2.version, recurrence_until: "2026-11-15" })).status).toBe(200);
    // The continuation cannot move its start back over the original either.
    const c1 = (await call(sam, "GET", `/tasks/${cont.id}`)).body.task;
    const back = await call(sam, "PATCH", `/tasks/${cont.id}`, { version: c1.version, due_date: "2026-11-09" });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe("overlaps_continuation");
    // No date is produced twice.
    const a = (await call(sam, "GET", `/tasks/${t.id}/occurrences?from=2026-10-01&to=2027-01-31`)).body.items.map((o: any) => o.date);
    const b = (await call(sam, "GET", `/tasks/${cont.id}/occurrences?from=2026-10-01&to=2027-01-31`)).body.items.map((o: any) => o.date);
    expect(a.filter((d: string) => b.includes(d))).toEqual([]);
    expect(b[0]).toBe("2026-11-23");
    // Once the continuation is deleted, the original may be extended again.
    const c2 = (await call(sam, "GET", `/tasks/${cont.id}`)).body.task;
    expect((await call(sam, "DELETE", `/tasks/${cont.id}?version=${c2.version}`)).status).toBe(200);
    const v3 = (await call(sam, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(sam, "PATCH", `/tasks/${t.id}`, { version: v3.version, recurrence_until: "2026-12-31" })).status).toBe(200);
  });
});

describe("restoring a person reopens their work in reporting", () => {
  it("closed periods disappear from the scope list once the owner is restored", async () => {
    vn("2026-11-20");
    const kp = (await call(admin, "GET", `/people/${kim.id}`)).body.person;
    expect(kp.status).toBe("archived");                                // archived in an earlier test
    expect((await call(admin, "POST", `/people/${kim.id}/restore`, { version: kp.version, role: "staff", brand_ids: [A], confirm: true })).status).toBe(200);
    const first = await (await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500`, { headers: { "x-tracker-reporting-key": secret } }))).json();
    let last = first;
    while (last.next_cursor) last = await (await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500&snapshot=${first.snapshot.id}&cursor=${last.next_cursor}`, { headers: { "x-tracker-reporting-key": secret } }))).json();
    const [{ id }] = await q("select id from tasks where title = 'Still held'");
    expect(last.in_scope_tasks.find((x: any) => x.task_id === id)).not.toHaveProperty("closed_periods");
  });
});
