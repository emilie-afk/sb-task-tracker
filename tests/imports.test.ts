// Private migration of old browser data and KPI spreadsheet imports. Fictional export files only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { freshDb, q, call, person, brand, login, closePool, type Who } from "./helpers";
import { normalizeLegacyExport } from "../server/legacy";
import { inspectZip } from "../server/xlsx";

let admin: Who, staff: Who, mgmt: Who, A: string, B: string;
beforeAll(async () => {
  await freshDb();
  A = await brand("Alpha Plants"); B = await brand("Beta Prints");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  staff = await login(await person("sam@example.test", "Sam Staff", "staff", "active", [A, B]));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
});
afterAll(closePool);

const legacyTask = (over: Record<string, unknown> = {}) => ({ id: 1, title: "Write blog", brand: "alpha", assignee: "sam", type: "adhoc", repeat: "none", kpi: "", due: "2026-06-05", note: "", done: false, createdBy: "boss", date: "2026-06-01", ...over });
const exportFile = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  format: "sb-task-tracker-legacy-export", version: 1, exported_at: "2026-11-01T02:00:00.000Z",
  keys: {
    tt_tasks: JSON.stringify(tasks), tt_nid: "99",
    tt_users: JSON.stringify([{ id: "sam", name: "Sam Staff", isManager: true, brands: ["alpha", "beta"] }, { id: "boss", name: "Ada Admin", isManager: true }]),
    tt_kpis: JSON.stringify({ sam: { alpha: [{ id: "k1", metric: "Blogs", sub: "Written", current: "2", target: "2", note: "Weekly" }] } }),
    ...extra,
  },
});
const preview = (file: unknown, label = "Browser A") => call(admin, "POST", "/imports/legacy/preview", { source_label: label, file });
const commitAll = (p: any, over: Record<string, unknown> = {}) => call(admin, "POST", `/imports/legacy/${p.id}/commit`, {
  person_map: { sam: staff.id, boss: admin.id }, brand_map: { alpha: A, beta: B },
  tasks: p.tasks.filter((t: any) => !t.already_imported).map((t: any) => t.cid), kpis: p.kpis.filter((k: any) => !k.already_imported).map((k: any) => k.cid), ...over,
});

