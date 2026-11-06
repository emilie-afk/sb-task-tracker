# Moving data out of the old browser-only tracker

The old tracker kept tasks (`tt_tasks`), KPI scorecards (`tt_kpis`), a user list (`tt_users`), brand permissions (`tt_perms`) and an id counter (`tt_nid`) in each browser's local storage. Browsers were never synchronized, so each one may hold a different version.

Nothing is erased automatically, and nothing is imported without an administrator's explicit selection.

## Before you start

- Deploy the new tracker on the **same site address** as the old one: browsers only expose saved data to the same address.
- Do not clear browser data, reinstall browsers or use private windows on the computers that used the old tracker until their export is done.
- Keep export files private: not in Git, chat channels or shared folders. Delete them once the import is verified.

## 1. Export from every browser that was used

On each computer and browser profile that used the old tracker:

1. Open `<site address>/legacy-export.html`.
2. The page reports how many tasks and KPIs it found (contents are not displayed).
3. Click **Download export file**. The file is saved on that computer only. Nothing is sent anywhere, and nothing is erased.
4. Give the file privately to an administrator, labelled with which browser it came from.

The helper exports only `tt_tasks`, `tt_kpis`, `tt_users` (used only to suggest who is who) and `tt_nid`. It does not read brand permissions, and old passwords were never stored in browsers.

## 2. Preview each file (administrators)

**Imports** → choose the file, give it a label → **Preview**. The preview shows:

- counts of tasks and KPIs, records that are invalid and why, records already imported;
- people mapping: each old login id → a person in the People list (suggested by name; you must confirm). Roles, manager flags and permissions from the old data are ignored;
- brand mapping: each old brand key → a brand, or *Unassigned brand*;
- notes per record (for example: old "Daily" becomes *Weekdays*; a recurring task marked done is recorded as completion of one occurrence only; a missing completion date uses the created date);
- flags for review:
  - the same old numeric id used by different records (ids were per browser, so they collide);
  - possible copies of one task (same title, creator and created date) with conflicting due date, owner, completion, brand, repeat or note. Nothing is merged or chosen automatically; flagged records start unselected.

## 3. Commit selected records

Select records and click **Import selected**. All mappings are validated first; if anything is missing (an unmapped person, a person without access to the mapped brand — access is never granted by an import, a Management account as owner), nothing is written.

Each committed record gets a new server id, keeps its original created, due and completion dates, and records its provenance (import batch and source fingerprint). The fingerprint covers the record's complete content, so:

- importing the same file again, or the same record exported from another browser, does not create a duplicate;
- different records that share an old id or a title stay separate.

KPI scorecards import as definitions; a stored current value is saved for the week of the export.

## 4. Verify, then clean up

1. Compare counts per person and brand with the old tracker in each browser.
2. Spot-check dates, completions and repeating tasks.
3. Delete the export files.
4. Only then, optionally, clear the old data in each browser (site settings → clear data).

## KPI spreadsheets

KPI scorecards can also be imported from an EOS scorecard `.xlsx` (KPI panel → **Upload Excel**, administrators): metric in column A (carried down to following rows), sub-metric in column B, first number from column C onward as the target; the first three rows are headers. Files are limited to 1 MB, 500 rows, 30 columns, 10,000 cells and 160 characters per cell, and are parsed on the server.
