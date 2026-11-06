// Authorization rules in one place. Every list, detail, search, summary, count, import and mutation goes through
// these functions; nothing trusts identity, role or brand values sent by the browser.
import type { Session } from "./auth";
import { forbidden } from "./http";

export const isAdmin = (s: Session) => s.role === "administrator";
export const readsAll = (s: Session) => s.allBrands;   // administrators and Management

/** May this person read records of this brand (null = Unassigned brand)? */
export function canReadBrand(s: Session, brandId: string | null) {
  if (s.allBrands) return true;
  return brandId !== null && s.brandIds.has(brandId);
}

/**
 * SQL condition limiting tasks (alias `t`) to what this person may read. Applied inside the query, before
 * pagination and aggregation. Staff never see Unassigned-brand tasks (brand_id is null fails `= any`).
 */
export function taskReadScope(s: Session, params: unknown[], alias = "t") {
  if (s.allBrands) return "true";
  params.push([...s.brandIds]);
  return `${alias}.brand_id = any($${params.length}::uuid[])`;
}

/** Staff may edit, complete and delete only their own tasks inside brands they are assigned to. */
export function canEditTask(s: Session, t: { assignee_id: string; brand_id: string | null }) {
  if (isAdmin(s)) return true;
  if (s.role !== "staff") return false;
  return t.assignee_id === s.userId && t.brand_id !== null && s.brandIds.has(t.brand_id);
}
export function assertCanEditTask(s: Session, t: { assignee_id: string; brand_id: string | null }) {
  if (!canEditTask(s, t)) throw forbidden("You can change only your own tasks in brands you are assigned to.");
}

/** Whose KPI scorecards and personal summaries this person may read. */
export function canReadPersonal(s: Session, ownerId: string) {
  return s.allBrands || ownerId === s.userId;
}

/** Fields staff may change on their own tasks. Everything else is administrator-only. */
export const STAFF_TASK_FIELDS = new Set(["title", "note", "type", "due_date", "recurrence", "recurrence_until"]);
