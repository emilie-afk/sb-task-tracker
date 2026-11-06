// Brands. Every role reads the brands it may see; only administrators add, rename, recolor, archive, restore or
// delete them, and set the private marketing dashboard mapping. New brands are visible to administrators and
// Management at once; staff only after an administrator assigns them. Dashboard reporting is never enabled
// automatically. Archiving keeps every record; only a never-used brand can be deleted.
import { z } from "zod";
import type { Router } from "../router";
import { ADMIN, ALL } from "../router";
import { query, tx } from "../db";
import { HttpError, badRequest, notFound, readJson } from "../http";
import { parse, version, line, color, qp, UUID_RE } from "../validate";
import { audit } from "../audit";
import { supportedDashboardBusinesses } from "../config";

export const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function registerBrands(r: Router) {
  r.get("/brands", ALL, async ({ url, session: s }) => {
    const include = qp(url, "include_archived", /^(0|1)$/, "1") === "1";
    const params: unknown[] = [];
    const where: string[] = [];
    if (!include) where.push("b.status = 'active'");
    if (!s.allBrands) { params.push([...s.brandIds]); where.push(`b.id = any($${params.length}::uuid[])`); }
    const admin = s.role === "administrator";
    const rows = await query<any>(
      `select b.id, b.display_name, b.color, b.status, b.version ${admin ? `, b.reporting_enabled, b.dashboard_business_id, b.created_at, b.archived_at,
              coalesce((select json_agg(json_build_object('id', u.id, 'name', u.display_name, 'archived', u.status = 'archived') order by lower(u.display_name))
                          from user_brand_access a join users u on u.id = a.user_id where a.brand_id = b.id), '[]') as staff_access,
              (select count(*)::int from tasks t where t.brand_id = b.id and t.deleted_at is null) as task_count` : ""}
         from brands b ${where.length ? "where " + where.join(" and ") : ""} order by b.status = 'archived', lower(b.display_name)`, params);
    return { items: rows, supported_dashboard_businesses: admin ? supportedDashboardBusinesses() : undefined };
  });

  r.post("/brands", ADMIN, async ({ req, session: s }) => {
    const b = parse(z.object({ display_name: line(80), color: color.nullable().optional() }).strict(), await readJson(req));
    const id = await tx(async (c) => {
      const row = (await c.query("insert into brands (display_name, name_key, color, created_by) values ($1,$2,$3,$4) returning id",
        [b.display_name, nameKey(b.display_name), b.color ?? null, s.userId])).rows[0];
      await audit(c, s.userId, "brand.added", "brand", row.id);
      return row.id as string;
    });
    return { id };
  }, true);

  r.patch("/brands/:id", ADMIN, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Brand");
    const b = parse(z.object({
      version, display_name: line(80).optional(), color: color.nullable().optional(),
      reporting_enabled: z.boolean().optional(), dashboard_business_id: z.string().regex(/^[a-z0-9_-]{1,40}$/).nullable().optional(),
    }).strict(), await readJson(req));
    await tx(async (c) => {
      const cur = (await c.query("select * from brands where id = $1 for update", [params.id])).rows[0];
      if (!cur) throw notFound("Brand");
      if (cur.version !== b.version) throw new HttpError(409, "conflict", "This brand was changed by someone else. Reload and try again.");
      const mapping = "dashboard_business_id" in b ? (b.dashboard_business_id ?? null) : cur.dashboard_business_id;
      if (mapping && !supportedDashboardBusinesses().includes(mapping)) throw badRequest("That dashboard business is not supported. Leave the mapping empty or choose a supported business.");
      const enabled = b.reporting_enabled ?? cur.reporting_enabled;
      if (enabled && !mapping) throw badRequest("Map the brand to a dashboard business before enabling reporting.");
      const next = { display_name: b.display_name ?? cur.display_name, color: "color" in b ? (b.color ?? null) : cur.color, reporting_enabled: mapping ? enabled : false, dashboard_business_id: mapping };
      await c.query("update brands set display_name = $2, name_key = $3, color = $4, reporting_enabled = $5, dashboard_business_id = $6, updated_at = now(), version = version + 1 where id = $1",
        [cur.id, next.display_name, nameKey(next.display_name), next.color, next.reporting_enabled, next.dashboard_business_id]);
      const changed = Object.keys(next).filter((k) => (cur as any)[k] !== (next as any)[k]);
      if (changed.length) await audit(c, s.userId, changed.some((k) => k.includes("reporting") || k.includes("dashboard")) ? "brand.reporting_changed" : "brand.edited", "brand", cur.id,
        { fields: changed, reporting_enabled: next.reporting_enabled, dashboard_business_id: next.dashboard_business_id });
    });
    return { ok: true };
  }, true);

  r.post("/brands/:id/archive", ADMIN, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Brand");
    const b = parse(z.object({ version }).strict(), await readJson(req));
    await tx(async (c) => {
      const cur = (await c.query("select * from brands where id = $1 for update", [params.id])).rows[0];
      if (!cur) throw notFound("Brand");
      if (cur.version !== b.version) throw new HttpError(409, "conflict", "This brand was changed by someone else. Reload and try again.");
      if (cur.status === "archived") return;
      // Tasks, KPI records, access and history are kept. No task is moved or deleted.
      await c.query("update brands set status = 'archived', archived_at = now(), updated_at = now(), version = version + 1 where id = $1", [cur.id]);
      await audit(c, s.userId, "brand.archived", "brand", cur.id);
    });
    return { ok: true };
  }, true);

  r.post("/brands/:id/restore", ADMIN, async ({ req, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Brand");
    const b = parse(z.object({ version }).strict(), await readJson(req));
    await tx(async (c) => {
      const cur = (await c.query("select * from brands where id = $1 for update", [params.id])).rows[0];
      if (!cur) throw notFound("Brand");
      if (cur.version !== b.version) throw new HttpError(409, "conflict", "This brand was changed by someone else. Reload and try again.");
      if (cur.status === "active") return;
      await c.query("update brands set status = 'active', archived_at = null, updated_at = now(), version = version + 1 where id = $1", [cur.id]);
      await audit(c, s.userId, "brand.restored", "brand", cur.id);
    });
    return { ok: true };
  }, true);

  r.delete("/brands/:id", ADMIN, async ({ url, params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Brand");
    const v = Number(qp(url, "version", /^\d{1,10}$/));
    await tx(async (c) => {
      const cur = (await c.query("select * from brands where id = $1 for update", [params.id])).rows[0];
      if (!cur) throw notFound("Brand");
      if (cur.version !== v) throw new HttpError(409, "conflict", "This brand was changed by someone else. Reload and try again.");
      const used = (await c.query(`select (select count(*) from tasks where brand_id = $1) + (select count(*) from kpi_definitions where brand_id = $1)
                                        + (select count(*) from user_brand_access where brand_id = $1) as n`, [cur.id])).rows[0].n;
      if (Number(used) > 0) throw new HttpError(409, "in_use", "This brand has tasks, KPI records or staff access. Archive it instead.");
      await c.query("delete from brands where id = $1", [cur.id]);
      await audit(c, s.userId, "brand.deleted", "brand", cur.id);
    });
    return { ok: true };
  }, true);
}
