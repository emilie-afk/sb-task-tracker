# Task Tracker

A private team workspace for tasks, recurring work, KPI scorecards and daily/period summaries, with approved Google sign-in and three roles (Administrator, Staff, Management).

This repository is **public**. It contains code, generic documentation and fictional test data only. People, brands, tasks, KPIs, imports and every credential live privately in the server database and server settings, and are reachable only through authenticated, authorized APIs.

| Topic | Document |
|---|---|
| Setup: database, Google OAuth, first administrator, People and Brands | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Moving data out of the old browser-only tracker | [docs/MIGRATION.md](docs/MIGRATION.md) |
| Recurrence, Vietnam dates and how summaries count | [docs/RECURRENCE.md](docs/RECURRENCE.md) |
| Read-only reporting API for the marketing dashboard | [docs/REPORTING_API.md](docs/REPORTING_API.md) |

Stack: TypeScript client (Vite, no framework) published from `dist/`; one Netlify Function API (`/api/*`); PostgreSQL; Google OAuth (authorization code + PKCE, ID token verified with `jose`); server-side sessions.

## Roles

| Capability | Administrator | Staff | Management |
|---|---|---|---|
| Read brands and tasks | All | Assigned brands only | All |
| KPI scorecards | All | Own, in assigned brands | All |
| Team summaries | All | Own | All |
| Create tasks | Yes | For self, in assigned brands | No |
| Edit, complete, delete tasks | All | Own, in assigned brands | No |
| Assign, reassign, change or clear a task's brand | Yes | No | No |
| KPI definitions, targets, values; imports | Yes | No | No |
| People, brands, integrations | Yes | No | No |

Every rule is enforced on the server (`server/policy.ts`, route role lists, record checks). Management receives `403` for every business change.

## Local development

```bash
npm install
export TEST_DATABASE_URL=postgresql://localhost/tracker_test   # disposable: its schema is dropped
npm test
npm run build && npm run check:public                            # PRIVATE_TERMS_FILE adds private words to block
DATABASE_URL=postgresql://localhost/tracker_dev npm run db:migrate
DATABASE_URL=... APP_BASE_URL=http://localhost:8888 APP_SECRET=<32+ chars> LOCAL_DEV_LOGIN=1 npm run dev
```

`LOCAL_DEV_LOGIN=1` adds `/dev/login?user=<id>` for fictional local accounts only; the dev server refuses to start on Netlify and the deployed function has no such route.

Browser regression tests run inside `npm test` when a Playwright Chromium is installed (`npx playwright install chromium`, or set `PLAYWRIGHT_BROWSERS_PATH`); without one they are reported as skipped.

Before every push: `npm test`, `npm run build`, `npm run check:public` with `PRIVATE_TERMS_FILE` pointing at a local (git-ignored) list of private names and terms.
