// Tasks screen: brand tabs, filters, single and bulk task creation, task cards, edit and detail dialogs, daily
// summary, KPI scorecard, team workload and period analytics. Management sees everything read-only.
import { h, replace, clear, tint, fmtDate, fmtTime, initials } from "../dom";
import { api, errorText, ApiError } from "../api";
import { modal, msg, attempt, select, field } from "../ui";
import type { Ctx } from "../main";

/** Why an occurrence's completion control is disabled (same reasons the server enforces). */
function blockedText(o: any): string {
  if (!o) return "View only";
  if (o.completion_blocked === "too_far_ahead") return `Can be completed from ${fmtDate(o.completable_from)}`;
  if (o.completion_blocked === "other_owner") return `Belongs to ${o.owner?.name ?? "someone else"}`;
  return "View only";
}

type Brand = { id: string; display_name: string; color: string | null; status: string; version: number };
type Person = { id: string; display_name: string; role: string; archived: boolean };

const TYPES: [string, string][] = [["routine", "Routine"], ["adhoc", "Ad hoc"], ["video", "Video"]];
const REPEATS: [string, string][] = [["", "No repeat"], ["daily", "Daily (every day)"], ["weekdays", "Weekdays (Mon–Fri)"], ["weekly", "Weekly"], ["monthly", "Monthly"]];
const REPEAT_LABEL: Record<string, string> = { daily: "↻ Daily", weekdays: "↻ Weekdays", weekly: "↻ Weekly", monthly: "↻ Monthly" };

