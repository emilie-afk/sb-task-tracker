// One Slack request, one task, across workflows: the direct Slack intake and the Marketing Dashboard (its private
// Slack review queue, Corporate Gifts drafts and plans) can each find the same Slack request.
//
// Identity: channel id, message ts and the request's number within the message (a1, a2, … in order of appearance,
// the same numbering in all three apps). A source without a number is "some request of this message" ('*').
// Concurrency: every workflow takes the message's advisory lock (lockMessages, in sorted order) before looking, and
// claims the request in the same transaction as the task it creates; the claim's primary key makes a second task for
// one request impossible even if a path forgot the lock.
// Matching (claimedTask): a numbered source matches only the claim with the same number; a message with an unnumbered
// claim, or an unnumbered source on a message with any claim, is ambiguous (review, never linked or created).
import { z } from "zod";
import type pg from "pg";
import { HttpError } from "./http";

export const slackSource = z.object({
  channel_id: z.string().regex(/^[A-Z0-9]{6,20}$/, "must be a Slack channel id"),
  message_ts: z.string().regex(/^\d{9,11}\.\d{6}$/, "must be a Slack timestamp"),
  action_id: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().optional(),
}).strict();
export type SlackSource = z.infer<typeof slackSource>;
export type Workflow = "intake" | "review" | "corporate" | "plan";

/** The shared per-request number, or null when the source does not carry one. */
export const requestNo = (s: SlackSource) => (s.action_id && /^a[0-9]{1,2}$/.test(s.action_id) ? s.action_id : null);

/** Serializes every workflow's look-then-create for these Slack messages (sorted, so two paths never deadlock). */
export async function lockMessages(c: pg.PoolClient, sources: SlackSource[]) {
  for (const k of [...new Set(sources.map((s) => `${s.channel_id}:${s.message_ts}`))].sort())
    await c.query("select pg_advisory_xact_lock(hashtextextended($1, 23))", [`slack-message:${k}`]);
}

export type Held = { kind: "none" } | { kind: "task"; task_id: string } | { kind: "ambiguous" };
/** The live task already holding these Slack requests, if exactly one does. Call under lockMessages. */
export async function claimedTask(c: pg.PoolClient, sources: SlackSource[]): Promise<Held> {
  const ids = new Set<string>();
  let ambiguous = false;
  for (const s of sources) {
    const rows: { request_id: string; task_id: string }[] = (await c.query(
      `select r.request_id, r.task_id from slack_request_claims r join tasks t on t.id = r.task_id
        where t.deleted_at is null and r.channel_id = $1 and r.message_ts = $2`, [s.channel_id, s.message_ts])).rows;
    const no = requestNo(s);
    if (no) {
      const exact = rows.find((r) => r.request_id === no);
      if (exact) ids.add(exact.task_id);
      else if (rows.some((r) => r.request_id === "*")) ambiguous = true;
    } else if (rows.length) ambiguous = true;
  }
  if (ambiguous || ids.size > 1) return { kind: "ambiguous" };
  return ids.size ? { kind: "task", task_id: [...ids][0] } : { kind: "none" };
}

/** Claims these requests for a task (same transaction as its creation or link). A claim of a deleted task is replaced. */
export async function claim(c: pg.PoolClient, taskId: string, workflow: Workflow, sources: SlackSource[]) {
  for (const s of sources) {
    const no = requestNo(s) ?? "*";
    const r = await c.query(
      `insert into slack_request_claims (channel_id, message_ts, request_id, task_id, claimed_by) values ($1,$2,$3,$4,$5)
       on conflict (channel_id, message_ts, request_id) do update set task_id = excluded.task_id, claimed_by = excluded.claimed_by, created_at = now()
         where slack_request_claims.task_id = excluded.task_id
            or exists (select 1 from tasks t where t.id = slack_request_claims.task_id and t.deleted_at is not null)
       returning task_id`, [s.channel_id, s.message_ts, no, taskId, workflow]);
    if (!r.rowCount && no !== "*") throw new HttpError(409, "already_in_tracker", "This Slack request already has a task in Task Tracker; nothing was created.");
  }
}
