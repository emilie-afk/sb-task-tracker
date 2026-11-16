# Planning API (Marketing Dashboard → Task Tracker)

A scoped, server-to-server operation that lets the Marketing Dashboard create the assigned tasks of a published marketing plan. The **dashboard owns the plan**; the **tracker owns the tasks** (completion, reassignment and every other task-level edit happen here). The dashboard then follows the tasks' status through the normal [reporting sync](REPORTING_API.md).

## Authentication and scope

- Header `x-tracker-planning-key: <secret>`. Created by an administrator under **Integrations → Marketing planning** (shown once, stored only as a SHA-256 hash, compared in constant time). Creating a new one revokes the previous one; **Revoke** stops task creation at once. It is separate from the reporting credential, and neither reaches the other's endpoints. Human sessions are never accepted.
- The credential **acts as the administrator who created it**. Tasks are created through the task editor's own validation (`prepareCreate`) with that administrator's permissions, so the same rules apply: open brand, assignable person (active administrator or staff with access to the brand; never Management or archived people), valid dates. If that person is archived or stops being an administrator, the API answers `503 planning_disabled`.
- Business scope applies to **every** endpoint, not only creation: a lookup, a replayed key and a due-date change reach a task only while its brand is mapped to a business the current credential allows. Otherwise the lookup leaves it out, a replay answers `409 key_unavailable` (with no task details) and a due-date change answers `404`. A replaced or narrower credential therefore cannot reach tasks of other businesses created under an earlier one.
- Brands: only **active** brands with **reporting enabled** and mapped to a dashboard business the credential allows (Succulents Box only by default). This keeps every created task visible to the dashboard's reporting sync.
- Without an active credential: `503 planning_disabled`. Rate limited per client address; failed keys are limited separately.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/planning/v1/directory` | Brands a plan may use, and people assignable in them: `{ brands: [{id, name, business_id}], people: [{id, name, brand_ids}] }`. No emails. |
| `POST /api/planning/v1/tasks` | Create one assigned task (idempotent, below). |
| `GET /api/planning/v1/tasks?keys=<k1>,<k2>` | Current state of up to 100 tasks created from plans, by assignment id. |
| `PATCH /api/planning/v1/tasks/<key>/due-date` | `{ due_date, expected_version }`: change the due date only if the task's version still matches; `409 conflict` (with the current task in `error.details.task`) otherwise. |

### Creating a task

```json
POST /api/planning/v1/tasks
{ "idempotency_key": "mkp:<assignment uuid>", "plan_id": "<plan uuid>", "brand_id": "<tracker brand>", "assignee_id": "<tracker person>",
  "title": "…", "brief": "…", "due_date": "2027-02-12", "sent_at": "2026-11-16T08:00:00.000Z" }
```

- `idempotency_key` is the dashboard's stable assignment id. The first call creates the task (`201`, `created: true`). Any later call with the same key — a double click, a retry after a timeout, a retry of a partial failure — returns the **original task as it is now** (`200`, `created: false`), including edits made in the tracker, and creates nothing. Concurrent calls with one key are serialized; only one task can exist per key. A key already used by another plan answers `409 key_in_use`; a key whose task is outside the credential's businesses answers `409 key_unavailable`.
- **Does a task exist?** A refusal made after the key was checked (under the key's lock, whatever its business) carries `error.details.task_exists: false`: no task exists for that key. Every other answer — `key_unavailable` (a task exists outside the credential's businesses), `key_in_use`, `stale_request`, `400`, `401`, `503`, timeouts — says nothing about whether a task exists, and a caller must keep treating an unanswered earlier attempt as unresolved.
- `sent_at` is when the caller sent the request; `supersedes_sent_at` (optional) is the `sent_at` of the caller's latest earlier attempt whose answer it never received. **Fence:** when a request is refused with `task_exists: false`, Task Tracker stores, under the key's lock and in the same transaction, `fenced_through` = the greater of the two, and returns it. Every later request for that key with `sent_at` at or before `fenced_through` is refused with `409 stale_request` and creates nothing, whichever server instance handles it and whatever its clock says. A caller may treat earlier unanswered attempts as unable to create a task once `fenced_through` is at or after their `sent_at`, and must send later attempts with a `sent_at` after `fenced_through`.
- As an extra guard, a request more than 60 seconds old (or 60 seconds ahead) by the handling instance's clock is also refused with `409 stale_request`; that check runs under the key's lock too.
- The brief becomes the task's note (max 2,000 characters). The task is a one-time ad hoc task created by the acting administrator; its history shows `created` and `linked_to_plan`.
- Errors: `400` invalid fields · `401` wrong key · `409 key_in_use` · `422 brand_not_allowed` · `422 unknown_person | archived_person | management_role | assignee_lacks_brand_access` · `503 planning_disabled`.

Task responses: `{ idempotency_key, plan_id, task_id, title, due_date, status: open|done|deleted, completed_on, recurring, brand: {id, name}, assignee: {id, name}, version, updated_at, open_url }`.

## Link back to the plan

Each task created from a plan shows **Open the plan in the Marketing Dashboard** in its detail. The link is built from this tracker's `MARKETING_DASHBOARD_URL` setting and the plan id (never from a URL sent by the caller). The dashboard applies its own plan visibility rules when the link is opened.

## Rollout

1. Apply migration `003_planning_integration.sql` (`npm run db:migrate`). Rollback: `db/rollback/003_planning_integration.down.sql`.
2. Set `MARKETING_DASHBOARD_URL` (Functions scope) and deploy.
3. As the administrator the tasks should be created by, open **Integrations → Marketing planning**, choose the businesses and create the credential. Store the secret only in the dashboard's `TASK_TRACKER_PLANNING_SECRET`.
