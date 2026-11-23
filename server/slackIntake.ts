// Slack task intake (scheduled Slack reader -> Task Tracker). Server-to-server only.
//
//   GET   /api/slack-intake/v1/state        checkpoint, linked people, brands, channel brands, open Slack-linked tasks
//   POST  /api/slack-intake/v1/batches      apply one batch of judged items and advance the checkpoint (idempotent)
//   Header: x-tracker-slack-key: <dedicated intake secret>
//
// The reader (a scheduled Claude run using the team's existing Slack connection) judges Slack text: which messages
// tagging a linked staff member are actionable requests, their titles, deadlines and brands, and which of that
// person's thread replies clearly confirm the work is finished. This endpoint never trusts the reader for
// permissions or business rules:
// - Its own random credential (stored hashed, compared in constant time). Human sessions are never accepted here and
//   this credential reaches nothing else. Tasks are created on behalf of the credential's acting administrator,
//   through the task editor's own rules (prepareCreate): active staff assignee, open brand, valid dates.
// - Assignees and reply authors are Slack member ids, resolved through the administrator-managed slack_user_links.
//   A completion is applied only when the reply's author is the person who owns the task (or that occurrence).
// - Completions are recorded as automation (completed_by is empty, history says "Slack automation" with the reply
//   link) and are credited to the owner by the normal ownership rules, so they count once everywhere.
// - Idempotency: one task per (channel, message ts, action id); each reply is judged once per task; a batch id
//   applied once. A manual reopen in the tracker is never undone by reprocessing the same reply.
// - Message edits change only the fields nobody changed in the tracker since the last sync (Slack's values are kept
//   in slack_task_links.synced_*); anything else becomes a review item. A deleted message flags its task for review.
// - No deadline in the request: the next working day (Mon–Fri, Vietnam time) after the message, marked as inferred.
//   Staff change deadlines on their own tasks in the tracker; that is a manual edit and later syncs keep it.
// - Task completion never changes KPI quantities.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { one, query, tx } from "./db";
import { HttpError, json, readJson, badRequest } from "./http";
import { hit, clientKey, RATE } from "./rateLimit";
import { parse, isoDate, line, text, rule, weekdays } from "./validate";
import { history } from "./tasks";
import { prepareCreate, insertTask, weeklyDays } from "./routes/tasks";
import { loadAssignments, ownerOn } from "./ownership";
import { occurrenceCompletion } from "./tasks";
import { lockMessages, claimedTask, claim } from "./slackSources";
import { todayVN, addDays, isoWeekday, vietnamDate, now } from "../shared/dates";
import { isSeriesOccurrence, normaliseDays } from "../shared/recurrence";
import type { Session } from "./auth";

export const SLACK_HEADER = "x-tracker-slack-key";
// Test hook: a pause after the claim lookup of a create, to prove the message lock serializes concurrent deliveries.
let hooks: { afterLookup?: (k: { channel_id: string; message_ts: string; action_id: string }) => Promise<void> } = {};
export function _setIntakeHooksForTests(h: typeof hooks | null) { hooks = h ?? {}; }
export const MAX_ITEMS = 200;
const hashKey = (k: string) => createHash("sha256").update(k).digest();

const TS = /^\d{10}\.\d{6}$/;
const ts = z.string().regex(TS, "must be a Slack timestamp");
const channelId = z.string().regex(/^[CGD][A-Z0-9]{6,15}$/, "must be a Slack channel id");
const slackUser = z.string().regex(/^[UW][A-Z0-9]{6,15}$/, "must be a Slack member id");
export const PERMALINK_RE = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p[0-9]{16}([?][A-Za-z0-9_.=&-]*)?$/;
const permalink = z.string().max(300).regex(PERMALINK_RE, "must be a Slack message link");
const key = z.object({ channel_id: channelId, message_ts: ts, action_id: z.string().regex(/^a[0-9]{1,2}$/) }).strict();
const reply = z.object({ channel_id: channelId, ts, permalink, author_slack_id: slackUser }).strict();

