import { h, replace } from "./dom";
import { errorText } from "./api";

/** A modal dialog. Returns a close function. */
export function modal(title: string, body: (Node | null)[], opts: { wide?: boolean; onClose?: () => void } = {}) {
  const box = h("div", { class: "modal" + (opts.wide ? " wide" : ""), role: "dialog", "aria-modal": "true" }, h("div", { class: "modal-t" }, title), ...body);
  const overlay = h("div", { class: "overlay on", on: { mousedown: (e: MouseEvent) => { if (e.target === overlay) close(); } } }, box);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  function close() { overlay.remove(); document.removeEventListener("keydown", onKey); opts.onClose?.(); }
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  return close;
}

export function msg(kind: "error" | "notice" | "ok", text: string) { return h("div", { class: kind, role: kind === "error" ? "alert" : "status" }, text); }

/** Runs an action, showing its error (if any) in `slot`. Returns true on success. */
export async function attempt(slot: HTMLElement, f: () => Promise<unknown>) {
  replace(slot);
  try { await f(); return true; } catch (e) { replace(slot, msg("error", errorText(e))); return false; }
}

export function select(options: [string, string][], value: string | null, attrs: Record<string, any> = {}) {
  return h("select", attrs, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
}
export const field = (label: string, control: Node) => h("div", null, h("div", { class: "fl" }, label), control);
