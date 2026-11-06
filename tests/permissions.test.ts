// Role matrix: Administrator, Staff, Management. Enforced on the server for lists, details, searches, summaries,
// counts, imports, bulk operations and every mutation. Fictional people and brands only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, q, call, person, brand, login, task, closePool, type Who } from "./helpers";
import { buildRouter } from "../server/app";

let A: string, B: string, C: string;            // brands
let admin: Who, staffA: Who, staffAB: Who, mgmt: Who;
let tA: any, tB: any, tOther: any, tUnassigned: any;

beforeAll(async () => {
  await freshDb();
  A = await brand("Alpha Plants"); B = await brand("Beta Prints"); C = await brand("Gamma Goods");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  staffA = await login(await person("sam@example.test", "Sam Staff", "staff", "active", [A]));
  staffAB = await login(await person("kim@example.test", "Kim Staff", "staff", "active", [A, B]));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
  tA = await task(staffA, { title: "Sam alpha task", brand_id: A });
  tB = await task(admin, { title: "Kim beta task", brand_id: B, assignee_id: staffAB.id, note: "beta note" });
  tOther = await task(admin, { title: "Kim alpha task", brand_id: A, assignee_id: staffAB.id });
  tUnassigned = await task(admin, { title: "No brand task", brand_id: null, assignee_id: admin.id });
  await task(admin, { title: "Gamma only", brand_id: C, assignee_id: admin.id });
});
afterAll(closePool);

const titles = (r: any) => r.body.items.map((t: any) => t.title).sort();

describe("reading", () => {
  it("administrators and Management read every brand and Unassigned-brand tasks", async () => {
    for (const who of [admin, mgmt]) {
      const r = await call(who, "GET", "/tasks");
      expect(titles(r)).toEqual(["Gamma only", "Kim alpha task", "Kim beta task", "No brand task", "Sam alpha task"]);
      expect(r.body.total).toBe(5);
      expect(titles(await call(who, "GET", "/tasks?brand=unassigned"))).toEqual(["No brand task"]);
    }
  });
  it("staff read task cards in their assigned brands only, including other people's", async () => {
    expect(titles(await call(staffA, "GET", "/tasks"))).toEqual(["Kim alpha task", "Sam alpha task"]);
    expect(titles(await call(staffAB, "GET", "/tasks"))).toEqual(["Kim alpha task", "Kim beta task", "Sam alpha task"]);
  });
  it("filters are applied before pagination and totals (no leaks through counts, search or paging)", async () => {
    const r = await call(staffA, "GET", "/tasks?limit=1&offset=0");
    expect(r.body.total).toBe(2);
    expect((await call(staffA, "GET", "/tasks?limit=1&offset=1")).body.items).toHaveLength(1);
    expect((await call(staffA, "GET", "/tasks?limit=1&offset=2")).body.items).toHaveLength(0);
    expect((await call(staffA, "GET", "/tasks?q=beta")).body).toMatchObject({ items: [], total: 0 });
    expect((await call(staffA, "GET", `/tasks?brand=${B}`)).body.total).toBe(0);
    expect((await call(staffA, "GET", "/tasks?brand=unassigned")).body.items).toEqual([]);
  });
  it("details of unreadable tasks answer 404", async () => {
    expect((await call(staffA, "GET", `/tasks/${tB.id}`)).status).toBe(404);
    expect((await call(staffA, "GET", `/tasks/${tUnassigned.id}`)).status).toBe(404);
    expect((await call(staffA, "GET", `/tasks/${tOther.id}`)).status).toBe(200);
    expect((await call(mgmt, "GET", `/tasks/${tB.id}`)).status).toBe(200);
  });
  it("brands: staff see only their brands; Management sees all but no reporting configuration", async () => {
    expect((await call(staffA, "GET", "/brands")).body.items.map((b: any) => b.display_name)).toEqual(["Alpha Plants"]);
    const m = await call(mgmt, "GET", "/brands");
    expect(m.body.items).toHaveLength(3);
    expect(m.body.items[0].dashboard_business_id).toBeUndefined();
    expect(m.body.items[0].staff_access).toBeUndefined();
  });
  it("summaries: staff see their own only; Management and administrators see the team", async () => {
    const s = await call(staffA, "GET", "/summaries?period=today");
    expect(s.body.by_person).toBeUndefined();
    expect(s.body.pending).toBe(1);
    expect((await call(staffA, "GET", `/summaries?person=${staffAB.id}`)).status).toBe(403);
    const m = await call(mgmt, "GET", "/summaries?period=today");
    expect(m.body.by_person.map((p: any) => p.name)).toEqual(["Ada Admin", "Kim Staff", "Sam Staff"]);
  });
  it("KPI scorecards: staff own only; Management and administrators all", async () => {
    await call(admin, "POST", "/kpis", { owner_id: staffAB.id, brand_id: A, metric: "Posts", target: "3" });
    expect((await call(staffA, "GET", `/kpis?owner=${staffAB.id}`)).status).toBe(403);
    expect((await call(staffA, "GET", "/kpis")).body.items).toEqual([]);
    expect((await call(mgmt, "GET", `/kpis?owner=${staffAB.id}`)).body.items).toHaveLength(1);
    expect((await call(staffAB, "GET", "/kpis")).body.items).toHaveLength(1);
  });
  it("the directory never contains emails; staff see only people sharing a brand", async () => {
    const d = await call(staffA, "GET", "/directory");
    expect(JSON.stringify(d.body)).not.toMatch(/@/);
    expect(d.body.items.map((p: any) => p.display_name).sort()).toEqual(["Kim Staff", "Sam Staff"]);
  });
});

