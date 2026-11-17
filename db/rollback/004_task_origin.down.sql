-- Rolls back 004. Review-queue tasks then look like plan tasks (their "Open the plan" link leads to a page that
-- answers "not available"); deploy the previous build first.
alter table task_plan_links drop column if exists origin;
delete from schema_migrations where name = '004_task_origin.sql';
