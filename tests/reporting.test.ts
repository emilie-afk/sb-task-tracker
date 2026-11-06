// Reporting API for the marketing dashboard: credential, scope, snapshots, pagination and removal markers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, q, call, person, brand, login, task, app, ORIGIN, closePool, type Who } from "./helpers";
import { _setClockForTests } from "../shared/dates";

let admin: Who, staff: Who, mgmt: Who;
let SB: string, P2S: string, NEWB: string, secret = "";
const report = (query = "", key: string | null = secret, init: RequestInit = {}) =>
  app(new Request(`${ORIGIN}/api/reporting/v1/tasks${query}`, { ...init, headers: { ...(key === null ? {} : { "x-tracker-reporting-key": key }), ...(init.headers ?? {}) } }));
const readAll = async (limit = 2) => {
  const first = await (await report(`?limit=${limit}`)).json();
  const items = [...first.items];
  let next = first.next_cursor, last = first;
  while (next) { last = await (await report(`?limit=${limit}&snapshot=${first.snapshot.id}&cursor=${next}`)).json(); items.push(...last.items); next = last.next_cursor; }
  return { first, items, removals: last.removals };
};

beforeAll(async () => {
  await freshDb();
  _setClockForTests(() => Date.parse("2026-11-10T03:00:00Z"));
  SB = await brand("Alpha Plants", { reporting_enabled: true, dashboard_business_id: "sb" });
  P2S = await brand("Beta Prints", { reporting_enabled: true, dashboard_business_id: "p2s" });
  NEWB = await brand("Gamma Goods");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  staff = await login(await person("sam@example.test", "Sam Staff", "staff", "active", [SB, P2S, NEWB]));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
});
afterAll(async () => { _setClockForTests(null); await closePool(); });

describe("reporting credential", () => {
  it("is disabled until an administrator creates a credential", async () => {
    const r = await report("", "x".repeat(40));
    expect(r.status).toBe(503);
  });
  it("only administrators create it; it is shown once and stored hashed", async () => {
    expect((await call(staff, "POST", "/integrations/reporting/credential", {})).status).toBe(403);
    expect((await call(mgmt, "POST", "/integrations/reporting/credential", {})).status).toBe(403);
    const r = await call(admin, "POST", "/integrations/reporting/credential", {});
    expect(r.status).toBe(200);
    secret = r.body.secret;
    expect(secret).toMatch(/^ttr_[A-Za-z0-9_-]{40,}$/);
    expect(r.body.allowed_business_ids).toEqual(["sb"]);
    const stored = await q("select encode(key_hash,'hex') h from reporting_credentials where revoked_at is null");
    expect(stored[0].h).not.toContain(secret);
    const status = await call(admin, "GET", "/integrations/reporting");
    expect(JSON.stringify(status.body)).not.toContain(secret);
  });
  it("rejects missing or wrong credentials, human sessions and every non-GET method", async () => {
    expect((await report("", null)).status).toBe(401);
    // Change the last character to one guaranteed to differ, so the key is always wrong.
    const tampered = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    expect(tampered).not.toBe(secret);
    expect(tampered.length).toBe(secret.length);
    expect((await report("", secret)).status).toBe(200);
    expect((await report("", tampered)).status).toBe(401);
    expect((await app(new Request(`${ORIGIN}/api/reporting/v1/tasks`, { headers: { cookie: admin.cookie } }))).status).toBe(401);
    expect((await report("", secret, { method: "POST" })).status).toBe(405);
    expect((await report("", secret, { method: "DELETE" })).status).toBe(405);
  });
  it("cannot reach human endpoints: the reporting key is not a session", async () => {
    for (const p of ["/people", "/tasks", "/integrations/reporting", "/brands"])
      expect((await app(new Request(`${ORIGIN}/api${p}`, { headers: { "x-tracker-reporting-key": secret } }))).status).toBe(401);
  });
});

