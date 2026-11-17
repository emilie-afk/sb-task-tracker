-- Tasks created from the marketing dashboard come either from a marketing plan (linked back to it) or from the
-- planning owner's private Slack review queue (no link back). Rollback: db/rollback/004_task_origin.down.sql
alter table task_plan_links add column origin text not null default 'plan' check (origin in ('plan', 'review'));
