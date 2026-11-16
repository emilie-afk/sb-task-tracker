-- Marketing planning integration (Marketing Dashboard -> Task Tracker): the dashboard's planning owner publishes a
-- plan and the dashboard creates its assigned tasks here through a scoped server-to-server operation.
-- The tracker owns those tasks (completion and task-level edits); the dashboard keeps only the link.
-- Rollback: db/rollback/003_planning_integration.down.sql

-- At most one active planning credential. Stored as SHA-256 only; shown once when generated. Tasks it creates are
-- created on behalf of `acting_user_id`, an administrator chosen when the credential is made; if that person stops
-- being an active administrator the credential stops working.
create table planning_credentials (
  id uuid primary key default gen_random_uuid(),
  key_hash bytea not null unique,
  acting_user_id uuid not null references users(id) on delete restrict,
  allowed_business_ids text[] not null default array['sb'] check (cardinality(allowed_business_ids) between 1 and 10),
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete restrict,
  last_used_at timestamptz
);
create unique index planning_credentials_one_active on planning_credentials ((true)) where revoked_at is null;

-- One row per task created from a marketing plan. `idempotency_key` is the dashboard's stable assignment id:
-- repeating the creation returns this task instead of creating another. The plan link is built from this
-- tracker's MARKETING_DASHBOARD_URL setting and the plan id, never from a URL sent by the caller.
create table task_plan_links (
  task_id uuid primary key references tasks(id) on delete restrict,
  idempotency_key text not null unique check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  plan_id text not null check (plan_id ~ '^[0-9a-f-]{36}$'),
  created_at timestamptz not null default now()
);
create index task_plan_links_plan on task_plan_links (plan_id);

-- Per-assignment fence. When a creation request is refused after confirming that no task exists for its key, the
-- greatest sent_at it covers (its own, and the caller's earlier unanswered attempt) is stored here under the key's
-- lock, in the same transaction. Any later request for that key sent at or before it is refused, whichever server
-- instance handles it, so an expired or delayed earlier attempt can never create a task afterwards.
create table task_plan_fences (
  idempotency_key text primary key check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  fenced_through timestamptz not null,
  updated_at timestamptz not null default now()
);
