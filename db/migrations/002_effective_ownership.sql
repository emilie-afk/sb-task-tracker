-- Effective-dated task ownership. tasks.assignee_id is the CURRENT assignee; task_assignments records who owned the
-- task from which operational (Vietnam) date. Work dated before a reassignment's effective date (completed
-- occurrences, completed one-time tasks) stays credited to the person who owned it then.
-- Owner of a date: the assignment with the latest effective_from on or before that date (the earliest assignment
-- for dates before it). Rollback: db/rollback/002_effective_ownership.down.sql
create table task_assignments (
  task_id uuid not null references tasks(id) on delete restrict,
  assignee_id uuid not null references users(id) on delete restrict,
  effective_from date not null,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references users(id) on delete restrict,
  primary key (task_id, effective_from)
);
create index task_assignments_assignee on task_assignments (assignee_id);

-- Every task starts with one assignment, however it was created (API, series continuation or import). It is
-- effective "from the start" (stored as 2000-01-01, the earliest operational date the app accepts), so a same-day
-- reassignment adds a new row instead of replacing the original owner.
create function task_initial_assignment() returns trigger language plpgsql as $$
begin
  insert into task_assignments (task_id, assignee_id, effective_from, assigned_by)
  values (new.id, new.assignee_id, date '2000-01-01', new.creator_id)
  on conflict do nothing;
  return null;
end $$;
create trigger tasks_initial_assignment after insert on tasks for each row execute function task_initial_assignment();

-- Existing tasks (none in production yet; kept for completeness).
insert into task_assignments (task_id, assignee_id, effective_from, assigned_by)
select id, assignee_id, date '2000-01-01', creator_id from tasks
on conflict do nothing;

-- Ownership changes alter reported assignees.
create trigger assignments_reporting_epoch after insert or update or delete on task_assignments for each statement execute function bump_reporting_epoch();
