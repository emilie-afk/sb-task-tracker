// People lifecycle, brand lifecycle, task brand changes and Unassigned-brand visibility. Fictional data only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, q, call, person, brand, login, task, closePool, type Who } from "./helpers";

let admin: Who, mgmt: Who;
let A: string, B: string;
beforeAll(async () => {
  await freshDb();
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
  A = await brand("Alpha Plants"); B = await brand("Beta Prints");
});
afterAll(closePool);
const getPerson = async (id: string) => (await call(admin, "GET", `/people/${id}`)).body.person;
const getBrand = async (id: string) => (await call(admin, "GET", "/brands")).body.items.find((b: any) => b.id === id);

describe("people", () => {
  it("adding an approved email creates a pending membership without code changes", async () => {
    const r = await call(admin, "POST", "/people", { email: "New.Person@Example.test", display_name: "New Person", role: "staff", brand_ids: [A] });
    expect(r.status).toBe(200);
    const p = await getPerson(r.body.id);
    expect(p).toMatchObject({ email: "new.person@example.test", status: "pending", role: "staff", brand_ids: [A], signed_in_before: false });
    expect((await call(admin, "POST", "/people", { email: "new.person@example.test", display_name: "Dup", role: "staff" })).status).toBe(409);
    expect((await call(admin, "POST", "/people", { email: "bad", display_name: "x", role: "staff" })).status).toBe(400);
    expect((await call(admin, "POST", "/people", { email: "x@example.test", display_name: "x", role: "viewer" })).status).toBe(400);
    expect((await call(admin, "POST", "/people", { email: "m2@example.test", display_name: "x", role: "management", brand_ids: [A] })).status).toBe(400);
  });
  it("role and brand changes take effect on the next request and are recorded", async () => {
    const id = await person("rosa@example.test", "Rosa Staff", "staff", "active", [A]);
    const rosa = await login(id);
    const t = await task(admin, { title: "Beta work", brand_id: B, assignee_id: admin.id });
    expect((await call(rosa, "GET", `/tasks/${t.id}`)).status).toBe(404);
    let p = await getPerson(id);
    await call(admin, "PATCH", `/people/${id}`, { version: p.version, brand_ids: [A, B] });
    expect((await call(rosa, "GET", `/tasks/${t.id}`)).status).toBe(200);
    p = await getPerson(id);
    await call(admin, "PATCH", `/people/${id}`, { version: p.version, role: "management" });
    expect((await call(rosa, "POST", "/tasks", { title: "x", brand_id: A })).status).toBe(403);
    expect((await q("select count(*)::int n from user_brand_access where user_id = $1", [id]))[0].n).toBe(0);
    const hist = (await call(admin, "GET", `/people/${id}`)).body.history;
    expect(hist.map((h: any) => h.action)).toContain("person.access_changed");
    expect((await call(admin, "PATCH", `/people/${id}`, { version: 1, display_name: "stale" })).status).toBe(409);
  });
  it("archiving revokes every session at once, even when task reassignment fails", async () => {
    const id = await person("leo@example.test", "Leo Leaving", "staff", "active", [A]);
    const leo = await login(id);
    const t1 = await task(leo, { title: "Leo open 1", brand_id: A });
    const t2 = await task(leo, { title: "Leo open 2", brand_id: A });
    const done = await task(leo, { title: "Leo done", brand_id: A });
    await call(leo, "POST", `/tasks/${done.id}/completion`, { done: true, version: done.version });
    const open = (await call(admin, "GET", `/people/${id}/open-tasks`)).body.items.map((x: any) => x.title).sort();
    expect(open).toEqual(["Leo open 1", "Leo open 2"]);
    const p = await getPerson(id);
    // One reassignment is valid, one targets a person without brand access (fails), access is revoked anyway.
    const noAccess = await person("noaccess@example.test", "No Access", "staff", "active", [B]);
    const r = await call(admin, "POST", `/people/${id}/archive`, { version: p.version, reassign: [{ task_id: t1.id, assignee_id: admin.id }, { task_id: t2.id, assignee_id: noAccess }] });
    expect(r.status).toBe(200);
    expect(r.body.archived).toBe(true);
    expect(r.body.sessions_revoked).toBe(1);
    expect(r.body.reassigned.map((x: any) => x.ok)).toEqual([true, false]);
    expect((await call(leo, "GET", "/tasks")).status).toBe(401);
    expect((await getPerson(id)).status).toBe("archived");
    // Historical attribution is kept: the done task and the unreassigned task still name Leo.
    const dt = (await call(admin, "GET", `/tasks/${done.id}`)).body.task;
    expect(dt.assignee).toMatchObject({ id, name: "Leo Leaving", archived: true });
    expect((await call(admin, "GET", `/tasks/${t2.id}`)).body.task.assignee.id).toBe(id);
    expect((await call(admin, "GET", `/tasks/${t1.id}`)).body.task.assignee.id).toBe(admin.id);
    // Archived people cannot receive new assignments and drop out of assignment lists and default summaries.
    expect((await call(admin, "POST", "/tasks", { title: "to Leo", brand_id: A, assignee_id: id })).status).toBe(409);
    expect((await call(admin, "POST", `/tasks/${t1.id}/reassign`, { assignee_id: id })).status).toBe(409);
    expect((await call(admin, "GET", `/people-assignable?brand=${A}`)).body.items.map((x: any) => x.id)).not.toContain(id);
    expect((await call(admin, "GET", "/summaries")).body.by_person.map((x: any) => x.id)).not.toContain(id);
    expect((await call(admin, "GET", "/summaries?include_archived=1")).body.by_person.find((x: any) => x.id === id)).toMatchObject({ archived: true });
    // Still available in historical filters, labelled archived.
    expect((await call(mgmt, "GET", "/directory")).body.items.find((x: any) => x.id === id)).toMatchObject({ archived: true });
    expect((await call(admin, "GET", `/tasks?person=${id}`)).body.total).toBe(2);
  });
  it("restoring requires confirmed role and brands and a fresh sign-in; old sessions never return", async () => {
    const id = await person("ria@example.test", "Ria Returns", "staff", "active", [A]);
    const old = await login(id);
    let p = await getPerson(id);
    await call(admin, "POST", `/people/${id}/archive`, { version: p.version });
    p = await getPerson(id);
    expect((await call(admin, "POST", `/people/${id}/restore`, { version: p.version, role: "staff", brand_ids: [B] })).status).toBe(400);   // confirm missing
    expect((await call(admin, "POST", `/people/${id}/restore`, { version: p.version, role: "staff", brand_ids: [B], confirm: true })).status).toBe(200);
    expect((await getPerson(id))).toMatchObject({ status: "active", brand_ids: [B] });
    expect((await call(old, "GET", "/tasks")).status).toBe(401);
    const fresh = await login(id);
    expect((await call(fresh, "GET", "/brands")).body.items.map((b: any) => b.id)).toEqual([B]);
  });
  it("only an unused pending invitation can be deleted", async () => {
    const inv = (await call(admin, "POST", "/people", { email: "temp@example.test", display_name: "Temp", role: "staff", brand_ids: [A] })).body.id;
    const used = (await call(admin, "POST", "/people", { email: "used@example.test", display_name: "Used", role: "staff", brand_ids: [A] })).body.id;
    await task(admin, { title: "for used", brand_id: A, assignee_id: used });
    const active = await person("act@example.test", "Active One", "staff");
    expect((await call(admin, "DELETE", `/people/${used}?version=${(await getPerson(used)).version}`)).status).toBe(409);
    expect((await call(admin, "DELETE", `/people/${active}?version=${(await getPerson(active)).version}`)).status).toBe(409);
    expect((await call(admin, "DELETE", `/people/${inv}?version=${(await getPerson(inv)).version}`)).status).toBe(200);
    expect((await q("select count(*)::int n from users where id = $1", [inv]))[0].n).toBe(0);
  });
  it("the last active administrator cannot be archived, deleted or demoted", async () => {
    const me = await getPerson(admin.id);
    expect((await call(admin, "PATCH", `/people/${admin.id}`, { version: me.version, role: "staff" })).status).toBe(409);
    expect((await call(admin, "POST", `/people/${admin.id}/archive`, { version: me.version })).status).toBe(409);
    expect((await call(admin, "DELETE", `/people/${admin.id}?version=${me.version}`)).status).toBe(409);
    const pendingAdmin = (await call(admin, "POST", "/people", { email: "admin2@example.test", display_name: "Second Admin", role: "administrator" })).body.id;
    // A pending administrator does not count as active.
    expect((await call(admin, "PATCH", `/people/${admin.id}`, { version: me.version, role: "staff" })).status).toBe(409);
    await q("update users set status = 'active', google_sub = 'g-admin2' where id = $1", [pendingAdmin]);
    expect((await call(admin, "PATCH", `/people/${pendingAdmin}`, { version: (await getPerson(pendingAdmin)).version, role: "management" })).status).toBe(200);
  });
});

