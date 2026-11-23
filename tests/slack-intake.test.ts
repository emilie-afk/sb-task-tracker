// Slack task intake: tasks created from @mentions, deadlines, manual edits kept, completion from the owner's own
// thread replies, review items, idempotency and credit. Fictional people, brands, channels and messages only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, q, call, person, brand, login, app, ORIGIN, closePool, type Who } from "./helpers";
import { _setClockForTests } from "../shared/dates";
import { nextWorkingDay } from "../server/slackIntake";

let admin: Who, tia: Who, kim: Who, mgmt: Who;
let A: string, B: string, key = "", reportKey = "";
const TIA = "U0TIA00001", KIM = "U0KIM00001", NOBODY = "U0NOB00001";
const CH = "C0ALPHA001", CH_NOMAP = "C0NOMAP001";
const vn = (date: string, time = "10:00") => _setClockForTests(() => Date.parse(`${date}T${time}:00+07:00`));
// Activation happens at 2026-11-20 10:00 in Vietnam; messages are posted after it, a second apart.
const ACT = Date.parse("2026-11-20T10:00:00+07:00") / 1000;
let seq = 1;
const linkFor = (ch: string, ts: string) => `https://example-team.slack.com/archives/${ch}/p${ts.replace(".", "")}`;
/** A fresh Slack timestamp (after activation) and its message link. */
const msg = (ch = CH) => { const ts = `${ACT + seq++}.000100`; return { ts, link: linkFor(ch, ts) }; };
/** A Slack timestamp at a given Vietnam time (unique per call). */
const msgAt = (vnTime: string, ch = CH) => { const ts = `${Date.parse(vnTime + "+07:00") / 1000}.${String(seq++).padStart(6, "0")}`; return { ts, link: linkFor(ch, ts) }; };
const slack = (method: string, path: string, body?: unknown, k: string | null = key, extra: Record<string, string> = {}) =>
  app(new Request(`${ORIGIN}/api/slack-intake/v1${path}`, { method, headers: { ...(k === null ? {} : { "x-tracker-slack-key": k }), ...(body ? { "content-type": "application/json" } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined }));
const state = async () => (await (await slack("GET", "/state")).json()) as any;
let batchNo = 0;
/** Post one batch covering the stored checkpoint up to now, advancing the checkpoint unless told not to. */
async function batch(items: unknown[], opts: { id?: string; from?: string; advance?: boolean } = {}) {
  const st = await state();
  // Tests move the clock back and forth; a run never ends before the stored checkpoint.
  const cp = st.checkpoint_ts as string, to = Number(st.now_ts.split(".")[0]) > Number(cp.split(".")[0]) ? st.now_ts as string : cp;
  const r = await slack("POST", "/batches", { batch_id: opts.id ?? `test-batch-${++batchNo}`, range: { from_ts: opts.from ?? cp, to_ts: to },
    ...(opts.advance === false ? {} : { checkpoint_ts: to }), items });
  return { status: r.status, body: (await r.json()) as any };
}
const create = (m: { ts: string; link: string }, extra: Record<string, unknown> = {}, ch = CH, action = "a0") => ({
  kind: "create", key: { channel_id: ch, message_ts: m.ts, action_id: action }, permalink: m.link, posted_at: "2026-11-20T03:00:00Z",
  assignee_slack_id: TIA, title: "Cập nhật banner trang chủ", description: "Theo yêu cầu trong Slack", ...extra,
});
const reply = (m: { ts: string }, author = TIA, ch = CH, at?: string) => { const r = at ? msgAt(at, ch) : msg(ch); return { channel_id: ch, ts: r.ts, permalink: r.link, author_slack_id: author }; };
const k = (m: { ts: string }, action = "a0", ch = CH) => ({ channel_id: ch, message_ts: m.ts, action_id: action });
const task = async (id: string, who: Who = admin) => (await call(who, "GET", `/tasks/${id}`)).body;
const reviews = async () => (await call(admin, "GET", "/integrations/slack")).body.reviews as any[];
const report = async () => {
  const r = await app(new Request(`${ORIGIN}/api/reporting/v1/tasks?limit=500`, { headers: { "x-tracker-reporting-key": reportKey } }));
  return ((await r.json()) as any).items as any[];
};

beforeAll(async () => {
  await freshDb();
  vn("2026-11-20");                                                     // Friday
  A = await brand("Alpha Plants", { reporting_enabled: true, dashboard_business_id: "sb" });
  B = await brand("Beta Prints");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  tia = await login(await person("tia@example.test", "Tia Staff", "staff", "active", [A]));
  kim = await login(await person("kim@example.test", "Kim Staff", "staff", "active", [A, B]));
  mgmt = await login(await person("mia@example.test", "Mia Management", "management"));
  reportKey = (await call(admin, "POST", "/integrations/reporting/credential", {})).body.secret;
});
afterAll(async () => { _setClockForTests(null); await closePool(); });

describe("activation, credentials and administration", () => {
  it("is off until an administrator creates the credential; creating it starts monitoring now", async () => {
    expect((await slack("GET", "/state", undefined, "tsl_" + "x".repeat(40))).status).toBe(503);
    expect((await q("select checkpoint_ts from slack_intake_state"))[0].checkpoint_ts).toBeNull();
    const c = await call(admin, "POST", "/integrations/slack/credential", {});
    expect(c.status).toBe(200);
    key = c.body.secret;
    expect(key).toMatch(/^tsl_/);
    expect((await q("select checkpoint_ts from slack_intake_state"))[0].checkpoint_ts).toMatch(/^\d{10}\.\d{6}$/);
    // The secret is stored only as a hash.
    const [row] = await q("select key_hash from slack_intake_credentials where revoked_at is null");
    expect(Buffer.from(row.key_hash).toString("utf8")).not.toContain(key);
  });
  it("only administrators manage the intake; Management and Staff are refused", async () => {
    for (const who of [mgmt, tia]) {
      expect((await call(who, "GET", "/integrations/slack")).status).toBe(403);
      expect((await call(who, "PUT", "/integrations/slack/people", { slack_user_id: TIA, user_id: tia.id })).status).toBe(403);
      expect((await call(who, "POST", "/integrations/slack/credential", {})).status).toBe(403);
    }
  });
  it("links Slack members to active staff only, and maps channels to active brands", async () => {
    expect((await call(admin, "PUT", "/integrations/slack/people", { slack_user_id: "U0ADM00001", user_id: admin.id })).status).toBe(400);
    expect((await call(admin, "PUT", "/integrations/slack/people", { slack_user_id: TIA, user_id: tia.id })).status).toBe(200);
    expect((await call(admin, "PUT", "/integrations/slack/people", { slack_user_id: KIM, user_id: kim.id })).status).toBe(200);
    expect((await call(admin, "PUT", "/integrations/slack/channels", { channel_id: CH, label: "#alpha", brand_id: A })).status).toBe(200);
    const s = (await call(admin, "GET", "/integrations/slack")).body;
    expect(s.people.map((p: any) => [p.name, p.slack_user_id])).toEqual([["Kim Staff", KIM], ["Tia Staff", TIA]]);
    expect(s.channels).toEqual([expect.objectContaining({ channel_id: CH, brand_id: A })]);
  });
  it("accepts only its own credential: no key, a wrong key or a browser session are refused, and the key opens nothing else", async () => {
    expect((await slack("GET", "/state", undefined, null)).status).toBe(401);
    expect((await slack("GET", "/state", undefined, "tsl_" + "y".repeat(43))).status).toBe(401);
    expect((await slack("GET", "/state", undefined, null, { cookie: admin.cookie })).status).toBe(401);
    const other = await app(new Request(`${ORIGIN}/api/tasks`, { headers: { "x-tracker-slack-key": key } }));
    expect(other.status).toBe(401);
    const rep = await app(new Request(`${ORIGIN}/api/reporting/v1/tasks`, { headers: { "x-tracker-reporting-key": key } }));
    expect(rep.status).toBe(401);
  });
  it("refuses a batch that would leave a gap after the checkpoint, and a batch before activation", async () => {
    const cp = (await state()).checkpoint_ts as string;
    const later = `${Number(cp.split(".")[0]) + 30}.000000`, to = `${Number(cp.split(".")[0]) + 90}.000000`;
    const gap = await slack("POST", "/batches", { batch_id: "gap-batch-1", range: { from_ts: later, to_ts: to }, checkpoint_ts: to, items: [] });
    expect(gap.status).toBe(409);
    expect(((await gap.json()) as any).error.code).toBe("checkpoint_gap");
    await q("update slack_intake_state set checkpoint_ts = null");
    const pre = await slack("POST", "/batches", { batch_id: "pre-batch-1", range: { from_ts: cp, to_ts: to }, checkpoint_ts: to, items: [] });
    expect(pre.status).toBe(409);
    expect(((await pre.json()) as any).error.code).toBe("not_activated");
    await q("update slack_intake_state set checkpoint_ts = $1", [cp]);
  });
});

describe("creating tasks from mentions", () => {
  beforeAll(() => vn("2026-11-22", "12:00"));                          // Sunday, two days after activation
  it("creates one task assigned to the linked person, brand from the channel, deadline inferred as the next working day", async () => {
    expect(nextWorkingDay(Date.parse("2026-11-20T03:00:00Z"))).toBe("2026-11-23");   // Friday -> Monday
    expect(nextWorkingDay(Date.parse("2026-11-18T18:00:00Z"))).toBe("2026-11-20");   // Thu 01:00 in Vietnam -> Friday
    const m = msg();
    const r = await batch([create(m)]);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ outcome: "created", due_date: "2026-11-23", due_inferred: true, brand_id: A });
    const t = (await task(r.body.results[0].task_id)).task;
    expect(t).toMatchObject({ title: "Cập nhật banner trang chủ", assignee: { id: tia.id }, due_date: "2026-11-23", brand: { id: A },
      slack: { permalink: m.link, due_inferred: true, source_deleted: false } });
    const d = await task(t.id);
    expect(d.history[0]).toMatchObject({ action: "created_from_slack", actor: null, changes: expect.objectContaining({ via: "slack", permalink: m.link }) });
    // Re-reading the same message (overlapping runs, a replayed or new batch) never creates a second task.
    const again = await batch([create(m)], { from: "1700000000.000000" });
    expect(again.body.results[0]).toMatchObject({ outcome: "duplicate", task_id: t.id });
    expect((await q("select count(*)::int n from slack_task_links where message_ts = $1", [m.ts]))[0].n).toBe(1);
  });
  it("uses an explicit deadline as given, and several requests in one message become separate tasks", async () => {
    const m = msg();
    const r = await batch([create(m, { title: "Write the blog post", due_date: "2026-11-25", deadline_text: "by Wednesday" }),
      create(m, { title: "Send the newsletter draft", due_date: "2026-11-24" }, CH, "a1")]);
    expect(r.body.results.map((x: any) => [x.outcome, x.due_date, x.due_inferred])).toEqual([["created", "2026-11-25", false], ["created", "2026-11-24", false]]);
    const t = (await task(r.body.results[0].task_id)).task;
    expect(t.slack.due_inferred).toBe(false);
  });
  it("puts a task with no clear brand under Unassigned brand for review, also when the person lacks access to the named brand", async () => {
    const m1 = msg(CH_NOMAP), m2 = msg();
    const r = await batch([create(m1, {}, CH_NOMAP), create(m2, { brand_id: B, title: "Beta poster" })]);
    expect(r.body.results.map((x: any) => [x.outcome, x.brand_id])).toEqual([["created", null], ["created", null]]);
    const kinds = (await reviews()).filter((x) => [r.body.results[0].task_id, r.body.results[1].task_id].includes(x.task_id)).map((x) => x.kind);
    expect(kinds).toEqual(["brand_unclear", "brand_unclear"]);
  });
  it("refuses a mention of someone who is not linked, without creating a task", async () => {
    const m = msg();
    const before = (await q("select count(*)::int n from tasks"))[0].n;
    const r = await batch([create(m, { assignee_slack_id: NOBODY })]);
    expect(r.body.results[0]).toMatchObject({ outcome: "refused", reason: "assignee_not_linked" });
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(before);
    expect((await reviews()).some((x) => x.kind === "refused" && x.permalink === m.link)).toBe(true);
  });
  it("creates a repeating task only when asked, as a routine series", async () => {
    const m = msg();
    const r = await batch([create(m, { title: "Weekly social post", recurrence: { rule: "weekly", days: [1], start: "2026-11-16" } })]);
    const t = (await task(r.body.results[0].task_id)).task;
    expect(t).toMatchObject({ type: "routine", recurrence: "weekly", recurrence_days: [1], due_date: "2026-11-16" });
    expect(t.slack.due_inferred).toBe(false);
  });
});

