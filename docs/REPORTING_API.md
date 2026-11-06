# Reporting API (Task Tracker → Marketing Dashboard)

A read-only, server-to-server pull. The tracker is the editing authority for its tasks; the dashboard shows them read-only. There is no write path back.

## Authentication and scope

- Header `x-tracker-reporting-key: <secret>`. Created by an administrator under **Integrations** (shown once, stored only as a SHA-256 hash, compared in constant time). Creating a new one revokes the previous one; **Revoke** disables reporting at once.
- The key is not a session: it reaches only `GET /api/reporting/v1/tasks`. Human sessions, OAuth credentials and administrator access are not accepted there.
- Without an active key or `TRACKER_INSTANCE_ID`, the endpoint answers `503 reporting_disabled`.
- A brand is reported only when an administrator **mapped** it to a dashboard business **and enabled** reporting for it, **and** the key's allowed businesses include that business. The key allows Succulents Box (`sb`) only unless an administrator chooses otherwise. New brands are never included automatically.
- Rate limited per client address; repeated wrong keys are limited separately.

## Request

```
GET /api/reporting/v1/tasks?limit=200
GET /api/reporting/v1/tasks?limit=200&snapshot=<snapshot.id>&cursor=<next_cursor>
```

`limit` 1–500 (default 200). The first page has no `snapshot`/`cursor`; later pages must send both.

## Response (`schema_version: 2`)

```json
{
  "schema_version": 2,
  "source_instance": "tracker-prod",
  "snapshot": { "id": "snp_<32 hex>", "generated_at": "2026-11-05T05:00:00.000Z", "operational_date": "2026-11-05",
                "timezone": "Asia/Ho_Chi_Minh", "window": { "from": "2026-09-06", "to": "2027-01-04" }, "total_items": 431 },
  "scope": { "business_ids": ["sb"] },
  "items": [ { "record_id": "task:<uuid>", "kind": "task", "task_id": "<uuid>", "occurrence_date": null,
               "title": "…", "type": "adhoc", "business_id": "sb",
               "brand": { "id": "<uuid>", "name": "…", "archived": false },
               "assignee": { "id": "<uuid>", "name": "…", "archived": false },
               "recurrence": null, "due_date": "2026-11-07", "status": "open", "completed_on": null, "created_on": "2026-11-01",
               "source_updated_at": "2026-11-04T09:12:00.000Z", "open_url": "https://<tracker>/#/tasks/<uuid>" } ],
  "in_scope_tasks": [ { "task_id": "<uuid>", "recurring": true, "first_due": "2026-01-05", "until": "2026-03-30" } ],
  "removals": [ { "task_id": "<uuid>", "reason": "deleted" } ],
  "page": { "offset": 0, "limit": 200, "count": 200 },
  "next_cursor": "200"
}
```

### Records

- One-time tasks: `record_id = task:<task id>`, `kind = task`.
- Recurring tasks: one record per **occurrence** in the snapshot window (60 days back to 60 days ahead), `record_id = occ:<task id>:<YYYY-MM-DD>`, `kind = occurrence`, `due_date = occurrence_date`, `status` for that occurrence only. A series is never reported as completed work.
- `assignee` is the person who **owned the task on that record's date** (effective-dated ownership): an occurrence or a completed one-time task stays credited to its owner at the time, even after the task is reassigned or that person is archived. Open one-time tasks show the current assignee.
- Records are ordered by `record_id`. Included fields are only those needed for task reporting. Notes, emails, account lists, KPI details and administrative fields are never sent.
- `open_url` opens the task in the tracker, which requires the viewer's own tracker sign-in.

### Snapshots and pagination

- Every page of one read carries the same `snapshot.id`. The id changes whenever anything that affects the output changes (tasks, occurrences, brands, people's names or status, the key) or the Vietnam date changes.
- A page requested with a `snapshot` that no longer matches answers `409 snapshot_changed`. The reader must discard the pages it has and start again; it must never combine pages of different snapshots.
- A read is complete only when a page has `next_cursor: null`.

### Reconciliation (authoritative scope)

`in_scope_tasks` is sent complete on the **last** page only (`null` on earlier pages). It lists **every** task currently in the reported scope, whatever its dates, with the date span its occurrences can have (`first_due`/`until` for recurring tasks; `null` for one-time tasks). It does not expire. A reader that has applied a complete snapshot can therefore reconcile after any gap:

- remove every stored copy whose `task_id` is not listed (deleted, cleared to Unassigned brand, moved out of reported brands or businesses), including occurrences far outside the window;
- remove stored occurrences of a listed task dated before `first_due` or after `until`;
- keep other occurrences outside the window as history.

At most 20,000 tasks are listed; above that the endpoint answers `503 reporting_too_large`.

### Removal markers (reasons)

`removals` is also sent on the last page only. It is informational: it gives the reason for tasks that were reported at least once and left the scope within the last 180 days. Correctness never depends on it.

| `reason` | Meaning |
|---|---|
| `deleted` | The task was deleted |
| `brand_unassigned` | Its brand was cleared |
| `brand_not_reported` | Moved to a brand that is unmapped or has reporting off (also: reporting turned off for its brand) |
| `out_of_scope` | Its brand maps to a business the key does not allow |

Archiving a brand does **not** remove its tasks: they stay reported with `brand.archived: true` while the brand remains mapped and enabled.

### Errors

`400` invalid parameters · `401` wrong or missing key · `405` any method other than GET · `409 snapshot_changed` · `429` rate limited · `503 reporting_disabled`.

## Consumer rules (implemented by the marketing dashboard)

- Read all pages into memory with bounded size and an overall deadline; refuse redirects; accept only `https`.
- Validate every page and record; all pages must share one `snapshot.id` and `source_instance`.
- Publish only a complete, valid snapshot, atomically. On any failure (network, timeout, oversize, malformed data, incomplete pagination, snapshot change after retries) keep the last good snapshot.
- Enforce one overall deadline across all pages, body reads and retries; discard anything that arrives after it and never start publishing after it.
- After a complete snapshot, in the same transaction: upsert by `(source_instance, record_id)`; remove records of tasks not in `in_scope_tasks` (using the `removals` reason when given) and occurrences outside their task's span; remove one-time tasks and occurrences inside `snapshot.window` that are missing from the snapshot; keep the rest as history.
