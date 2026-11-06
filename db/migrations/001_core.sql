-- Task Tracker core schema: approved memberships, revocable sessions, brands and staff brand access, tasks with
-- history and recurrence occurrences, KPI scorecards, import provenance, reporting integration state and audit.
-- Rollback: db/rollback/001_core.down.sql
--
-- This migration creates structure only. It inserts no people, brands, tasks or KPI records: an empty database
-- stays empty until an administrator populates it (scripts/provision-admin.ts, the People and Brands screens,
-- or the private import).

create table rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);

-- ------------------------------------------------------------ people and access
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and length(email) between 3 and 320 and email like '%_@_%'),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role text not null check (role in ('administrator', 'staff', 'management')),
  -- pending: approved but never signed in; active: signed in at least once; archived: left, cannot sign in.
  status text not null default 'pending' check (status in ('pending', 'active', 'archived')),
  google_sub text check (google_sub is null or length(google_sub) between 1 and 255),
  last_sign_in_at timestamptz,
  archived_at timestamptz,
  archived_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  version int not null default 1,
  check ((status = 'archived') = (archived_at is not null))
);
create unique index users_email_unique on users (email);
create unique index users_google_sub_unique on users (google_sub) where google_sub is not null;

create table brands (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  name_key text not null,
  color text check (color is null or color ~ '^#[0-9a-f]{6}$'),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Marketing dashboard reporting: never enabled automatically. A mapping is required and set privately.
  reporting_enabled boolean not null default false,
  dashboard_business_id text check (dashboard_business_id is null or dashboard_business_id ~ '^[a-z0-9_-]{1,40}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  version int not null default 1,
  check ((status = 'archived') = (archived_at is not null)),
  check (not reporting_enabled or dashboard_business_id is not null)
);
create unique index brands_name_key_unique on brands (name_key);

-- Staff brand access. Administrators and Management read every brand and need no rows here.
create table user_brand_access (
  user_id uuid not null references users(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete restrict,
  granted_at timestamptz not null default now(),
  granted_by uuid references users(id) on delete restrict,
  primary key (user_id, brand_id)
);
create index user_brand_access_brand on user_brand_access (brand_id);

-- Server-side sessions. The cookie holds a random token; only its SHA-256 is stored.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text
);
create index sessions_user_live on sessions (user_id) where revoked_at is null;

-- Pending Google sign-ins: single-use state with nonce and PKCE verifier, bound to the starting browser.
create table oauth_states (
  state_hash bytea primary key,
  nonce text not null,
  code_verifier text not null,
  browser_hash bytea not null,
  expires_at timestamptz not null
);

-- ------------------------------------------------------------ KPI scorecards
create table kpi_definitions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete restrict,       -- whose scorecard
  brand_id uuid not null references brands(id) on delete restrict,
  metric text not null check (length(btrim(metric)) between 1 and 160),
  sub_metric text check (sub_metric is null or length(sub_metric) <= 160),
  target text check (target is null or length(target) <= 40),
  note text check (note is null or length(note) <= 500),
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index kpi_definitions_owner on kpi_definitions (owner_id, brand_id) where archived_at is null;

-- Scorecard values per week (period_start is the Monday of the week, Vietnam time). Task completion never
-- writes here: completed tasks are not KPI performance.
create table kpi_values (
  kpi_id uuid not null references kpi_definitions(id) on delete restrict,
  period_start date not null check (extract(isodow from period_start) = 1),
  value text not null check (length(value) <= 40),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete restrict,
  primary key (kpi_id, period_start)
);

-- ------------------------------------------------------------ imports (provenance)
create table import_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('legacy_browser', 'kpi_xlsx')),
  status text not null default 'preview' check (status in ('preview', 'committed', 'discarded')),
  source_label text not null check (length(source_label) between 1 and 120),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  preview jsonb not null,                   -- normalized candidate records (untrusted input, validated)
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid not null references users(id) on delete restrict,
  committed_at timestamptz,
  committed_by uuid references users(id) on delete restrict,
  expires_at timestamptz not null
);

-- One row per committed source record. The fingerprint is the SHA-256 of the record's complete canonical content,
-- so repeating an import is a no-op, while records that merely share an old numeric id or a title stay distinct.
create table import_records (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references import_batches(id) on delete restrict,
  record_kind text not null check (record_kind in ('task', 'kpi')),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  legacy_ref text check (legacy_ref is null or length(legacy_ref) <= 80),
  target_id uuid not null,
  committed_at timestamptz not null default now(),
  unique (record_kind, fingerprint)
);