describe("deadlines and edits", () => {
  it("lets the person change their own deadline; a later Slack edit keeps it and flags the conflict, other fields follow Slack", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Edit me" })])).body.results[0].task_id;
    const cur = (await task(id, tia)).task;
    const e = await call(tia, "PATCH", `/tasks/${id}`, { version: cur.version, due_date: "2026-11-27" });
    expect(e.status).toBe(200);
    expect((await task(id)).task.slack.due_inferred).toBe(false);          // no longer the inferred date
    const u = await batch([{ kind: "update", key: k(m), edited_ts: "1763609999.000100", title: "Edit me (v2)", due_date: "2026-11-24" }]);
    expect(u.body.results[0]).toMatchObject({ outcome: "updated", conflicts: ["due_date"] });
    const t = (await task(id)).task;
    expect(t).toMatchObject({ title: "Edit me (v2)", due_date: "2026-11-27" });
    expect((await reviews()).some((x) => x.kind === "edit_conflict" && x.task_id === id)).toBe(true);
    const h = (await task(id)).history.map((x: any) => x.action);
    expect(h).toEqual(["updated_from_slack", "edited", "created_from_slack"]);
    // The same edit seen again changes nothing.
    const again = await batch([{ kind: "update", key: k(m), edited_ts: "1763609999.000100", title: "Edit me (v2)", due_date: "2026-11-24" }]);
    expect(again.body.results[0].outcome).toBe("unchanged");
  });
  it("applies a Slack deadline edit when nobody changed it in the tracker, and it stops being inferred", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Deadline later" })])).body.results[0].task_id;
    await batch([{ kind: "update", key: k(m), edited_ts: "1763609999.000200", title: "Deadline later", due_date: "2026-11-26" }]);
    expect((await task(id)).task).toMatchObject({ due_date: "2026-11-26", slack: { due_inferred: false } });
  });
  it("flags a task whose Slack message was deleted, once", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Deleted source" })])).body.results[0].task_id;
    await batch([{ kind: "deleted", key: k(m) }]);
    await batch([{ kind: "deleted", key: k(m) }]);
    expect((await task(id)).task).toMatchObject({ status: "open", slack: { source_deleted: true } });
    expect((await reviews()).filter((x) => x.kind === "source_deleted" && x.task_id === id)).toHaveLength(1);
  });
});