describe("reported content", () => {
  it("includes only enabled, mapped brands within the credential's scope (Succulents Box by default)", async () => {
    await task(staff, { title: "SB one-time", brand_id: SB, note: "private note", due_date: "2026-11-12" });
    await task(staff, { title: "P2S task", brand_id: P2S });
    await task(staff, { title: "New brand task", brand_id: NEWB });
    await task(admin, { title: "Unassigned task", brand_id: null, assignee_id: admin.id });
    const { first, items } = await readAll(50);
    expect(first).toMatchObject({ schema_version: 2, source_instance: "tracker-test", scope: { business_ids: ["sb"] } });
    expect(items.map((i: any) => i.title)).toEqual(["SB one-time"]);
    const it0 = items[0];
    expect(it0).toMatchObject({ kind: "task", business_id: "sb", status: "open", due_date: "2026-11-12", brand: { name: "Alpha Plants", archived: false }, assignee: { name: "Sam Staff" } });
    expect(it0.record_id).toBe(`task:${it0.task_id}`);
    expect(it0.open_url).toBe(`${ORIGIN}/#/tasks/${it0.task_id}`);
    // No notes, emails or account lists.
    const text = JSON.stringify(first);
    expect(text).not.toMatch(/private note|@example\.test|"note"|"email"/);
  });
  it("reports recurring work as dated occurrences with stable ids, never as one completed series", async () => {
    const t = await task(staff, { title: "Weekly SB", brand_id: SB, recurrence: "weekly", due_date: "2026-11-03" });
    await call(staff, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-10" });
    const { items } = await readAll(50);
    const occ = items.filter((i: any) => i.task_id === t.id);
    expect(occ.every((o: any) => o.kind === "occurrence" && o.record_id === `occ:${t.id}:${o.occurrence_date}`)).toBe(true);
    expect(occ.find((o: any) => o.occurrence_date === "2026-11-10").status).toBe("done");
    expect(occ.filter((o: any) => o.status === "done")).toHaveLength(1);
    expect(new Set(occ.map((o: any) => o.record_id)).size).toBe(occ.length);
  });
  it("paginates within one snapshot and refuses mixed versions when data changes mid-read", async () => {
    const p1 = await (await report("?limit=2")).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBe("2");
    const p2 = await (await report(`?limit=2&snapshot=${p1.snapshot.id}&cursor=2`)).json();
    expect(p2.snapshot.id).toBe(p1.snapshot.id);
    expect(p2.items[0].record_id > p1.items[1].record_id).toBe(true);
    await task(staff, { title: "Changed during read", brand_id: SB });
    const p3 = await report(`?limit=2&snapshot=${p1.snapshot.id}&cursor=4`);
    expect(p3.status).toBe(409);
    expect((await p3.json()).error.code).toBe("snapshot_changed");
    expect((await report("?limit=0")).status).toBe(400);
    expect((await report("?limit=501")).status).toBe(400);
    expect((await report("?cursor=2")).status).toBe(400);
  });
  it("reading never changes the snapshot (credential use and sign-ins do not invalidate pages)", async () => {
    const first = await (await report("?limit=1")).json();
    for (let i = 0; i < 15; i++) await report("?limit=1");                                    // records last use
    await q("update users set last_sign_in_at = now(), status = status");                   // sign-in style update
    const again = await report(`?limit=1&snapshot=${first.snapshot.id}&cursor=1`);
    expect(again.status).toBe(200);
  });
  it("sends explicit removal markers for deleted, unassigned and out-of-scope tasks that were reported before", async () => {
    const del = await task(staff, { title: "To delete", brand_id: SB });
    const clear = await task(admin, { title: "To clear", brand_id: SB, assignee_id: admin.id });
    const move = await task(admin, { title: "To move", brand_id: SB, assignee_id: admin.id });
    await readAll(50);                                          // reported once
    await call(staff, "DELETE", `/tasks/${del.id}?version=${del.version}`);
    await call(admin, "PATCH", `/tasks/${clear.id}`, { version: clear.version, brand_id: null });
    await call(admin, "PATCH", `/tasks/${move.id}`, { version: move.version, brand_id: NEWB });
    const { items, removals } = await readAll(50);
    const reasons = Object.fromEntries(removals.map((r: any) => [r.task_id, r.reason]));
    expect(reasons[del.id]).toBe("deleted");
    expect(reasons[clear.id]).toBe("brand_unassigned");
    expect(reasons[move.id]).toBe("brand_not_reported");
    expect(items.map((i: any) => i.task_id)).not.toEqual(expect.arrayContaining([del.id, clear.id, move.id]));
    // Never-reported tasks of unrelated brands are not named in removals.
    const p2sTask = (await q("select id from tasks where title = 'P2S task'"))[0].id;
    expect(Object.keys(reasons)).not.toContain(p2sTask);
  });
  it("archived mapped brands stay reported with an archived label; disabling reporting removes them", async () => {
    const t = await task(staff, { title: "Archive me", brand_id: SB });
    const b = (await call(admin, "GET", "/brands")).body.items.find((x: any) => x.id === SB);
    await call(admin, "POST", `/brands/${SB}/archive`, { version: b.version });
    let { items } = await readAll(50);
    expect(items.find((i: any) => i.task_id === t.id).brand.archived).toBe(true);
    const b2 = (await call(admin, "GET", "/brands")).body.items.find((x: any) => x.id === SB);
    await call(admin, "PATCH", `/brands/${SB}`, { version: b2.version, reporting_enabled: false });
    const all = await readAll(50);
    expect(all.items).toHaveLength(0);
    expect(all.removals.map((r: any) => r.task_id)).toContain(t.id);
  });
  it("revoking the credential disables reporting at once", async () => {
    await call(admin, "DELETE", "/integrations/reporting/credential");
    expect((await report()).status).toBe(503);
  });
});
