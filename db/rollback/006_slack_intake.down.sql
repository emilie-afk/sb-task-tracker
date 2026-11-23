-- Rolls back 006. Tasks created from Slack stay as ordinary tasks; their Slack links, review items and processing
-- state are lost. Deploy the previous build first.
drop table if exists slack_intake_batches;
drop table if exists slack_request_claims;
drop table if exists slack_review_items;
drop table if exists slack_replies;
drop table if exists slack_task_series;
drop table if exists slack_task_links;
drop table if exists slack_channel_brands;
drop table if exists slack_user_links;
drop table if exists slack_intake_state;
drop table if exists slack_intake_credentials;
delete from schema_migrations where name = '006_slack_intake.sql';