const createItem = z.object({
  kind: z.literal("create"), key, thread_ts: ts.nullable().optional(), permalink, posted_at: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be a time").optional(),
  assignee_slack_id: slackUser, title: line(300), description: text(2000).nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  due_date: isoDate.nullable().optional(), deadline_text: line(200).nullable().optional(),
  recurrence: z.object({ rule, days: weekdays.nullable().optional(), start: isoDate, until: isoDate.nullable().optional() }).strict().nullable().optional(),
  edited_ts: ts.nullable().optional(),
}).strict();
// A request the reader is unsure about (who is asked, conflicting instructions): no task; an administrator review
// item carries the proposed task and the doubt.
const reviewItem = z.object({ kind: z.literal("review"), key, permalink, title: line(300), description: text(2000).nullable().optional(), note: text(500) }).strict();
const updateItem = z.object({
  kind: z.literal("update"), key, edited_ts: ts, title: line(300), description: text(2000).nullable().optional(), due_date: isoDate.nullable().optional(),
}).strict();
const deletedItem = z.object({ kind: z.literal("deleted"), key }).strict();
const completeItem = z.object({ kind: z.literal("complete"), key, reply, occurrence_date: isoDate.nullable().optional() }).strict();
const notedItem = z.object({ kind: z.literal("noted"), key, reply, outcome: z.enum(["progress", "review"]), note: text(1000).nullable().optional(), occurrence_date: isoDate.nullable().optional() }).strict();
const item = z.discriminatedUnion("kind", [createItem, updateItem, deletedItem, completeItem, notedItem, reviewItem]);
const batchSchema = z.object({
  batch_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,80}$/),
  range: z.object({ from_ts: ts, to_ts: ts }).strict(),
  // Only the run's last batch, sent after every earlier batch of the run succeeded, advances the checkpoint.
  checkpoint_ts: ts.nullable().optional(),
  items: z.array(item).max(MAX_ITEMS),
}).strict();
type Item = z.infer<typeof item>;

type Cred = { id: string; acting_user_id: string };
async function authenticate(req: Request): Promise<{ cred: Cred; actor: Session }> {
  const presented = req.headers.get(SLACK_HEADER) ?? "";
  const cred = await one<Cred & { key_hash: Buffer }>("select id, key_hash, acting_user_id from slack_intake_credentials where revoked_at is null");
  if (!cred) throw new HttpError(503, "slack_intake_disabled", "Slack task intake is not configured.");
  const ok = presented.length >= 32 && presented.length <= 200 && timingSafeEqual(hashKey(presented), Buffer.from(cred.key_hash));
  if (!ok) {
    await hit({ bucket: `slack-fail:${clientKey(req)}`, ...RATE.reportingAuthFail });
    throw new HttpError(401, "unauthorized", "Invalid Slack intake credential.");
  }
  const u = await one<any>("select id, email, display_name, role, status from users where id = $1", [cred.acting_user_id]);
  if (!u || u.status === "archived" || u.role !== "administrator")
    throw new HttpError(503, "slack_intake_disabled", "The Slack intake credential's acting administrator is no longer an active administrator.");
  if (Math.random() < 0.2) await query("update slack_intake_credentials set last_used_at = now() where id = $1", [cred.id]);
  const actor: Session = { sessionId: "slack-intake", userId: u.id, email: u.email, displayName: u.display_name, role: "administrator", brandIds: new Set(), allBrands: true };
  return { cred, actor };
}

/** The next working day (Monday–Friday) after the Vietnam date of an instant. */
export function nextWorkingDay(at: number): string {
  let d = addDays(vietnamDate(at), 1);
  while (isoWeekday(d) > 5) d = addDays(d, 1);
  return d;
}
const tsCompare = (a: string, b: string) => (a === b ? 0 : (a.length === b.length ? (a < b ? -1 : 1) : Number(a) < Number(b) ? -1 : 1));

async function review(c: pg.PoolClient, dedupe: string, kind: string, taskId: string | null, link: string | null, note: string | null) {
  await c.query(`insert into slack_review_items (dedupe_key, kind, task_id, permalink, note) values ($1,$2,$3,$4,$5) on conflict (dedupe_key) do nothing`,
    [dedupe.slice(0, 200), kind, taskId, link, note ? note.slice(0, 1000) : null]);
}
const keyText = (k: { channel_id: string; message_ts: string; action_id: string }) => `${k.channel_id}:${k.message_ts}:${k.action_id}`;

async function personFor(c: pg.PoolClient, slackId: string) {
  return (await c.query(
    "select u.id, u.email, u.display_name, u.role, u.status from slack_user_links l join users u on u.id = l.user_id where l.slack_user_id = $1", [slackId])).rows[0] ?? null;
}

/** The session the person would have if they acted in the tracker now: current role, status and brand access. */
async function sessionFor(c: pg.PoolClient, u: { id: string; email: string; display_name: string; role: string; status: string }): Promise<Session | null> {
  if (u.status !== "active") return null;
  const allBrands = u.role === "administrator" || u.role === "management";
  const brandIds = new Set<string>(allBrands ? [] : (await c.query("select brand_id from user_brand_access where user_id = $1", [u.id])).rows.map((r: any) => r.brand_id));
  return { sessionId: "slack-reply", userId: u.id, email: u.email, displayName: u.display_name, role: u.role as Session["role"], brandIds, allBrands };
}

/** The Slack request a key names (its link row), or null. */
async function linkFor(c: pg.PoolClient, k: { channel_id: string; message_ts: string; action_id: string }) {
  return (await c.query(`select l.*, l.synced_due::text synced_due_t from slack_task_links l where l.channel_id = $1 and l.message_ts = $2 and l.action_id = $3`,
    [k.channel_id, k.message_ts, k.action_id])).rows[0] ?? null;
}

