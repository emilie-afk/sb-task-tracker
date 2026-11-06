import { z } from "zod";
import { badRequest } from "./http";
import { isIsoDate } from "../shared/dates";
import { RULES } from "../shared/recurrence";

export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be an id");
export const isoDate = z.string().refine(isIsoDate, "must be a date (YYYY-MM-DD)");
export const version = z.number().int().min(1).max(2_147_483_647);
/** Single-line text: trimmed, no control characters. */
export const line = (max: number, min = 1) => z.string().trim().min(min).max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "contains control characters");
/** Multi-line text: newlines and tabs allowed, other control characters rejected. */
export const text = (max: number) => z.string().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "contains control characters");
export const taskType = z.enum(["routine", "adhoc", "video"]);
export const role = z.enum(["administrator", "staff", "management"]);
export const rule = z.enum(RULES);
export const email = z.string().trim().toLowerCase().max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address");
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a color like #1d9e75").transform((v) => v.toLowerCase());

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest("Some fields are not valid.", r.error.issues.slice(0, 20).map((i) => ({ field: i.path.join("."), message: i.message })));
  return r.data;
}

/** Validated query-string values. */
export function qp(url: URL, name: string, re: RegExp, fallback: string | null = null): string | null {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return fallback;
  if (v.length > 200 || !re.test(v)) throw badRequest(`Invalid ${name}.`);
  return v;
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