describe("completion from the owner's replies", () => {
  it("completes once from the owner's reply, as automation credited to the owner; replays change nothing", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Gửi báo giá" })])).body.results[0].task_id;
    const rp = reply(m);
    const item = { kind: "complete", key: k(m), reply: rp };
    const first = await batch([item], { id: "complete-once-1" });
    expect(first.body.results[0]).toMatchObject({ outcome: "completed", task_id: id });
    expect((await batch([item], { id: "complete-once-1" })).body).toMatchObject({ replayed: true });
    expect((await batch([item])).body.results[0]).toMatchObject({ outcome: "already_processed" });
    const d = await task(id);
    expect(d.task).toMatchObject({ status: "done", completed_on: "2026-11-20", assignee: { id: tia.id } });
    expect(d.history.find((x: any) => x.action === "completed_from_slack")).toMatchObject({ actor: null, changes: { via: "slack", reply: rp.permalink } });
    expect((await q("select completed_by from tasks where id = $1", [id]))[0].completed_by).toBeNull();
    // Counted once for the owner: weekly workload and the dashboard feed.
    const w = (await call(admin, "GET", "/tasks/week?start=2026-11-16")).body;
    expect(w.completed.filter((u: any) => u.task_id === id)).toHaveLength(1);
    const items = (await report()).filter((i: any) => i.task_id === id);
    expect(items).toEqual([expect.objectContaining({ status: "done", assignee: expect.objectContaining({ id: tia.id }) })]);
  });
  it("a manual reopen in the tracker is not undone by reprocessing the same reply", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Reopen me" })])).body.results[0].task_id;
    const rp = reply(m);
    await batch([{ kind: "complete", key: k(m), reply: rp }]);
    const cur = (await task(id)).task;
    expect((await call(tia, "POST", `/tasks/${id}/completion`, { done: false, version: cur.version })).status).toBe(200);
    const r = await batch([{ kind: "complete", key: k(m), reply: rp }]);
    expect(r.body.results[0].outcome).toBe("already_processed");
    expect((await task(id)).task.status).toBe("open");
  });
  it("keeps the task open on progress, and sends an ambiguous reply to review", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Progress only" })])).body.results[0].task_id;
    const p = reply(m), amb = reply(m);
    const r = await batch([{ kind: "noted", key: k(m), reply: p, outcome: "progress" },
      { kind: "noted", key: k(m), reply: amb, outcome: "review", note: "Reply may mean the work is finished." }]);
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(["progress", "review"]);
    expect((await task(id)).task.status).toBe("open");
    expect((await reviews()).filter((x) => x.kind === "ambiguous_reply" && x.task_id === id)).toHaveLength(1);
    const st = (await state()).open_tasks.find((x: any) => x.task_id === id);
    expect(st).toMatchObject({ owner_slack_id: TIA, status: "open" });
    expect(st.processed_replies).toEqual([p.ts, amb.ts].sort());
  });
  it("completes only the tasks a reply clearly covers when one thread has several", async () => {
    const m = msg();
    const r = await batch([create(m, { title: "Thread task one" }), create(m, { title: "Thread task two" }, CH, "a1")]);
    const [one, two] = r.body.results.map((x: any) => x.task_id);
    const rp = reply(m);
    await batch([{ kind: "complete", key: k(m), reply: rp }, { kind: "noted", key: k(m, "a1"), reply: rp, outcome: "progress" }]);
    expect((await task(one)).task.status).toBe("done");
    expect((await task(two)).task.status).toBe("open");
  });
  it("refuses a completion written by someone other than the owner", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Owner only" })])).body.results[0].task_id;
    const r = await batch([{ kind: "complete", key: k(m), reply: reply(m, KIM) }]);
    expect(r.body.results[0]).toMatchObject({ outcome: "refused", reason: "author_not_owner" });
    expect((await task(id)).task.status).toBe("open");
  });
  it("completes the named occurrence of a repeating task only, and sends an unclear occurrence to review", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Daily stories", recurrence: { rule: "daily", start: "2026-11-16" } })])).body.results[0].task_id;
    const ok = await batch([{ kind: "complete", key: k(m), reply: reply(m), occurrence_date: "2026-11-19" }]);
    expect(ok.body.results[0]).toMatchObject({ outcome: "completed", occurrence_date: "2026-11-19" });
    const unclear = await batch([{ kind: "complete", key: k(m), reply: reply(m) }]);
    expect(unclear.body.results[0]).toMatchObject({ outcome: "review", reason: "occurrence_unclear" });
    const rows = await q("select occurrence_date::text d, completed_by from task_occurrences where task_id = $1", [id]);
    expect(rows).toEqual([{ d: "2026-11-19", completed_by: null }]);
    const items = (await report()).filter((i: any) => i.task_id === id && i.status === "done");
    expect(items.map((i: any) => i.occurrence_date)).toEqual(["2026-11-19"]);
  });
  it("never changes KPI values", async () => {
    expect((await q("select count(*)::int n from kpi_values"))[0].n).toBe(0);
  });
});

