// Normalizes an export of the old browser-only tracker (made with legacy-export.html) into import candidates.
// Everything in the file is untrusted: it is size-limited, schema-checked record by record, and never trusted for
// identity, roles, permissions, passwords or sessions (those keys are not even read).
import { createHash } from "node:crypto";
import { isIsoDate, addDays, vietnamDate } from "../shared/dates";
import { occurrences } from "../shared/recurrence";

export const LEGACY_FORMAT = "sb-task-tracker-legacy-export";
export const LEGACY_LIMITS = { tasks: 5000, kpis: 1000, users: 200, rawKeyBytes: 3 * 1024 * 1024 };

export type TaskCandidate = {
  cid: string; legacy_id: string; title: string; note: string | null; type: "routine" | "adhoc" | "video";
  legacy_brand: string; legacy_assignee: string; legacy_creator: string; date: string; due: string | null;
  recurrence: "weekdays" | "weekly" | "monthly" | null; done: boolean; completed_on: string | null; completed_occurrence: string | null;
  legacy_kpi: string | null; notes: string[]; flags: string[];
};
export type KpiCandidate = {
  cid: string; legacy_id: string; legacy_owner: string; legacy_brand: string; metric: string; sub_metric: string | null;
  target: string | null; note: string | null; current: string | null; value_week_of: string; notes: string[]; flags: string[];
};
export type Invalid = { kind: "task" | "kpi" | "file"; ref: string; reason: string };

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
export const fingerprint = (kind: string, record: unknown) => createHash("sha256").update(`${kind}|${canonical(record)}`).digest("hex");

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const str = (v: unknown, max: number, ref: string, field: string, errors: string[], required = false): string | null => {
  if (v === undefined || v === null || v === "") { if (required) errors.push(`${field} is missing`); return null; }
  if (typeof v !== "string" && typeof v !== "number") { errors.push(`${field} is not text`); return null; }
  const s = String(v).trim();
  if (s.length > max) { errors.push(`${field} is longer than ${max} characters`); return null; }
  if (CTRL.test(s)) { errors.push(`${field} contains control characters`); return null; }
  if (required && !s) errors.push(`${field} is empty`);
  return s || null;
};
const key = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(v) ? v : null;