describe("legacy browser export", () => {
  it("previews counts, validation failures, mappings and notes without writing tasks", async () => {
    const file = exportFile([
      legacyTask(),
      legacyTask({ id: 2, title: "Daily check", repeat: "daily", due: "", done: true, completedAt: "2026-06-03" }),
      legacyTask({ id: 3, title: "", brand: "alpha" }),                       // invalid: empty title
      legacyTask({ id: 4, due: "2026-02-30" }),                                // invalid date
      legacyTask({ id: 5, title: "Done once", done: true }),                  // no completion date stored
    ], { tt_perms: JSON.stringify({ sam: ["alpha", "beta", "gamma"] }) });
    const r = await preview(file);
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ tasks: 3, kpis: 1, invalid: 2 });
    expect(r.body.invalid.map((i: any) => i.reason).join(" ")).toMatch(/title is missing/);
    expect(r.body.people.find((p: any) => p.legacy_id === "sam").suggested_user_id).toBe(staff.id);
    expect(r.body.brands.sort()).toEqual(["alpha"]);
    const daily = r.body.tasks.find((t: any) => t.title === "Daily check");
    expect(daily).toMatchObject({ recurrence: "weekdays", due: "2026-06-01", completed_occurrence: "2026-06-03", completed_on: null });
    expect(r.body.tasks.find((t: any) => t.title === "Done once").completed_on).toBe("2026-06-01");
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(0);
    // Roles, manager flags, brand permissions and passwords are never part of a preview.
    expect(JSON.stringify(r.body)).not.toMatch(/isManager|gamma|tt_perms|password/i);
  });
  it("commits only selected records with original dates, provenance and stable ids; repeats are idempotent", async () => {
    const file = exportFile([legacyTask(), legacyTask({ id: 7, title: "Picked", done: true, completedAt: "2026-06-04", note: "<b>bold</b><script>x()</script>" })]);
    const p = (await preview(file)).body;
    const picked = p.tasks.find((t: any) => t.title === "Picked");
    const r = await commitAll(p, { tasks: [picked.cid], kpis: [] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tasks_created: 1, tasks_already_imported: 0 });
    const [t] = await q("select id, title, note, operational_date::text d, completed_on::text c, import_record_id, assignee_id from tasks where title = 'Picked'");
    expect(t).toMatchObject({ d: "2026-06-01", c: "2026-06-04", note: "<b>bold</b><script>x()</script>", assignee_id: staff.id });
    expect(t.import_record_id).not.toBeNull();
    // Same file again: the committed record is reported as already imported and never duplicated.
    const again = (await preview(file)).body;
    expect(again.tasks.find((x: any) => x.title === "Picked").already_imported).toBe(true);
    const r2 = await call(admin, "POST", `/imports/legacy/${again.id}/commit`, { person_map: { sam: staff.id, boss: admin.id }, brand_map: { alpha: A }, tasks: [picked.cid], kpis: [] });
    expect(r2.body).toMatchObject({ tasks_created: 0, tasks_already_imported: 1 });
    expect((await q("select count(*)::int n from tasks where title = 'Picked'"))[0].n).toBe(1);
    // A committed preview cannot be committed again.
    expect((await commitAll(p)).status).toBe(409);
  });
  it("handles old numeric id collisions across browsers and flags conflicting copies without choosing", async () => {
    const browserA = exportFile([legacyTask({ id: 10, title: "Shared title", due: "2026-06-10" }), legacyTask({ id: 11, title: "Only in A" })]);
    const browserB = exportFile([legacyTask({ id: 10, title: "Different task same id" }), legacyTask({ id: 12, title: "Shared title", due: "2026-06-12" })]);
    const pa = (await preview(browserA, "Browser A")).body;
    await commitAll(pa);
    const pb = (await preview(browserB, "Browser B")).body;
    const diff = pb.tasks.find((t: any) => t.title === "Different task same id");
    expect(diff.already_imported).toBe(false);
    expect(diff.flags.join(" ")).toMatch(/old id 10 was imported earlier/i);
    // Combined file (both browsers): conflicting due dates are flagged, both stay selectable.
    const both = exportFile([legacyTask({ id: 20, title: "Same origin", due: "2026-06-10" }), legacyTask({ id: 21, title: "Same origin", due: "2026-06-12" })]);
    const pc = (await preview(both, "Merged")).body;
    expect(pc.tasks.filter((t: any) => t.title === "Same origin").every((t: any) => /conflicting due date/.test(t.flags.join(" ")))).toBe(true);
    const dupIds = normalizeLegacyExport(exportFile([legacyTask({ id: 30, title: "One" }), legacyTask({ id: 30, title: "Two" })]));
    expect(dupIds.ok && dupIds.tasks.every((t) => /used by 2 different records/.test(t.flags.join(" ")))).toBe(true);
    // Identical records from two browsers have one fingerprint: imported once.
    const same = normalizeLegacyExport(exportFile([legacyTask({ id: 40 }), legacyTask({ id: 40 })]));
    expect(same.ok && same.tasks.length).toBe(1);
  });
  it("refuses incomplete mappings and access that the import would have to grant; nothing is written", async () => {
    const p = (await preview(exportFile([legacyTask({ id: 50, title: "Needs mapping", brand: "gamma" })]))).body;
    const missing = await call(admin, "POST", `/imports/legacy/${p.id}/commit`, { person_map: { sam: staff.id, boss: admin.id }, brand_map: {}, tasks: [p.tasks[0].cid] });
    expect(missing.status).toBe(422);
    const outsider = await person("out@example.test", "Out Sider", "staff", "active", []);
    const noAccess = await call(admin, "POST", `/imports/legacy/${p.id}/commit`, { person_map: { sam: outsider, boss: admin.id }, brand_map: { gamma: A }, tasks: [p.tasks[0].cid] });
    expect(noAccess.status).toBe(422);
    expect(JSON.stringify(noAccess.body)).toMatch(/never granted/);
    expect((await q("select count(*)::int n from user_brand_access where user_id = $1", [outsider]))[0].n).toBe(0);
    const mg = await call(admin, "POST", `/imports/legacy/${p.id}/commit`, { person_map: { sam: mgmt.id, boss: admin.id }, brand_map: { gamma: null }, tasks: [p.tasks[0].cid] });
    expect(mg.status).toBe(422);
    expect((await q("select count(*)::int n from tasks where title = 'Needs mapping'"))[0].n).toBe(0);
    const unassigned = await call(admin, "POST", `/imports/legacy/${p.id}/commit`, { person_map: { sam: staff.id, boss: admin.id }, brand_map: { gamma: null }, tasks: [p.tasks[0].cid] });
    expect(unassigned.status).toBe(200);
    expect((await q("select brand_id from tasks where title = 'Needs mapping'"))[0].brand_id).toBeNull();
  });
  it("imports KPI scorecards with the current value stored for the export week", async () => {
    const p = (await preview(exportFile([]))).body;
    const r = await call(admin, "POST", `/imports/legacy/${p.id}/commit`, { person_map: { sam: staff.id }, brand_map: { alpha: A }, tasks: [], kpis: p.kpis.map((k: any) => k.cid) });
    expect(r.body.kpis_created + r.body.kpis_already_imported).toBe(1);   // an earlier test may have committed it
    const k = (await call(staff, "GET", "/kpis?week=2026-11-01")).body.items[0];
    expect(k).toMatchObject({ metric: "Blogs", sub_metric: "Written", target: "2", value: "2" });
  });
  it("rejects files that are not exports, oversized bodies, and non-administrators", async () => {
    expect((await preview({ format: "something else" })).status).toBe(400);
    expect((await preview(exportFile([]) as any as unknown, "x".repeat(200))).status).toBe(400);
    expect((await call(admin, "POST", "/imports/legacy/preview", { file: { blob: "x".repeat(6 * 1024 * 1024) } })).status).toBe(413);
    expect((await call(staff, "POST", "/imports/legacy/preview", { file: exportFile([]) })).status).toBe(403);
    expect((await call(mgmt, "POST", "/imports/legacy/preview", { file: exportFile([]) })).status).toBe(403);
    expect(normalizeLegacyExport({ ...exportFile([]), keys: { tt_tasks: "{not json" } })).toMatchObject({ ok: true, invalid: [{ ref: "tt_tasks", reason: "not valid JSON" }] });
  });
});

