# Recurrence, dates and summaries

## Dates

- **Operational dates** (created date, due date, completion date, occurrence dates, KPI weeks) are calendar dates in **Vietnam time** (`Asia/Ho_Chi_Minh`, UTC+7, no daylight saving). The day changes at 17:00 UTC.
- **Event timestamps** (sign-ins, completion instants, audit events, history) are stored in UTC and shown in Vietnam time.
- KPI values are per week; a week starts on Monday (Vietnam).
- Imports keep the original dates of each record. Nothing is re-dated using the import day.

## Recurring tasks

A recurring task is **one series record** with a rule and a first due date (the anchor). Occurrences are computed, never stored as separate tasks. Each occurrence has a stable identity: `(task id, occurrence date)`.

| Rule | Occurrences |
|---|---|
| `daily` | Every calendar day from the anchor |
| `weekdays` | Monday to Friday from the anchor (the old tracker's "Daily (Mon–Fri)") |
| `weekly` | The anchor's weekday, every week |
| `monthly` | The anchor's day of month. If a month is shorter (anchor on the 29th–31st), that month's **last day**: an anchor of Jan 31 gives Feb 28 (Feb 29 in leap years), Mar 31, Apr 30… |

- **Completing** marks one occurrence done (`task_occurrences`). It never completes the series, another occurrence, or creates a task. Reopening removes that one completion.
- A task card shows the earliest unfinished occurrence of the last 7 days (marked overdue when before today); otherwise today's occurrence when done; otherwise the next upcoming one; for a series that has ended, its last occurrence (overdue if unfinished). List and detail load completion records for exactly these candidate occurrences, so they always agree.
- **Editing title, note or type** applies to the whole series.
- **Changing the rule or first date** of a series that has already started ends the current series yesterday (its completions stay with it) and continues as a new series from the new first date (today or later). Turning repetition off works the same way and continues as a one-time task. Before a series starts, the schedule is edited in place.
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

## How summaries count

| Work | Counts as done | Counts as pending |
|---|---|---|
| One-time task | Its completion date is in the period | It is open now, was created on or before the period end, and is due on or before the period end (or has no due date) |
| Recurring task | Each occurrence dated in the period (up to today) that was completed | Each occurrence dated in the period, up to today, that was not completed |

Each unit is credited to its owner as described above, not to the task's current assignee.

- Future occurrences are not pending yet. A series is never counted as one completed item.
- "Routine / repeating" groups routine tasks and all occurrences; "One-time / ad hoc" covers the rest.
- Staff see only their own summaries; administrators and Management see the team. Default team summaries cover active people; archived people's work is included only when asked for.
- **Task completion is not KPI performance.** Completing a task linked to a KPI never changes that KPI's values; scorecard values are entered or imported as such.
