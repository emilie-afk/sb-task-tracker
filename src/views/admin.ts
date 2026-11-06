// Administrator screens: People, Brands, Imports (private migration) and Integrations (dashboard reporting).
import { h, replace, tint, fmtDate, fmtTime } from "../dom";
import { api, errorText } from "../api";
import { modal, msg, attempt, select, field } from "../ui";
import type { Ctx } from "../main";

const ROLES: [string, string][] = [["staff", "Staff"], ["administrator", "Administrator"], ["management", "Management (view all, no editing)"]];
const roleLabel = (r: string) => ({ staff: "Staff", administrator: "Administrator", management: "Management" } as Record<string, string>)[r] ?? r;

async function activeBrands() { return (await api("/brands")).items as any[]; }

function brandChecks(brands: any[], selected: string[], includeArchivedIfSelected = true) {
  const box = h("div", { class: "brand-checks" }, ...brands.filter((b) => b.status === "active" || (includeArchivedIfSelected && selected.includes(b.id)))
    .map((b) => h("label", { class: "brand-check" }, h("input", { type: "checkbox", value: b.id, checked: selected.includes(b.id) }), b.display_name + (b.status === "archived" ? " (archived)" : ""))));
  return { box, values: () => [...box.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value) };
}

// ====================================================================== People
export async function peopleView(root: HTMLElement, ctx: Ctx) {
  const list = h("div"), err = h("div");
  replace(root, h("div", { class: "page" },
    h("h2", null, "People"),
    h("div", { class: "sub" }, "Only approved Google accounts can sign in. Adding someone creates a pending invitation; they become active after their first sign-in. Share the app address with them — no email is sent. Archiving someone ends their access immediately; their history stays."),
    h("div", { class: "row" }, h("button", { class: "btn-p", on: { click: () => addPerson() } }, "+ Add person")), err, list));

  async function load() {
    try {
      const [people, brands] = await Promise.all([api("/people"), activeBrands()]);
      const bname = new Map(brands.map((b: any) => [b.id, b.display_name + (b.status === "archived" ? " (archived)" : "")]));
      replace(list, h("table", { class: "tbl" },
        h("thead", null, h("tr", null, ...["Person", "Role", "Brand access", "Status", "Last sign-in", ""].map((x) => h("th", null, x)))),
        h("tbody", null, ...people.items.map((p: any) => h("tr", null,
          h("td", null, h("div", null, h("b", null, p.display_name)), h("div", { class: "muted" }, p.email)),
          h("td", null, roleLabel(p.role)),
          h("td", null, p.role === "staff" ? (p.brand_ids.map((id: string) => bname.get(id) ?? "Unknown").join(", ") || h("span", { class: "muted" }, "None")) : h("span", { class: "muted" }, "All brands")),
          h("td", null, h("span", { class: `status ${p.status}` }, p.status === "pending" ? "Invited" : p.status === "active" ? "Active" : "Archived"), p.live_sessions ? h("div", { class: "muted" }, `${p.live_sessions} session(s)`) : null),
          h("td", null, p.last_sign_in_at ? fmtTime(p.last_sign_in_at) : h("span", { class: "muted" }, "Never")),
          h("td", null, h("div", { class: "actions" },
            p.status !== "archived" ? h("button", { class: "btn-sm", on: { click: () => editPerson(p, brands) } }, "Edit") : null,
            p.status !== "archived" ? h("button", { class: "btn-sm danger", on: { click: () => archivePerson(p) } }, "Archive") : h("button", { class: "btn-sm", on: { click: () => restorePerson(p, brands) } }, "Restore"),
            p.live_sessions ? h("button", { class: "btn-sm", on: { click: () => revoke(p) } }, "Sign out everywhere") : null,
            p.status === "pending" && !p.signed_in_before ? h("button", { class: "btn-sm danger", on: { click: () => deleteInvite(p) } }, "Delete invitation") : null,
            h("button", { class: "btn-sm", on: { click: () => showHistory(p) } }, "History"))))))));
    } catch (e) { replace(list, msg("error", errorText(e))); }
  }

  async function addPerson() {
    const brands = await activeBrands();
    const email = h("input", { type: "email", maxlength: "320", placeholder: "name@company.example" }), name = h("input", { type: "text", maxlength: "120" });
    const role = select(ROLES, "staff"), checks = brandChecks(brands, [], false), e2 = h("div");
    const brandRow = h("div", null, h("div", { class: "fl" }, "Brand access (staff)"), checks.box);
    role.addEventListener("change", () => { brandRow.className = role.value === "staff" ? "" : "hidden"; });
    const close = modal("Add person", [h("div", { class: "fg fg2" }, field("Google account email (exact)", email), field("Display name", name)), h("div", { class: "fg" }, field("Role", role)), brandRow,
      h("div", { class: "note-line" }, "Management can view everything but cannot change business data. Brand access applies to staff only."), e2,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: async () => {
        if (await attempt(e2, () => api("/people", { method: "POST", json: { email: email.value.trim(), display_name: name.value.trim(), role: role.value, brand_ids: role.value === "staff" ? checks.values() : [] } }))) {
          close(); replace(err, msg("ok", `Invitation added. Send ${name.value.trim()} the app address: ${location.origin}`)); load();
        } } } }, "Add"))]);
  }
  function editPerson(p: any, brands: any[]) {
    const name = h("input", { type: "text", value: p.display_name, maxlength: "120" }), role = select(ROLES, p.role), checks = brandChecks(brands, p.brand_ids), e2 = h("div");
    const brandRow = h("div", { class: p.role === "staff" ? "" : "hidden" }, h("div", { class: "fl" }, "Brand access"), checks.box);
    role.addEventListener("change", () => { brandRow.className = role.value === "staff" ? "" : "hidden"; });
    const close = modal(`Edit ${p.display_name}`, [h("div", { class: "fg fg2" }, field("Display name", name), field("Role", role)), brandRow,
      h("div", { class: "note-line" }, "Changes take effect on their next action. Removing brand access does not move their tasks."), e2,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: async () => {
        if (await attempt(e2, () => api(`/people/${p.id}`, { method: "PATCH", json: { version: p.version, display_name: name.value.trim(), role: role.value, brand_ids: role.value === "staff" ? checks.values() : [] } }))) { close(); load(); }
      } } }, "Save"))]);
  }
  async function archivePerson(p: any) {
    const [open, assignable] = await Promise.all([api(`/people/${p.id}/open-tasks`), api("/people-assignable")]);
    const others = assignable.items.filter((x: any) => x.id !== p.id);
    const choices = open.items.map((t: any) => ({ t, sel: select([["", "Leave with them for later review"], ...others.map((o: any) => [o.id, `Reassign to ${o.display_name}`] as [string, string])], "") }));
    const e2 = h("div"), result = h("div");
    const close = modal(`Archive ${p.display_name}?`, [
      h("p", { class: "sub" }, "Archiving ends every session and blocks sign-in immediately, even if a reassignment below fails. Their completed work, KPI history and audit records stay attributed to them. Nothing is transferred automatically."),
      open.items.length ? h("div", null, h("div", { class: "fl" }, `Open tasks (${open.items.length})`), ...choices.map(({ t, sel }: any) => h("div", { class: "split" },
        h("span", null, t.title, t.brand_name ? h("span", { class: "arch-label" }, t.brand_name) : h("span", { class: "arch-label" }, "Unassigned brand"), t.due_date ? h("span", { class: "muted" }, ` · due ${fmtDate(t.due_date)}`) : null), sel)))
        : h("div", { class: "note-line" }, "No open tasks."),
      e2, result,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: async () => {
        const reassign = choices.filter((c: any) => c.sel.value).map((c: any) => ({ task_id: c.t.id, assignee_id: c.sel.value }));
        await attempt(e2, async () => {
          const r = await api(`/people/${p.id}/archive`, { method: "POST", json: { version: p.version, reassign } });
          const failed = r.reassigned.filter((x: any) => !x.ok);
          replace(result, msg("ok", `Archived. ${r.sessions_revoked} session(s) ended.`), ...failed.map((f: any) => msg("notice", `A task stayed with them: ${f.message}`)),
            ...r.reassigned.flatMap((x: any) => (x.notices ?? []).map((n: string) => msg("notice", n))));
          load();
          if (!failed.length) setTimeout(close, 1200);
        });
      } } }, "Archive"))], { wide: true });
  }
  function restorePerson(p: any, brands: any[]) {
    const role = select(ROLES, p.role), checks = brandChecks(brands, p.brand_ids), e2 = h("div");
    const brandRow = h("div", { class: p.role === "staff" ? "" : "hidden" }, h("div", { class: "fl" }, "Brand access"), checks.box);
    role.addEventListener("change", () => { brandRow.className = role.value === "staff" ? "" : "hidden"; });
    const close = modal(`Restore ${p.display_name}`, [h("p", { class: "sub" }, "Confirm the role and brand access they should have now. They must sign in again; old sessions are never restored."),
      field("Role", role), brandRow, e2,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: async () => {
        if (await attempt(e2, () => api(`/people/${p.id}/restore`, { method: "POST", json: { version: p.version, role: role.value, brand_ids: role.value === "staff" ? checks.values() : [], confirm: true } }))) { close(); load(); }
      } } }, "Restore"))]);
  }
  async function revoke(p: any) {
    if (!confirm(`End every active session for ${p.display_name}? They can sign in again if their access is active.`)) return;
    try { await api(`/people/${p.id}/revoke-sessions`, { method: "POST", json: {} }); } catch (e) { alert(errorText(e)); }
    load();
  }
  async function deleteInvite(p: any) {
    if (!confirm(`Delete the unused invitation for ${p.display_name}?`)) return;
    try { await api(`/people/${p.id}?version=${p.version}`, { method: "DELETE" }); } catch (e) { alert(errorText(e)); }
    load();
  }
  async function showHistory(p: any) {
    const r = await api(`/people/${p.id}`);
    modal(`Access history · ${p.display_name}`, [...(r.history.length ? r.history.map((x: any) => h("div", { class: "note-line" },
      `${fmtTime(x.at)} · ${x.actor ?? "Setup"} · ${x.action.replace(/^person\.|^auth\./, "").replace(/_/g, " ")}${x.details?.role ? ` (role ${x.details.role.from ?? ""} → ${x.details.role.to ?? x.details.role})` : ""}`))
      : [h("div", { class: "empty" }, "No changes recorded.")])], { wide: true });
  }
  await load();
}

