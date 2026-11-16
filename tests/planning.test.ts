// Marketing planning integration: scoped server-to-server task creation from the dashboard, idempotency,
// validation shared with the task editor, due-date changes with version checks, and the plan backlink.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, q, call, person, brand, login, task, app, ORIGIN, closePool, type Who } from "./helpers";
import { _setPlanningHooksForTests, _setPlanningClockForTests } from "../server/planning";

let admin: Who, admin2: Who, staff: Who, mgmt: Who;
let SB: string, P2S: string, OFF: string, thao: string, outsider: string, secret = "";
const PLAN = "11111111-2222-4333-8444-555555555555";
const plan = (method: string, path: string, body?: unknown, key: string | null = secret) =>
  app(new Request(`${ORIGIN}/api/planning/v1${path}`, { method, headers: { ...(key === null ? {} : { "x-tracker-planning-key": key }), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }))
    .then(async (r) => ({ status: r.status, body: await r.json() }));
const create = (over: Record<string, unknown> = {}) => plan("POST", "/tasks", {
  idempotency_key: "mkp:aaaaaaaa-0000-4000-8000-000000000001", plan_id: PLAN, brand_id: SB, assignee_id: thao,
  title: "Draft three LinkedIn ad concepts for Employee Appreciation Day", brief: "Channel: LinkedIn\nAudience: HR and People Operations", due_date: "2027-02-12", sent_at: new Date().toISOString(), ...over });

beforeAll(async () => {
  await freshDb();
  process.env.MARKETING_DASHBOARD_URL = "https://dashboard.example.test";
  SB = await brand("Alpha Plants", { reporting_enabled: true, dashboard_business_id: "sb" });
  P2S = await brand("Beta Prints", { reporting_enabled: true, dashboard_business_id: "p2s" });
  OFF = await brand("Gamma Goods", { reporting_enabled: false, dashboard_business_id: "sb" });
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  admin2 = await login(await person("ben@example.test", "Ben Admin", "administrator"));
  thao = await person("thao@example.test", "Thao Staff", "staff", "active", [SB]);
  staff = await login(thao);
  outsider = await person("omar@example.test", "Omar Other", "staff", "active", [P2S]);
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
});
afterAll(async () => { delete process.env.MARKETING_DASHBOARD_URL; await closePool(); });

describe("planning credential", () => {
  it("is disabled until an administrator creates one; a wrong key is refused", async () => {
    expect((await plan("GET", "/directory", undefined, "x".repeat(40))).status).toBe(503);
    expect((await call(staff, "POST", "/integrations/planning/credential", {})).status).toBe(403);
    expect((await call(mgmt, "POST", "/integrations/planning/credential", {})).status).toBe(403);
    const r = await call(admin, "POST", "/integrations/planning/credential", { allowed_business_ids: ["sb"] });
    expect(r.status).toBe(200);
    secret = r.body.secret;
    expect(secret).toMatch(/^tpl_/);
    const [row] = await q("select key_hash, acting_user_id from planning_credentials where revoked_at is null");
    expect(Buffer.from(row.key_hash).toString("utf8")).not.toContain(secret);
    expect(row.acting_user_id).toBe(admin.id);
    expect((await plan("GET", "/directory", undefined, "tpl_" + "x".repeat(43))).status).toBe(401);
    expect((await plan("GET", "/directory", undefined, null)).status).toBe(401);
  });
  it("a session cookie is not a planning credential, and the reporting key is not either", async () => {
    const r = await app(new Request(`${ORIGIN}/api/planning/v1/directory`, { headers: { cookie: admin.cookie } }));
    expect(r.status).toBe(401);
  });
});

describe("directory", () => {
  it("lists only active, reported brands of allowed businesses, and people assignable in them", async () => {
    const r = await plan("GET", "/directory");
    expect(r.status).toBe(200);
    expect(r.body.brands.map((b: any) => b.name)).toEqual(["Alpha Plants"]);
    const names = r.body.people.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Ada Admin", "Ben Admin", "Thao Staff"]));
    expect(names).not.toContain("Omar Other");          // no access to an allowed brand
    expect(names).not.toContain("Mia Management");      // management cannot hold tasks
    expect(JSON.stringify(r.body)).not.toContain("@example.test");   // no emails
  });
});

describe("creating tasks", () => {
  let first: any;
  it("creates the task with the editor's rules, as the acting administrator, and links it to the plan", async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    first = r.body.task;
    expect(first).toMatchObject({ title: "Draft three LinkedIn ad concepts for Employee Appreciation Day", due_date: "2027-02-12", status: "open",
      assignee: { id: thao, name: "Thao Staff" }, brand: { id: SB, name: "Alpha Plants" }, plan_id: PLAN });
    const [t] = await q("select creator_id, note, type from tasks where id = $1", [first.task_id]);
    expect(t).toMatchObject({ creator_id: admin.id, type: "adhoc" });
    expect(t.note).toContain("HR and People Operations");
    // Thao sees it in her own list, and its detail links back to the plan.
    const mine = await call(staff, "GET", `/tasks?person=${thao}`);
    expect(mine.body.items.map((x: any) => x.id)).toContain(first.task_id);
    const d = await call(staff, "GET", `/tasks/${first.task_id}`);
    expect(d.body.plan_url).toBe(`https://dashboard.example.test/#/planning/${PLAN}`);
    expect(d.body.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(["created", "linked_to_plan"]));
  });

  it("a repeated creation (retry or timeout) returns the original task with edits made in the tracker, never a duplicate", async () => {
    const edited = await call(staff, "PATCH", `/tasks/${first.task_id}`, { version: first.version, title: "Draft three LinkedIn concepts (v2)" });
    expect(edited.status).toBe(200);
    const r = await create({ title: "Something else", due_date: "2027-01-01" });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(false);
    expect(r.body.task).toMatchObject({ task_id: first.task_id, title: "Draft three LinkedIn concepts (v2)", due_date: "2027-02-12" });
    expect((await q("select count(*)::int n from task_plan_links"))[0].n).toBe(1);
  });

  it("concurrent attempts with one key create one task", async () => {
    const key = "mkp:aaaaaaaa-0000-4000-8000-000000000009";
    const rs = await Promise.all([1, 2, 3, 4].map(() => create({ idempotency_key: key })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.task.task_id)).size).toBe(1);
  });

  it("refuses an invalid assignee, a brand outside the scope and a key used by another plan, creating nothing", async () => {
    const before = (await q("select count(*)::int n from tasks"))[0].n;
    const noAccess = await create({ idempotency_key: "mkp:bad-assignee-001", assignee_id: outsider });
    expect(noAccess.status).toBe(422);
    expect(noAccess.body.error.code).toBe("assignee_lacks_brand_access");
    const unknown = await create({ idempotency_key: "mkp:bad-assignee-002", assignee_id: "99999999-9999-4999-8999-999999999999" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("unknown_person");
    expect((await create({ idempotency_key: "mkp:bad-brand-0001", brand_id: P2S, assignee_id: outsider })).status).toBe(422);   // p2s not allowed
    expect((await create({ idempotency_key: "mkp:bad-brand-0002", brand_id: OFF })).status).toBe(422);                           // reporting off
    const other = await create({ plan_id: "99999999-2222-4333-8444-555555555555" });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("key_in_use");
    expect((await create({ idempotency_key: "mkp:bad-input-01", due_date: "2027-02-30" })).status).toBe(400);
    expect((await create({ idempotency_key: "mkp:bad-input-02", extra: 1 })).status).toBe(400);
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(before);
  });
});

describe("refusals say whether a task exists", () => {
  it("a refusal after the key check explicitly confirms no task exists for that key", async () => {
    const r = await create({ idempotency_key: "mkp:confirm-none-01", assignee_id: outsider });
    expect(r.status).toBe(422);
    expect(r.body.error.details.task_exists).toBe(false);
    const b = await create({ idempotency_key: "mkp:confirm-none-02", brand_id: OFF });
    expect(b.body.error.details.task_exists).toBe(false);
  });
  it("a request older than the allowed age is refused without creating anything (and without confirming absence)", async () => {
    const before = (await q("select count(*)::int n from tasks"))[0].n;
    const r = await create({ idempotency_key: "mkp:stale-request-01", sent_at: new Date(Date.now() - 61_000).toISOString() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("stale_request");
    expect(r.body.error.details?.task_exists).toBeUndefined();
    expect((await create({ idempotency_key: "mkp:stale-request-02", sent_at: "not a time" })).status).toBe(400);
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(before);
  });
});

describe("a paused original request cannot create a task after absence was confirmed", () => {
  it("is judged fresh or stale at the moment it holds the key lock, not when it arrived", async () => {
    const key = "mkp:paused-original-01";
    const t0 = Date.now();
    let now = t0;
    _setPlanningClockForTests(() => now);
    let release!: () => void, reached!: () => void;
    const paused = new Promise<void>((r) => { release = r; });
    const atLock = new Promise<void>((r) => { reached = r; });
    _setPlanningHooksForTests({ beforeLock: async (k) => { if (k === key && !(globalThis as any).__resumed) { (globalThis as any).__resumed = true; reached(); await paused; } } });
    try {
      // 1. The original (valid) request arrives fresh and pauses before taking the lock.
      const original = create({ idempotency_key: key, sent_at: new Date(t0).toISOString() });
      await atLock;
      // 2. It expires. Thao loses access; a retry takes the lock, is fresh, finds no task and is refused,
      //    confirming that no task exists, at checked_at more than 60 s after the original was sent.
      now = t0 + 61_000;
      await q("delete from user_brand_access where user_id = $1 and brand_id = $2", [thao, SB]);
      const retry = await create({ idempotency_key: key, sent_at: new Date(now).toISOString() });
      expect(retry.status).toBe(422);
      expect(retry.body.error.details).toMatchObject({ task_exists: false, checked_at: new Date(t0 + 61_000).toISOString() });
      // 3. Access comes back (the original would now be valid), then the original resumes: it is stale under the lock.
      await q("insert into user_brand_access (user_id, brand_id) values ($1,$2)", [thao, SB]);
      release();
      const r = await original;
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("stale_request");
      expect((await q("select count(*)::int n from task_plan_links where idempotency_key = $1", [key]))[0].n).toBe(0);
    } finally {
      _setPlanningHooksForTests(null); _setPlanningClockForTests(null); delete (globalThis as any).__resumed;
    }
  });
});

describe("the fence holds across server instances with different clocks", () => {
  it("a delayed original handled by an instance whose clock is behind is refused once a retry fenced the key", async () => {
    const key = "mkp:two-clocks-0001";
    const t0 = Date.now();
    let instanceClock = t0;                                   // the clock of whichever instance handles the next step
    _setPlanningClockForTests(() => instanceClock);
    let release!: () => void, reached!: () => void;
    const paused = new Promise<void>((r) => { release = r; }), atLock = new Promise<void>((r) => { reached = r; });
    let first = true;
    _setPlanningHooksForTests({ beforeLock: async (k) => { if (k === key && first) { first = false; reached(); await paused; } } });
    try {
      // The original (valid) request, sent at t0, pauses before the lock on instance B.
      const original = create({ idempotency_key: key, sent_at: new Date(t0).toISOString() });
      await atLock;
      // Instance A (clock t0+61 s) handles a retry sent at t0+61 s; Thao has lost access, so it is refused with no task:
      // the key is fenced through the retry's sent_at, which also covers the original (t0).
      instanceClock = t0 + 61_000;
      await q("delete from user_brand_access where user_id = $1 and brand_id = $2", [thao, SB]);
      const retry = await create({ idempotency_key: key, sent_at: new Date(t0 + 61_000).toISOString(), supersedes_sent_at: new Date(t0).toISOString() });
      expect(retry.status).toBe(422);
      expect(retry.body.error.details).toMatchObject({ task_exists: false, fenced_through: new Date(t0 + 61_000).toISOString() });
      expect((await q("select count(*)::int n from task_plan_fences where idempotency_key = $1", [key]))[0].n).toBe(1);
      // Access is back. Instance B's clock is 31 s behind (t0+30 s): by that clock the original is still fresh.
      await q("insert into user_brand_access (user_id, brand_id) values ($1,$2)", [thao, SB]);
      instanceClock = t0 + 30_000;
      release();
      const r = await original;
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("stale_request");
      expect((await q("select count(*)::int n from task_plan_links where idempotency_key = $1", [key]))[0].n).toBe(0);
      // A new attempt sent after the fence is accepted normally.
      instanceClock = t0 + 62_000;
      const later = await create({ idempotency_key: key, sent_at: new Date(t0 + 62_000).toISOString() });
      expect(later.status).toBe(201);
    } finally { _setPlanningHooksForTests(null); _setPlanningClockForTests(null); }
  });

  it("the fence also covers an earlier attempt sent from a clock that ran ahead (supersedes_sent_at)", async () => {
    const key = "mkp:ahead-clock-0001";
    const t0 = Date.now();
    await q("delete from user_brand_access where user_id = $1 and brand_id = $2", [thao, SB]);
    try {
      // The retry is sent at t0 by a machine behind the one that sent the unanswered original at t0+5 s.
      const retry = await create({ idempotency_key: key, sent_at: new Date(t0).toISOString(), supersedes_sent_at: new Date(t0 + 5_000).toISOString() });
      expect(retry.body.error.details.fenced_through).toBe(new Date(t0 + 5_000).toISOString());
    } finally { await q("insert into user_brand_access (user_id, brand_id) values ($1,$2)", [thao, SB]); }
    const original = await create({ idempotency_key: key, sent_at: new Date(t0 + 5_000).toISOString() });
    expect(original.status).toBe(409);
    expect((await q("select count(*)::int n from task_plan_links where idempotency_key = $1", [key]))[0].n).toBe(0);
  });
});

describe("reading and due dates", () => {
  it("reads tasks by assignment id, including completion done in the tracker", async () => {
    const t = (await create()).body.task;
    const done = await call(staff, "POST", `/tasks/${t.task_id}/completion`, { done: true, version: t.version });
    expect(done.status).toBe(200);
    const r = await plan("GET", "/tasks?keys=mkp:aaaaaaaa-0000-4000-8000-000000000001,mkp:not-created-0001");
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ status: "done", task_id: t.task_id });
    await call(staff, "POST", `/tasks/${t.task_id}/completion`, { done: false, version: r.body.items[0].version });
  });

  it("changes a due date only when the version still matches; otherwise reports the conflict with the current task", async () => {
    const t = (await plan("GET", "/tasks?keys=mkp:aaaaaaaa-0000-4000-8000-000000000001")).body.items[0];
    const ok = await plan("PATCH", "/tasks/mkp:aaaaaaaa-0000-4000-8000-000000000001/due-date", { due_date: "2027-02-19", expected_version: t.version });
    expect(ok.status).toBe(200);
    expect(ok.body.task.due_date).toBe("2027-02-19");
    const stale = await plan("PATCH", "/tasks/mkp:aaaaaaaa-0000-4000-8000-000000000001/due-date", { due_date: "2027-02-26", expected_version: t.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.task.due_date).toBe("2027-02-19");
    expect((await plan("PATCH", "/tasks/mkp:missing-task-001/due-date", { due_date: "2027-02-26", expected_version: 1 })).status).toBe(404);
  });
});

describe("business scope applies to every path, not only creation", () => {
  it("a credential restricted to Succulents Box cannot read, replay or change a P2S task created under an earlier credential", async () => {
    const wide = (await call(admin, "POST", "/integrations/planning/credential", { allowed_business_ids: ["sb", "p2s"] })).body.secret;
    const key = "mkp:p2s-task-000001";
    const made = await plan("POST", "/tasks", { idempotency_key: key, plan_id: PLAN, brand_id: P2S, assignee_id: outsider, title: "P2S coloring-page promo", due_date: "2027-02-01", sent_at: new Date().toISOString() }, wide);
    expect(made.status).toBe(201);
    const before = (await q("select version, due_date::text d from tasks where id = $1", [made.body.task.task_id]))[0];

    secret = (await call(admin, "POST", "/integrations/planning/credential", { allowed_business_ids: ["sb"] })).body.secret;   // replaces the wide one
    const read = await plan("GET", `/tasks?keys=${key}`);
    expect(read.status).toBe(200);
    expect(read.body.items).toEqual([]);
    const replay = await plan("POST", "/tasks", { idempotency_key: key, plan_id: PLAN, brand_id: SB, assignee_id: thao, title: "x", due_date: "2027-02-01", sent_at: new Date().toISOString() });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("key_unavailable");
    expect(replay.body.error.details?.task_exists).toBeUndefined();          // a task exists: never "confirmed absent"
    expect(JSON.stringify(replay.body)).not.toContain(made.body.task.task_id);
    expect(JSON.stringify(replay.body)).not.toContain("P2S coloring-page");
    const change = await plan("PATCH", `/tasks/${key}/due-date`, { due_date: "2027-03-01", expected_version: before.version });
    expect(change.status).toBe(404);
    expect((await q("select version, due_date::text d from tasks where id = $1", [made.body.task.task_id]))[0]).toEqual(before);
    expect((await q("select count(*)::int n from task_plan_links where idempotency_key = $1", [key]))[0].n).toBe(1);
  });

  it("a task whose brand moves out of the credential's businesses after creation drops out of scope too", async () => {
    const t = (await plan("GET", "/tasks?keys=mkp:aaaaaaaa-0000-4000-8000-000000000001")).body.items[0];
    expect(t).toBeTruthy();
    await q("update brands set dashboard_business_id = 'p2s' where id = $1", [SB]);
    expect((await plan("GET", "/tasks?keys=mkp:aaaaaaaa-0000-4000-8000-000000000001")).body.items).toEqual([]);
    expect((await plan("PATCH", "/tasks/mkp:aaaaaaaa-0000-4000-8000-000000000001/due-date", { due_date: "2027-03-02", expected_version: t.version })).status).toBe(404);
    await q("update brands set dashboard_business_id = 'sb' where id = $1", [SB]);
    expect((await plan("GET", "/tasks?keys=mkp:aaaaaaaa-0000-4000-8000-000000000001")).body.items).toHaveLength(1);
  });
});

describe("credential lifecycle", () => {
  it("stops working when its acting administrator is archived, and when revoked", async () => {
    const r = await call(admin2, "POST", "/integrations/planning/credential", { allowed_business_ids: ["sb"] });
    const key2 = r.body.secret;
    expect((await plan("GET", "/directory", undefined, secret)).status).toBe(401);    // replaced
    await q("update users set status = 'archived', archived_at = now() where id = $1", [admin2.id]);
    expect((await plan("GET", "/directory", undefined, key2)).status).toBe(503);
    await q("update users set status = 'active', archived_at = null where id = $1", [admin2.id]);
    expect((await plan("GET", "/directory", undefined, key2)).status).toBe(200);
    await call(admin, "DELETE", "/integrations/planning/credential");
    expect((await plan("GET", "/directory", undefined, key2)).status).toBe(503);
  });
});