type Member = { id: string; title: string; note: string | null; due_date: string | null; recurrence: any; recurrence_days: number[] | null; recurrence_until: string | null;
  completed_on: string | null; assignee_id: string; brand_id: string | null; version: number; operational_date: string };
/** The live tasks that carry a Slack request, oldest first: the task created from it, then each continuation. */
async function seriesOf(c: pg.PoolClient, linkTaskId: string): Promise<Member[]> {
  return (await c.query(
    `select t.id, t.title, t.note, t.due_date::text due_date, t.recurrence, t.recurrence_days, t.recurrence_until::text recurrence_until,
            t.completed_on::text completed_on, t.assignee_id, t.brand_id, t.version, t.operational_date::text operational_date
       from slack_task_series s join tasks t on t.id = s.task_id
      where s.link_task_id = $1 and t.deleted_at is null order by t.created_at, t.id for update of t`, [linkTaskId])).rows;
}
const tsDate = (t: string) => vietnamDate(Number(t.split(".")[0]) * 1000);
const tsNow = () => `${Math.floor(now() / 1000)}.000000`;
const tsPlus = (t: string, seconds: number) => `${Number(t.split(".")[0]) + seconds}.${t.split(".")[1]}`;

async function applyCreate(c: pg.PoolClient, actor: Session, it: z.infer<typeof createItem>, activated: string) {
  // Monitoring starts at activation: an earlier message never becomes a task, however far back a run reads.
  if (tsCompare(it.key.message_ts, activated) < 0) return { outcome: "before_activation" };
  const existing = await linkFor(c, it.key);
  if (existing) return { outcome: "duplicate", task_id: existing.task_id };
  const person = await personFor(c, it.assignee_slack_id);
  if (!person || person.status === "archived" || person.role !== "staff") {
    await review(c, `refused:${keyText(it.key)}`, "refused", null, it.permalink, "The tagged Slack member is not linked to an active staff member in Task Tracker; no task was created.");
    return { outcome: "refused", reason: "assignee_not_linked" };
  }
  // One Slack request, one task: under the message's lock (shared with the Marketing Dashboard's deliveries), link to
  // a task another workflow already created for this request; anything ambiguous goes to review.
  const src = { channel_id: it.key.channel_id, message_ts: it.key.message_ts, action_id: it.key.action_id };
  await lockMessages(c, [src]);
  const held = await claimedTask(c, [src]);
  await hooks.afterLookup?.(it.key);
  const linkedElsewhere = held.kind === "task" && (await c.query("select 1 from slack_task_series where task_id = $1", [held.task_id])).rowCount;
  if (held.kind === "ambiguous" || linkedElsewhere) {
    await review(c, `dup:${keyText(it.key)}`, "possible_duplicate", held.kind === "task" ? held.task_id : null, it.permalink,
      "This Slack request may already be in Task Tracker (the message has tasks and it is not clear which request is which); no task was created. Check and link or create by hand.");
    return { outcome: "review", reason: "possible_duplicate" };
  }
  if (held.kind === "task") return linkExisting(c, it, held.task_id, person.id);
  // Brand: the one named in the message (an active brand), else the channel's configured brand, else Unassigned.
  let brandId: string | null = null;
  if (it.brand_id) {
    const b = (await c.query("select id from brands where id = $1 and status = 'active'", [it.brand_id])).rows[0];
    if (b) brandId = b.id;
  }
  if (!brandId) brandId = (await c.query("select b.id from slack_channel_brands m join brands b on b.id = m.brand_id where m.channel_id = $1 and b.status = 'active'", [it.key.channel_id])).rows[0]?.id ?? null;
  // A staff member without access to the brand cannot hold it: keep the task, under Unassigned brand, for review.
  if (brandId && !(await c.query("select 1 from user_brand_access where user_id = $1 and brand_id = $2", [person.id, brandId])).rowCount) brandId = null;

  const rec = it.recurrence ?? null;
  const inferred = !rec && !it.due_date;
  // Dates follow the message: its Vietnam date is the day the request was made, whenever the run processes it.
  const postedOn = tsDate(it.key.message_ts);
  const due = rec ? rec.start : it.due_date ?? nextWorkingDay(Number(it.key.message_ts.split(".")[0]) * 1000);
  const fields: any = {
    brand_id: brandId, assignee_id: person.id, type: rec ? "routine" : "adhoc", title: it.title, note: it.description ?? null, kpi_id: null,
    due_date: due, recurrence: rec?.rule ?? null, recurrence_days: rec ? weeklyDays(rec.rule, rec.days ?? null, rec.start) : null, recurrence_until: rec?.until ?? null,
  };
  if (rec?.until && rec.until < addDays(rec.start, -1)) throw new HttpError(422, "invalid_dates", "The end date is before the start date.");
  const assignee = await prepareCreate(c, actor, fields);
  const id = await insertTask(c, actor, it.title, assignee, fields);
  await c.query("update tasks set operational_date = least(operational_date, $2::date) where id = $1", [id, postedOn]);
  await c.query(
    `insert into slack_task_links (task_id, channel_id, message_ts, action_id, thread_ts, permalink, synced_title, synced_note, synced_due, due_inferred, edited_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, it.key.channel_id, it.key.message_ts, it.key.action_id, it.thread_ts ?? null, it.permalink, it.title, it.description ?? null, due, inferred, it.edited_ts ?? null]);
  await c.query("insert into slack_task_series (task_id, link_task_id) values ($1, $1)", [id]);
  await claim(c, id, "intake", [src]);
  // One creation entry, recorded as automation (the editor's own "created" entry becomes it).
  await c.query(`update task_history set actor_id = null, action = 'created_from_slack', changes = changes || $2::jsonb where task_id = $1 and action = 'created'`,
    [id, JSON.stringify({ via: "slack", permalink: it.permalink, due_inferred: inferred, ...(it.deadline_text ? { deadline_text: it.deadline_text } : {}) })]);
  if (!brandId) await review(c, `brand:${id}`, "brand_unclear", id, it.permalink, "No brand in the message or channel mapping (or the assignee has no access to it). Choose the brand.");
  return { outcome: "created", task_id: id, due_date: due, due_inferred: inferred, brand_id: brandId };
}

/** Attaches a Slack request to a task another workflow already created for it (replies then complete it as usual). */
async function linkExisting(c: pg.PoolClient, it: z.infer<typeof createItem>, taskId: string, personId: string) {
  const t = (await c.query("select id, title, note, due_date::text due_date, assignee_id from tasks where id = $1 for update", [taskId])).rows[0];
  await c.query(
    `insert into slack_task_links (task_id, channel_id, message_ts, action_id, thread_ts, permalink, synced_title, synced_note, synced_due, due_inferred, edited_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)`,
    [t.id, it.key.channel_id, it.key.message_ts, it.key.action_id, it.thread_ts ?? null, it.permalink, t.title, t.note ?? null, t.due_date, it.edited_ts ?? null]);
  await c.query("insert into slack_task_series (task_id, link_task_id) values ($1, $1) on conflict do nothing", [t.id]);
  await history(c, t.id, null, "linked_to_slack", { via: "slack", permalink: it.permalink });
  if (t.assignee_id !== personId) await review(c, `assignee:${t.id}`, "possible_duplicate", t.id, it.permalink,
    "This Slack request was linked to an existing task that is assigned to someone other than the person tagged in Slack. Check who should hold it.");
  return { outcome: "linked_existing", task_id: t.id };
}

async function applyUpdate(c: pg.PoolClient, it: z.infer<typeof updateItem>) {
  const l = await linkFor(c, it.key);
  if (!l) return { outcome: "unknown_task" };
  if (l.edited_ts && tsCompare(it.edited_ts, l.edited_ts) <= 0) return { outcome: "unchanged", task_id: l.task_id };
  // An edit applies to the current series (the latest continuation), never to ended ones.
  const t = (await seriesOf(c, l.task_id)).at(-1);
  if (!t) return { outcome: "unchanged", task_id: l.task_id };
  const wanted: Record<string, { cur: unknown; synced: unknown; next: unknown; col: string }> = {
    title: { cur: t.title, synced: l.synced_title, next: it.title, col: "title" },
    note: { cur: t.note ?? null, synced: l.synced_note ?? null, next: it.description ?? null, col: "note" },
  };
  // A one-time task's deadline follows an edit only when Slack now states one and nobody changed it in the tracker.
  if (!t.recurrence && it.due_date) wanted.due_date = { cur: t.due_date, synced: l.synced_due_t, next: it.due_date, col: "due_date" };
  const apply: Record<string, unknown> = {}, conflicts: string[] = [], changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [f, v] of Object.entries(wanted)) {
    if (v.next === v.synced) continue;                                    // Slack did not change this field
    if (v.cur === v.synced) { apply[v.col] = v.next; changes[f] = { from: v.cur, to: v.next }; }
    else if (v.cur !== v.next) conflicts.push(f);                         // changed in both places
  }
  const sets: string[] = [], params: unknown[] = [t.id];
  for (const [col, val] of Object.entries(apply)) { params.push(val); sets.push(`${col} = $${params.length}`); }
  if (sets.length) {
    await c.query(`update tasks set ${sets.join(", ")}, updated_at = now(), version = version + 1 where id = $1`, params);
    await history(c, t.id, null, "updated_from_slack", { via: "slack", permalink: l.permalink, ...changes });
  }
  // Slack's values become the new baseline; a deadline Slack now states is no longer an inferred one.
  await c.query(
    `update slack_task_links set synced_title = $2, synced_note = $3, synced_due = coalesce($4::date, synced_due), edited_ts = $5,
            due_inferred = case when $4::date is not null then false else due_inferred end
      where task_id = $1`,
    [l.task_id, it.title, it.description ?? null, !t.recurrence && it.due_date ? it.due_date : null, it.edited_ts]);
  if (conflicts.length) await review(c, `edit:${l.task_id}:${it.edited_ts}`, "edit_conflict", t.id, l.permalink,
    `The Slack message was edited, but these fields were also changed in Task Tracker and were kept: ${conflicts.join(", ")}.`);
  return { outcome: sets.length ? "updated" : conflicts.length ? "conflict" : "unchanged", task_id: t.id, ...(conflicts.length ? { conflicts } : {}) };
}

async function applyDeleted(c: pg.PoolClient, it: z.infer<typeof deletedItem>) {
  const l = await linkFor(c, it.key);
  if (!l) return { outcome: "unknown_task" };
  const current = (await seriesOf(c, l.task_id)).at(-1)?.id ?? l.task_id;
  if (!l.source_deleted_at) {
    await c.query("update slack_task_links set source_deleted_at = now() where task_id = $1", [l.task_id]);
    await review(c, `deleted:${l.task_id}`, "source_deleted", current, l.permalink, "The Slack message this task came from was deleted. Check whether the task is still needed.");
  }
  return { outcome: "flagged", task_id: current };
}

type Reply = z.infer<typeof reply>;
async function recordReply(c: pg.PoolClient, r: Reply, linkTaskId: string, outcome: string, occ: string | null, credited: string | null = null) {
  await c.query(`insert into slack_replies (channel_id, reply_ts, task_id, credited_task_id, occurrence_date, replied_on, outcome, permalink) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [r.channel_id, r.ts, linkTaskId, credited, occ, tsDate(r.ts), outcome, r.permalink]);
}
async function replySeen(c: pg.PoolClient, r: Reply, linkTaskId: string) {
  return (await c.query("select outcome from slack_replies where channel_id = $1 and reply_ts = $2 and task_id = $3", [r.channel_id, r.ts, linkTaskId])).rows[0]?.outcome ?? null;
}
/** A reply must come after the request and not from the future. */
function replyTimeProblem(r: Reply, k: { message_ts: string }) {
  if (tsCompare(r.ts, k.message_ts) <= 0) return "reply_before_request";
  if (tsCompare(r.ts, tsPlus(tsNow(), 300)) > 0) return "reply_in_future";
  return null;
}