// ====================================================================== Brands
export async function brandsView(root: HTMLElement, _ctx: Ctx) {
  const list = h("div");
  replace(root, h("div", { class: "page" }, h("h2", null, "Brands"),
    h("div", { class: "sub" }, "New brands are visible to administrators and Management immediately, and to staff once you give them access on the People screen. Archiving keeps every task and KPI record; only a brand that was never used can be deleted. Dashboard reporting is off until you map and enable it."),
    h("div", { class: "row" }, h("button", { class: "btn-p", on: { click: () => editBrand(null) } }, "+ Add brand")), list));
  let supported: string[] = [];
  async function load() {
    try {
      const r = await api("/brands");
      supported = r.supported_dashboard_businesses ?? [];
      replace(list, h("table", { class: "tbl" },
        h("thead", null, h("tr", null, ...["Brand", "Status", "Staff with access", "Tasks", "Dashboard reporting", ""].map((x) => h("th", null, x)))),
        h("tbody", null, ...r.items.map((b: any) => h("tr", null,
          h("td", null, tint(h("span", { class: "swatch" }), b.color), h("b", null, b.display_name)),
          h("td", null, h("span", { class: `status ${b.status}` }, b.status === "active" ? "Active" : "Archived")),
          h("td", null, b.staff_access.length ? b.staff_access.map((s: any) => s.name + (s.archived ? " (archived)" : "")).join(", ") : h("span", { class: "muted" }, "None")),
          h("td", null, String(b.task_count)),
          h("td", null, b.dashboard_business_id ? `${b.reporting_enabled ? "On" : "Off"} · ${b.dashboard_business_id}` : h("span", { class: "muted" }, "Not mapped")),
          h("td", null, h("div", { class: "actions" },
            h("button", { class: "btn-sm", on: { click: () => editBrand(b) } }, "Edit"),
            b.status === "active" ? h("button", { class: "btn-sm danger", on: { click: () => act(b, "archive", "Archive this brand? No new tasks can use it; existing records are kept and can still be completed or moved.") } }, "Archive")
              : h("button", { class: "btn-sm", on: { click: () => act(b, "restore") } }, "Restore"),
            b.task_count === 0 && !b.staff_access.length ? h("button", { class: "btn-sm danger", on: { click: () => del(b) } }, "Delete") : null)))))));
    } catch (e) { replace(list, msg("error", errorText(e))); }
  }
  function editBrand(b: any | null) {
    const name = h("input", { type: "text", maxlength: "80", value: b?.display_name ?? "" }), color = h("input", { type: "color", value: b?.color ?? "#5f5e5a" });
    const mapping = select([["", "Not mapped"], ...supported.map((s) => [s, s] as [string, string])], b?.dashboard_business_id ?? "");
    const enabled = h("input", { type: "checkbox", checked: !!b?.reporting_enabled });
    const e2 = h("div");
    const close = modal(b ? `Edit ${b.display_name}` : "Add brand", [h("div", { class: "fg fg2" }, field("Name", name), field("Color", color)),
      b ? h("div", { class: "card" }, h("div", { class: "fl" }, "Marketing dashboard (private mapping)"), h("div", { class: "fg fg2" }, field("Dashboard business", mapping),
        h("label", { class: "inline" }, enabled, "Report this brand's tasks")), h("div", { class: "note-line" }, "Only mapped and enabled brands are sent, and only if the reporting credential includes that business.")) : null,
      e2, h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: () => close() } }, "Cancel"), h("button", { class: "btn-p", on: { click: async () => {
        const ok = await attempt(e2, () => b
          ? api(`/brands/${b.id}`, { method: "PATCH", json: { version: b.version, display_name: name.value.trim(), color: color.value, dashboard_business_id: mapping.value || null, reporting_enabled: !!mapping.value && enabled.checked } })
          : api("/brands", { method: "POST", json: { display_name: name.value.trim(), color: color.value } }));
        if (ok) { close(); load(); }
      } } }, "Save"))]);
  }
  async function act(b: any, what: "archive" | "restore", ask?: string) {
    if (ask && !confirm(ask)) return;
    try { await api(`/brands/${b.id}/${what}`, { method: "POST", json: { version: b.version } }); } catch (e) { alert(errorText(e)); }
    load();
  }
  async function del(b: any) {
    if (!confirm(`Permanently delete ${b.display_name}? This is only possible because it was never used.`)) return;
    try { await api(`/brands/${b.id}?version=${b.version}`, { method: "DELETE" }); } catch (e) { alert(errorText(e)); }
    load();
  }
  await load();
}