export async function tasksView(root: HTMLElement, ctx: Ctx) {
  const me = ctx.me;
  const isAdmin = me.role === "administrator", isMgmt = me.role === "management", readsAll = isAdmin || isMgmt;
  const state = { brand: "all", brandStatus: "active", person: me.role === "staff" ? me.id : "all", type: "all", q: "", period: "today", from: ctx.today, to: ctx.today, showArchivedPeople: false };
  let brands: Brand[] = [], people: Person[] = [];

  const btabs = h("div", { class: "btabs" });
  const personFilter = h("div", { class: "row" });
  const typeChips = h("div", { class: "row" });
  const search = h("input", { type: "text", class: "search-in", placeholder: "Search…", "aria-label": "Search tasks", on: { input: debounce(() => { state.q = search.value.trim(); loadTasks(); }, 250) } });
  const addWrap = h("div", { class: "add-wrap" });
  const strip = h("div", { class: "hidden" });
  const taskArea = h("div");
  const summaryArea = h("div"), kpiArea = h("div"), teamArea = h("div"), analyticsArea = h("div");
  const archivedToggle = h("label", { class: "inline" }, h("input", { type: "checkbox", on: { change: (e: Event) => { state.brandStatus = (e.target as HTMLInputElement).checked ? "archived" : "active"; state.brand = "all"; renderBrandTabs(); loadAll(); } } }), "Archived brands");

  replace(root,
    h("div", { class: "content" },
      h("div", null,
        h("div", { class: "toolbar" }, btabs, h("div", { class: "sep" }), archivedToggle),
        h("div", { class: "toolbar" }, personFilter, h("div", { class: "sep" }), typeChips, h("div", { class: "search-wrap" }, h("span", { class: "search-icon" }, "⚲"), search)),
        addWrap, strip, taskArea,
        isMgmt ? null : h("button", { class: "btn-add", on: { click: () => openAdd() } }, "+ Add task")),
      h("div", { class: "rp" },
        h("div", { class: "panel" }, h("div", { class: "pt" }, `Today · ${fmtDate(ctx.today)}`), summaryArea),
        h("div", { class: "panel" }, h("div", { class: "pt" }, "EOS Scorecard"), kpiArea),
        readsAll ? h("div", { class: "panel" }, h("div", { class: "pt" }, "Team workload · today"), teamArea) : null,
        h("div", { class: "panel" }, h("div", { class: "pt" }, "Analytics"), analyticsArea))));

  // ------------------------------------------------------------------ filters
  function renderBrandTabs() {
    const visible = brands.filter((b) => (state.brandStatus === "archived" ? b.status === "archived" : b.status === "active"));
    const tab = (key: string, label: string, color?: string | null, archived = false) => {
      const dot = tint(h("span", { class: "dot" }), color);
      return h("button", { class: "btab" + (state.brand === key ? " on" : "") + (archived ? " arch" : ""), on: { click: () => { state.brand = key; renderBrandTabs(); loadAll(); } } }, color ? dot : null, label);
    };
    replace(btabs, tab("all", "All"), ...visible.map((b) => tab(b.id, b.display_name, b.color, b.status === "archived")),
      readsAll && state.brandStatus === "active" ? tab("unassigned", "Unassigned brand") : null);
  }
  function renderPersonFilter() {
    const list = people.filter((p) => p.role !== "management" && (state.showArchivedPeople || !p.archived || p.id === state.person));
    const chip = (id: string, label: string, archived = false) => h("button", { class: "fchip" + (state.person === id ? " on" : ""), on: { click: () => { state.person = id; renderPersonFilter(); loadAll(); } } },
      label, archived ? h("span", { class: "arch-label" }, "Archived") : null);
    replace(personFilter, chip("all", "Everyone"), ...list.map((p) => chip(p.id, p.display_name.split(" ")[0] || p.display_name, p.archived)),
      people.some((p) => p.archived) ? h("label", { class: "inline" }, h("input", { type: "checkbox", checked: state.showArchivedPeople, on: { change: (e: Event) => { state.showArchivedPeople = (e.target as HTMLInputElement).checked; renderPersonFilter(); } } }), "Show archived") : null);
  }
  function renderTypeChips() {
    const chip = (v: string, l: string) => h("button", { class: "fchip" + (state.type === v ? " on" : ""), on: { click: () => { state.type = v; renderTypeChips(); loadTasks(); } } }, l);
    replace(typeChips, chip("all", "All types"), ...TYPES.map(([v, l]) => chip(v, l)));
  }
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ brand: state.brand, brand_status: state.brandStatus, person: state.person, type: state.type, ...(state.q ? { q: state.q } : {}), ...extra }).toString();

  // ------------------------------------------------------------------ task list
  async function loadTasks() {
    try {
      const r = await api(`/tasks?${qs()}`);
      renderTasks(r.items, r.total);
    } catch (e) { replace(taskArea, msg("error", errorText(e))); }
  }
  function renderTasks(items: any[], total: number) {
    const open = items.filter((t) => t.status === "open"), done = items.filter((t) => t.status === "done");
    const overdue = open.filter((t) => t.overdue), current = open.filter((t) => !t.overdue);
    const section = (title: string, list: any[], extra: Node | null = null) => list.length
      ? [h("div", { class: "sh" }, extra, title, h("span", { class: "cnt" }, list.length)), h("div", { class: "tlist" }, ...list.map(card))] : [];
    replace(taskArea,
      ...section("Overdue", overdue, h("span", { class: "red" }, "⚠")),
      ...section("Active", current),
      open.length ? null : h("div", { class: "empty" }, "No active tasks for this view."),
      ...section("Completed", done),
      total > items.length ? h("div", { class: "note-line" }, `Showing the latest ${items.length} of ${total} tasks. Narrow the filters to see others.`) : null);
    const todayTotal = items.filter((t) => (t.occurrence ? t.occurrence.date === ctx.today : t.operational_date === ctx.today));
    if (todayTotal.length) {
      const d = todayTotal.filter((t) => t.status === "done").length;
      replace(strip, h("div", { class: "row card" }, h("b", null, `${todayTotal.length} tasks today`), h("span", { class: "green" }, `${d} done`), h("span", { class: d === todayTotal.length ? "green" : "red" }, `${todayTotal.length - d} pending`)));
      strip.className = "";
    } else strip.className = "hidden";
  }
  function card(t: any) {
    const done = t.status === "done";
    // Completion follows the occurrence's owner (can_complete), not permission to edit the series (can_edit).
    const chk = h("div", { class: "chk" + (done ? " on" : "") + (t.can_complete ? "" : " disabled"), role: "checkbox", "aria-checked": String(done),
      "aria-disabled": t.can_complete ? null : "true", tabindex: t.can_complete ? "0" : "-1",
      title: t.can_complete ? (done ? "Mark not done" : "Mark done") : blockedText(t.occurrence),
      on: { click: () => t.can_complete && toggle(t) } }, done ? "✓" : "");
    const otherOwner = t.occurrence && t.occurrence.owner.id !== t.assignee.id ? t.occurrence.owner : null;
    const brandBadge = t.brand ? tint(h("span", { class: "b brand-badge" }, t.brand.name), null) : h("span", { class: "b brand-badge" }, "Unassigned brand");
    const due = t.occurrence ? t.occurrence.date : t.due_date;
    return h("div", { class: "tc" + (done ? " done-c" : "") },
      chk,
      h("div", { class: "ti" },
        h("div", { class: "tt" }, h("a", { href: `#/tasks/${t.id}`, class: "plain" }, t.title)),
        t.note ? h("div", { class: "tn" }, t.note) : null,
        h("div", { class: "tm" },
          h("span", { class: "b " + (t.type === "routine" ? "br" : t.type === "video" ? "bv" : "ba") }, TYPES.find(([v]) => v === t.type)?.[1] ?? t.type),
          state.brand === "all" || state.brand === "unassigned" ? brandBadge : null,
          t.brand?.archived ? h("span", { class: "arch-label" }, "Archived brand") : null,
          h("span", { class: "ac" }, t.assignee.name), t.assignee.archived ? h("span", { class: "arch-label" }, "Archived") : null,
          t.recurrence ? h("span", { class: "rc" }, REPEAT_LABEL[t.recurrence] ?? "↻") : null,
          t.kpi ? h("span", { class: "kc" }, `⬡ ${t.kpi.metric}${t.kpi.sub_metric ? " · " + t.kpi.sub_metric : ""}`) : t.legacy_kpi_label ? h("span", { class: "kc" }, `⬡ ${t.legacy_kpi_label}`) : null,
          due && !done ? h("span", { class: t.overdue ? "od" : "mt" }, `${t.occurrence?.upcoming ? "Next" : "Due"} ${fmtDate(due)}`) : null,
          done && t.occurrence ? h("span", { class: "mt" }, `Done for ${fmtDate(t.occurrence.date)}`) : null,
          t.occurrence?.completion_blocked === "too_far_ahead" ? h("span", { class: "mt too-early" }, blockedText(t.occurrence)) : null,
          otherOwner ? h("span", { class: "arch-label" }, `${otherOwner.name}'s occurrence${otherOwner.archived ? " (archived)" : ""}`) : null)),
      h("div", { class: "tc-actions" },
        t.can_edit ? h("button", { class: "ic-btn", title: "Edit", "aria-label": "Edit task", on: { click: () => openEdit(t) } }, "✎") : null,
        t.can_edit ? h("button", { class: "ic-btn del", title: "Delete", "aria-label": "Delete task", on: { click: () => del(t) } }, "✕") : null));
  }
  async function toggle(t: any) {
    try {
      const body = t.recurrence ? { done: !t.occurrence?.done, occurrence_date: t.occurrence?.date } : { done: t.status !== "done", version: t.version };
      await api(`/tasks/${t.id}/completion`, { method: "POST", json: body });
    } catch (e) { alert(errorText(e)); }
    loadAll();
  }
  async function del(t: any) {
    if (!confirm(`Delete "${t.title}"? It disappears from all lists; its history is kept.`)) return;
    try { await api(`/tasks/${t.id}?version=${t.version}`, { method: "DELETE" }); } catch (e) { alert(errorText(e)); }
    loadAll();
  }

  // ------------------------------------------------------------------ add task
  async function kpiOptions(owner: string, brand: string): Promise<[string, string][]> {
    if (!brand || brand === "none" || (!isAdmin && owner !== me.id)) return [["", "— None —"]];
    try {
      const r = await api(`/kpis?owner=${owner}&brand=${brand}`);
      return [["", "— None —"], ...r.items.map((k: any) => [k.id, `${k.metric}${k.sub_metric ? " · " + k.sub_metric : ""}`] as [string, string])];
    } catch { return [["", "— None —"]]; }
  }
  function openAdd() {
    const err = h("div");
    const active = brands.filter((b) => b.status === "active");
    const brandOpts: [string, string][] = [...active.map((b) => [b.id, b.display_name] as [string, string]), ...(isAdmin ? [["none", "Unassigned brand"] as [string, string]] : [])];
    if (!brandOpts.length) { replace(addWrap, msg("notice", isAdmin ? "Add a brand on the Brands screen first." : "You have no assigned brands yet. Ask an administrator.")); addWrap.className = "add-wrap open"; return; }
    const start = state.brand !== "all" && brandOpts.some(([v]) => v === state.brand) ? state.brand : brandOpts[0][0];
    const fBrand = select(brandOpts, start), fAssignee = h("select"), fKpi = h("select");
    const fType = select(TYPES, "adhoc"), fRepeat = select(REPEATS, ""), fDue = h("input", { type: "date" }), fNote = h("input", { type: "text", placeholder: "Optional context…", maxlength: "2000" });
    const fTitle = h("input", { type: "text", placeholder: "What needs to be done?", maxlength: "300" });
    const fBulk = h("textarea", { placeholder: "One task per line (up to 50)" });
    let mode: "single" | "bulk" = "single";
    const tabSingle = h("button", { class: "fchip on", on: { click: () => setMode("single") } }, "Single"), tabBulk = h("button", { class: "fchip", on: { click: () => setMode("bulk") } }, "Bulk");
    const single = h("div", null, field("Task title *", fTitle)), bulk = h("div", { class: "hidden" }, field("Task titles — one per line *", fBulk));
    function setMode(m: typeof mode) { mode = m; single.className = m === "single" ? "" : "hidden"; bulk.className = m === "bulk" ? "" : "hidden"; tabSingle.className = "fchip" + (m === "single" ? " on" : ""); tabBulk.className = "fchip" + (m === "bulk" ? " on" : ""); }
    async function refreshAssignees() {
      if (!isAdmin) return refreshKpis();
      const r = await api(`/people-assignable?brand=${fBrand.value}`);
      const prev = fAssignee.value;
      replace(fAssignee, ...r.items.map((p: any) => h("option", { value: p.id, selected: p.id === prev }, p.display_name + (p.status === "pending" ? " (invited)" : ""))));
      await refreshKpis();
    }
    async function refreshKpis() { replace(fKpi, ...(await kpiOptions(isAdmin ? fAssignee.value : me.id, fBrand.value)).map(([v, l]) => h("option", { value: v }, l))); }
    fBrand.addEventListener("change", refreshAssignees);
    fAssignee.addEventListener("change", refreshKpis);
    fRepeat.addEventListener("change", () => { if (fRepeat.value && !fDue.value) fDue.value = ctx.today; });
    async function save() {
      const base = { brand_id: fBrand.value === "none" ? null : fBrand.value, ...(isAdmin ? { assignee_id: fAssignee.value } : {}), type: fType.value,
        recurrence: fRepeat.value || null, due_date: fDue.value || null, note: fNote.value.trim() || null, kpi_id: fKpi.value || null };
      const ok = await attempt(err, () => mode === "single"
        ? api("/tasks", { method: "POST", json: { title: fTitle.value.trim(), ...base } })
        : api("/tasks/bulk", { method: "POST", json: { titles: fBulk.value.split("\n").map((s) => s.trim()).filter(Boolean), ...base } }));
      if (ok) { closeAdd(); loadAll(); }
    }
    replace(addWrap,
      h("div", { class: "row" }, h("div", { class: "add-ttl grow" }, isAdmin ? "Assign task" : "Add my task"), tabSingle, tabBulk),
      isAdmin ? h("div", { class: "fg" }, field("Assign to", fAssignee)) : null,
      h("div", { class: "fg" }, field("Brand", fBrand)),
      h("div", { class: "fg fg3" }, field("Type", fType), field("Repeat", fRepeat), field("Due date (first due date if repeating)", fDue)),
      h("div", { class: "fg fg2" }, field("Link to EOS KPI", fKpi), field("Note", fNote)),
      single, bulk, err,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: closeAdd } }, "Cancel"), h("button", { class: "btn-p", on: { click: save } }, "Save")));
    addWrap.className = "add-wrap open";
    refreshAssignees().catch(() => {});
    fTitle.focus();
  }
  function closeAdd() { addWrap.className = "add-wrap"; clear(addWrap); }

  // ------------------------------------------------------------------ edit and detail
  async function openEdit(t: any) {
    const err = h("div"), notices = h("div");
    const fTitle = h("input", { type: "text", value: t.title, maxlength: "300" }), fNote = h("textarea", { maxlength: "2000" });
    fNote.value = t.note ?? "";
    const fType = select(TYPES, t.type), fRepeat = select(REPEATS, t.recurrence ?? ""), fDue = h("input", { type: "date", value: t.due_date ?? "" }), fUntil = h("input", { type: "date", value: t.recurrence_until ?? "" });
    const adminFields = h("div");
    let fBrand: HTMLSelectElement | null = null, fAssignee: HTMLSelectElement | null = null, fKpi: HTMLSelectElement | null = null;
    if (isAdmin) {
      const opts: [string, string][] = [...brands.filter((b) => b.status === "active" || b.id === t.brand?.id).map((b) => [b.id, b.display_name + (b.status === "archived" ? " (archived)" : "")] as [string, string]), ["none", "Unassigned brand"]];
      fBrand = select(opts, t.brand?.id ?? "none"); fAssignee = h("select"); fKpi = h("select");
      const fillAssignees = async () => {
        const r = await api(`/people-assignable?brand=${fBrand!.value}`);
        const list = r.items.some((p: any) => p.id === t.assignee.id) ? r.items : [{ id: t.assignee.id, display_name: t.assignee.name + (t.assignee.archived ? " (archived)" : " (no access)") }, ...r.items];
        replace(fAssignee!, ...list.map((p: any) => h("option", { value: p.id, selected: p.id === t.assignee.id }, p.display_name)));
        replace(fKpi!, ...(await kpiOptions(fAssignee!.value, fBrand!.value)).map(([v, l]) => h("option", { value: v, selected: v === (t.kpi?.id ?? "") }, l)));
      };
      fBrand.addEventListener("change", fillAssignees);
      fAssignee.addEventListener("change", async () => replace(fKpi!, ...(await kpiOptions(fAssignee!.value, fBrand!.value)).map(([v, l]) => h("option", { value: v }, l))));
      fillAssignees().catch(() => {});
      replace(adminFields, h("div", { class: "fg fg2" }, field("Brand", fBrand), field("Assigned to", fAssignee)), h("div", { class: "fg" }, field("KPI link", fKpi)));
    }
    const close = modal("Edit task", [
      h("div", { class: "fg" }, field("Task title", fTitle)),
      h("div", { class: "fg fg2" }, field("Type", fType), field("Repeat", fRepeat)),
      h("div", { class: "fg fg2" }, field(t.recurrence ? "First due date" : "Due date", fDue), field("Repeat until (optional)", fUntil)),
      t.recurrence ? h("div", { class: "note-line" }, "Changing the repeat rule or first date of a series that already started ends it yesterday and continues as a new series; past completions stay as they are. Set “Repeat until” to stop a series.") : null,
      h("div", { class: "fg" }, field("Note", fNote)),
      adminFields, notices, err,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: save } }, "Save changes")),
    ], { wide: true });
    async function save() {
      const body: Record<string, unknown> = { version: t.version, title: fTitle.value.trim(), note: fNote.value.trim() || null, type: fType.value, due_date: fDue.value || null,
        recurrence: fRepeat.value || null, recurrence_until: fRepeat.value ? fUntil.value || null : null };
      if (isAdmin && fBrand && fAssignee && fKpi) Object.assign(body, { brand_id: fBrand.value === "none" ? null : fBrand.value, assignee_id: fAssignee.value, kpi_id: fKpi.value || null });
      try {
        const r = await api(`/tasks/${t.id}`, { method: "PATCH", json: body });
        if (r.notices?.length) { replace(notices, ...r.notices.map((n: string) => msg("notice", n))); replace(err); t = r.task; loadAll(); return; }
        close(); loadAll();
      } catch (e) {
        replace(err, msg("error", errorText(e) + (e instanceof ApiError && e.status === 409 && e.code === "conflict" ? " (Close and reopen the task.)" : "")));
      }
    }
  }

  async function openDetail(id: string) {
    let d: any;
    try { d = await api(`/tasks/${id}`); } catch (e) { alert(errorText(e)); location.hash = "#/tasks"; return; }
    const t = d.task;
    const occBox = h("div");
    // Each occurrence is labelled with its owner; only occurrences this person may complete get a control.
    async function renderOccurrences() {
      if (!t.recurrence) return;
      const occ = (await api(`/tasks/${id}/occurrences`).catch(() => ({ items: [] }))).items;
      replace(occBox, occ.length ? h("div", null, h("div", { class: "pt" }, "Occurrences (last and next 30 days)"),
        h("table", { class: "tbl occ-tbl" }, h("tbody", null, ...occ.map((o: any) => h("tr", { "data-date": o.date },
          h("td", null, fmtDate(o.date)),
          h("td", null, o.owner?.name ?? "", o.owner?.archived ? h("span", { class: "arch-label" }, "Archived") : null),
          h("td", null, o.done ? h("span", { class: "green" }, "Done") : h("span", { class: o.overdue ? "red" : "grey" }, o.overdue ? "Overdue" : "Open")),
          h("td", null, o.can_complete ? h("button", { class: "btn-sm occ-toggle", on: { click: async () => {
            try { await api(`/tasks/${id}/completion`, { method: "POST", json: { done: !o.done, occurrence_date: o.date } }); } catch (e) { alert(errorText(e)); }
            await renderOccurrences(); loadAll();
          } } }, o.done ? "Mark not done" : "Mark done") : h("span", { class: "muted occ-blocked", title: blockedText(o) }, o.completion_blocked === "too_far_ahead" ? blockedText(o) : "—"))))))) : null);
    }
    await renderOccurrences();
    modal(t.title, [
      h("div", { class: "tm" }, h("span", { class: "ac" }, t.assignee.name), t.brand ? h("span", { class: "b brand-badge" }, t.brand.name) : h("span", { class: "b brand-badge" }, "Unassigned brand"),
        t.recurrence ? h("span", { class: "rc" }, REPEAT_LABEL[t.recurrence]) : null, t.due_date ? h("span", { class: "mt" }, `Due ${fmtDate(t.due_date)}`) : null,
        h("span", { class: "mt" }, `Created ${fmtDate(t.operational_date)} by ${t.creator.name}`)),
      t.note ? h("p", { class: "tn" }, t.note) : null,
      d.assignments?.length > 1 ? h("div", { class: "note-line" }, "Ownership: " + d.assignments.map((a: any) => `${a.assignee_name}${a.archived ? " (archived)" : ""} ${a.effective_from ? "from " + fmtDate(a.effective_from) : "from the start"}`).join(" · ")) : null,
      occBox,
      h("div", { class: "pt" }, "History"),
      h("div", null, ...d.history.map((x: any) => h("div", { class: "note-line" }, `${fmtTime(x.at)} · ${x.actor ?? "Import"} · ${x.action.replace(/_/g, " ")}`))),
      h("div", { class: "row-end" }, t.can_edit ? h("button", { class: "btn-g", on: { click: () => openEdit(t) } }, "Edit") : null),
    ], { wide: true, onClose: () => { if (location.hash.startsWith("#/tasks/")) history.replaceState(null, "", "#/tasks"); } });
  }

  // ------------------------------------------------------------------ right panel
  async function loadSummary() {
    try {
      const s = await api(`/summaries?period=today&brand=${state.brand}&person=${state.person}`);
      replace(summaryArea, statBlock(s), splitBlock(s));
      if (readsAll && teamArea) replace(teamArea, ...(s.by_person ?? []).map((p: any) => h("div", { class: "split" },
        h("span", { class: "row" }, h("span", { class: "av" }, initials(p.name)), p.name, p.archived ? h("span", { class: "arch-label" }, "Archived") : null),
        h("span", null, h("span", { class: "grey" }, `${p.pending} pending · `), h("span", { class: "green" }, `${p.done} done`)))));
      if (readsAll && s.by_person && !s.by_person.length) replace(teamArea, h("div", { class: "empty" }, "No team activity."));
    } catch (e) { replace(summaryArea, msg("error", errorText(e))); }
  }
  async function loadAnalytics() {
    const chip = (p: string, l: string) => h("button", { class: "fchip" + (state.period === p ? " on" : ""), on: { click: () => { state.period = p; loadAnalytics(); } } }, l);
    const from = h("input", { type: "date", value: state.from }), to = h("input", { type: "date", value: state.to });
    const apply = () => { state.from = from.value; state.to = to.value; loadAnalytics(); };
    from.addEventListener("change", apply); to.addEventListener("change", apply);
    const head = [h("div", { class: "row" }, chip("today", "Today"), chip("yesterday", "Yesterday"), chip("mtd", "Month to date"), chip("lm", "Last month"), chip("custom", "Range")),
      state.period === "custom" ? h("div", { class: "fg fg2" }, field("From", from), field("To", to)) : null];
    try {
      const extra = state.period === "custom" ? `&from=${state.from}&to=${state.to}` : "";
      const s = await api(`/summaries?period=${state.period}&brand=${state.brand}&person=${state.person}${extra}`);
      replace(analyticsArea, ...head, h("div", { class: "note-line" }, `${fmtDate(s.range.from)}${s.range.from !== s.range.to ? " – " + fmtDate(s.range.to) : ""} · Vietnam time`),
        statBlock(s, "Completed"), splitBlock(s),
        s.by_person ? h("div", null, h("div", { class: "fl" }, "By person"), ...s.by_person.map((p: any) => h("div", { class: "split" }, h("span", null, p.name, p.archived ? h("span", { class: "arch-label" }, "Archived") : null),
          h("span", null, h("span", { class: "green" }, `${p.done} done`), h("span", { class: "grey" }, ` · ${p.pending} pending`))))) : null,
        h("div", { class: "note-line" }, "Each occurrence of a repeating task counts once. Task completion is not a KPI result."));
    } catch (e) { replace(analyticsArea, ...head, msg("error", errorText(e))); }
  }
  function statBlock(s: any, doneLabel = "Tasks done") {
    const total = s.done + s.pending;
    const bar = h("div", { class: "bar" }, h("span"));
    (bar.firstChild as HTMLElement).style.width = total ? `${Math.round((s.done / total) * 100)}%` : "0%";
    return h("div", { class: "statgrid" }, h("div", { class: "stat" }, h("div", { class: "n green" }, s.done), h("div", { class: "l" }, doneLabel), bar),
      h("div", { class: "stat" }, h("div", { class: "n" + (s.pending ? " red" : " green") }, s.pending), h("div", { class: "l" }, "Pending")));
  }
  function splitBlock(s: any) {
    return h("div", null,
      h("div", { class: "split" }, h("span", { class: "grey" }, "Routine / repeating"), h("span", null, h("span", { class: "green" }, `${s.routine.done} done`), h("span", { class: "grey" }, ` · ${s.routine.pending} left`))),
      h("div", { class: "split" }, h("span", { class: "grey" }, "One-time / ad hoc"), h("span", null, h("span", { class: "green" }, `${s.one_time.done} done`), h("span", { class: "grey" }, ` · ${s.one_time.pending} left`))));
  }

  // ------------------------------------------------------------------ KPI scorecard
  let kpiOwner: string | null = me.role === "staff" ? me.id : null;
  async function loadKpis() {
    const owner = me.role === "staff" ? me.id : state.person !== "all" ? state.person : kpiOwner;
    const brandQ = state.brand === "all" || state.brand === "unassigned" ? "all" : state.brand;
    try {
      const r = await api(`/kpis?brand=${brandQ}${owner ? `&owner=${owner}` : ""}`);
      if (!owner && readsAll && r.owners.length) { kpiOwner = r.owners[0].id; return loadKpis(); }
      const ownerPick = readsAll && state.person === "all" && r.owners.length > 1
        ? select(r.owners.map((o: any) => [o.id, o.display_name + (o.archived ? " (archived)" : "")]), owner, { on: { change: (e: Event) => { kpiOwner = (e.target as HTMLSelectElement).value; loadKpis(); } } }) : null;
      const rows = r.items.map((k: any) => {
        const hasT = !!k.target && !isNaN(parseFloat(k.target)), hasV = !!k.value && !isNaN(parseFloat(k.value));
        const up = hasT && hasV && parseFloat(k.value) >= parseFloat(k.target);
        const val = isAdmin
          ? h("input", { type: "text", class: "kpi-in", value: k.value ?? "", placeholder: "—", maxlength: "40", title: `Value for the week of ${fmtDate(r.week_start)}`,
              on: { change: async (e: Event) => { try { await api(`/kpis/${k.id}/values/${r.week_start}`, { method: "PUT", json: { value: (e.target as HTMLInputElement).value.trim() || null } }); } catch (x) { alert(errorText(x)); } loadKpis(); } } })
          : h("span", { class: "kpi-val" }, k.value ?? "—");
        return h("div", { class: "kpi-row" }, h("div", { class: "top" },
          h("div", { class: "grow" }, h("div", { class: "kpi-metric" }, k.metric), k.sub_metric ? h("div", { class: "kpi-sub" }, k.sub_metric) : null, k.note ? h("div", { class: "kpi-note" }, k.note) : null,
            state.brand === "all" ? h("div", { class: "kpi-sub" }, k.brand_name) : null),
          h("div", { class: "row" }, val, k.target ? h("span", { class: "grey" }, `/ ${k.target}`) : null, hasT && hasV ? h("span", { class: up ? "up" : "down" }, up ? "▲" : "▼") : null,
            isAdmin ? h("button", { class: "ic-btn", title: "Edit KPI", "aria-label": "Edit KPI", on: { click: () => editKpi(k) } }, "✎") : null,
            isAdmin ? h("button", { class: "ic-btn del", title: "Remove KPI", "aria-label": "Remove KPI", on: { click: async () => { if (confirm("Remove this KPI from the scorecard? Its history is kept.")) { try { await api(`/kpis/${k.id}?version=${k.version}`, { method: "DELETE" }); } catch (x) { alert(errorText(x)); } loadKpis(); } } } }, "✕") : null)));
      });
      replace(kpiArea, ownerPick, r.owner ? h("div", { class: "note-line" }, `${r.owner.display_name} · week of ${fmtDate(r.week_start)}`) : null,
        ...(rows.length ? rows : [h("div", { class: "empty" }, "No scorecard yet.")]),
        isAdmin ? h("div", { class: "row", }, h("button", { class: "btn-sm", on: { click: () => addKpi(owner) } }, "+ Add KPI"), h("button", { class: "btn-sm", on: { click: () => importKpis(owner) } }, "Upload Excel")) : null);
    } catch (e) { replace(kpiArea, msg("error", errorText(e))); }
  }
  function kpiForm(k: any = {}) {
    const metric = h("input", { type: "text", value: k.metric ?? "", maxlength: "160", placeholder: "e.g. Blogs" }), sub = h("input", { type: "text", value: k.sub_metric ?? "", maxlength: "160", placeholder: "e.g. No. written" });
    const target = h("input", { type: "text", value: k.target ?? "", maxlength: "40", placeholder: "e.g. 2" }), note = h("input", { type: "text", value: k.note ?? "", maxlength: "500" });
    return { metric, sub, target, note, nodes: [h("div", { class: "fg fg2" }, field("Metric name", metric), field("Sub-metric", sub)), h("div", { class: "fg fg2" }, field("Target", target), field("Note", note))] };
  }
  async function ownerAndBrand(owner: string | null) {
    const r = await api("/people-assignable");
    const fOwner = select(r.items.map((p: any) => [p.id, p.display_name]), owner ?? r.items[0]?.id ?? null);
    const fBrand = select(brands.filter((b) => b.status === "active").map((b) => [b.id, b.display_name]), state.brand.length === 36 ? state.brand : brands[0]?.id ?? null);
    return { fOwner, fBrand, node: h("div", { class: "fg fg2" }, field("For person", fOwner), field("Brand", fBrand)) };
  }
  async function addKpi(owner: string | null) {
    const f = kpiForm(), err = h("div"), ob = await ownerAndBrand(owner);
    const close = modal("Add KPI", [ob.node, ...f.nodes, err, h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"),
      h("button", { class: "btn-p", on: { click: async () => { if (await attempt(err, () => api("/kpis", { method: "POST", json: { owner_id: ob.fOwner.value, brand_id: ob.fBrand.value, metric: f.metric.value.trim(), sub_metric: f.sub.value.trim() || null, target: f.target.value.trim() || null, note: f.note.value.trim() || null } }))) { kpiOwner = ob.fOwner.value; close(); loadKpis(); } } } }, "Add"))]);
  }
  function editKpi(k: any) {
    const f = kpiForm(k), err = h("div");
    const close = modal("Edit KPI", [...f.nodes, err, h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"),
      h("button", { class: "btn-p", on: { click: async () => { if (await attempt(err, () => api(`/kpis/${k.id}`, { method: "PATCH", json: { version: k.version, metric: f.metric.value.trim(), sub_metric: f.sub.value.trim() || null, target: f.target.value.trim() || null, note: f.note.value.trim() || null } }))) { close(); loadKpis(); } } } }, "Save"))]);
  }
  async function importKpis(owner: string | null) {
    const err = h("div"), preview = h("div"), ob = await ownerAndBrand(owner);
    const file = h("input", { type: "file", accept: ".xlsx" });
    let batch: any = null;
    file.addEventListener("change", async () => {
      const f = file.files?.[0]; if (!f) return;
      const fd = new FormData(); fd.set("file", f);
      batch = null; replace(preview);
      await attempt(err, async () => {
        batch = await api("/imports/kpi-xlsx/preview", { method: "POST", body: fd });
        replace(preview, h("div", { class: "fl" }, `${batch.rows.length} rows found — select to import:`),
          ...batch.rows.map((r: any) => h("label", { class: "inline" }, h("input", { type: "checkbox", checked: true, "data-cid": r.cid }), `${r.metric}${r.sub_metric ? " · " + r.sub_metric : ""}${r.target ? ` (target ${r.target})` : ""}`)),
          ...batch.skipped.map((s: any) => h("div", { class: "flag" }, `Row ${s.row} skipped: ${s.reason}`)));
      });
    });
    const close = modal("Import KPIs from Excel", [ob.node, field("EOS scorecard (.xlsx, up to 1 MB; metric in column A, sub-metric in B)", file), preview, err,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: async () => {
        if (!batch) return;
        const rows = [...preview.querySelectorAll<HTMLInputElement>("input[data-cid]")].filter((c) => c.checked).map((c) => c.dataset.cid!);
        if (await attempt(err, async () => { const r = await api(`/imports/kpi-xlsx/${batch.id}/commit`, { method: "POST", json: { owner_id: ob.fOwner.value, brand_id: ob.fBrand.value, rows } }); alert(`${r.created} KPI(s) added${r.already_imported ? `, ${r.already_imported} already imported` : ""}.`); })) { kpiOwner = ob.fOwner.value; close(); loadKpis(); }
      } } }, "Import selected"))], { wide: true });
  }

  // ------------------------------------------------------------------ boot
  async function loadAll() { await Promise.all([loadTasks(), loadSummary(), loadKpis(), loadAnalytics()]); }
  try {
    [brands, people] = await Promise.all([api("/brands").then((r) => r.items), api("/directory").then((r) => r.items)]);
  } catch (e) { replace(root, h("div", { class: "page" }, msg("error", errorText(e)))); return; }
  renderBrandTabs(); renderPersonFilter(); renderTypeChips();
  await loadAll();
  const m = /^#\/tasks\/([0-9a-f-]{36})$/.exec(location.hash);
  if (m) openDetail(m[1]);
  return { openDetail };
}

function debounce<T extends (...a: any[]) => void>(f: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); };
}