async function applyComplete(c: pg.PoolClient, it: z.infer<typeof completeItem>) {
  const l = await linkFor(c, it.key);
  if (!l) return { outcome: "unknown_task" };
  const seen = await replySeen(c, it.reply, l.task_id);
  if (seen) return { outcome: "already_processed", task_id: l.task_id, previous: seen };
  const bad = replyTimeProblem(it.reply, it.key);
  if (bad) throw badRequest(`${bad}: the reply's timestamp must be after the request and not in the future.`);
  const members = await seriesOf(c, l.task_id);
  if (!members.length) { await recordReply(c, it.reply, l.task_id, "refused", null); return { outcome: "refused", reason: "task_deleted", task_id: l.task_id }; }
  // The work is credited to the day the reply was written (Vietnam time), not the day this run processes it.
  const repliedOn = tsDate(it.reply.ts);
  const occAsked = it.occurrence_date ?? null;
  // Route to the series that has the occurrence (a schedule change continues a series as a new task), else to the
  // current one-time task. Anything else is unclear.
  // Route to the series that has the occurrence (a schedule change continues a series as a new task). A reply that
  // names an occurrence no series has is never redirected elsewhere; one that names none completes the current
  // one-time task (a one-time continuation only if the reply was written after it was created). Anything else goes
  // to review.
  const latest = members[members.length - 1];
  const target: Member | undefined = occAsked
    ? members.find((m) => m.recurrence && isSeriesOccurrence(m, occAsked))
    : !latest.recurrence && (members.length === 1 || repliedOn >= latest.operational_date) ? latest : undefined;
  if (!target) {
    await recordReply(c, it.reply, l.task_id, "review", occAsked);
    await review(c, `reply:${it.reply.channel_id}:${it.reply.ts}:${l.task_id}`, "ambiguous_reply", latest.id, it.reply.permalink,
      occAsked ? "A completion reply named a date that is not an occurrence of this request's tasks; nothing was completed."
        : "A completion reply did not identify which occurrence or task it finished; nothing was completed.");
    return { outcome: "review", reason: "occurrence_unclear", task_id: latest.id };
  }
  const occ = target.recurrence ? occAsked : null;
  // Ownership is checked on the date the work belongs to: the occurrence date for a repeating task, the reply date
  // (which becomes the completion date) for a one-time task. That person is the one credited, so the reply must be
  // theirs. A reply from someone who owns the task on another date is inconsistent and goes to review.
  const author = await personFor(c, it.reply.author_slack_id);
  const asg = (await loadAssignments([target.id], c)).get(target.id) ?? [];
  const creditDate = occ ?? repliedOn;
  const owner = ownerOn(asg, creditDate, target.assignee_id);
  if (!author || author.id !== owner) {
    const ownsAnotherDate = !!author && (target.assignee_id === author.id || asg.some((a) => a.assignee_id === author.id));
    await recordReply(c, it.reply, l.task_id, ownsAnotherDate ? "review" : "refused", occ);
    if (ownsAnotherDate) {
      await review(c, `owner:${it.reply.channel_id}:${it.reply.ts}:${l.task_id}`, "ambiguous_reply", target.id, it.reply.permalink,
        `A completion reply came from someone who did not own this task on ${creditDate}; nothing was completed. Check who did the work.`);
      return { outcome: "review", reason: "owner_on_date_mismatch", task_id: target.id };
    }
    return { outcome: "refused", reason: "author_not_owner", task_id: target.id };
  }
  // And Task Tracker must still let that person complete their own work now: active, Staff, access to the brand.
  const sess = await sessionFor(c, author);
  let blocked: string | null = null;
  if (!sess) blocked = "not_permitted";
  else {
    const rule = occurrenceCompletion(sess, target, owner, creditDate, repliedOn);
    if (!rule.can_complete) blocked = rule.completion_blocked === "too_far_ahead" ? "too_far_ahead" : "not_permitted";
  }
  if (blocked) {
    await recordReply(c, it.reply, l.task_id, "refused", occ);
    await review(c, `refused:${it.reply.channel_id}:${it.reply.ts}:${l.task_id}`, "refused", target.id, it.reply.permalink,
      blocked === "too_far_ahead" ? "A completion reply named an occurrence more than a month ahead; nothing was completed."
        : "A completion reply was not applied: Task Tracker does not allow this person to complete the task now (role, status or brand access).");
    return { outcome: "refused", reason: blocked, task_id: target.id };
  }
  if (target.recurrence) {
    const ins = await c.query(`insert into task_occurrences (task_id, occurrence_date, completed_on, completed_at, completed_by) values ($1,$2,$3, now(), null)
                               on conflict (task_id, occurrence_date) do nothing`, [target.id, occ, repliedOn]);
    await recordReply(c, it.reply, l.task_id, ins.rowCount ? "completed" : "already_done", occ, target.id);
    if (ins.rowCount) await history(c, target.id, null, "occurrence_completed_from_slack", { via: "slack", occurrence_date: occ, replied_on: repliedOn, reply: it.reply.permalink });
    return { outcome: ins.rowCount ? "completed" : "already_done", task_id: target.id, occurrence_date: occ, completed_on: repliedOn };
  }
  if (target.completed_on) { await recordReply(c, it.reply, l.task_id, "already_done", null, target.id); return { outcome: "already_done", task_id: target.id }; }
  await c.query("update tasks set completed_on = $2, completed_at = now(), completed_by = null, updated_at = now(), version = version + 1 where id = $1", [target.id, repliedOn]);
  await recordReply(c, it.reply, l.task_id, "completed", null, target.id);
  await history(c, target.id, null, "completed_from_slack", { via: "slack", replied_on: repliedOn, reply: it.reply.permalink });
  return { outcome: "completed", task_id: target.id, completed_on: repliedOn };
}

