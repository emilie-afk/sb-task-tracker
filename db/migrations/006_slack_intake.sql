-- Slack task intake: a scheduled reader (using the team's existing Slack connection) turns Slack requests that tag a
-- linked staff member into tasks, and that person's clear "done" replies in the same thread into completions.
-- The tracker owns the tasks and applies its own rules; this stores the private mapping, links and processing state.
-- Rollback: db/rollback/006_slack_intake.down.sql

-- At most one active intake credential (SHA-256 only, shown once). Tasks are created on behalf of `acting_user_id`,
-- an active administrator; completions are recorded as automation (no person), credited to the task's owner.
-- `checkpoint_ts` is the Slack timestamp through which messages have been processed; it starts at activation.
-- `activated_ts` is set once, when the first credential is created: messages posted before it never become tasks,
-- however far back a run's overlap reaches.
create table slack_intake_credentials (
  id uuid primary key default gen_random_uuid(),
  key_hash bytea not null unique,
  acting_user_id uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete restrict,
  last_used_at timestamptz
);
create unique index slack_intake_credentials_one_active on slack_intake_credentials ((true)) where revoked_at is null;

create table slack_intake_state (
  id smallint primary key default 1 check (id = 1),
  checkpoint_ts text check (checkpoint_ts is null or checkpoint_ts ~ '^\d{10}\.\d{6}$'),
  activated_ts text check (activated_ts is null or activated_ts ~ '^\d{10}\.\d{6}$'),
  updated_at timestamptz not null default now()
);
insert into slack_intake_state (id, checkpoint_ts) values (1, null);

-- Slack member -> tracker person (private; managed by administrators).
create table slack_user_links (
  slack_user_id text primary key check (slack_user_id ~ '^[UW][A-Z0-9]{6,15}$'),
  user_id uuid not null unique references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete restrict
);

-- Slack channel -> brand for tasks whose message names no brand. Null brand = Unassigned brand (administrator review).
create table slack_channel_brands (
  channel_id text primary key check (channel_id ~ '^[CG][A-Z0-9]{6,15}$'),
  label text check (label is null or length(label) between 1 and 80),
  brand_id uuid references brands(id) on delete restrict,
  updated_at timestamptz not null default now()
);

-- One task per request: (channel, message ts, action id). synced_* hold the values last taken from Slack, so a later
-- edit of the message changes only fields nobody changed in the tracker (manual edits win; conflicts go to review).
create table slack_task_links (
  task_id uuid primary key references tasks(id) on delete restrict,
  channel_id text not null check (channel_id ~ '^[CGD][A-Z0-9]{6,15}$'),
  message_ts text not null check (message_ts ~ '^\d{10}\.\d{6}$'),
  action_id text not null check (action_id ~ '^a[0-9]{1,2}$'),
  thread_ts text check (thread_ts is null or thread_ts ~ '^\d{10}\.\d{6}$'),
  permalink text not null check (permalink ~ '^https://[a-z0-9-]+\.slack\.com/archives/[A-Z0-9]+/p[0-9]{16}([?][A-Za-z0-9_.=&-]*)?$'),
  synced_title text not null,
  synced_note text,
  synced_due date,
  due_inferred boolean not null default false,
  edited_ts text check (edited_ts is null or edited_ts ~ '^\d{10}\.\d{6}$'),
  source_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (channel_id, message_ts, action_id)
);
create index slack_task_links_thread on slack_task_links (channel_id, coalesce(thread_ts, message_ts));

-- Every task that carries a Slack request: the task created from it and each series that continues it after a
-- schedule change (tasks.previous_series_id). Replies are routed to the series that has the occurrence.
create table slack_task_series (
  task_id uuid primary key references tasks(id) on delete restrict,
  link_task_id uuid not null references slack_task_links(task_id) on delete cascade
);
create index slack_task_series_link on slack_task_series (link_task_id);

-- Every reply judged against a Slack request (task_id = the request's link task), once. Reprocessing the same reply
-- never acts again (a later manual reopen stands). credited_task_id is the series it completed; replied_on is the
-- reply's Vietnam date (the day the work is credited to), processed_at when the tracker handled it.
create table slack_replies (
  channel_id text not null,
  reply_ts text not null check (reply_ts ~ '^\d{10}\.\d{6}$'),
  task_id uuid not null references tasks(id) on delete restrict,
  credited_task_id uuid references tasks(id) on delete restrict,
  occurrence_date date,
  replied_on date,
  outcome text not null check (outcome in ('completed', 'already_done', 'progress', 'review', 'refused')),
  permalink text,
  processed_at timestamptz not null default now(),
  primary key (channel_id, reply_ts, task_id)
);

-- Things for an administrator to look at: unclear brand, ambiguous reply, edit conflict, deleted source, refused item.
create table slack_review_items (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique check (length(dedupe_key) between 1 and 200),
  task_id uuid references tasks(id) on delete restrict,
  kind text not null check (kind in ('brand_unclear', 'ambiguous_reply', 'edit_conflict', 'source_deleted', 'refused', 'possible_duplicate', 'needs_check')),
  permalink text,
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete restrict
);
create index slack_review_open on slack_review_items (created_at) where resolved_at is null;

-- One Slack request, one task, across workflows. Each Slack request a task was created from is claimed here by its
-- identity: channel, message ts and the request's number within the message (a1, a2, … in order of appearance; the
-- direct intake, the dashboard's Slack review queue and Corporate Gifts all use this numbering). A request whose number
-- is unknown is claimed as '*' (some request of that message). Every workflow takes the message's lock, looks here,
-- and links to the claimed task instead of creating a second one; the primary key makes a second claim impossible.
-- A message with an unnumbered claim, or a source without a number on a message with claims, is ambiguous and goes
-- to review. Identity only: no Slack text or links.
create table slack_request_claims (
  channel_id text not null check (channel_id ~ '^[A-Z0-9]{6,20}$'),
  message_ts text not null check (message_ts ~ '^\d{9,11}\.\d{6}$'),
  request_id text not null check (request_id ~ '^(\*|a[0-9]{1,2})$'),
  task_id uuid not null references tasks(id) on delete restrict,
  claimed_by text not null check (claimed_by in ('intake', 'review', 'corporate', 'plan')),
  created_at timestamptz not null default now(),
  primary key (channel_id, message_ts, request_id)
);
create index slack_request_claims_task on slack_request_claims (task_id);

-- Batches already applied: a retry of the same batch returns the stored result and changes nothing.
create table slack_intake_batches (
  batch_id text primary key check (batch_id ~ '^[A-Za-z0-9_.:-]{8,80}$'),
  received_at timestamptz not null default now(),
  result jsonb not null
);