-- ------------------------------------------------------------ tasks
create table tasks (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references brands(id) on delete restrict,             -- null = Unassigned brand
  assignee_id uuid not null references users(id) on delete restrict,
  creator_id uuid not null references users(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 300),
  note text check (note is null or length(note) <= 2000),
  type text not null check (type in ('routine', 'adhoc', 'video')),
  due_date date,
  -- Recurrence: a series is one task; occurrences are computed from the rule and anchored on due_date.
  recurrence text check (recurrence in ('daily', 'weekdays', 'weekly', 'monthly')),
  recurrence_until date,
  previous_series_id uuid references tasks(id) on delete restrict,
  kpi_id uuid references kpi_definitions(id) on delete restrict,
  legacy_kpi_label text check (legacy_kpi_label is null or length(legacy_kpi_label) <= 160),
  -- Operational (Vietnam) date the task was created; preserved from imports, never regenerated.
  operational_date date not null,
  -- Completion of a one-time task. Recurring series are never completed as a whole (see task_occurrences).
  completed_on date,
  completed_at timestamptz,
  completed_by uuid references users(id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references users(id) on delete restrict,
  import_record_id uuid references import_records(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  check (recurrence is null or due_date is not null),
  check (recurrence is null or completed_on is null),
  check (recurrence_until is null or (recurrence is not null and recurrence_until >= due_date - 1)),
  check (completed_at is null or completed_on is not null)
);
create index tasks_brand on tasks (brand_id) where deleted_at is null;
create index tasks_assignee on tasks (assignee_id) where deleted_at is null;
create index tasks_updated on tasks (updated_at);

-- Completion of one occurrence of a recurring series. Identity: (task_id, occurrence_date).
create table task_occurrences (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete restrict,
  occurrence_date date not null,
  completed_on date not null,
  completed_at timestamptz,
  completed_by uuid references users(id) on delete restrict,
  import_record_id uuid references import_records(id) on delete restrict,
  unique (task_id, occurrence_date)
);

create table task_history (
  id bigserial primary key,
  task_id uuid not null references tasks(id) on delete restrict,
  at timestamptz not null default now(),
  actor_id uuid references users(id) on delete restrict,
  action text not null check (length(action) <= 60),
  changes jsonb not null default '{}'::jsonb
);
create index task_history_task on task_history (task_id, at desc);

-- ------------------------------------------------------------ marketing dashboard reporting
-- At most one active reporting credential. Stored as SHA-256 only; shown once when generated.
create table reporting_credentials (
  id uuid primary key default gen_random_uuid(),
  key_hash bytea not null unique,
  allowed_business_ids text[] not null default array['sb'] check (cardinality(allowed_business_ids) between 1 and 10),
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete restrict,
  last_used_at timestamptz
);
-- Tasks that have appeared in at least one reporting snapshot. Removal markers are sent only for these.
create table reporting_exposures (
  task_id uuid primary key references tasks(id) on delete restrict,
  first_reported_at timestamptz not null default now()
);

create unique index reporting_credentials_one_active on reporting_credentials ((true)) where revoked_at is null;

-- Bumped in the same transaction as any change that can alter the reporting output, so a paginated read can
-- prove all of its pages came from one consistent state.
create table reporting_state (
  id int primary key check (id = 1),
  epoch bigint not null default 1
);
insert into reporting_state (id, epoch) values (1, 1);

create function bump_reporting_epoch() returns trigger language plpgsql as $$
begin
  update reporting_state set epoch = epoch + 1 where id = 1;
  return null;
end $$;
create trigger tasks_reporting_epoch after insert or update or delete on tasks for each statement execute function bump_reporting_epoch();
create trigger occurrences_reporting_epoch after insert or update or delete on task_occurrences for each statement execute function bump_reporting_epoch();
create trigger brands_reporting_epoch after insert or update or delete on brands for each statement execute function bump_reporting_epoch();
-- Row-level with conditions, so routine updates (sign-in times, credential last use) never invalidate a read.
create trigger users_reporting_epoch after update on users for each row
  when (old.display_name is distinct from new.display_name or old.status is distinct from new.status) execute function bump_reporting_epoch();
create trigger credentials_reporting_epoch_insert after insert on reporting_credentials for each statement execute function bump_reporting_epoch();
create trigger credentials_reporting_epoch_update after update on reporting_credentials for each row
  when (old.revoked_at is distinct from new.revoked_at or old.allowed_business_ids is distinct from new.allowed_business_ids) execute function bump_reporting_epoch();

-- ------------------------------------------------------------ audit
create table audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid references users(id) on delete restrict,
  actor_label text not null check (length(actor_label) <= 80),   -- 'user', 'setup', 'reporting'
  action text not null check (length(action) <= 60),
  target_type text check (target_type is null or length(target_type) <= 40),
  target_id text check (target_id is null or length(target_id) <= 80),
  details jsonb
);
create index audit_events_target on audit_events (target_type, target_id, at desc);
