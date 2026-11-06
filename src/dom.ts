// Safe DOM building. Every value from the server or the user becomes a text node or a validated attribute.
// The client never parses strings as HTML (tests/public.test.ts enforces this).
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = { on?: Record<string, (e: any) => void> } & Record<string, unknown>;

const SAFE_URL = /^(#\/|\/(?!\/)|https:\/\/)/;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "on") { for (const [ev, fn] of Object.entries(v as Record<string, (e: any) => void>)) el.addEventListener(ev, fn); continue; }
    if (k.startsWith("on")) throw new Error("use the `on` map for events");
    if ((k === "href" || k === "src" || k === "action") && !SAFE_URL.test(String(v))) continue;   // no javascript:, data: or protocol-relative URLs
    if (k === "class") el.className = String(v);
    else if (k === "value" && "value" in el) (el as any).value = String(v);
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "multiple" || k === "readOnly") (el as any)[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children.flat(10 as 1)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Node) { while (el.firstChild) el.removeChild(el.firstChild); }
export function replace(el: Node, ...children: Child[]) { clear(el); append(el, children); }

/** Applies a validated brand color to an element through the CSSOM (not an inline style attribute). */
export function tint(el: HTMLElement, color: string | null | undefined, prop: "background" | "color" = "background") {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) el.style[prop] = color;
  return el;
}

export function fmtDate(d: string | null | undefined) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const [, m, day] = d.split("-");
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m - 1] + " " + parseInt(day, 10);
}
export function fmtTime(t: string | null | undefined) {
  if (!t) return "";
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
