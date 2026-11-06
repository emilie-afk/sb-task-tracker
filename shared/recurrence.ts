// Recurrence. A recurring task is one series record anchored on its first due date; occurrences are computed,
// never stored as separate tasks. Completing an occurrence stores (task_id, occurrence_date) only.
//
//   daily     every calendar day from the anchor
//   weekdays  Monday to Friday from the anchor (the old tracker's "Daily (Mon–Fri)")
//   weekly    the anchor's weekday, every week
//   monthly   the anchor's day of month; when a month is shorter (anchor on the 29th–31st), the month's last day
//
// The series ends on recurrence_until (inclusive) when set. Occurrence identity is stable: the same rule, anchor
// and date always produce the same occurrence, so a completion can never complete another occurrence.
import { addDays, daysInMonth, fmt, isoWeekday, isIsoDate } from "./dates";

export const RULES = ["daily", "weekdays", "weekly", "monthly"] as const;
export type Rule = (typeof RULES)[number];
export const isRule = (r: unknown): r is Rule => typeof r === "string" && (RULES as readonly string[]).includes(r);

/** Occurrence dates of a series inside [from, to], inclusive and ascending. Bounded to 1,000 results. */
export function occurrences(rule: Rule, anchor: string, from: string, to: string, until?: string | null): string[] {
  if (!isIsoDate(anchor) || !isIsoDate(from) || !isIsoDate(to)) throw new Error("invalid date");
  const end = until && until < to ? until : to;
  const start = anchor > from ? anchor : from;
  const out: string[] = [];
  if (start > end) return out;
  if (rule === "monthly") {
    const day = Number(anchor.slice(8, 10));
    let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
    for (let i = 0; i < 1200 && out.length < 1000; i++) {
      const d = fmt(y, m, Math.min(day, daysInMonth(y, m)));
      if (d > end) break;
      if (d >= start) out.push(d);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }
  if (rule === "weekly") {
    const offset = (isoWeekday(anchor) - isoWeekday(start) + 7) % 7;
    for (let d = addDays(start, offset); d <= end && out.length < 1000; d = addDays(d, 7)) out.push(d);
    return out;
  }
  for (let d = start; d <= end && out.length < 1000; d = addDays(d, 1)) {
    if (rule === "weekdays" && isoWeekday(d) > 5) continue;
    out.push(d);
  }
  return out;
}

export const isOccurrence = (rule: Rule, anchor: string, date: string, until?: string | null) =>
  isIsoDate(date) && occurrences(rule, anchor, date, date, until).length === 1;

/** The next occurrence strictly after `date`, or null when the series has ended. */
export function nextOccurrence(rule: Rule, anchor: string, date: string, until?: string | null): string | null {
  const from = addDays(date, 1);
  return occurrences(rule, anchor, from, addDays(from, 366), until)[0] ?? null;
}

/** Stable occurrence identity used in APIs and reporting. */
export const occurrenceKey = (taskId: string, date: string) => `${taskId}:${date}`;
