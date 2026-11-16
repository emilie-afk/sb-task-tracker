-- Rolls back 003. Tasks created from marketing plans stay as ordinary tasks; only their plan links are lost.
drop table if exists task_plan_fences;
drop table if exists task_plan_links;
drop table if exists planning_credentials;
delete from schema_migrations where name = '003_planning_integration.sql';
