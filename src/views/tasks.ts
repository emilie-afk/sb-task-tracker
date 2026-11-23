// Tasks screen: a weekly timeline (Monday–Sunday, Vietnam time) with overdue, undated, upcoming and completed
// work; brand, staff, type and search filters; single and bulk task creation with weekly schedules; edit and
// detail dialogs; week summary, KPI scorecard, team workload and period analytics.
// Administrators manage everyone's tasks, staff carry out their own, Management reads everything.
import { h, replace, clear, tint, fmtDate, fmtTime, initials } from "../dom";
import { api, errorText, ApiError } from "../api";
import { modal, msg, attempt, select, field } from "../ui";
import { addDays, weekStart, isoWeekday } from "../../shared/dates";
import type { Ctx } from "../main";

/** Why a completion control is disabled (same reasons the server enforces). */
function blockedText(u: any): string {
  if (!u) return "View only";
  if (u.completion_blocked === "too_far_ahead") return `Can be completed from ${fmtDate(u.completable_from)}`;
  if (u.completion_blocked === "other_owner") return `Belongs to ${u.owner?.name ?? "someone else"}`;
  return "View only";
}

type Brand = { id: string; display_name: string; color: string | null; status: string; version: number };
type Person = { id: string; display_name: string; role: string; archived: boolean };

const TYPES: [string, string][] = [["routine", "Routine"], ["adhoc", "Ad hoc"], ["video", "Video"]];
const REPEATS: [string, string][] = [["", "No repeat"], ["weekly", "Repeat weekly"], ["weekdays", "Weekdays (Mon–Fri)"], ["daily", "Every day"], ["monthly", "Monthly"]];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const weekLabel = (ws: string) => `${fmtDate(ws)} – ${fmtDate(addDays(ws, 6))}, ${addDays(ws, 6).slice(0, 4)}`;

/**
 * Schedule controls shared by the add form and the editor: repeat rule, weekday checkboxes (weekly), start date
 * and optional end date. A weekly schedule whose weekdays were not picked by hand follows the start date.
 */
function scheduleFields(init: { recurrence: string | null; days: number[] | null; start: string | null; until: string | null }, startLabel: string) {
  const fRepeat = select(REPEATS, init.recurrence ?? "");
  const fStart = h("input", { type: "date", value: init.start ?? "", class: "f-start" });
  const fUntil = h("input", { type: "date", value: init.until ?? "", class: "f-until" });
  let touched = !!init.days;
  const boxes = DAYS.map((d, i) => h("input", { type: "checkbox", value: String(i + 1), checked: !!init.days?.includes(i + 1), "aria-label": DAY_LONG[i],
    on: { change: () => { touched = true; } } }));
  const dayRow = h("div", { class: "weekday-pick" }, ...boxes.map((b, i) => h("label", { class: "inline" }, b, DAYS[i])));
  const dayWrap = h("div", { class: "hidden" }, field("Repeat on", dayRow));
  const untilWrap = h("div", null, field("End date (optional)", fUntil));
  const startLabelEl = h("div", { class: "fl" }, startLabel);
  const followStart = () => {
    if (touched || !fStart.value) return;
    const wd = isoWeekday(fStart.value);
    boxes.forEach((b, i) => { b.checked = i + 1 === wd; });
  };
  const sync = () => {
    dayWrap.className = fRepeat.value === "weekly" ? "" : "hidden";
    untilWrap.className = fRepeat.value ? "" : "hidden";
    if (fRepeat.value === "weekly") followStart();
  };
  fRepeat.addEventListener("change", sync);
  fStart.addEventListener("change", () => { if (fRepeat.value === "weekly") followStart(); });
  sync();
  const days = () => (fRepeat.value === "weekly" ? boxes.filter((b) => b.checked).map((b) => Number(b.value)) : null);
  const node = h("div", null,
    h("div", { class: "fg fg3" }, field("Repeat", fRepeat), h("div", null, startLabelEl, fStart), untilWrap),
    dayWrap);
  return { fRepeat, fStart, fUntil, days, node, sync, startLabelEl,
    value: () => ({ recurrence: fRepeat.value || null, recurrence_days: fRepeat.value === "weekly" ? (days()!.length ? days() : null) : null,
      due_date: fStart.value || null, recurrence_until: fRepeat.value ? fUntil.value || null : null }) };
}

