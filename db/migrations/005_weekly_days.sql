-- Weekly routines on chosen weekdays. A weekly series repeats on every weekday in recurrence_days (ISO 1 = Monday …
-- 7 = Sunday) from its start date (due_date). Null keeps the earlier rule: the start date's weekday.
-- Rollback: db/rollback/005_weekly_days.down.sql
alter table tasks add column recurrence_days smallint[]
  check (recurrence_days is null or (recurrence = 'weekly' and cardinality(recurrence_days) between 1 and 7
         and recurrence_days <@ array[1,2,3,4,5,6,7]::smallint[]));