async function applyNoted(c: pg.PoolClient, it: z.infer<typeof notedItem>) {
  const l = await linkFor(c, it.key);
  if (!l) return { outcome: "unknown_task" };
  if (await replySeen(c, it.reply, l.task_id)) return { outcome: "already_processed", task_id: l.task_id };
  const bad = replyTimeProblem(it.reply, it.key);
  if (bad) throw badRequest(`${bad}: the reply's timestamp must be after the request and not in the future.`);
  const current = (await seriesOf(c, l.task_id)).at(-1)?.id ?? l.task_id;
  await recordReply(c, it.reply, l.task_id, it.outcome, it.occurrence_date ?? null);
  if (it.outcome === "review")
    await review(c, `reply:${it.reply.channel_id}:${it.reply.ts}:${l.task_id}`, "ambiguous_reply", current, it.reply.permalink, it.note ?? "A reply may refer to this task; check whether it is finished.");
  return { outcome: it.outcome, task_id: current };
}

async function applyReview(c: pg.PoolClient, it: z.infer<typeof reviewItem>, activated: string) {
  if (tsCompare(it.key.message_ts, activated) < 0) return { outcome: "before_activation" };
  if (await linkFor(c, it.key)) return { outcome: "duplicate" };
  await review(c, `check:${keyText(it.key)}`, "needs_check", null, it.permalink, `${it.note} Proposed task: ${it.title}${it.description ? ` — ${it.description}` : ""}`);
  return { outcome: "review", reason: "needs_check" };
}