export async function tasksView(root: HTMLElement, ctx: Ctx) {
  const me = ctx.me;
  const isAdmin = me.role === "administrator", isMgmt = me.role === "management", readsAll = isAdmin || isMgmt;
  const state = { brand: "all", brandStatus: "active", person: me.role === "staff" ? me.id : "all", type: "all", q: "", period: "today", from: ctx.today, to: ctx.today,
    showArchivedPeople: false, week: weekStart(ctx.today) };
  let brands: Brand[] = [], people: Person[] = [];
  let lastWeek: any = null;

  const btabs = h("div", { class: "btabs" });
  const personFilter = h("div", { class: "row" });
  const typeChips = h("div", { class: "row" });
  const search = h("input", { type: "text", class: "search-in", placeholder: "Search…", "aria-label": "Search tasks", on: { input: debounce(() => { state.q = search.value.trim(); loadWeek(); }, 250) } });
  const addWrap = h("div", { class: "add-wrap" });
  const weekBar = h("div", { class: "weekbar" });
  const taskArea = h("div");
  const summaryTitle = h("div", { class: "pt" });
  const summaryArea = h("div"), kpiArea = h("div"), teamArea = h("div"), analyticsArea = h("div");
  const archivedToggle = h("label", { class: "inline" }, h("input", { type: "checkbox", on: { change: (e: Event) => { state.brandStatus = (e.target as HTMLInputElement).checked ? "archived" : "active"; state.brand = "all"; renderBrandTabs(); loadAll(); } } }), "Archived brands");

  replace(root,
    h("div", { class: "content" },
      h("div", null,
        h("div", { class: "toolbar" }, btabs, h("div", { class: "sep" }), archivedToggle),
        h("div", { class: "toolbar" }, personFilter, h("div", { class: "sep" }), typeChips, h("div", { class: "search-wrap" }, h("span", { class: "search-icon" }, "⚲"), search)),
        addWrap,
        isMgmt ? null : h("button", { class: "btn-add", on: { click: () => openAdd() } }, isAdmin ? "+ Assign task" : "+ Add task"),
        weekBar, taskArea),
      h("div", { class: "rp" },
        h("div", { class: "panel" }, summaryTitle, summaryArea),
        h("div", { class: "panel" }, h("div", { class: "pt" }, "EOS Scorecard"), kpiArea),
        readsAll ? h("div", { class: "panel team-panel" }, h("div", { class: "pt" }, "Team workload · week"), teamArea) : null,
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
  /** Task-doer filter: staff only (administrators manage tasks, Management reads them). */
  function renderPersonFilter() {
    const list = people.filter((p) => p.role === "staff" && (state.showArchivedPeople || !p.archived || p.id === state.person));
    const chip = (id: string, label: string, archived = false) => h("button", { class: "fchip" + (state.person === id ? " on" : ""), on: { click: () => { state.person = id; renderPersonFilter(); loadAll(); } } },
      label, archived ? h("span", { class: "arch-label" }, "Archived") : null);
    replace(personFilter, chip("all", "Everyone"), ...list.map((p) => chip(p.id, p.display_name.split(" ")[0] || p.display_name, p.archived)),
      people.some((p) => p.archived && p.role === "staff") ? h("label", { class: "inline" }, h("input", { type: "checkbox", checked: state.showArchivedPeople, on: { change: (e: Event) => { state.showArchivedPeople = (e.target as HTMLInputElement).checked; renderPersonFilter(); } } }), "Show archived") : null);
  }
  function renderTypeChips() {
    const chip = (v: string, l: string) => h("button", { class: "fchip" + (state.type === v ? " on" : ""), on: { click: () => { state.type = v; renderTypeChips(); loadWeek(); } } }, l);
    replace(typeChips, chip("all", "All types"), ...TYPES.map(([v, l]) => chip(v, l)));
  }
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ brand: state.brand, brand_status: state.brandStatus, person: state.person, type: state.type, ...(state.q ? { q: state.q } : {}), ...extra }).toString();

  // ------------------------------------------------------------------ week navigation
  function renderWeekBar() {
    const current = weekStart(ctx.today);
    const go = (ws: string) => { state.week = ws; loadWeek(); };
    const opts: [string, string][] = [];
    for (let i = -12; i <= 12; i++) { const ws = addDays(current, 7 * i); opts.push([ws, weekLabel(ws) + (i === 0 ? " (this week)" : "")]); }
    if (!opts.some(([v]) => v === state.week)) opts.push([state.week, weekLabel(state.week)]);
    opts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const pick = select(opts, state.week, { class: "week-pick", "aria-label": "Week", on: { change: (e: Event) => go((e.target as HTMLSelectElement).value) } });
    replace(weekBar,
      h("button", { class: "btn-sm week-prev", "aria-label": "Previous week", on: { click: () => go(addDays(state.week, -7)) } }, "‹ Previous"),
      pick,
      h("button", { class: "btn-sm week-next", "aria-label": "Next week", on: { click: () => go(addDays(state.week, 7)) } }, "Next ›"),
      state.week !== current ? h("button", { class: "btn-sm week-today", on: { click: () => go(current) } }, "This week") : null);
  }

  // ------------------------------------------------------------------ timeline
  async function loadWeek() {
    renderWeekBar();
    try {
      const w = await api(`/tasks/week?${qs({ start: state.week })}`);
      lastWeek = w;
      renderTimeline(w);
      renderWeekSummary(w);
    } catch (e) { replace(taskArea, msg("error", errorText(e))); replace(summaryArea, msg("error", errorText(e))); }
  }
  function renderTimeline(w: any) {
    const section = (cls: string, title: Node | string, list: any[], icon: Node | null = null) =>
      h("div", { class: "tl-sec " + cls }, h("div", { class: "sh" }, icon, title, h("span", { class: "cnt" }, list.length)), h("div", { class: "tlist" }, ...list.map(unitCard)));
    const dayBlocks = w.days.map((d: any) => {
      const wd = isoWeekday(d.date);
      const isToday = d.date === w.today;
      return h("div", { class: "tl-day" + (isToday ? " today" : "") + (d.date < w.today ? " past" : ""), "data-date": d.date },
        h("div", { class: "sh" }, `${DAY_LONG[wd - 1]} · ${fmtDate(d.date)}`, isToday ? h("span", { class: "today-tag" }, "Today") : null, h("span", { class: "cnt" }, d.items.length)),
        d.items.length ? h("div", { class: "tlist" }, ...d.items.map(unitCard)) : h("div", { class: "tl-none" }, d.date < w.today ? "—" : "Nothing due"));
    });
    const completed = w.completed.length
      ? h("details", { class: "tl-sec tl-done" }, h("summary", { class: "sh" }, "Completed this week", h("span", { class: "cnt" }, w.completed.length)), h("div", { class: "tlist" }, ...w.completed.map(unitCard)))
      : null;
    replace(taskArea,
      w.overdue.length ? section("tl-overdue", "Overdue", w.overdue, h("span", { class: "red" }, "⚠")) : null,
      h("div", { class: "tl-week" }, ...dayBlocks),
      w.undated.length ? section("tl-undated", "No due date", w.undated) : null,
      w.upcoming.length ? h("div", { class: "tl-sec tl-upcoming" }, h("div", { class: "sh" }, "Upcoming", h("span", { class: "cnt" }, w.upcoming.reduce((n: number, g: any) => n + g.items.length, 0))),
        ...w.upcoming.map((g: any) => h("div", { class: "tl-upweek" }, h("div", { class: "fl" }, `Week of ${weekLabel(g.week_start)}`), h("div", { class: "tlist" }, ...g.items.map(unitCard))))) : null,
      completed,
      h("div", { class: "note-line" }, `Overdue looks back ${w.overdue_lookback_days} days for repeating tasks; older occurrences stay in their own weeks. Unfinished work of archived people is closed and not shown.`));
  }
  const SLACK_LINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\//;
  /** "From Slack" link, inferred-deadline and deleted-source chips for tasks created by the Slack intake. */
  function slackChips(t: any) {
    const sl = t.slack;
    if (!sl || typeof sl.permalink !== "string" || !SLACK_LINK.test(sl.permalink)) return [];
    return [h("a", { class: "mt slack-link", href: sl.permalink, target: "_blank", rel: "noopener noreferrer", title: "Open the Slack message" }, "From Slack"),
      sl.due_inferred ? h("span", { class: "mt slack-inferred", title: "No deadline in the message: set to the next working day" }, "Deadline inferred") : null,
      sl.source_deleted ? h("span", { class: "arch-label" }, "Slack message deleted") : null];
  }
  function unitCard(u: any) {
    const t = u.task;
    const done = u.status === "done";
    const chk = h("div", { class: "chk" + (done ? " on" : "") + (u.can_complete ? "" : " disabled"), role: "checkbox", "aria-checked": String(done),
      "aria-disabled": u.can_complete ? null : "true", tabindex: u.can_complete ? "0" : "-1",
      title: u.can_complete ? (done ? "Mark not done" : "Mark done") : blockedText(u),
      on: { click: () => u.can_complete && toggle(u), keydown: (e: KeyboardEvent) => { if ((e.key === " " || e.key === "Enter") && u.can_complete) { e.preventDefault(); toggle(u); } } } }, done ? "✓" : "");
    const brandBadge = t.brand ? h("span", { class: "b brand-badge" }, t.brand.name) : h("span", { class: "b brand-badge" }, "Unassigned brand");
    return h("div", { class: "tc" + (done ? " done-c" : ""), "data-key": u.key },
      chk,
      h("div", { class: "ti" },
        h("div", { class: "tt" }, h("a", { href: `#/tasks/${t.id}`, class: "plain" }, t.title)),
        t.note ? h("div", { class: "tn" }, t.note) : null,
        h("div", { class: "tm" },
          h("span", { class: "b " + (t.type === "routine" ? "br" : t.type === "video" ? "bv" : "ba") }, TYPES.find(([v]) => v === t.type)?.[1] ?? t.type),
          state.brand === "all" || state.brand === "unassigned" ? brandBadge : null,
          t.brand?.archived ? h("span", { class: "arch-label" }, "Archived brand") : null,
          h("span", { class: "ac" }, u.owner.name), u.owner.archived ? h("span", { class: "arch-label" }, "Archived") : null,
          t.schedule ? h("span", { class: "rc" }, "↻ " + t.schedule) : null,
          t.kpi ? h("span", { class: "kc" }, `⬡ ${t.kpi.metric}${t.kpi.sub_metric ? " · " + t.kpi.sub_metric : ""}`) : t.legacy_kpi_label ? h("span", { class: "kc" }, `⬡ ${t.legacy_kpi_label}`) : null,
          u.date && !done ? h("span", { class: u.overdue ? "od" : "mt" }, `${u.kind === "occurrence" ? "For" : "Due"} ${fmtDate(u.date)}`) : null,
          done ? h("span", { class: "mt" }, u.kind === "occurrence" ? `Done for ${fmtDate(u.date)}` : `Done ${fmtDate(u.completed_on)}`) : null,
          done && u.completed_by && u.completed_by !== u.owner.name ? h("span", { class: "mt" }, `ticked by ${u.completed_by}`) : null,
          u.completion_blocked === "too_far_ahead" ? h("span", { class: "mt too-early" }, blockedText(u)) : null,
          ...slackChips(t))),
      h("div", { class: "tc-actions" },
        t.can_edit ? h("button", { class: "ic-btn", title: "Edit", "aria-label": "Edit task", on: { click: () => openEdit(t.id) } }, "✎") : null,
        t.can_edit ? h("button", { class: "ic-btn del", title: "Delete", "aria-label": "Delete task", on: { click: () => del(t) } }, "✕") : null));
  }
  async function toggle(u: any) {
    try {
      const body = u.kind === "occurrence" ? { done: u.status !== "done", occurrence_date: u.date } : { done: u.status !== "done", version: u.task.version };
      await api(`/tasks/${u.task_id}/completion`, { method: "POST", json: body });
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
    if (!owner || !brand || brand === "none" || (!isAdmin && owner !== me.id)) return [["", "— None —"]];
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
    const fBrand = select(brandOpts, start), fAssignee = h("select", { class: "f-assignee" }), fKpi = h("select");
    const fType = select(TYPES, "adhoc", { class: "f-type" }), fNote = h("input", { type: "text", placeholder: "Optional context…", maxlength: "2000" });
    const sched = scheduleFields({ recurrence: null, days: null, start: null, until: null }, "Due date (start date if repeating)");
    // New Routine tasks default to a weekly schedule starting today, on today's weekday.
    fType.addEventListener("change", () => {
      if (fType.value === "routine" && !sched.fRepeat.value) { sched.fRepeat.value = "weekly"; if (!sched.fStart.value) sched.fStart.value = ctx.today; sched.sync(); }
    });
    sched.fRepeat.addEventListener("change", () => { if (sched.fRepeat.value && !sched.fStart.value) { sched.fStart.value = ctx.today; sched.sync(); } });
    const fTitle = h("input", { type: "text", placeholder: "What needs to be done?", maxlength: "300" });
    const fBulk = h("textarea", { placeholder: "One task per line (up to 50)" });
    let mode: "single" | "bulk" = "single";
    const tabSingle = h("button", { class: "fchip on", on: { click: () => setMode("single") } }, "Single"), tabBulk = h("button", { class: "fchip", on: { click: () => setMode("bulk") } }, "Bulk");
    const single = h("div", null, field("Task title *", fTitle)), bulk = h("div", { class: "hidden" }, field("Task titles — one per line *", fBulk));
    function setMode(m: typeof mode) { mode = m; single.className = m === "single" ? "" : "hidden"; bulk.className = m === "bulk" ? "" : "hidden"; tabSingle.className = "fchip" + (m === "single" ? " on" : ""); tabBulk.className = "fchip" + (m === "bulk" ? " on" : ""); }
    async function refreshAssignees() {
      if (!isAdmin) return refreshKpis();
      const r = await api(`/people-assignable?brand=${fBrand.value}`);
      const prev = fAssignee.value || (state.person !== "all" ? state.person : "");
      replace(fAssignee, ...(r.items.length ? r.items.map((p: any) => h("option", { value: p.id, selected: p.id === prev }, p.display_name + (p.status === "pending" ? " (invited)" : "")))
        : [h("option", { value: "" }, "No staff with access to this brand")]));
      await refreshKpis();
    }
    async function refreshKpis() { replace(fKpi, ...(await kpiOptions(isAdmin ? fAssignee.value : me.id, fBrand.value)).map(([v, l]) => h("option", { value: v }, l))); }
    fBrand.addEventListener("change", refreshAssignees);
    fAssignee.addEventListener("change", refreshKpis);
    async function save() {
      const base = { brand_id: fBrand.value === "none" ? null : fBrand.value, ...(isAdmin ? { assignee_id: fAssignee.value || undefined } : {}), type: fType.value,
        ...sched.value(), note: fNote.value.trim() || null, kpi_id: fKpi.value || null };
      const ok = await attempt(err, () => mode === "single"
        ? api("/tasks", { method: "POST", json: { title: fTitle.value.trim(), ...base } })
        : api("/tasks/bulk", { method: "POST", json: { titles: fBulk.value.split("\n").map((s) => s.trim()).filter(Boolean), ...base } }));
      if (ok) { closeAdd(); loadAll(); }
    }
    replace(addWrap,
      h("div", { class: "row" }, h("div", { class: "add-ttl grow" }, isAdmin ? "Assign task" : "Add my task"), tabSingle, tabBulk),
      isAdmin ? h("div", { class: "fg" }, field("Assign to (staff)", fAssignee)) : null,
      h("div", { class: "fg fg2" }, field("Brand", fBrand), field("Type", fType)),
      sched.node,
      h("div", { class: "fg fg2" }, field("Link to EOS KPI", fKpi), field("Note", fNote)),
      single, bulk, err,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: closeAdd } }, "Cancel"), h("button", { class: "btn-p", on: { click: save } }, "Save")));
    addWrap.className = "add-wrap open";
    refreshAssignees().catch(() => {});
    fTitle.focus();
  }
  function closeAdd() { addWrap.className = "add-wrap"; clear(addWrap); }

  // ------------------------------------------------------------------ edit and detail
  async function openEdit(id: string) {
    let t: any;
    try { t = (await api(`/tasks/${id}`)).task; } catch (e) { alert(errorText(e)); return; }
    const err = h("div"), notices = h("div");
    const fTitle = h("input", { type: "text", value: t.title, maxlength: "300" }), fNote = h("textarea", { maxlength: "2000" });
    fNote.value = t.note ?? "";
    const fType = select(TYPES, t.type);
    const started = !!t.recurrence && !!t.due_date && t.due_date < ctx.today;
    const days = t.recurrence === "weekly" ? (t.recurrence_days ?? (t.due_date ? [isoWeekday(t.due_date)] : null)) : null;
    const sched = scheduleFields({ recurrence: t.recurrence, days, start: t.due_date, until: t.recurrence_until }, t.recurrence ? "Start date" : "Due date");
    const original = JSON.stringify([t.recurrence ?? null, days]);
    // Changing the rule or weekdays of a running series takes effect from a date (today or later); the series up
    // to the day before keeps its occurrences, completions and ownership.
    const onScheduleChange = () => {
      if (!started) return;
      const changed = JSON.stringify([sched.fRepeat.value || null, sched.days()]) !== original;
      if (changed && sched.fStart.value < ctx.today) { sched.fStart.value = ctx.today; sched.sync(); }
      // An ended series restarts without its old end date (the continuation never inherits it).
      if (changed && sched.fUntil.value && sched.fUntil.value < sched.fStart.value) sched.fUntil.value = "";
      replace(sched.startLabelEl, changed ? "Takes effect from" : "Start date");
    };
    sched.fRepeat.addEventListener("change", onScheduleChange);
    sched.node.querySelectorAll<HTMLInputElement>(".weekday-pick input").forEach((b) => b.addEventListener("change", onScheduleChange));
    const adminFields = h("div");
    let fBrand: HTMLSelectElement | null = null, fAssignee: HTMLSelectElement | null = null, fKpi: HTMLSelectElement | null = null;
    if (isAdmin) {
      const opts: [string, string][] = [...brands.filter((b) => b.status === "active" || b.id === t.brand?.id).map((b) => [b.id, b.display_name + (b.status === "archived" ? " (archived)" : "")] as [string, string]), ["none", "Unassigned brand"]];
      fBrand = select(opts, t.brand?.id ?? "none"); fAssignee = h("select"); fKpi = h("select");
      const fillAssignees = async () => {
        const r = await api(`/people-assignable?brand=${fBrand!.value}`);
        const list = r.items.some((p: any) => p.id === t.assignee.id) ? r.items : [{ id: t.assignee.id, display_name: t.assignee.name + (t.assignee.archived ? " (archived)" : " (current)") }, ...r.items];
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
      h("div", { class: "fg fg2" }, field("Type", fType), h("div", null, h("div", { class: "fl" }, "Current schedule"), h("div", { class: "sched-now" }, t.schedule ? `${t.schedule} · from ${fmtDate(t.due_date)}${t.recurrence_until ? " until " + fmtDate(t.recurrence_until) : ""}` : "No repeat"))),
      sched.node,
      started ? h("div", { class: "note-line" }, "This series has started. A new rule or weekdays take effect from the date you choose (today or later); earlier occurrences, their completions and ownership stay as they are. Set an end date to stop the series.") : null,
      h("div", { class: "fg" }, field("Note", fNote)),
      adminFields, notices, err,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: save } }, "Save changes")),
    ], { wide: true });
    async function save() {
      const body: Record<string, unknown> = { version: t.version, title: fTitle.value.trim(), note: fNote.value.trim() || null, type: fType.value, ...sched.value() };
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
    // Each occurrence is labelled with its owner (who is credited) and, when different, who ticked it.
    async function renderOccurrences() {
      if (!t.recurrence) return;
      const occ = (await api(`/tasks/${id}/occurrences`).catch(() => ({ items: [] }))).items;
      const status = (o: any) => o.done ? h("span", { class: "green" }, "Done") : o.closed ? h("span", { class: "grey" }, "Closed") : h("span", { class: o.overdue ? "red" : "grey" }, o.overdue ? "Overdue" : "Open");
      replace(occBox, occ.length ? h("div", null, h("div", { class: "pt" }, "Occurrences (last and next 30 days)"),
        h("table", { class: "tbl occ-tbl" }, h("tbody", null, ...occ.map((o: any) => h("tr", { "data-date": o.date },
          h("td", null, `${DAYS[isoWeekday(o.date) - 1]} ${fmtDate(o.date)}`),
          h("td", null, o.owner?.name ?? "", o.owner?.archived ? h("span", { class: "arch-label" }, "Archived") : null),
          h("td", null, status(o)),
          h("td", { class: "muted" }, o.done && o.completed_by && o.completed_by !== o.owner?.name ? `ticked by ${o.completed_by}` : ""),
          h("td", null, o.can_complete && !o.closed ? h("button", { class: "btn-sm occ-toggle", on: { click: async () => {
            try { await api(`/tasks/${id}/completion`, { method: "POST", json: { done: !o.done, occurrence_date: o.date } }); } catch (e) { alert(errorText(e)); }
            await renderOccurrences(); loadAll();
          } } }, o.done ? "Mark not done" : "Mark done") : h("span", { class: "muted occ-blocked", title: blockedText(o) }, o.completion_blocked === "too_far_ahead" ? blockedText(o) : "—"))))))) : null);
    }
    await renderOccurrences();
    modal(t.title, [
      h("div", { class: "tm" }, h("span", { class: "ac" }, t.assignee.name), t.assignee.archived ? h("span", { class: "arch-label" }, "Archived") : null,
        t.brand ? h("span", { class: "b brand-badge" }, t.brand.name) : h("span", { class: "b brand-badge" }, "Unassigned brand"),
        t.schedule ? h("span", { class: "rc sched-detail" }, `↻ ${t.schedule} · from ${fmtDate(t.due_date)}${t.recurrence_until ? " until " + fmtDate(t.recurrence_until) : ""}`) : t.due_date ? h("span", { class: "mt" }, `Due ${fmtDate(t.due_date)}`) : null,
        t.closed ? h("span", { class: "arch-label" }, "Closed") : null,
        h("span", { class: "mt" }, `Created ${fmtDate(t.operational_date)} by ${t.creator.name}`), ...slackChips(t)),
      t.note ? h("p", { class: "tn tn-full" }, t.note) : null,
      typeof d.plan_url === "string" && /^https:\/\//.test(d.plan_url) ? h("div", { class: "note-line plan-link" }, "From a marketing plan: ",
        h("a", { href: d.plan_url, target: "_blank", rel: "noopener noreferrer" }, "Open the plan in the Marketing Dashboard")) : null,
      d.assignments?.length > 1 ? h("div", { class: "note-line" }, "Ownership: " + d.assignments.map((a: any) => `${a.assignee_name}${a.archived ? " (archived)" : ""} ${a.effective_from ? "from " + fmtDate(a.effective_from) : "from the start"}`).join(" · ")) : null,
      occBox,
      h("div", { class: "pt" }, "History"),
      h("div", null, ...d.history.map((x: any) => h("div", { class: "note-line" }, `${fmtTime(x.at)} · ${x.actor ?? (x.changes?.via === "slack" ? "Slack automation" : "Import")} · ${x.action.replace(/_/g, " ")}`))),
      h("div", { class: "row-end" }, t.can_edit ? h("button", { class: "btn-g", on: { click: () => openEdit(t.id) } }, "Edit") : null),
    ], { wide: true, onClose: () => { if (location.hash.startsWith("#/tasks/")) history.replaceState(null, "", "#/tasks"); } });
  }

  // ------------------------------------------------------------------ right panel
  function renderWeekSummary(w: any) {
    const s = w.summary;
    replace(summaryTitle, w.week.is_current ? `This week · ${fmtDate(w.week.start)} – ${fmtDate(w.week.end)}` : `Week · ${fmtDate(w.week.start)} – ${fmtDate(w.week.end)}`);
    replace(summaryArea, statBlock(s), splitBlock(s),
      h("div", { class: "split wk-overdue" }, h("span", { class: "grey" }, "Overdue (all weeks)"), h("span", { class: s.overdue ? "red" : "green" }, String(s.overdue))),
      h("div", { class: "split wk-undated" }, h("span", { class: "grey" }, "No due date"), h("span", null, String(s.undated))));
    if (readsAll) {
      const rows = (w.workload ?? []).map((p: any) => h("div", { class: "split wl-row", "data-person": p.id },
        h("span", { class: "row" }, h("span", { class: "av" }, initials(p.name)), p.name, p.invited ? h("span", { class: "arch-label" }, "Invited") : null),
        h("span", null, h("span", { class: "grey" }, `${p.pending} pending · `), h("span", { class: "green" }, `${p.done} done`), p.overdue ? h("span", { class: "red" }, ` · ${p.overdue} late`) : null)));
      replace(teamArea, ...(rows.length ? rows : [h("div", { class: "empty" }, "No active staff.")]),
        h("div", { class: "note-line" }, "Active staff, for the selected week and brand, type and search filters."));
    }
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
  function statBlock(s: any, doneLabel = "Done") {
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
  async function loadAll() { await Promise.all([loadWeek(), loadKpis(), loadAnalytics()]); }
  try {
    [brands, people] = await Promise.all([api("/brands").then((r) => r.items), api("/directory").then((r) => r.items)]);
  } catch (e) { replace(root, h("div", { class: "page" }, msg("error", errorText(e)))); return; }
  renderBrandTabs(); renderPersonFilter(); renderTypeChips();
  await loadAll();
  const m = /^#\/tasks\/([0-9a-f-]{36})$/.exec(location.hash);
  if (m) openDetail(m[1]);
  void lastWeek;
  return { openDetail };
}

function debounce<T extends (...a: any[]) => void>(f: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); };
}
