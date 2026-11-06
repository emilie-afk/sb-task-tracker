// Calendar-date helpers. Operational task dates are 'YYYY-MM-DD' strings in Vietnam time (Asia/Ho_Chi_Minh,
// UTC+7, no daylight saving). Event timestamps (sign-ins, completions, audit) are stored in UTC.
export const OPERATIONS_TZ = "Asia/Ho_Chi_Minh";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month1: number) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function parts(s: string) {
  if (!isIsoDate(s)) throw new Error("invalid date");
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}
export const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const toMs = (s: string) => { const p = parts(s); return Date.UTC(p.y, p.m - 1, p.d); };
const fromMs = (ms: number) => { const t = new Date(ms); return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

export const addDays = (s: string, n: number) => fromMs(toMs(s) + n * 86_400_000);
export const dayDiff = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / 86_400_000);
/** ISO weekday, Monday = 1 … Sunday = 7. */
export const isoWeekday = (s: string) => new Date(toMs(s)).getUTCDay() || 7;
export const weekStart = (s: string) => addDays(s, 1 - isoWeekday(s));
export const monthStart = (s: string) => s.slice(0, 8) + "01";
export function monthEnd(s: string) { const p = parts(s); return fmt(p.y, p.m, daysInMonth(p.y, p.m)); }

/** The calendar date in Vietnam at the given instant. Vietnam is UTC+7 all year. */
export function vietnamDate(at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return fromMs(ms + 7 * 3_600_000);
}

/** Today in Vietnam. Overridable in tests to check midnight behavior. */
let clock: () => number = () => Date.now();
export function _setClockForTests(f: (() => number) | null) { clock = f ?? (() => Date.now()); }
export const now = () => clock();
export const todayVN = () => vietnamDate(clock());

/** Named periods used by the summaries, in Vietnam dates. */
export function periodRange(period: string, today: string): { from: string; to: string } | null {
  switch (period) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = addDays(today, -1); return { from: y, to: y }; }
    case "mtd": return { from: monthStart(today), to: today };
    case "lm": { const last = addDays(monthStart(today), -1); return { from: monthStart(last), to: last }; }
    default: return null;
  }
}