// ====================================================================== Imports
export async function importsView(root: HTMLElement, _ctx: Ctx) {
  const area = h("div"), err = h("div"), recent = h("div");
  const file = h("input", { type: "file", accept: ".json,application/json" }), label = h("input", { type: "text", maxlength: "120", placeholder: "e.g. Browser export from laptop 1" });
  replace(root, h("div", { class: "page" }, h("h2", null, "Import old browser data"),
    h("div", { class: "sub" }, "The old tracker kept tasks and KPIs in each browser separately. In every browser that was used, open ", h("a", { href: "/legacy-export.html" }, "the export helper"),
      " on this site and download the file (nothing is uploaded and nothing is erased). Then preview each file here, map people and brands, and import only the records you select. Repeating an import never duplicates records. Keep export files out of shared folders and Git."),
    h("div", { class: "card" }, h("div", { class: "fg fg2" }, field("Export file", file), field("Label", label)), h("button", { class: "btn-p", on: { click: () => previewFile() } }, "Preview"), err),
    area, h("h2", null, "Recent imports"), recent));

  async function loadRecent() {
    try {
      const r = await api("/imports");
      replace(recent, r.items.length ? h("table", { class: "tbl" }, h("tbody", null, ...r.items.map((b: any) => h("tr", null, h("td", null, fmtTime(b.created_at)), h("td", null, b.kind === "kpi_xlsx" ? "KPI spreadsheet" : "Browser data"),
        h("td", null, b.source_label), h("td", null, b.status), h("td", null, b.created_by))))) : h("div", { class: "empty" }, "No imports yet."));
    } catch (e) { replace(recent, msg("error", errorText(e))); }
  }
  async function previewFile() {
    const f = file.files?.[0];
    if (!f) return replace(err, msg("error", "Choose an export file."));
    if (f.size > 5 * 1024 * 1024) return replace(err, msg("error", "The file is larger than 5 MB."));
    let parsed: unknown;
    try { parsed = JSON.parse(await f.text()); } catch { return replace(err, msg("error", "This file is not an export from the helper.")); }
    let p: any;
    if (!(await attempt(err, async () => { p = await api("/imports/legacy/preview", { method: "POST", json: { source_label: label.value.trim() || f.name.slice(0, 100), file: parsed } }); }))) return;
    renderPreview(p);
  }
  async function renderPreview(p: any) {
    const brands = (await api("/brands")).items;
    const people: [string, string][] = [["", "— choose —"], ...p.mappable_people.map((u: any) => [u.id, `${u.display_name}${u.status === "archived" ? " (archived)" : ""}`] as [string, string])];
    const personSel = new Map<string, HTMLSelectElement>(p.people.map((x: any) => [x.legacy_id, select(people, x.suggested_user_id ?? "")]));
    const brandSel = new Map<string, HTMLSelectElement>(p.brands.map((k: string) => [k, select([["", "— choose —"], ["none", "Unassigned brand"], ...brands.map((b: any) => [b.id, b.display_name] as [string, string])], "")]));
    const taskBoxes = p.tasks.map((t: any) => ({ t, box: h("input", { type: "checkbox", checked: !t.already_imported && !t.flags.length, disabled: t.already_imported }) }));
    const kpiBoxes = p.kpis.map((k: any) => ({ k, box: h("input", { type: "checkbox", checked: !k.already_imported, disabled: k.already_imported }) }));
    const e2 = h("div"), done = h("div");
    replace(area, h("div", { class: "card" },
      h("h2", null, "Preview"),
      h("div", { class: "row" }, ...[["Tasks", p.summary.tasks], ["KPIs", p.summary.kpis], ["Invalid records", p.summary.invalid], ["Flagged for review", p.summary.flagged], ["Already imported", p.summary.already_imported.tasks + p.summary.already_imported.kpis]]
        .map(([l, n]) => h("div", { class: "stat" }, h("div", { class: "n" }, String(n)), h("div", { class: "l" }, String(l))))),
      p.invalid.length ? h("div", null, h("div", { class: "fl" }, "Not importable"), ...p.invalid.map((i: any) => h("div", { class: "flag" }, `${i.ref}: ${i.reason}`))) : null,
      h("div", { class: "fl" }, "People (old login id → person here). Roles and permissions from the old tracker are not imported."),
      h("table", { class: "tbl" }, h("tbody", null, ...p.people.map((x: any) => h("tr", null, h("td", null, x.legacy_id, x.name ? h("span", { class: "muted" }, ` (${x.name})`) : null), h("td", null, personSel.get(x.legacy_id)!))))),
      h("div", { class: "fl" }, "Brands (old key → brand here)"),
      h("table", { class: "tbl" }, h("tbody", null, ...p.brands.map((k: string) => h("tr", null, h("td", null, k), h("td", null, brandSel.get(k)!))))),
      h("div", { class: "fl" }, "Tasks — flagged records are not selected by default; nothing is merged or chosen automatically"),
      h("table", { class: "tbl" }, h("tbody", null, ...taskBoxes.map(({ t, box }: any) => h("tr", null, h("td", null, box),
        h("td", null, h("b", null, t.title), h("div", { class: "muted" }, `old id ${t.legacy_id} · ${t.legacy_assignee} · ${t.legacy_brand} · created ${fmtDate(t.date)}${t.due ? ` · due ${fmtDate(t.due)}` : ""}${t.done ? " · done" : ""}`),
          t.note ? h("div", { class: "tn" }, t.note) : null, ...t.notes.map((n: string) => h("div", { class: "note-line" }, n)), ...t.flags.map((f: string) => h("div", { class: "flag" }, f)),
          t.already_imported ? h("div", { class: "note-line" }, "Already imported.") : null))))),
      p.kpis.length ? h("div", { class: "fl" }, "KPIs") : null,
      p.kpis.length ? h("table", { class: "tbl" }, h("tbody", null, ...kpiBoxes.map(({ k, box }: any) => h("tr", null, h("td", null, box),
        h("td", null, h("b", null, k.metric), k.sub_metric ? ` · ${k.sub_metric}` : "", h("div", { class: "muted" }, `${k.legacy_owner} · ${k.legacy_brand}${k.target ? ` · target ${k.target}` : ""}${k.current ? ` · current ${k.current}` : ""}`),
          ...k.notes.map((n: string) => h("div", { class: "note-line" }, n)), k.already_imported ? h("div", { class: "note-line" }, "Already imported.") : null))))) : null,
      e2, done,
      h("div", { class: "row-end" }, h("button", { class: "btn-g", on: { click: async () => { await api(`/imports/${p.id}/discard`, { method: "POST", json: {} }).catch(() => {}); replace(area); loadRecent(); } } }, "Discard"),
        h("button", { class: "btn-p", on: { click: async () => {
          const person_map: Record<string, string> = {}, brand_map: Record<string, string | null> = {};
          personSel.forEach((s, k) => { if (s.value) person_map[k] = s.value; });
          brandSel.forEach((s, k) => { if (s.value) brand_map[k] = s.value === "none" ? null : s.value; });
          const tasks = taskBoxes.filter((x: any) => x.box.checked && !x.box.disabled).map((x: any) => x.t.cid), kpis = kpiBoxes.filter((x: any) => x.box.checked && !x.box.disabled).map((x: any) => x.k.cid);
          if (!confirm(`Import ${tasks.length} task(s) and ${kpis.length} KPI(s)?`)) return;
          await attempt(e2, async () => {
            const r = await api(`/imports/legacy/${p.id}/commit`, { method: "POST", json: { person_map, brand_map, tasks, kpis } });
            replace(done, msg("ok", `Imported ${r.tasks_created} task(s) and ${r.kpis_created} KPI(s). Already present: ${r.tasks_already_imported + r.kpis_already_imported}.`));
            loadRecent();
          });
        } } }, "Import selected"))));
  }
  await loadRecent();
}

