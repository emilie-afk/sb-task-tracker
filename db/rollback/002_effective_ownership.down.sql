-- Rolls back 002. Historical ownership is lost: every task is attributed to its current assignee again.
drop trigger if exists assignments_reporting_epoch on task_assignments;
drop trigger if exists tasks_initial_assignment on tasks;
drop function if exists task_initial_assignment();
drop table if exists task_assignments;
delete from schema_migrations where name = '002_effective_ownership.sql';
