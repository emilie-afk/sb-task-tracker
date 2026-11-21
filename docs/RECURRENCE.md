# Recurrence, dates and summaries

## Dates

- **Operational dates** (created date, due date, completion date, occurrence dates, KPI weeks) are calendar dates in **Vietnam time** (`Asia/Ho_Chi_Minh`, UTC+7, no daylight saving). The day changes at 17:00 UTC.
- **Event timestamps** (sign-ins, completion instants, audit events, history) are stored in UTC and shown in Vietnam time.
- KPI values are per week; a week starts on Monday (Vietnam).
- Imports keep the original dates of each record. Nothing is re-dated using the import day.

## Recurring tasks

A recurring task is **one series record** with a rule and a start date (the anchor, stored as `due_date`). Occurrences are computed, never stored as separate tasks. Each occurrence has a stable identity: `(task id, occurrence date)`.

| Rule | Occurrences |
|---|---|
| `daily` | Every calendar day from the anchor |
| `weekdays` | Monday to Friday from the anchor (the old tracker's "Daily (Mon–Fri)") |
| `weekly` | Every week on the chosen weekdays (`recurrence_days`, ISO 1 = Monday … 7 = Sunday), from the start date. New weekly series always store their weekdays (default: the start date's weekday); a series stored without weekdays uses the start date's weekday |
| `monthly` | The anchor's day of month. If a month is shorter (anchor on the 29th–31st), that month's **last day**: an anchor of Jan 31 gives Feb 28 (Feb 29 in leap years), Mar 31, Apr 30… |

- **Completing** marks one occurrence done (`task_occurrences`). It never completes the series, another occurrence, or creates a task. Reopening removes that one completion.
- A task card shows the earliest unfinished occurrence of the last 7 days (marked overdue when before today); otherwise today's occurrence when done; otherwise the next upcoming one; for a series that has ended, its last occurrence (overdue if unfinished). List and detail load completion records for exactly these candidate occurrences, so they always agree.
- **Editing title, note or type** applies to the whole series.
- **Changing the rule, weekdays or start date** of a series that has already started takes effect from a chosen date (today or later): the current series ends the day before (its occurrences, completions and ownership history stay with it) and a new series continues from that date, linked by `previous_series_id`. A completion on or after the effective date blocks the change until it is unmarked. Turning repetition off works the same way and continues as a one-time task from today. Before a series starts, the schedule is edited in place.
- An ended series is never extended by a schedule change: restarting it keeps its own end date. A series has at most one continuation; its end date must stay before the continuation's start (it cannot be moved onto or past it, or cleared), and a continuation cannot move its start back over the series it continues, so no date is produced twice.
- New **Routine** tasks default to *Repeat weekly* from today on today's weekday; the weekdays, start date and optional end date can be changed in the form.
- **Cancelling** a series means setting *Repeat until*: no occurrences after that date. It cannot be set before an occurrence that is already marked done.
- **Deleting** a recurring task hides the whole series (soft delete; history kept).

## Ownership and reassignment

A task's assignee can change (administrator reassignment, the task editor, or when someone is archived). Ownership is **effective-dated** (`task_assignments`):

- The original assignee owns the task from the start. A reassignment takes effect from today (Vietnam), or from the day after the latest completed work on the task if that is later, so completed work never changes hands. Reassigning twice on one day keeps the latest choice.
- Each occurrence belongs to whoever owned the task on its date; a completed one-time task belongs to whoever owned it on its completion date; an open one-time task belongs to its current assignee.
- Completion dates, completion actors and history are never rewritten. The task detail lists the ownership periods; the occurrence list shows each occurrence's owner.
- Staff can complete or reopen only occurrences in their own ownership period (administrators can change any). For everyone, an occurrence can be completed at most 31 days ahead (today + 31 is allowed, today + 32 is not). Cards, the occurrence list and the completion endpoint use this one rule.
- Task cards separate the two permissions: `can_edit` (edit the series) and `can_complete` (complete the occurrence the card shows, also given on `occurrence` with its owner). A staff member who has owned the task sees their own period on the card, so a replacement sees and completes their own occurrence without clearing the previous owner's backlog; administrators see the whole series, with older occurrences labelled with their owner. Occurrences someone cannot complete show a disabled control with the reason (`completion_blocked`: `other_owner`, `view_only`, or `too_far_ahead` with `completable_from`). The task detail lists each occurrence with its owner and a control only where completion is allowed.
- Summaries and the dashboard reporting API use the same rule. Nothing is transferred to a replacement automatically.

## Roles and who holds tasks

- **Administrators** manage the team's work: brands, people, tasks, KPIs, imports and integrations. They create, edit, assign, reassign, complete, reopen and delete anyone's tasks, but they are never given new tasks: assignment, reassignment, the planning API and the assignee pickers accept active staff only. Tasks an administrator already held keep their history and stay readable; they can be edited or reassigned to staff.
- **Staff** hold and carry out tasks in their assigned brands, and complete or reopen only work they own.
- **Management** reads every brand and task; every change is refused on the server.
- The task-doer filter, team workload and team summaries list staff only.

## Closed work (archived people)

Unfinished work whose owner is archived is **closed**: a one-time task still held by an archived person, and each unfinished occurrence dated in an archived owner's period (including future ones of a series still assigned to them). Closed work is not open, not done and not counted anywhere: not in the timeline, overdue lists, week counts, team workload, summaries or dashboard reporting (the dashboard drops its copy). Finished work keeps its credit. Reassigning a closed task to an active staff member reopens it for them from the reassignment date; an administrator can still record a closed occurrence as done (a correction credited to its owner) from the task detail. Restoring the person reopens their unfinished work.

## Weekly timeline

The Tasks screen shows one week, **Monday to Sunday in Vietnam time** (default: this week), with previous/next buttons and a week picker showing the date range.

- **Overdue**: open work dated before today, from any week. One-time tasks have no look-back limit; repeating occurrences are looked back 14 days (older ones stay visible in their own weeks).
- **Days**: open work dated on each day of the week that is not overdue.
- **No due date**: open one-time tasks without a due date.
- **Upcoming**: open one-time tasks due after the selected week, grouped by week. Repeating occurrences appear in their own weeks.
- **Completed this week** (collapsible): one-time tasks completed in the week and occurrences of the week that are done.
- Brand, staff, type and search filters apply together; the staff filter follows each unit's effective-dated owner.
- Week counts: every unit dated in the week (each occurrence counts once; a one-time task counts in the week it is due, or in the week it was completed), done and pending, with overdue and undated counts shown separately.
- Team workload (administrators and Management): every active staff member, including those with nothing this week, with pending, done and overdue counts for the selected week and the brand, type and search filters.
- A completion records the account that ticked it (`completed_by`) and credits the work to the owner; when they differ the card and detail say "ticked by …".

## How summaries count

| Work | Counts as done | Counts as pending |
|---|---|---|
| One-time task | Its completion date is in the period | It is open now, was created on or before the period end, and is due on or before the period end (or has no due date) |
| Recurring task | Each occurrence dated in the period (up to today) that was completed | Each occurrence dated in the period, up to today, that was not completed |

Each unit is credited to its owner as described above, not to the task's current assignee.

- Future occurrences are not pending yet. A series is never counted as one completed item.
- "Routine / repeating" groups routine tasks and all occurrences; "One-time / ad hoc" covers the rest.
- Staff see only their own summaries; administrators and Management see the team (staff only). Default team summaries cover active people; archived people's finished work is included only when asked for. Closed work is never counted.
- **Task completion is not KPI performance.** Completing a task linked to a KPI never changes that KPI's values; scorecard values are entered or imported as such.