// ====================================================================== Integrations
export async function integrationsView(root: HTMLElement, _ctx: Ctx) {
  const area = h("div");
  replace(root, h("div", { class: "page" }, h("h2", null, "Marketing dashboard reporting"),
    h("div", { class: "sub" }, "The marketing dashboard reads tasks from this tracker with its own read-only credential (one way). This tracker stays the place where its tasks are edited. Only brands you map and enable are sent; no emails, notes or account lists are included."), area));
  async function load() {
    try {
      const r = await api("/integrations/reporting");
      const scope = h("div", { class: "brand-checks" }, ...r.supported_dashboard_businesses.map((b: string) => h("label", { class: "brand-check" },
        h("input", { type: "checkbox", value: b, checked: (r.credential?.allowed_business_ids ?? ["sb"]).includes(b) }), b)));
      const secretBox = h("div"), e2 = h("div");
      replace(area,
        !r.instance_id_configured ? msg("notice", "TRACKER_INSTANCE_ID is not set on the server, so reporting stays disabled.") : null,
        h("div", { class: "card" },
          h("div", { class: "fl" }, "Reporting credential"),
          r.credential ? h("div", { class: "note-line" }, `Active since ${fmtTime(r.credential.created_at)}${r.credential.created_by ? ` (by ${r.credential.created_by})` : ""} · last used ${r.credential.last_used_at ? fmtTime(r.credential.last_used_at) : "never"} · businesses: ${r.credential.allowed_business_ids.join(", ")}`)
            : h("div", { class: "note-line" }, "None. Reporting is off."),
          h("div", { class: "fl" }, "Dashboard businesses this credential may read (Succulents Box only by default)"), scope,
          h("div", { class: "row" },
            h("button", { class: "btn-p", on: { click: async () => {
              if (r.credential && !confirm("Create a new credential? The current one stops working immediately.")) return;
              const allowed = [...scope.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
              await attempt(e2, async () => {
                const c = await api("/integrations/reporting/credential", { method: "POST", json: { allowed_business_ids: allowed } });
                const box = h("input", { type: "text", class: "secret", value: c.secret, readOnly: true, "aria-label": "Reporting secret" });
                replace(secretBox, msg("notice", "Copy this secret now into the marketing dashboard's server settings (TASK_TRACKER_REPORTING_SECRET). It is not shown again and is not stored here."), box);
                box.select();
              });
            } } }, r.credential ? "Replace credential" : "Create credential"),
            r.credential ? h("button", { class: "btn-sm danger", on: { click: async () => { if (confirm("Revoke the credential? The dashboard stops receiving updates and keeps its last snapshot.")) { await api("/integrations/reporting/credential", { method: "DELETE" }).catch((e) => alert(errorText(e))); load(); } } } }, "Revoke") : null),
          e2, secretBox),
        h("table", { class: "tbl" }, h("thead", null, h("tr", null, ...["Brand", "Mapping", "Sent to dashboard"].map((x) => h("th", null, x)))),
          h("tbody", null, ...r.brands.map((b: any) => h("tr", null, h("td", null, b.name, b.archived ? h("span", { class: "arch-label" }, "Archived") : null),
            h("td", null, b.dashboard_business_id ?? h("span", { class: "muted" }, "Not mapped")), h("td", null, b.included ? h("span", { class: "green" }, b.reason) : h("span", { class: "muted" }, b.reason)))))),
        h("div", { class: "note-line" }, "Change a brand's mapping on the Brands screen."));
    } catch (e) { replace(area, msg("error", errorText(e))); }
  }
  await load();
}