describe("brands", () => {
  it("adding a brand needs no code change; admins and Management see it, staff only when assigned; reporting stays off", async () => {
    const r = await call(admin, "POST", "/brands", { display_name: "Delta Decor", color: "#1D9E75" });
    expect(r.status).toBe(200);
    const b = await getBrand(r.body.id);
    expect(b).toMatchObject({ color: "#1d9e75", status: "active", reporting_enabled: false, dashboard_business_id: null });
    expect((await call(mgmt, "GET", "/brands")).body.items.map((x: any) => x.id)).toContain(r.body.id);
    const s = await login(await person("dee@example.test", "Dee Staff", "staff", "active", [A]));
    expect((await call(s, "GET", "/brands")).body.items.map((x: any) => x.id)).not.toContain(r.body.id);
    expect((await call(admin, "POST", "/brands", { display_name: "delta  decor" })).status).toBe(409);
    expect((await call(admin, "POST", "/brands", { display_name: "Bad color", color: "red" })).status).toBe(400);
    expect((await call(admin, "POST", "/brands", { display_name: "Bad color", color: "#12345g" })).status).toBe(400);
  });
  it("reporting needs an explicit supported mapping and is never enabled automatically", async () => {
    const b = await getBrand(A);
    expect((await call(admin, "PATCH", `/brands/${A}`, { version: b.version, reporting_enabled: true })).status).toBe(400);
    expect((await call(admin, "PATCH", `/brands/${A}`, { version: b.version, dashboard_business_id: "not-a-business" })).status).toBe(400);
    expect((await call(admin, "PATCH", `/brands/${A}`, { version: b.version, dashboard_business_id: "sb" })).status).toBe(200);
    expect((await getBrand(A)).reporting_enabled).toBe(false);
  });
  it("archiving keeps records, blocks new tasks and assignments, allows completion and moves, and can be restored", async () => {
    const E = await brand("Epsilon Supply");
    const s = await person("eli@example.test", "Eli Staff", "staff", "active", [E, A]);
    const eli = await login(s);
    const t = await task(eli, { title: "Epsilon open", brand_id: E });
    await call(admin, "POST", "/kpis", { owner_id: s, brand_id: E, metric: "Epsilon KPI" });
    await call(admin, "POST", `/brands/${E}/archive`, { version: (await getBrand(E)).version });
    expect((await q("select count(*)::int n from tasks where brand_id = $1", [E]))[0].n).toBe(1);
    expect((await call(eli, "POST", "/tasks", { title: "new", brand_id: E })).status).toBe(409);
    expect((await call(admin, "POST", "/tasks", { title: "new", brand_id: E, assignee_id: admin.id })).status).toBe(409);
    const other = await person("oli@example.test", "Oli Staff", "staff", "active", [E]);
    expect((await call(admin, "POST", "/people", { email: "x2@example.test", display_name: "X", role: "staff", brand_ids: [E] })).status).toBe(409);
    expect((await call(admin, "POST", `/tasks/${t.id}/reassign`, { assignee_id: other })).status).toBe(409);
    // Not in default lists; available in the archived-brand filter.
    expect((await call(eli, "GET", "/tasks")).body.items.map((x: any) => x.id)).not.toContain(t.id);
    expect((await call(eli, "GET", "/tasks?brand_status=archived")).body.items.map((x: any) => x.id)).toEqual([t.id]);
    expect((await call(eli, "POST", `/tasks/${t.id}/completion`, { done: true, version: t.version })).status).toBe(200);
    const cur = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(admin, "PATCH", `/tasks/${t.id}`, { version: cur.version, brand_id: A })).status).toBe(200);
    expect((await call(admin, "DELETE", `/brands/${E}?version=${(await getBrand(E)).version}`)).status).toBe(409);
    expect((await call(admin, "POST", `/brands/${E}/restore`, { version: (await getBrand(E)).version })).status).toBe(200);
    expect((await getBrand(E)).status).toBe("active");
  });
  it("only a never-used brand can be deleted", async () => {
    const r = await call(admin, "POST", "/brands", { display_name: "Unused Brand" });
    expect((await call(admin, "DELETE", `/brands/${r.body.id}?version=1`)).status).toBe(200);
    expect((await call(admin, "DELETE", `/brands/${A}?version=${(await getBrand(A)).version}`)).status).toBe(409);
  });
});