describe("batches", () => {
  it("rejects malformed input and links that are not Slack message links", async () => {
    const m = msg();
    const bad = await batch([create(m, { permalink: "https://evil.example.test/archives/C0ALPHA001/p1763600000000100" })]);
    expect(bad.status).toBe(400);
    expect((await batch([{ kind: "complete", key: k(m), reply: { ...reply(m), author_slack_id: "not-a-member" } }])).status).toBe(400);
  });
  it("advances the checkpoint and never moves it backwards", async () => {
    const before = (await state()).checkpoint_ts as string;
    const r = await slack("POST", "/batches", { batch_id: "backwards-1", range: { from_ts: "1700000000.000000", to_ts: "1700000100.000000" }, checkpoint_ts: "1700000100.000000", items: [] });
    expect(r.status).toBe(200);
    expect((await state()).checkpoint_ts).toBe(before);
  });
});

describe("review fixes: authorization, continuations, reply dates, paging and recovery", () => {
  /** A fresh linked staff member with access to brand A. */
  async function linked(name: string, slackId: string) {
    const id = await person(`${name.toLowerCase()}@example.test`, `${name} Staff`, "staff", "active", [A]);
    expect((await call(admin, "PUT", "/integrations/slack/people", { slack_user_id: slackId, user_id: id })).status).toBe(200);
    return id;
  }
  it("refuses Slack completion by someone now in Management, and after their brand access was removed", async () => {
    const lee = await linked("Lee", "U0LEE00001"), max = await linked("Max", "U0MAX00001");
    const m1 = msg(), m2 = msg();
    const r = await batch([create(m1, { assignee_slack_id: "U0LEE00001", title: "Role changes" }), create(m2, { assignee_slack_id: "U0MAX00001", title: "Access removed" })]);
    const [t1, t2] = r.body.results.map((x: any) => x.task_id);
    await q("update users set role = 'management' where id = $1", [lee]);
    await q("delete from user_brand_access where user_id = $1", [max]);
    const c = await batch([{ kind: "complete", key: k(m1), reply: reply(m1, "U0LEE00001") }, { kind: "complete", key: k(m2), reply: reply(m2, "U0MAX00001") }]);
    expect(c.body.results.map((x: any) => [x.outcome, x.reason])).toEqual([["refused", "not_permitted"], ["refused", "not_permitted"]]);
    expect((await task(t1)).task.status).toBe("open");
    expect((await task(t2)).task.status).toBe("open");
    expect((await reviews()).filter((x) => x.kind === "refused" && [t1, t2].includes(x.task_id))).toHaveLength(2);
  });
  it("refuses a completion from an archived owner and on a repeating occurrence owned by someone else", async () => {
    const ann = await linked("Ann", "U0ANN00001");
    const m = msg();
    const id = (await batch([create(m, { assignee_slack_id: "U0ANN00001", title: "Ann weekly", recurrence: { rule: "weekly", days: [5], start: "2026-11-13" } })])).body.results[0].task_id;
    // Ownership moved to Kim from Nov 20: the Nov 20 occurrence is Kim's, so Ann's "done" cannot complete it; Ann
    // owned other dates, so this is an inconsistency for review rather than a stranger's reply.
    await q("insert into task_assignments (task_id, assignee_id, effective_from) values ($1, $2, '2026-11-20')", [id, kim.id]);
    const r1 = await batch([{ kind: "complete", key: k(m), reply: reply(m, "U0ANN00001"), occurrence_date: "2026-11-20" }]);
    expect(r1.body.results[0]).toMatchObject({ outcome: "review", reason: "owner_on_date_mismatch" });
    await q("update users set status = 'archived', archived_at = now() where id = $1", [ann]);
    const r2 = await batch([{ kind: "complete", key: k(m), reply: reply(m, "U0ANN00001"), occurrence_date: "2026-11-13" }]);
    expect(r2.body.results[0]).toMatchObject({ outcome: "refused", reason: "not_permitted" });
    expect(await q("select count(*)::int n from task_occurrences where task_id = $1", [id])).toEqual([{ n: 0 }]);
  });
  it("keeps the Slack request on a series continued after a schedule change, and routes replies to the series with the occurrence", async () => {
    const m = msg();
    const old = (await batch([create(m, { title: "Weekly report", recurrence: { rule: "weekly", days: [1], start: "2026-11-16" } })])).body.results[0].task_id;
    // Tia moves it from Mondays to Tuesdays from Nov 24: the running series ends and a continuation starts.
    const cur = (await task(old, tia)).task;
    const p = await call(tia, "PATCH", `/tasks/${old}`, { version: cur.version, recurrence: "weekly", recurrence_days: [2], due_date: "2026-11-24" });
    expect(p.status).toBe(200);
    const [{ id: nu }] = await q("select id from tasks where previous_series_id = $1", [old]);
    expect((await task(nu)).task.slack).toMatchObject({ permalink: m.link });
    // The reader sees the request once, pointing at the current series and listing both.
    const all: any[] = [];
    let cursor: string | null = null;
    do { const st: any = await (await slack("GET", `/state?limit=50${cursor ? `&cursor=${cursor}` : ""}`)).json(); all.push(...st.open_tasks); cursor = st.next_cursor; } while (cursor);
    const w = all.filter((x) => x.key.message_ts === m.ts);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ request_task_id: old, task_id: nu, status: "repeating" });
    expect(w[0].series.map((x: any) => x.task_id)).toEqual([old, nu]);
    // A reply for the old Monday goes to the old series; one for the new Tuesday to the continuation.
    vn("2026-11-25", "09:00");
    try {
      const r = await batch([{ kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-20T18:00:00"), occurrence_date: "2026-11-16" },
        { kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-24T17:00:00"), occurrence_date: "2026-11-24" },
        { kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-24T17:05:00"), occurrence_date: "2026-11-26" }]);
      expect(r.body.results.map((x: any) => [x.outcome, x.task_id])).toEqual([["completed", old], ["completed", nu], ["review", nu]]);
      expect(await q("select task_id, occurrence_date::text d, completed_on::text c from task_occurrences where task_id = any($1::uuid[]) order by d", [[old, nu]]))
        .toEqual([{ task_id: old, d: "2026-11-16", c: "2026-11-20" }, { task_id: nu, d: "2026-11-24", c: "2026-11-24" }]);
      // An edit of the Slack message changes the current series only.
      await batch([{ kind: "update", key: k(m), edited_ts: "1763700000.000100", title: "Weekly report (Tue)" }]);
      expect((await task(nu)).task.title).toBe("Weekly report (Tue)");
      expect((await task(old)).task.title).toBe("Weekly report");
    } finally { vn("2026-11-22", "12:00"); }
  });
  it("credits a Sunday-night reply processed on Monday to Sunday, across the midnight and week boundary", async () => {
    const m1 = msgAt("2026-11-21T09:00:00"), m2 = msgAt("2026-11-21T09:00:01"), m3 = msgAt("2026-11-21T09:00:02");
    const r = await batch([create(m1, { title: "Late Sunday", due_date: "2026-11-21" }), create(m2, { title: "Just after midnight", due_date: "2026-11-21" }),
      create(m3, { title: "Daily late", recurrence: { rule: "daily", start: "2026-11-21" } })]);
    const [late, early, daily] = r.body.results.map((x: any) => x.task_id);
    vn("2026-11-23", "08:30");                                            // Monday morning run
    try {
      const c = await batch([{ kind: "complete", key: k(m1), reply: reply(m1, TIA, CH, "2026-11-22T23:59:59") },
        { kind: "complete", key: k(m2), reply: reply(m2, TIA, CH, "2026-11-23T00:00:01") },
        { kind: "complete", key: k(m3), reply: reply(m3, TIA, CH, "2026-11-22T23:30:00"), occurrence_date: "2026-11-22" }]);
      expect(c.body.results.map((x: any) => x.completed_on)).toEqual(["2026-11-22", "2026-11-23", "2026-11-22"]);
      const prev = (await call(admin, "GET", "/tasks/week?start=2026-11-16")).body, cur = (await call(admin, "GET", "/tasks/week?start=2026-11-23")).body;
      const ids = (w: any) => w.completed.map((u: any) => u.task_id);
      expect(ids(prev)).toEqual(expect.arrayContaining([late, daily]));
      expect(ids(cur)).toContain(early);                                  // completed Monday
      expect(prev.completed.find((u: any) => u.task_id === late).completed_on).toBe("2026-11-22");
      expect(cur.completed.find((u: any) => u.task_id === early).completed_on).toBe("2026-11-23");
      expect(ids(cur)).not.toContain(late);
      const rep = (await report()).filter((i: any) => [late, early].includes(i.task_id)).map((i: any) => [i.task_id, i.completed_on]);
      expect(rep).toEqual(expect.arrayContaining([[late, "2026-11-22"], [early, "2026-11-23"]]));
      // Processing time is recorded separately.
      const [row] = await q("select replied_on::text d, processed_at from slack_replies where credited_task_id = $1", [late]);
      expect(row.d).toBe("2026-11-22");
      expect(row.processed_at).toBeTruthy();
    } finally { vn("2026-11-22", "12:00"); }
  });
  it("refuses replies dated before their request or in the future", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Time checks" })])).body.results[0].task_id;
    const before = { channel_id: CH, ts: `${ACT - 5}.000100`, permalink: linkFor(CH, `${ACT - 5}.000100`), author_slack_id: TIA };
    const future = reply(m, TIA, CH, "2026-11-30T10:00:00");
    const r = await batch([{ kind: "complete", key: k(m), reply: before }, { kind: "complete", key: k(m), reply: future }]);
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(["refused", "refused"]);
    expect((await task(id)).task.status).toBe("open");
  });
  it("never imports a request posted before activation, even when a run reads further back; replacing the credential keeps the activation time", async () => {
    const early = msgAt("2026-11-20T09:30:00");
    const before = (await q("select count(*)::int n from tasks"))[0].n;
    const r = await batch([create(early, { title: "Before activation" })], { from: `${ACT - 7200}.000000` });
    expect(r.body.results[0]).toMatchObject({ outcome: "before_activation" });
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(before);
    const st0 = await state();
    const c = await call(admin, "POST", "/integrations/slack/credential", {});
    key = c.body.secret;
    const st1 = await state();
    expect(st1.activated_ts).toBe(`${ACT}.000000`);
    expect(st1.activated_ts).toBe(st0.activated_ts);
    expect(st1.checkpoint_ts).toBe(st0.checkpoint_ts);
  });
  it("advances the checkpoint only with the run's final batch, never into the future, and caps batch size", async () => {
    vn("2026-11-26", "13:00");                                          // after every checkpoint stored so far
    const cp0 = (await state()).checkpoint_ts;
    try {
      const m = msg();
      const part = await batch([create(m, { title: "Part of a long run" })], { advance: false });
      expect(part.body.results[0].outcome).toBe("created");
      expect((await state()).checkpoint_ts).toBe(cp0);
      const fin = await batch([]);
      expect(fin.body.checkpoint_ts).toBe((await state()).now_ts);
      const st = await state();
      const ahead = `${Number(st.now_ts.split(".")[0]) + 3600}.000000`;
      const f = await slack("POST", "/batches", { batch_id: "future-cp-1", range: { from_ts: st.checkpoint_ts, to_ts: ahead }, checkpoint_ts: ahead, items: [] });
      expect(f.status).toBe(400);
      const big = Array.from({ length: 201 }, () => ({ kind: "deleted", key: k(msg()) }));
      const b = await slack("POST", "/batches", { batch_id: "too-big-1", range: { from_ts: st.checkpoint_ts, to_ts: st.now_ts }, items: big });
      expect(b.status).toBe(400);
    } finally { vn("2026-11-22", "12:00"); }
  });
  it("pages through every watched request with no gaps or repeats", async () => {
    const ms = Array.from({ length: 7 }, () => msg());
    await batch(ms.map((m, i) => create(m, { title: `Paged ${i}` })));
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const st: any = await (await slack("GET", `/state?limit=3${cursor ? `&cursor=${cursor}` : ""}`)).json();
      expect(st.open_tasks.length).toBeLessThanOrEqual(3);
      seen.push(...st.open_tasks.map((x: any) => x.request_task_id));
      cursor = st.next_cursor; pages++;
    } while (cursor);
    const [{ n }] = await q("select count(*)::int n from slack_task_links");
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(n);                                          // all are recent, so all are watched
    expect(pages).toBe(Math.ceil(n / 3));
    expect((await slack("GET", "/state?limit=0")).status).toBe(400);
    expect((await slack("GET", "/state?cursor=bad")).status).toBe(400);
  });
});

describe("review fixes 2: ownership on the credit date, occurrences never redirected", () => {
  it("credits a one-time task to whoever owned it on the reply date: the new owner's earlier reply goes to review, the previous owner's is accepted", async () => {
    const m = msgAt("2026-11-22T09:00:00");
    const id = (await batch([create(m, { title: "Handover task" })])).body.results[0].task_id;
    vn("2026-11-23", "09:00");                                            // Monday: reassigned to Kim, effective today
    try {
      const cur = (await task(id)).task;
      expect((await call(admin, "POST", `/tasks/${id}/reassign`, { assignee_id: kim.id, version: cur.version })).status).toBe(200);
      // The reader sees the ownership history, so it can recognize replies from the previous owner.
      const st = (await state()).open_tasks.find((x: any) => x.request_task_id === id);
      expect(st.series[0].owners).toEqual([{ slack_id: TIA, from: null }, { slack_id: KIM, from: "2026-11-23" }]);
      expect(st.series[0].owner_slack_id).toBe(KIM);
      // Kim's Sunday reply: Kim did not own the task on Sunday. Not credited to anyone; review.
      const r1 = await batch([{ kind: "complete", key: k(m), reply: reply(m, KIM, CH, "2026-11-22T20:00:00") }]);
      expect(r1.body.results[0]).toMatchObject({ outcome: "review", reason: "owner_on_date_mismatch" });
      expect((await task(id)).task.status).toBe("open");
      expect((await reviews()).some((x) => x.task_id === id && x.kind === "ambiguous_reply")).toBe(true);
      // Tia's Sunday reply: Tia owned it on Sunday and may still complete her own work. Credited to Tia on Sunday.
      const r2 = await batch([{ kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-22T21:00:00") }]);
      expect(r2.body.results[0]).toMatchObject({ outcome: "completed", completed_on: "2026-11-22" });
      const items = (await report()).filter((i: any) => i.task_id === id);
      expect(items).toEqual([expect.objectContaining({ status: "done", completed_on: "2026-11-22", assignee: expect.objectContaining({ id: tia.id }) })]);
    } finally { vn("2026-11-22", "12:00"); }
  });
  it("accepts the new owner's reply from the day the reassignment takes effect", async () => {
    const m = msgAt("2026-11-22T09:00:05");
    const id = (await batch([create(m, { title: "Handover task 2" })])).body.results[0].task_id;
    vn("2026-11-23", "15:00");
    try {
      const cur = (await task(id)).task;
      await call(admin, "POST", `/tasks/${id}/reassign`, { assignee_id: kim.id, version: cur.version });
      const r = await batch([{ kind: "complete", key: k(m), reply: reply(m, KIM, CH, "2026-11-23T14:00:00") }]);
      expect(r.body.results[0]).toMatchObject({ outcome: "completed", completed_on: "2026-11-23" });
      const items = (await report()).filter((i: any) => i.task_id === id);
      expect(items[0].assignee.id).toBe(kim.id);
    } finally { vn("2026-11-22", "12:00"); }
  });
  it("never completes a one-time continuation for an occurrence date the routine did not have", async () => {
    const m = msg();
    const old = (await batch([create(m, { title: "Routine to one-time", recurrence: { rule: "weekly", days: [1], start: "2026-11-16" } })])).body.results[0].task_id;
    // Tia turns the running weekly routine into a one-time task due Nov 25: the routine ends and a one-time task continues it.
    const cur = (await task(old, tia)).task;
    expect((await call(tia, "PATCH", `/tasks/${old}`, { version: cur.version, recurrence: null, due_date: "2026-11-25" })).status).toBe(200);
    const [nu] = await q("select id, recurrence, operational_date::text od from tasks where previous_series_id = $1", [old]);
    expect(nu.recurrence).toBeNull();
    // An occurrence date outside the routine's schedule (a Wednesday) goes to review; nothing is completed.
    const r1 = await batch([{ kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-22T10:00:00"), occurrence_date: "2026-11-18" }]);
    expect(r1.body.results[0]).toMatchObject({ outcome: "review", reason: "occurrence_unclear" });
    // A reply with no occurrence written before the one-time task existed is also unclear.
    const r2 = await batch([{ kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-20T18:00:00") }]);
    expect(r2.body.results[0]).toMatchObject({ outcome: "review", reason: "occurrence_unclear" });
    expect((await task(nu.id)).task.status).toBe("open");
    expect(await q("select count(*)::int n from task_occurrences where task_id = $1", [old])).toEqual([{ n: 0 }]);
    // A valid Monday of the routine completes that occurrence; a later plain "done" completes the one-time task.
    const r3 = await batch([{ kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-22T10:30:00"), occurrence_date: "2026-11-16" },
      { kind: "complete", key: k(m), reply: reply(m, TIA, CH, "2026-11-22T11:00:00") }]);
    expect(r3.body.results.map((x: any) => [x.outcome, x.task_id])).toEqual([["completed", old], ["completed", nu.id]]);
  });
});

describe("one Slack request, one task, across the intake and the Marketing Dashboard", () => {
  let planKey = "";
  const PLAN_ID = "11111111-2222-4333-8444-555555555555";
  const plan = (method: string, path: string, body?: unknown) =>
    app(new Request(`${ORIGIN}/api/planning/v1${path}`, { method, headers: { "x-tracker-planning-key": planKey, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }))
      .then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  let n = 0;
  const nextKey = () => `mkp:00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const deliver = (sources: unknown[], over: Record<string, unknown> = {}) => plan("POST", "/tasks", {
    idempotency_key: nextKey(), plan_id: PLAN_ID, brand_id: A, assignee_id: tia.id,
    title: "Dashboard copy of the request", due_date: "2026-11-27", sent_at: new Date().toISOString(), origin: "review", slack_sources: sources, ...over });
  const linkWaiting = (sources: unknown[], over: Record<string, unknown> = {}) => plan("POST", "/slack-links", { idempotency_key: nextKey(), plan_id: PLAN_ID, origin: "review", slack_sources: sources, ...over });
  const src = (m: { ts: string }, action?: string) => ({ channel_id: CH, message_ts: m.ts, ...(action ? { action_id: action } : {}) });
  const tasksFor = async (m: { ts: string }) => (await q("select count(distinct task_id)::int n from slack_request_claims where message_ts = $1", [m.ts]))[0].n;
  const allTasks = async () => (await q("select count(*)::int n from tasks"))[0].n;
  beforeAll(async () => { planKey = (await call(admin, "POST", "/integrations/planning/credential", { allowed_business_ids: ["sb"] })).body.secret; });

  it("links the intake to a task the dashboard already delivered for the same request; replies complete it and the dashboard sees it", async () => {
    const m = msg();
    const d = await deliver([src(m, "a1")]);
    expect(d.status).toBe(201);
    const r = await batch([create(m, { title: "Intake copy" }, CH, "a1")]);
    expect(r.body.results[0]).toMatchObject({ outcome: "linked_existing", task_id: d.body.task.task_id });
    expect(await tasksFor(m)).toBe(1);
    expect((await task(d.body.task.task_id)).task).toMatchObject({ title: "Dashboard copy of the request", slack: { permalink: m.link, due_inferred: false } });
    await batch([{ kind: "complete", key: k(m, "a1"), reply: reply(m) }]);
    const seen = await plan("GET", `/tasks?keys=${d.body.task.idempotency_key}`);
    expect(seen.body.items[0]).toMatchObject({ task_id: d.body.task.task_id, status: "done" });
  });
  it("links a dashboard delivery to the task the intake already created; a repeat returns the same task", async () => {
    const m = msg();
    const id = (await batch([create(m, { title: "Intake first" }, CH, "a1")])).body.results[0].task_id;
    const d = await deliver([src(m, "a1")]);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ created: false, linked: true, task: { task_id: id, title: "Intake first" } });
    const again = await plan("POST", "/tasks", { idempotency_key: d.body.task.idempotency_key, plan_id: PLAN_ID, brand_id: A, assignee_id: tia.id, title: "x", due_date: "2026-11-27", sent_at: new Date().toISOString(), slack_sources: [src(m, "a1")] });
    expect(again.body.task.task_id).toBe(id);
    expect(await tasksFor(m)).toBe(1);
  });
  it("links each request of a multi-request message by its own number; a source without a number stays for review", async () => {
    const m = msg();
    const r = await batch([create(m, { title: "Write blog post" }, CH, "a1"), create(m, { title: "Send newsletter" }, CH, "a2")]);
    const [blog, newsletter] = r.body.results.map((x: any) => x.task_id);
    // A Corporate Gifts draft for "Send newsletter" carries a2: it links to the newsletter task, never the blog post.
    const l = await linkWaiting([src(m, "a2")], { source_workflow: "corporate" });
    expect(l.body).toMatchObject({ linked: true, task: { task_id: newsletter } });
    // Without a request number the draft is ambiguous: not linked, and sending it creates nothing.
    const l2 = await linkWaiting([src(m)], { source_workflow: "corporate" });
    expect(l2.body).toMatchObject({ linked: false, reason: "ambiguous" });
    const before = await allTasks();
    const d = await deliver([src(m)], { source_workflow: "corporate", title: "Send newsletter (draft)" });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe("needs_review");
    expect(await allTasks()).toBe(before);
    // The blog post task is untouched by either draft.
    expect((await q("select count(*)::int n from task_plan_links where task_id = $1", [blog]))[0].n).toBe(0);
    // A second dashboard item for the newsletter request is refused (already linked), and a message with no tasks is not found.
    expect((await linkWaiting([src(m, "a2")])).body).toMatchObject({ linked: false, reason: "not_linkable" });
    const dup = await deliver([src(m, "a2")]);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("already_in_tracker");
    expect((await linkWaiting([src(msg(), "a1")])).body).toMatchObject({ linked: false, reason: "not_found" });
  });
  it("sends the intake's request to review when the dashboard holds an unnumbered request of the same message", async () => {
    const m = msg();
    const d = await deliver([src(m)], { source_workflow: "corporate", title: "Corporate copy (no number)" });
    expect(d.status).toBe(201);
    const before = await allTasks();
    const r = await batch([create(m, {}, CH, "a1")]);
    expect(r.body.results[0]).toMatchObject({ outcome: "review", reason: "possible_duplicate" });
    expect(await allTasks()).toBe(before);
    expect((await reviews()).some((x) => x.kind === "possible_duplicate" && x.permalink === m.link)).toBe(true);
    // A different number on a message the dashboard holds by number is a different request: created.
    const m3 = msg();
    await deliver([src(m3, "a1")]);
    expect((await batch([create(m3, { title: "Other request" }, CH, "a2")])).body.results[0].outcome).toBe("created");
  });
  it("creates one task when the intake and the dashboard deliver the same request at the same moment (either order)", async () => {
    const { _setIntakeHooksForTests } = await import("../server/slackIntake");
    const { _setPlanningSourceHooksForTests } = await import("../server/planning");
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      // The intake is mid-delivery (looked up, not yet committed) when the dashboard sends the same request.
      const m1 = msg();
      let dash: Promise<any> | null = null;
      _setIntakeHooksForTests({ afterLookup: async () => { dash = deliver([src(m1, "a1")]); await pause(300); } });
      const r1 = await batch([create(m1, { title: "Race 1" }, CH, "a1")]);
      _setIntakeHooksForTests(null);
      const d1 = await dash!;
      expect(r1.body.results[0].outcome).toBe("created");
      expect(d1.body).toMatchObject({ linked: true, task: { task_id: r1.body.results[0].task_id } });
      expect(await tasksFor(m1)).toBe(1);
      // The dashboard is mid-delivery when the intake reads the same request.
      const m2 = msg();
      let intake: Promise<any> | null = null;
      _setPlanningSourceHooksForTests({ afterSourceLookup: async () => { intake = batch([create(m2, { title: "Race 2" }, CH, "a1")]); await pause(300); } });
      const d2 = await deliver([src(m2, "a1")]);
      _setPlanningSourceHooksForTests(null);
      const r2 = await intake!;
      expect(d2.status).toBe(201);
      expect(r2.body.results[0]).toMatchObject({ outcome: "linked_existing", task_id: d2.body.task.task_id });
      expect(await tasksFor(m2)).toBe(1);
    } finally { _setIntakeHooksForTests(null); _setPlanningSourceHooksForTests(null); }
  });
  it("keeps a request the reader is unsure about in review: no task, the proposed task and the doubt for an administrator", async () => {
    const m = msg();
    const before = await allTasks();
    const r = await batch([{ kind: "review", key: k(m, "a1"), permalink: m.link, title: "Unclear who", note: "Check: the thread also asks Kim; confirm who should do it." }]);
    expect(r.body.results[0]).toMatchObject({ outcome: "review", reason: "needs_check" });
    expect(await allTasks()).toBe(before);
    const item = (await reviews()).find((x) => x.kind === "needs_check" && x.permalink === m.link);
    expect(item.note).toContain("Proposed task: Unclear who");
    // Seen again in an overlapping run: still one review item.
    await batch([{ kind: "review", key: k(m, "a1"), permalink: m.link, title: "Unclear who", note: "Check: the thread also asks Kim; confirm who should do it." }]);
    expect((await reviews()).filter((x) => x.kind === "needs_check" && x.permalink === m.link)).toHaveLength(1);
  });
  it("flags a link whose task is assigned to someone other than the tagged person", async () => {
    const m = msg();
    const d = await deliver([src(m, "a1")], { assignee_id: kim.id });
    const r = await batch([create(m, {}, CH, "a1")]);
    expect(r.body.results[0]).toMatchObject({ outcome: "linked_existing", task_id: d.body.task.task_id });
    expect((await reviews()).some((x) => x.kind === "possible_duplicate" && x.task_id === d.body.task.task_id)).toBe(true);
  });
});