function parseKey(raw: unknown, name: string, invalid: Invalid[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") { invalid.push({ kind: "file", ref: name, reason: "not stored text" }); return null; }
  if (raw.length > LEGACY_LIMITS.rawKeyBytes) { invalid.push({ kind: "file", ref: name, reason: "too large" }); return null; }
  try { return JSON.parse(raw); } catch { invalid.push({ kind: "file", ref: name, reason: "not valid JSON" }); return null; }
}

export function normalizeLegacyExport(file: unknown) {
  const invalid: Invalid[] = [];
  const tasks: TaskCandidate[] = [], kpis: KpiCandidate[] = [];
  const people = new Map<string, string | null>();       // legacy id -> name shown in the old tracker
  const brands = new Set<string>();
  const f = file as any;
  if (!f || typeof f !== "object" || f.format !== LEGACY_FORMAT || f.version !== 1 || !f.keys || typeof f.keys !== "object")
    return { ok: false as const, error: "This is not a Task Tracker legacy export file." };
  const exportedAt = typeof f.exported_at === "string" && Number.isFinite(Date.parse(f.exported_at)) ? new Date(f.exported_at) : null;
  if (!exportedAt) return { ok: false as const, error: "The export has no valid export time." };
  const exportDay = vietnamDate(exportedAt);

  const users = parseKey(f.keys.tt_users, "tt_users", invalid);
  if (Array.isArray(users)) for (const u of users.slice(0, LEGACY_LIMITS.users)) {
    // Only the id and display name are used, to help map people. Roles, manager flags and brand lists are ignored.
    const id = key(u?.id);
    if (id) people.set(id, typeof u?.name === "string" && u.name.length <= 120 && !CTRL.test(u.name) ? u.name.trim() : null);
  }

  const rawTasks = parseKey(f.keys.tt_tasks, "tt_tasks", invalid);
  if (rawTasks !== null && !Array.isArray(rawTasks)) invalid.push({ kind: "file", ref: "tt_tasks", reason: "not a list" });
  const taskList = Array.isArray(rawTasks) ? rawTasks : [];
  if (taskList.length > LEGACY_LIMITS.tasks) invalid.push({ kind: "file", ref: "tt_tasks", reason: `more than ${LEGACY_LIMITS.tasks} tasks; the rest were ignored` });
  taskList.slice(0, LEGACY_LIMITS.tasks).forEach((t: any, i: number) => {
    const ref = `task #${i + 1}`;
    const errors: string[] = [];
    if (!t || typeof t !== "object" || Array.isArray(t)) { invalid.push({ kind: "task", ref, reason: "not a task record" }); return; }
    const legacyId = typeof t.id === "number" && Number.isSafeInteger(t.id) ? String(t.id) : typeof t.id === "string" && /^\w{1,40}$/.test(t.id) ? t.id : null;
    if (!legacyId) errors.push("id is missing");
    const title = str(t.title, 300, ref, "title", errors, true);
    const note = str(t.note, 2000, ref, "note", errors);
    const kpi = str(t.kpi, 160, ref, "KPI label", errors);
    const brand = key(t.brand), assignee = key(t.assignee), creator = key(t.createdBy) ?? assignee;
    if (!brand) errors.push("brand is missing");
    if (!assignee) errors.push("assignee is missing");
    const type = ["routine", "adhoc", "video"].includes(t.type) ? t.type : null;
    if (!type) errors.push("type is not routine, ad hoc or video");
    const date = isIsoDate(t.date) ? t.date : null;
    if (!date) errors.push("created date is missing or invalid");
    const due = t.due === "" || t.due === undefined || t.due === null ? null : isIsoDate(t.due) ? t.due : (errors.push("due date is invalid"), null);
    const repeat = t.repeat === undefined || t.repeat === "" || t.repeat === "none" ? null : ["daily", "weekly", "monthly"].includes(t.repeat) ? t.repeat : (errors.push("repeat value is invalid"), null);
    if (typeof t.done !== "boolean") errors.push("done flag is invalid");
    const completedAt = t.completedAt === undefined || t.completedAt === null || t.completedAt === "" ? null : isIsoDate(t.completedAt) ? t.completedAt : (errors.push("completion date is invalid"), null);
    if (errors.length) { invalid.push({ kind: "task", ref: legacyId ? `${ref} (old id ${legacyId})` : ref, reason: errors.join("; ") }); return; }

    const notes: string[] = [];
    // The source record exactly as stored: its fingerprint makes repeated imports idempotent.
    const source = { id: legacyId, title, note, kpi, brand, assignee, createdBy: creator, type, date, due, repeat, done: t.done, completedAt };
    let recurrence: TaskCandidate["recurrence"] = null, completedOn: string | null = null, completedOcc: string | null = null;
    if (repeat) {
      const rule: "weekdays" | "weekly" | "monthly" = repeat === "daily" ? "weekdays" : (repeat as "weekly" | "monthly");
      recurrence = rule;
      if (repeat === "daily") notes.push("Old \"Daily\" repeat (Mon–Fri) becomes Weekdays.");
      if (!due) notes.push("The first due date is the date the task was created.");
      if (t.done) {
        const anchor = due ?? date!;
        const until = completedAt ?? date!;
        completedOcc = until >= anchor ? occurrences(rule, anchor, addDays(until, -400), until).pop() ?? null : null;
        notes.push(completedOcc ? `The old tracker marked the whole series done; that is recorded as completion of the ${completedOcc} occurrence only.` : "The old tracker marked the series done before its first occurrence; no occurrence is marked done.");
      }
    } else if (t.done) {
      completedOn = completedAt ?? date!;
      if (!completedAt) notes.push("No completion date was stored; the created date is used.");
    }
    if (!people.has(assignee!)) people.set(assignee!, null);
    if (!people.has(creator!)) people.set(creator!, null);
    brands.add(brand!);
    tasks.push({
      cid: fingerprint("task", source), legacy_id: legacyId!, title: title!, note, type, legacy_brand: brand!, legacy_assignee: assignee!, legacy_creator: creator!,
      date: date!, due: recurrence ? due ?? date! : due, recurrence, done: t.done, completed_on: completedOn, completed_occurrence: completedOcc, legacy_kpi: kpi, notes, flags: [],
    });
  });

  const rawKpis = parseKey(f.keys.tt_kpis, "tt_kpis", invalid);
  if (rawKpis && typeof rawKpis === "object" && !Array.isArray(rawKpis)) {
    for (const [owner, byBrand] of Object.entries(rawKpis as Record<string, unknown>).slice(0, LEGACY_LIMITS.users)) {
      if (!key(owner) || !byBrand || typeof byBrand !== "object" || Array.isArray(byBrand)) { invalid.push({ kind: "kpi", ref: `scorecard ${kpis.length + 1}`, reason: "not a scorecard" }); continue; }
      for (const [brand, list] of Object.entries(byBrand as Record<string, unknown>)) {
        if (!key(brand) || !Array.isArray(list)) { invalid.push({ kind: "kpi", ref: "scorecard brand", reason: "not a list of KPIs" }); continue; }
        for (const k of list.slice(0, 200)) {
          if (kpis.length >= LEGACY_LIMITS.kpis) break;
          const errors: string[] = [];
          const ref = `KPI ${kpis.length + 1}`;
          const metric = str(k?.metric, 160, ref, "metric", errors, true), sub = str(k?.sub, 160, ref, "sub-metric", errors);
          const target = str(k?.target, 40, ref, "target", errors), note = str(k?.note, 500, ref, "note", errors), current = str(k?.current, 40, ref, "current value", errors);
          const legacyId = typeof k?.id === "string" && /^\w{1,40}$/.test(k.id) ? k.id : "";
          if (errors.length) { invalid.push({ kind: "kpi", ref, reason: errors.join("; ") }); continue; }
          const source = { owner, brand, id: legacyId, metric, sub, target, note, current };
          if (!people.has(owner)) people.set(owner, null);
          brands.add(brand);
          kpis.push({ cid: fingerprint("kpi", source), legacy_id: legacyId, legacy_owner: owner, legacy_brand: brand, metric: metric!, sub_metric: sub, target, note, current,
            value_week_of: exportDay, notes: current ? [`The current value is stored for the week of ${exportDay} (the export date).`] : [], flags: [] });
        }
      }
    }
  } else if (rawKpis !== null) invalid.push({ kind: "file", ref: "tt_kpis", reason: "not a scorecard object" });

  // Same record exported from two browsers: identical content has the same fingerprint and is imported once.
  const seen = new Set<string>();
  const uniqTasks = tasks.filter((t) => (seen.has(t.cid) ? false : (seen.add(t.cid), true)));
  const uniqKpis = kpis.filter((k) => (seen.has(k.cid) ? false : (seen.add(k.cid), true)));
  flagTaskConflicts(uniqTasks);
  return { ok: true as const, exported_at: exportedAt.toISOString(), tasks: uniqTasks, kpis: uniqKpis, invalid,
    people: [...people.entries()].map(([legacy_id, name]) => ({ legacy_id, name })), brands: [...brands] };
}

/**
 * Old numeric ids are per browser and can collide; titles can repeat for different work. Nothing is merged or
 * chosen automatically: candidates that look related are flagged for the administrator to review.
 */
export function flagTaskConflicts(tasks: TaskCandidate[]) {
  const byId = new Map<string, TaskCandidate[]>(), byOrigin = new Map<string, TaskCandidate[]>();
  for (const t of tasks) {
    byId.set(t.legacy_id, [...(byId.get(t.legacy_id) ?? []), t]);
    const origin = `${t.title.toLowerCase()}|${t.legacy_creator}|${t.date}`;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), t]);
  }
  for (const group of byId.values()) if (group.length > 1)
    for (const t of group) t.flags.push(`Old id ${t.legacy_id} is used by ${group.length} different records (exports from different browsers). They are kept separate.`);
  for (const group of byOrigin.values()) if (group.length > 1) {
    const differs = (f: (t: TaskCandidate) => unknown) => new Set(group.map((t) => JSON.stringify(f(t)))).size > 1;
    const fields = [differs((t) => t.due) && "due date", differs((t) => t.legacy_assignee) && "owner", differs((t) => [t.done, t.completed_on]) && "completion",
      differs((t) => t.legacy_brand) && "brand", differs((t) => t.recurrence) && "repeat", differs((t) => t.note) && "note"].filter(Boolean);
    for (const t of group) t.flags.push(fields.length
      ? `Possible copies of one task with conflicting ${fields.join(", ")}. Review and select the right version; nothing is chosen automatically.`
      : "Possible duplicate: same title, creator and date as another record. Review before selecting both.");
  }
}