async function applyItem(c: pg.PoolClient, actor: Session, it: Item, activated: string) {
  switch (it.kind) {
    case "review": return applyReview(c, it, activated);
    case "create": return applyCreate(c, actor, it, activated);
    case "update": return applyUpdate(c, it);
    case "deleted": return applyDeleted(c, it);
    case "complete": return applyComplete(c, it);
    case "noted": return applyNoted(c, it);
  }
}

export const STATE_PAGE = 200;
/**
 * Slack requests the reader should keep watching, one page at a time (keyset on the request's task id): created in
 * the last 90 days, or with a live series that is still open (an unfinished one-time task, or a repeating series that
 * has not ended more than 31 days ago). Each lists its live series so replies can name the right one.
 */
async function watchedLinks(after: string | null, limit: number) {
  const today = todayVN();
  const rows = await query<any>(
    `select l.task_id, l.channel_id, l.message_ts, l.action_id, l.thread_ts, l.permalink, l.source_deleted_at,
            coalesce((select array_agg(r.reply_ts order by r.reply_ts) from slack_replies r where r.task_id = l.task_id), '{}') replies
       from slack_task_links l
      where ($1::uuid is null or l.task_id > $1::uuid)
        and exists (select 1 from slack_task_series s join tasks t on t.id = s.task_id
                     where s.link_task_id = l.task_id and t.deleted_at is null
                       and (l.created_at > now() - interval '90 days'
                            or (t.recurrence is null and t.completed_on is null)
                            or (t.recurrence is not null and (t.recurrence_until is null or t.recurrence_until >= $2::date))))
      order by l.task_id limit $3`, [after, addDays(today, -31), limit + 1]);
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.task_id);
  const series = ids.length ? await query<any>(
    `select s.link_task_id, t.id, t.title, t.recurrence, t.recurrence_days, t.due_date::text due_date, t.recurrence_until::text recurrence_until,
            t.completed_on::text completed_on, t.assignee_id
       from slack_task_series s join tasks t on t.id = s.task_id
      where s.link_task_id = any($1::uuid[]) and t.deleted_at is null order by t.created_at, t.id`, [ids]) : [];
  const people = new Map((await query<{ user_id: string; slack_user_id: string }>("select user_id, slack_user_id from slack_user_links")).map((p) => [p.user_id, p.slack_user_id]));
  // Ownership history, so the reader can recognize replies from earlier owners (the server still decides).
  const asg = await loadAssignments(series.map((t) => t.id));
  const items = page.map((r) => {
    const own = series.filter((x) => x.link_task_id === r.task_id).map((t) => ({
      task_id: t.id, title: t.title, owner_slack_id: people.get(t.assignee_id) ?? null,
      owners: (asg.get(t.id) ?? [{ assignee_id: t.assignee_id, effective_from: t.due_date }]).map((a, i) => ({ slack_id: people.get(a.assignee_id) ?? null, from: i === 0 ? null : a.effective_from })),
      status: t.recurrence ? "repeating" : t.completed_on ? "done" : "open",
      schedule: t.recurrence ? { rule: t.recurrence, days: normaliseDays(t.recurrence_days), start: t.due_date, until: t.recurrence_until } : null,
      due_date: t.recurrence ? null : t.due_date,
    }));
    const cur = own[own.length - 1];
    return {
      request_task_id: r.task_id, task_id: cur.task_id, key: { channel_id: r.channel_id, message_ts: r.message_ts, action_id: r.action_id },
      thread_ts: r.thread_ts ?? r.message_ts, permalink: r.permalink, title: cur.title, owner_slack_id: cur.owner_slack_id, status: cur.status,
      series: own, source_deleted: !!r.source_deleted_at, processed_replies: r.replies,
    };
  });
  return { items, next_cursor: rows.length > limit ? page[page.length - 1].task_id : null };
}