describe("KPI spreadsheet", () => {
  async function workbook(rows: (string | number)[][]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Scorecard");
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const upload = (buf: Buffer, who = admin) => { const fd = new FormData(); fd.set("file", new File([new Uint8Array(buf)], "scorecard.xlsx")); return call(who, "POST", "/imports/kpi-xlsx/preview", fd); };

  it("parses the scorecard layout on the server and imports selected rows once", async () => {
    const buf = await workbook([["Scorecard"], ["Owner"], ["Metric", "Metrics", "Target"], ["Blogs", "Written", 2], ["", "Updated", 3], ["Social", "Posts <script>", "n/a", 5]]);
    const r = await upload(buf);
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: any) => [x.metric, x.sub_metric, x.target])).toEqual([["Blogs", "Written", "2"], ["Blogs", "Updated", "3"], ["Social", "Posts <script>", "5"]]);
    const commit = await call(admin, "POST", `/imports/kpi-xlsx/${r.body.id}/commit`, { owner_id: staff.id, brand_id: B, rows: r.body.rows.map((x: any) => x.cid) });
    expect(commit.body).toMatchObject({ created: 3, already_imported: 0 });
    const again = await upload(buf);
    const c2 = await call(admin, "POST", `/imports/kpi-xlsx/${again.body.id}/commit`, { owner_id: staff.id, brand_id: B, rows: again.body.rows.map((x: any) => x.cid) });
    expect(c2.body).toMatchObject({ created: 0, already_imported: 3 });
  });
  it("rejects non-xlsx files, oversized files, too many rows and expanding archives", async () => {
    expect((await upload(Buffer.from("not a spreadsheet"))).status).toBe(400);
    expect((await upload(Buffer.alloc(1024 * 1024 + 10, 1))).status).toBe(413);
    const many = await workbook(Array.from({ length: 600 }, (_, i) => ["m" + i, "s", 1]));
    expect((await upload(many)).status).toBe(413);
    // A crafted central directory claiming a huge uncompressed size is refused before parsing.
    const ok = await workbook([["a"]]);
    const forged = Buffer.from(ok);
    const eocd = forged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cd = forged.readUInt32LE(eocd + 16);
    forged.writeUInt32LE(500 * 1024 * 1024, cd + 24);
    expect(() => inspectZip(forged)).toThrow(/expands too much/);
    expect((await upload(await workbook([["a"]]), staff)).status).toBe(403);
  });
});