describe("changing", () => {
  it("staff create tasks only for themselves, in their assigned active brands", async () => {
    expect((await call(staffA, "POST", "/tasks", { title: "Mine", brand_id: A })).status).toBe(200);
    expect((await call(staffA, "POST", "/tasks", { title: "Other brand", brand_id: B })).status).toBe(403);
    expect((await call(staffA, "POST", "/tasks", { title: "No brand", brand_id: null })).status).toBe(403);
    expect((await call(staffA, "POST", "/tasks", { title: "For Kim", brand_id: A, assignee_id: staffAB.id })).status).toBe(403);
    expect((await call(staffA, "POST", "/tasks/bulk", { titles: ["a", "b"], brand_id: A })).status).toBe(200);
    expect((await call(staffA, "POST", "/tasks/bulk", { titles: ["a"], brand_id: B })).status).toBe(403);
  });
  it("staff edit, complete and delete only their own tasks, and only allowed fields", async () => {
    const t = (await call(staffA, "GET", `/tasks/${tA.id}`)).body.task;
    const ok = await call(staffA, "PATCH", `/tasks/${tA.id}`, { version: t.version, title: "Sam alpha task (edited)", note: "n", type: "routine", due_date: "2030-01-02" });
    expect(ok.status).toBe(200);
    for (const field of [{ assignee_id: staffAB.id }, { brand_id: B }, { brand_id: null }, { kpi_id: null }])
      expect((await call(staffA, "PATCH", `/tasks/${tA.id}`, { version: ok.body.task.version, ...field })).status).toBe(403);
    expect((await call(staffA, "PATCH", `/tasks/${tA.id}`, { version: ok.body.task.version, creator_id: admin.id })).status).toBe(400);
    expect((await call(staffA, "PATCH", `/tasks/${tOther.id}`, { version: tOther.version, title: "hijack" })).status).toBe(403);
    expect((await call(staffA, "POST", `/tasks/${tOther.id}/completion`, { done: true, version: tOther.version })).status).toBe(403);
    expect((await call(staffA, "DELETE", `/tasks/${tOther.id}?version=${tOther.version}`)).status).toBe(403);
    expect((await call(staffA, "POST", `/tasks/${tA.id}/reassign`, { assignee_id: staffAB.id })).status).toBe(403);
    expect((await call(staffAB, "POST", `/tasks/${tOther.id}/completion`, { done: true, version: tOther.version })).status).toBe(200);
  });
  it("staff lose edit rights on their own task when their brand access is removed", async () => {
    const mine = await task(staffAB, { title: "Kim beta own", brand_id: B });
    const kim = (await call(admin, "GET", `/people/${staffAB.id}`)).body.person;
    expect((await call(admin, "PATCH", `/people/${staffAB.id}`, { version: kim.version, brand_ids: [A] })).status).toBe(200);
    expect((await call(staffAB, "POST", `/tasks/${mine.id}/completion`, { done: true, version: mine.version })).status).toBe(404);
    expect((await call(staffAB, "GET", `/tasks/${mine.id}`)).status).toBe(404);
    const again = (await call(admin, "GET", `/people/${staffAB.id}`)).body.person;
    await call(admin, "PATCH", `/people/${staffAB.id}`, { version: again.version, brand_ids: [A, B] });
  });
  it("Management receives 403 on every business mutation, including crafted API calls", async () => {
    const routes = buildRouter().routes.filter((r) => r.method !== "GET");
    expect(routes.length).toBeGreaterThan(20);
    for (const r of routes) {
      const path = r.re.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, tA.id);
      const res = await call(mgmt, r.method, `${path}?version=1`, {});
      expect([403], `${r.method} ${path}`).toContain(res.status);
    }
    // Sign-out remains allowed.
    expect((await call(mgmt, "POST", "/auth/logout")).status).toBe(200);
  });
  it("staff receive 403 on every administrator-only mutation", async () => {
    const routes = buildRouter().routes.filter((r) => r.method !== "GET" && !r.roles.includes("staff"));
    for (const r of routes) {
      const path = r.re.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, tA.id);
      expect((await call(staffA, r.method, `${path}?version=1`, {})).status, `${r.method} ${path}`).toBe(403);
    }
  });
  it("no route grants Management a mutation (the router refuses to register one)", () => {
    for (const r of buildRouter().routes) if (r.method !== "GET") expect(r.roles).not.toContain("management");
  });
  it("Management's reads stay unaffected by the 403s", async () => {
    mgmt = await login(mgmt.id);   // the previous test signed out
    expect((await call(mgmt, "GET", "/tasks")).status).toBe(200);
    expect((await call(mgmt, "GET", "/kpis")).status).toBe(200);
    expect((await call(mgmt, "GET", "/people")).status).toBe(403);   // people administration is admin-only
  });
});