export async function handleSlackIntake(req: Request, path: string): Promise<Response> {
  await hit({ bucket: `slack:${clientKey(req)}`, ...RATE.reporting });
  const { actor } = await authenticate(req);

  if (path === "/slack-intake/v1/state" && req.method === "GET") {
    const state = await one<{ checkpoint_ts: string | null; activated_ts: string | null }>("select checkpoint_ts, activated_ts from slack_intake_state where id = 1");
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !/^[0-9a-f-]{36}$/.test(cursor)) throw badRequest("Invalid cursor.");
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? STATE_PAGE : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw badRequest("limit must be 1–500.");
    const page = await watchedLinks(cursor, limit);
    const people = await query<any>(
      `select l.slack_user_id, u.id user_id, u.display_name name, u.role, u.status <> 'archived' active,
              coalesce((select array_agg(b.id) from user_brand_access a join brands b on b.id = a.brand_id where a.user_id = u.id and b.status = 'active'), '{}') brand_ids
         from slack_user_links l join users u on u.id = l.user_id order by lower(u.display_name)`);
    const brands = await query<any>("select id, display_name name from brands where status = 'active' order by lower(display_name)");
    const channels = await query<any>("select channel_id, label, brand_id from slack_channel_brands order by channel_id");
    return json({ checkpoint_ts: state?.checkpoint_ts ?? null, activated_ts: state?.activated_ts ?? null, now_ts: tsNow(), today: todayVN(), max_batch_items: MAX_ITEMS,
      people, brands, channel_brands: channels, open_tasks: page.items, next_cursor: page.next_cursor });
  }

  if (path === "/slack-intake/v1/batches" && req.method === "POST") {
    const b = parse(batchSchema, await readJson(req));
    const cp = b.checkpoint_ts ?? null;
    if (tsCompare(b.range.from_ts, b.range.to_ts) > 0 || (cp && tsCompare(cp, b.range.to_ts) > 0)) throw badRequest("range.from_ts must not be after range.to_ts, and checkpoint_ts not after range.to_ts.");

    const result = await tx(async (c) => {
      // One batch at a time.
      await c.query("select pg_advisory_xact_lock(hashtextextended('slack_intake', 11))");
      const done = (await c.query("select result from slack_intake_batches where batch_id = $1", [b.batch_id])).rows[0];
      if (done) return { ...done.result, replayed: true };
      const st = (await c.query("select checkpoint_ts, activated_ts from slack_intake_state where id = 1 for update")).rows[0];
      if (!st?.checkpoint_ts) throw new HttpError(409, "not_activated", "Slack intake has no starting checkpoint. Create the intake credential in Task Tracker first.");
      // No gaps: the batch must start at or before the stored checkpoint (overlap is fine; items are idempotent).
      if (tsCompare(b.range.from_ts, st.checkpoint_ts) > 0)
        throw new HttpError(409, "checkpoint_gap", "This batch starts after the stored checkpoint; read again from the checkpoint.", { checkpoint_ts: st.checkpoint_ts });
      // Lock every message this batch may create a task for, in sorted order, before any item runs: the Marketing
      // Dashboard takes the same locks (also sorted), so the two paths serialize without deadlocks.
      await lockMessages(c, b.items.filter((x) => x.kind === "create").map((x) => ({ channel_id: x.key.channel_id, message_ts: x.key.message_ts })));
      const results: any[] = [];
      for (let i = 0; i < b.items.length; i++) {
        const it = b.items[i];
        await c.query("savepoint slack_item");
        try {
          results.push({ index: i, kind: it.kind, ...(await applyItem(c, actor, it, st.activated_ts ?? st.checkpoint_ts)) });
          await c.query("release savepoint slack_item");
        } catch (e) {
          // A refusal by the tracker's rules is final for that item (recorded for review); other errors fail the batch.
          if (!(e instanceof HttpError) || e.status < 400 || e.status >= 500) throw e;
          await c.query("rollback to savepoint slack_item");
          const link = "permalink" in it ? (it as any).permalink : "reply" in it ? (it as any).reply.permalink : null;
          await review(c, `refused:${it.kind}:${keyText(it.key)}:${"reply" in it ? (it as any).reply.ts : ""}`, "refused", null, link, `${e.code}: ${e.message}`);
          results.push({ index: i, kind: it.kind, outcome: "refused", reason: e.code });
        }
      }
      // The checkpoint never moves ahead of the tracker's clock (a later run would skip what is posted meanwhile).
      if (cp && tsCompare(cp, st.checkpoint_ts) > 0 && tsCompare(cp, tsPlus(tsNow(), 120)) > 0) throw badRequest("checkpoint_ts is in the future.");
      // Advance only when asked (the run's last batch) and never backwards.
      const next = cp && tsCompare(cp, st.checkpoint_ts) > 0 ? cp : st.checkpoint_ts;
      await c.query("update slack_intake_state set checkpoint_ts = $1, updated_at = now() where id = 1", [next]);
      const out = { batch_id: b.batch_id, checkpoint_ts: next, results, counts: countOutcomes(results) };
      await c.query("insert into slack_intake_batches (batch_id, result) values ($1, $2)", [b.batch_id, JSON.stringify(out)]);
      return out;
    });
    return json(result);
  }

  const known = path === "/slack-intake/v1/state" || path === "/slack-intake/v1/batches";
  throw known ? new HttpError(405, "method_not_allowed", "Method not allowed.") : new HttpError(404, "not_found", "No such endpoint.");
}

function countOutcomes(results: { outcome: string }[]) {
  const n: Record<string, number> = {};
  for (const r of results) n[r.outcome] = (n[r.outcome] ?? 0) + 1;
  return n;
}

/** For task screens: the Slack message a task came from, and whether its deadline is still the inferred one. */
export async function slackLinkFor(taskId: string) {
  const r = await one<{ permalink: string; due_inferred: boolean; source_deleted_at: string | null }>(
    `select l.permalink, (l.due_inferred and t.due_date is not distinct from l.synced_due) due_inferred, l.source_deleted_at
       from slack_task_links l join tasks t on t.id = l.task_id where l.task_id = $1`, [taskId]);
  return r ? { permalink: r.permalink, due_inferred: r.due_inferred, source_deleted: !!r.source_deleted_at } : null;
}