describe("task brand changes", () => {
  it("administrators assign, change and clear a brand; Unassigned-brand tasks are visible to admins and Management only", async () => {
    const s = await person("bo@example.test", "Bo Staff", "staff", "active", [A, B]);
    const bo = await login(s);
    const t = await task(bo, { title: "Movable", brand_id: A });
    let cur = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    const cleared = await call(admin, "PATCH", `/tasks/${t.id}`, { version: cur.version, brand_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.brand).toBeNull();
    expect((await call(bo, "GET", `/tasks/${t.id}`)).status).toBe(404);
    expect((await call(mgmt, "GET", "/tasks?brand=unassigned")).body.items.map((x: any) => x.id)).toContain(t.id);
    expect((await call(bo, "GET", "/tasks?brand=unassigned")).body.items).toEqual([]);
    cur = cleared.body.task;
    const moved = await call(admin, "PATCH", `/tasks/${t.id}`, { version: cur.version, brand_id: B });
    expect(moved.body.task.brand.id).toBe(B);
    const hist = (await call(admin, "GET", `/tasks/${t.id}`)).body.history.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(["brand_cleared", "brand_changed"]));
    // Staff and Management cannot change or clear a brand.
    expect((await call(bo, "PATCH", `/tasks/${t.id}`, { version: moved.body.task.version, brand_id: A })).status).toBe(403);
    expect((await call(mgmt, "PATCH", `/tasks/${t.id}`, { version: moved.body.task.version, brand_id: null })).status).toBe(403);
  });
  it("moving into a brand the assignee cannot access requires reassignment; access is never granted silently", async () => {
    const s = await person("cy@example.test", "Cy Staff", "staff", "active", [A]);
    const t = await task(admin, { title: "Cy task", brand_id: A, assignee_id: s });
    const r = await call(admin, "PATCH", `/tasks/${t.id}`, { version: t.version, brand_id: B });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("assignee_lacks_brand_access");
    expect((await q("select count(*)::int n from user_brand_access where user_id = $1 and brand_id = $2", [s, B]))[0].n).toBe(0);
    const both = await call(admin, "PATCH", `/tasks/${t.id}`, { version: t.version, brand_id: B, assignee_id: admin.id });
    expect(both.status).toBe(200);
    expect(both.body.task).toMatchObject({ brand: { id: B }, assignee: { id: admin.id } });
  });
  it("an incompatible KPI link is cleared with a visible explanation, in the same transaction", async () => {
    const s = await person("di@example.test", "Di Staff", "staff", "active", [A, B]);
    const k = (await call(admin, "POST", "/kpis", { owner_id: s, brand_id: A, metric: "Blogs" })).body.id;
    const t = await task(admin, { title: "KPI linked", brand_id: A, assignee_id: s, kpi_id: k });
    expect(t.kpi.id).toBe(k);
    const r = await call(admin, "PATCH", `/tasks/${t.id}`, { version: t.version, brand_id: B });
    expect(r.status).toBe(200);
    expect(r.body.task.kpi).toBeNull();
    expect(r.body.notices[0]).toMatch(/KPI link was removed/);
    expect((await call(admin, "PATCH", `/tasks/${t.id}`, { version: r.body.task.version, kpi_id: k })).status).toBe(400);
  });
});
