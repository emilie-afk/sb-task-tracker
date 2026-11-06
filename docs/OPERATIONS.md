# Operations: setup, deploy and rollback

Generic instructions. Keep deployment-specific values (site names, account emails, database hosts) out of this repository.

## 1. Database

Use a **separate** PostgreSQL database for the tracker (for example its own Neon project or database), or at minimum an isolated schema, with a role that can reach nothing else. Never give the tracker credentials for the marketing dashboard's database.

Example for a dedicated database (run as an owner, adapt names):

```sql
create role tracker_app login password '<generated>';
create database tracker owner tracker_admin;          -- tracker_admin runs migrations only
\c tracker
revoke all on schema public from public;
grant usage on schema public to tracker_app;
-- after migrations:
grant select, insert, update, delete on all tables in schema public to tracker_app;
grant usage, select on all sequences in schema public to tracker_app;
```

`DATABASE_URL` for the running app uses `tracker_app`; migrations run with the owner role from a trusted machine. TLS certificate verification is on by default.

Migrations (`db/migrations/*.sql`) create structure only and never insert people, brands, tasks or KPIs. The build never runs them.

```bash
DATABASE_URL=<owner connection> npm run db:migrate
```

## 2. Server settings (Netlify → Site configuration → Environment variables, Functions scope)

| Name | Value |
|---|---|
| `DATABASE_URL` | Restricted app role connection string |
| `APP_BASE_URL` | Exact `https://` origin of the site, no path |
| `APP_SECRET` | Random, at least 32 characters (`openssl rand -base64 48`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth web client for this app |
| `TRACKER_INSTANCE_ID` | Stable id reported to the dashboard, e.g. `tracker-prod` |
| `DASHBOARD_BUSINESS_IDS` | Optional; dashboard business ids brands may be mapped to (default `sb,p2s,perksradar`) |

None of these are exposed to the client build. Missing or malformed values make the affected feature fail closed (`503`), never fall back to weaker behavior.

The old `PASSWORD_<NAME>` and `BRANDS_<NAME>` variables are no longer read. Delete them from the site settings after the new sign-in works.

## 3. Google OAuth client

In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type *Web application*:

- Authorized JavaScript origins: none required.
- Authorized redirect URI: exactly `APP_BASE_URL/api/auth/callback` (no wildcard, no trailing slash).
- Scopes used: `openid email profile`.

An OAuth consent screen in *Testing* mode only admits listed test users; that is an extra Google-side restriction. Access to the tracker is still decided only by the approved People list.

## 4. First administrator (private, one time)

From a trusted machine with the production `DATABASE_URL`:

```bash
ADMIN_EMAIL='<exact Google account email>' ADMIN_NAME='<display name>' npm run provision-admin
```

It refuses to run if an administrator already exists. The account becomes active at its first successful Google sign-in. No administrator email is ever committed.

## 5. People

Administrators open **People**:

- **Add person**: exact Google email, display name, role, and (for staff) brand access. The membership is pending until the person's first approved sign-in, which binds it to their Google account. Send them the site address; the app sends no email.
- **Edit**: role and staff brand access. Effective on the person's next request.
- **Archive** (someone leaves): shows their open tasks; choose per task to reassign it or leave it for later review. Access is revoked first and independently; a failed reassignment never leaves the account active. Archived people keep their name on tasks, completed work, KPI records and history, disappear from assignment lists and default team summaries, and stay in historical filters labelled *Archived*. Nothing is transferred automatically. Reassigned work is effective-dated: occurrences and tasks completed before the reassignment stay credited to the archived person in summaries and in dashboard reporting (see RECURRENCE.md).
- **Restore**: confirm the role and brand access again; the person must sign in again.
- **Sign out everywhere**: revokes every session of that person.
- **Delete invitation**: only for an unused pending invitation without any records.
- The last active administrator can never be archived, deleted or demoted.

The Management account is added the same way, with role *Management*, after deployment.

## 6. Brands

Administrators open **Brands** to add, rename, recolor, archive, restore or (never-used only) delete brands. New brands are visible to administrators and Management immediately and to staff only after they are given access. Archiving keeps tasks, KPIs and history, blocks new tasks and assignments, and leaves existing tasks completable and movable. A task's brand can be changed or cleared (to *Unassigned brand*, visible to administrators and Management only) from the task editor.

Dashboard reporting per brand is off by default; see [REPORTING_API.md](REPORTING_API.md).

## 7. Deploy checklist

1. `npm ci && npm test && npm run build && npm run check:public` (with `PRIVATE_TERMS_FILE`).
2. Back up the database (Neon branch or `pg_dump`) before migrations.
3. Run pending migrations with the owner role.
4. Deploy; Netlify publishes only `dist/`.
5. Verify: signed-out page shows only the sign-in button; `/api/tasks` without a session answers `401`; an approved account signs in; a Management account gets `403` on any change.

## 8. Rollback

- **Code**: redeploy the previous Netlify deploy. The old code stored data in browsers, so a code rollback does not affect server data.
- **Schema**: `db/rollback/001_core.down.sql` **deletes every tracker table and record**. Use it only to remove the new tracker entirely, and only after a verified backup. To recover data, restore the backup (Neon point-in-time restore or `pg_restore`) instead.
- **Access emergency**: People → *Sign out everywhere*, or archive the account; for a global cut, revoke all sessions with `update sessions set revoked_at = now() where revoked_at is null;`.
