// KPI scorecards. Administrators and Management read every scorecard; staff read only their own, within their
// assigned brands. Only administrators create, edit, archive, set values or import. Task completion is never
// turned into KPI values: a scorecard value is always entered (or imported) as such.
import { z } from "zod";
import type { Router } from "../router";
import { ADMIN, ALL } from "../router";
import { query, one, tx } from "../db";
import { HttpError, badRequest, forbidden, notFound, readJson } from "../http";
import { parse, uuid, version, line, text, qp, UUID_RE } from "../validate";
import { canReadPersonal } from "../policy";
import { audit } from "../audit";
import { todayVN, weekStart, isIsoDate } from "../../shared/dates";

const kpiFields = { metric: line(160), sub_metric: line(160, 0).nullable().optional(), target: line(40, 0).nullable().optional(), note: text(500).nullable().optional() };

export async function assertKpiOwner(c: any, ownerId: string, brandId: string) {
  const u = (await c.query("select role, status from users where id = $1", [ownerId])).rows[0];
  if (!u || u.status === "archived" || u.role === "management") throw new HttpError(409, "invalid_owner", "Scorecards belong to non-archived staff or administrators.");
  const b = (await c.query("select status from brands where id = $1", [brandId])).rows[0];
  if (!b) throw badRequest("Unknown brand.");
  if (b.status !== "active") throw new HttpError(409, "brand_archived", "That brand is archived.");
  if (u.role === "staff" && !(await c.query("select 1 from user_brand_access where user_id = $1 and brand_id = $2", [ownerId, brandId])).rows[0])
    throw new HttpError(409, "assignee_lacks_brand_access", "This person does not have access to that brand.");
}

