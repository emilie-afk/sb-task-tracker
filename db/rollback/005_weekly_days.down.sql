-- Rolls back 005. Weekly series that used several weekdays fall back to their start date's weekday only; deploy the
-- previous build first. Completions of occurrences on other weekdays are kept but no longer shown.
alter table tasks drop column if exists recurrence_days;
delete from schema_migrations where name = '005_weekly_days.sql';
