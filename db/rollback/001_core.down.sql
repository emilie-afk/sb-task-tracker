-- Rolls back 001_core.sql. THIS DELETES EVERY TRACKER RECORD. Take a verified backup first (docs/OPERATIONS.md).
-- Run only when the new tracker must be fully removed; to restore service, redeploy the previous code instead.
drop trigger if exists credentials_reporting_epoch_update on reporting_credentials;
drop trigger if exists credentials_reporting_epoch_insert on reporting_credentials;
drop trigger if exists users_reporting_epoch on users;
drop trigger if exists brands_reporting_epoch on brands;
drop trigger if exists occurrences_reporting_epoch on task_occurrences;
drop trigger if exists tasks_reporting_epoch on tasks;
drop function if exists bump_reporting_epoch();
drop table if exists audit_events;
drop table if exists reporting_state;
drop table if exists reporting_credentials;
drop table if exists reporting_exposures;
drop table if exists task_history;
drop table if exists task_occurrences;
drop table if exists tasks;
drop table if exists import_records;
drop table if exists import_batches;
drop table if exists kpi_values;
drop table if exists kpi_definitions;
drop table if exists oauth_states;
drop table if exists sessions;
drop table if exists user_brand_access;
drop table if exists brands;
drop table if exists users;
drop table if exists rate_limits;
delete from schema_migrations where name = '001_core.sql';