export function registerKpis(r: Router) {
  r.get("/kpis", ALL, async ({ url, session: s }) => {
    const owner = qp(url, "owner", /^[0-9a-f-]{36}$/, s.role === "staff" ? s.userId : null);
    const brand = qp(url, "brand", /^(all|[0-9a-f-]{36})$/, "all")!;
    const week = weekStart(qp(url, "week", /^\d{4}-\d{2}-\d{2}$/, todayVN())!);
    if (!isIsoDate(week)) throw badRequest("Invalid week.");
    // People with scorecards, for the owner picker (administrators and Management only).
    const owners = s.allBrands ? await query(
      `select u.id, u.display_name, u.status = 'archived' archived from users u
        where exists (select 1 from kpi_definitions k where k.owner_id = u.id and k.archived_at is null) order by archived, lower(u.display_name)`) : [];
    if (!owner) return { owner: null, week_start: week, items: [], owners };
    if (!canReadPersonal(s, owner)) throw forbidden("You can view only your own scorecard.");
    const params: unknown[] = [owner, week];
    let scope = "";
    if (!s.allBrands) { params.push([...s.brandIds]); scope = ` and k.brand_id = any($${params.length}::uuid[])`; }
    if (brand !== "all") { params.push(brand); scope += ` and k.brand_id = $${params.length}`; }
    const items = await query(
      `select k.id, k.version, k.metric, k.sub_metric, k.target, k.note, k.brand_id, b.display_name brand_name, b.status brand_status, v.value
         from kpi_definitions k join brands b on b.id = k.brand_id
         left join kpi_values v on v.kpi_id = k.id and v.period_start = $2
        where k.owner_id = $1 and k.archived_at is null${scope}
        order by lower(b.display_name), k.sort_order, k.created_at`, params);
    const who = await one("select id, display_name, status = 'archived' archived from users where id = $1", [owner]);
    return { owner: who, week_start: week, items, owners };
  });

  r.post("/kpis", ADMIN, async ({ req, session: s }) => {
    const b = parse(z.object({ owner_id: uuid, brand_id: uuid, ...kpiFields }).strict(), await readJson(req));
    const id = await tx(async (c) => {
      await assertKpiOwner(c, b.owner_id, b.brand_id);
      const row = (await c.query(
        `insert into kpi_definitions (owner_id, brand_id, metric, sub_metric, target, note, sort_order, created_by)
         values ($1,$2,$3,$4,$5,$6, coalesce((select max(sort_order) + 1 from kpi_definitions where owner_id = $1 and brand_id = $2), 0), $7) returning id`,
        [b.owner_id, b.brand_id, b.metric, b.sub_metric || null, b.target || null, b.note || null, s.userId])).rows[0];
      await audit(c, s.userId, "kpi.added", "kpi", row.id, { owner_id: b.owner_id, brand_id: b.brand_id });
      return row.id as string;
    });
    return { id };
  });

  r.patch("/kpis/:id", ADMIN, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("KPI");
    const b = parse(z.object({ version, metric: kpiFields.metric.optional(), sub_metric: kpiFields.sub_metric, target: kpiFields.target, note: kpiFields.note }).strict(), await readJson(req));
    await tx(async (c) => {
      const k = (await c.query("select * from kpi_definitions where id = $1 and archived_at is null for update", [params.id])).rows[0];
      if (!k) throw notFound("KPI");
      if (k.version !== b.version) throw new HttpError(409, "conflict", "This KPI was changed by someone else. Reload and try again.");
      const next = { metric: b.metric ?? k.metric, sub_metric: "sub_metric" in b ? b.sub_metric || null : k.sub_metric, target: "target" in b ? b.target || null : k.target, note: "note" in b ? b.note || null : k.note };
      await c.query("update kpi_definitions set metric = $2, sub_metric = $3, target = $4, note = $5, updated_at = now(), version = version + 1 where id = $1",
        [k.id, next.metric, next.sub_metric, next.target, next.note]);
      await audit(c, s.userId, "kpi.edited", "kpi", k.id, { fields: Object.keys(next).filter((f) => (k as any)[f] !== (next as any)[f]), target: { from: k.target, to: next.target } });
    });
    return { ok: true };
  });

  r.delete("/kpis/:id", ADMIN, async ({ url, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("KPI");
    const v = Number(qp(url, "version", /^\d{1,10}$/));
    await tx(async (c) => {
      const k = (await c.query("select * from kpi_definitions where id = $1 and archived_at is null for update", [params.id])).rows[0];
      if (!k) throw notFound("KPI");
      if (k.version !== v) throw new HttpError(409, "conflict", "This KPI was changed by someone else. Reload and try again.");
      // Archived, not deleted: past values and task links stay in history.
      await c.query("update kpi_definitions set archived_at = now(), updated_at = now(), version = version + 1 where id = $1", [k.id]);
      await audit(c, s.userId, "kpi.archived", "kpi", k.id);
    });
    return { ok: true };
  });

  r.put("/kpis/:id/values/:week", ADMIN, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id) || !isIsoDate(params.week)) throw notFound("KPI");
    const b = parse(z.object({ value: line(40, 0).nullable() }).strict(), await readJson(req));
    const week = weekStart(params.week);
    await tx(async (c) => {
      const k = (await c.query("select id from kpi_definitions where id = $1 and archived_at is null for update", [params.id])).rows[0];
      if (!k) throw notFound("KPI");
      const prev = (await c.query("select value from kpi_values where kpi_id = $1 and period_start = $2", [k.id, week])).rows[0]?.value ?? null;
      if (b.value) await c.query(`insert into kpi_values (kpi_id, period_start, value, updated_by) values ($1,$2,$3,$4)
                                  on conflict (kpi_id, period_start) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`, [k.id, week, b.value, s.userId]);
      else await c.query("delete from kpi_values where kpi_id = $1 and period_start = $2", [k.id, week]);
      if (prev !== (b.value || null)) await audit(c, s.userId, "kpi.value_set", "kpi", k.id, { week, from: prev, to: b.value || null });
    });
    return { ok: true, week_start: week };
  });
}
