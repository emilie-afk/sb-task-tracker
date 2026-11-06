// Private, administrator-only imports with a preview step:
//   1. Old browser data (legacy-export.html file): preview shows counts, validation failures, person and brand
//      mappings and possible duplicates or conflicts. Only explicitly selected records are committed, each with
//      a stable server id and provenance. Repeating an import is a no-op for records already committed.
//   2. KPI scorecard spreadsheets (.xlsx), parsed on the server with strict limits.
// Imported content is untrusted and always rendered as text. Passwords, sessions, roles and permissions from the
// old tracker are never read or imported.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Router } from "../router";
import { ADMIN } from "../router";
import { query, one, tx } from "../db";
import { HttpError, badRequest, notFound, readJson, readUpload, LIMITS } from "../http";
import { parse, uuid, line, UUID_RE } from "../validate";
import { audit } from "../audit";
import { hit, accountKey, RATE } from "../rateLimit";
import { normalizeLegacyExport, fingerprint, type TaskCandidate, type KpiCandidate } from "../legacy";
import { parseKpiWorkbook } from "../xlsx";
import { weekStart } from "../../shared/dates";
import { assertKpiOwner } from "./kpis";

const BATCH_HOURS = 24;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

async function loadBatch(id: string, kind: string) {
  if (!UUID_RE.test(id)) throw notFound("Import");
  const b = await one<any>("select * from import_batches where id = $1 and kind = $2", [id, kind]);
  if (!b) throw notFound("Import");
  return b;
}

async function alreadyImported(kind: "task" | "kpi", cids: string[]) {
  if (!cids.length) return new Set<string>();
  return new Set((await query<{ fingerprint: string }>("select fingerprint from import_records where record_kind = $1 and fingerprint = any($2::text[])", [kind, cids])).map((r) => r.fingerprint));
}

export function registerImports(r: Router) {
  // ------------------------------------------------------------------ legacy browser data
  r.post("/imports/legacy/preview", ADMIN, async ({ req, session: s }) => {
    await hit({ bucket: `import:${accountKey(s.userId)}`, ...RATE.imports });
    const body = await readJson(req, LIMITS.importJsonBytes);
    const label = parse(line(120), body.source_label ?? "Browser export");
    const norm = normalizeLegacyExport(body.file);
    if (!norm.ok) throw badRequest(norm.error);
    const doneTasks = await alreadyImported("task", norm.tasks.map((t) => t.cid));
    const doneKpis = await alreadyImported("kpi", norm.kpis.map((k) => k.cid));
    // Earlier imports of a different record under the same old id (from another browser) are flagged too.
    const prevRefs = new Set((await query<{ legacy_ref: string }>("select legacy_ref from import_records where record_kind = 'task' and legacy_ref = any($1::text[])",
      [norm.tasks.filter((t) => !doneTasks.has(t.cid)).map((t) => `task:${t.legacy_id}`)])).map((x) => x.legacy_ref));
    for (const t of norm.tasks) if (!doneTasks.has(t.cid) && prevRefs.has(`task:${t.legacy_id}`)) t.flags.push(`A different record with old id ${t.legacy_id} was imported earlier. Check that this is not the same task.`);
    const preview = { exported_at: norm.exported_at, tasks: norm.tasks, kpis: norm.kpis, people: norm.people, brands: norm.brands, invalid: norm.invalid };
    const summary = {
      tasks: norm.tasks.length, kpis: norm.kpis.length, invalid: norm.invalid.length,
      already_imported: { tasks: doneTasks.size, kpis: doneKpis.size }, flagged: norm.tasks.filter((t) => t.flags.length).length,
    };
    const id = await tx(async (c) => {
      const row = (await c.query(`insert into import_batches (kind, source_label, file_sha256, preview, summary, created_by, expires_at)
                                  values ('legacy_browser', $1, $2, $3, $4, $5, now() + make_interval(hours => $6)) returning id`,
        [label, sha(JSON.stringify(body.file)), JSON.stringify(preview), JSON.stringify(summary), s.userId, BATCH_HOURS])).rows[0];
      await audit(c, s.userId, "import.previewed", "import", row.id, { kind: "legacy_browser", ...summary });
      return row.id as string;
    });
    const suggestions = await query<{ id: string; display_name: string; role: string; status: string }>("select id, display_name, role, status from users where role <> 'management' order by lower(display_name)");
    return {
      id, summary, exported_at: norm.exported_at, invalid: norm.invalid,
      tasks: norm.tasks.map((t) => ({ ...t, already_imported: doneTasks.has(t.cid) })),
      kpis: norm.kpis.map((k) => ({ ...k, already_imported: doneKpis.has(k.cid) })),
      people: norm.people.map((p) => ({ ...p, suggested_user_id: suggestions.find((u) => p.name && u.display_name.toLowerCase() === p.name.toLowerCase())?.id ?? null })),
      brands: norm.brands, mappable_people: suggestions,
    };
  }, true);

  const commitSchema = z.object({
    person_map: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/), uuid),
    brand_map: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/), uuid.nullable()),
    tasks: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(5000).default([]),
    kpis: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000).default([]),
  }).strict();

  r.post("/imports/legacy/:id/commit", ADMIN, async ({ req, params, session: s }) => {
    const body = parse(commitSchema, await readJson(req, LIMITS.importJsonBytes));
    const result = await tx(async (c) => {
      const batch = (await c.query("select * from import_batches where id = $1 and kind = 'legacy_browser' for update", [params.id])).rows[0];
      if (!batch) throw notFound("Import");
      if (batch.status !== "preview") throw new HttpError(409, "already_committed", "This import was already committed or discarded. Start a new preview.");
      if (new Date(batch.expires_at) < new Date()) throw new HttpError(409, "expired", "This preview expired. Start a new preview.");
      const preview = batch.preview as { tasks: TaskCandidate[]; kpis: KpiCandidate[] };
      const tasks = preview.tasks.filter((t) => body.tasks.includes(t.cid));
      const kpis = preview.kpis.filter((k) => body.kpis.includes(k.cid));
      if (tasks.length !== new Set(body.tasks).size || kpis.length !== new Set(body.kpis).size) throw badRequest("Some selected records are not in this preview.");

      // Validate every mapping before writing anything; the whole commit succeeds or nothing is written.
      const people = new Map((await c.query("select id, role, status from users where id = any($1::uuid[])", [Object.values(body.person_map)])).rows.map((u) => [u.id, u]));
      const brands = new Map((await c.query("select id from brands where id = any($1::uuid[])", [Object.values(body.brand_map).filter(Boolean)])).rows.map((b) => [b.id, b]));
      const access = new Set((await c.query("select user_id || ':' || brand_id k from user_brand_access where user_id = any($1::uuid[])", [Object.values(body.person_map)])).rows.map((x) => x.k));
      const problems: string[] = [];
      const person = (legacy: string, what: string) => {
        const id = body.person_map[legacy];
        const u = id ? people.get(id) : undefined;
        if (!u) { problems.push(`${what}: choose who "${legacy}" is`); return null; }
        if (u.role === "management") { problems.push(`${what}: Management accounts cannot hold tasks or scorecards`); return null; }
        return id;
      };
      const brand = (legacy: string, what: string, required: boolean) => {
        if (!(legacy in body.brand_map)) { problems.push(`${what}: choose a brand for "${legacy}"`); return undefined; }
        const id = body.brand_map[legacy];
        if (id === null) { if (required) problems.push(`${what}: a scorecard needs a brand`); return null; }
        if (!brands.has(id)) { problems.push(`${what}: unknown brand`); return undefined; }
        return id;
      };
      const plan = tasks.map((t) => {
        const assignee = person(t.legacy_assignee, `Task "${t.title}"`), creator = person(t.legacy_creator, `Task "${t.title}" (creator)`);
        const b = brand(t.legacy_brand, `Task "${t.title}"`, false);
        const role = assignee ? people.get(assignee).role : null;
        if (assignee && b && role === "staff" && !access.has(`${assignee}:${b}`)) problems.push(`Task "${t.title}": the mapped person has no access to the mapped brand (access is never granted by an import)`);
        return { t, assignee, creator, brand: b };
      });
      const kplan = kpis.map((k) => {
        const owner = person(k.legacy_owner, `KPI "${k.metric}"`), b = brand(k.legacy_brand, `KPI "${k.metric}"`, true);
        if (owner && b && people.get(owner).role === "staff" && !access.has(`${owner}:${b}`)) problems.push(`KPI "${k.metric}": the mapped person has no access to the mapped brand`);
        return { k, owner, brand: b };
      });
      if (problems.length) throw new HttpError(422, "import_invalid", "Fix the mappings before committing. Nothing was imported.", [...new Set(problems)].slice(0, 50));

      let created = 0, skipped = 0, kCreated = 0, kSkipped = 0;
      for (const p of plan) {
        const rec = (await c.query(`insert into import_records (batch_id, record_kind, fingerprint, legacy_ref, target_id) values ($1,'task',$2,$3, gen_random_uuid())
                                    on conflict (record_kind, fingerprint) do nothing returning id, target_id`, [batch.id, p.t.cid, `task:${p.t.legacy_id}`])).rows[0];
        if (!rec) { skipped++; continue; }          // already imported earlier: idempotent
        const t = p.t;
        await c.query(
          `insert into tasks (id, brand_id, assignee_id, creator_id, title, note, type, due_date, recurrence, legacy_kpi_label, operational_date, completed_on, import_record_id, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
          [rec.target_id, p.brand, p.assignee, p.creator, t.title, t.note, t.type, t.due, t.recurrence, t.legacy_kpi, t.date, t.completed_on, rec.id]);
        if (t.completed_occurrence)
          await c.query("insert into task_occurrences (task_id, occurrence_date, completed_on, import_record_id) values ($1,$2,$2,$3)", [rec.target_id, t.completed_occurrence, rec.id]);
        await c.query("insert into task_history (task_id, actor_id, action, changes) values ($1,$2,'imported',$3)", [rec.target_id, s.userId, JSON.stringify({ import_id: batch.id, old_id: t.legacy_id })]);
        created++;
      }
      for (const p of kplan) {
        const rec = (await c.query(`insert into import_records (batch_id, record_kind, fingerprint, legacy_ref, target_id) values ($1,'kpi',$2,$3, gen_random_uuid())
                                    on conflict (record_kind, fingerprint) do nothing returning id, target_id`, [batch.id, p.k.cid, p.k.legacy_id ? `kpi:${p.k.legacy_id}` : null])).rows[0];
        if (!rec) { kSkipped++; continue; }
        await c.query(`insert into kpi_definitions (id, owner_id, brand_id, metric, sub_metric, target, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rec.target_id, p.owner, p.brand, p.k.metric, p.k.sub_metric, p.k.target, p.k.note, s.userId]);
        if (p.k.current) await c.query("insert into kpi_values (kpi_id, period_start, value, updated_by) values ($1,$2,$3,$4)", [rec.target_id, weekStart(p.k.value_week_of), p.k.current, s.userId]);
        kCreated++;
      }
      await c.query("update import_batches set status = 'committed', committed_at = now(), committed_by = $2 where id = $1", [batch.id, s.userId]);
      const out = { tasks_created: created, tasks_already_imported: skipped, kpis_created: kCreated, kpis_already_imported: kSkipped };
      await audit(c, s.userId, "import.committed", "import", batch.id, { kind: "legacy_browser", ...out });
      return out;
    });
    return result;
  }, true);

  r.post("/imports/:id/discard", ADMIN, async ({ params, session: s }) => {
    if (!UUID_RE.test(params.id)) throw notFound("Import");
    const n = await one("update import_batches set status = 'discarded', preview = '{}'::jsonb where id = $1 and status = 'preview' returning id", [params.id]);
    if (n) await audit(null, s.userId, "import.discarded", "import", params.id);
    return { ok: true };
  }, true);

  r.get("/imports", ADMIN, async () => ({
    items: await query(`select b.id, b.kind, b.status, b.source_label, b.summary, b.created_at, b.committed_at, u.display_name created_by
                          from import_batches b join users u on u.id = b.created_by order by b.created_at desc limit 50`),
  }));

  // ------------------------------------------------------------------ KPI spreadsheet
  r.post("/imports/kpi-xlsx/preview", ADMIN, async ({ req, session: s }) => {
    await hit({ bucket: `import:${accountKey(s.userId)}`, ...RATE.imports });
    const file = await readUpload(req, LIMITS.uploadBytes);
    const parsed = await parseKpiWorkbook(file.bytes);
    const rows = parsed.rows.map((r) => ({ ...r, cid: fingerprint("kpi_xlsx_row", { metric: r.metric, sub: r.sub_metric, target: r.target, row: r.row }) }));
    const id = (await one<{ id: string }>(`insert into import_batches (kind, source_label, file_sha256, preview, summary, created_by, expires_at)
                                           values ('kpi_xlsx', $1, $2, $3, $4, $5, now() + make_interval(hours => $6)) returning id`,
      ["Scorecard spreadsheet", sha(file.bytes), JSON.stringify({ rows }), JSON.stringify({ rows: rows.length, skipped: parsed.skipped.length }), s.userId, BATCH_HOURS]))!.id;
    await audit(null, s.userId, "import.previewed", "import", id, { kind: "kpi_xlsx", rows: rows.length, skipped: parsed.skipped.length });
    return { id, rows, skipped: parsed.skipped };
  }, true);

  r.post("/imports/kpi-xlsx/:id/commit", ADMIN, async ({ req, params, session: s }) => {
    const body = parse(z.object({ owner_id: uuid, brand_id: uuid, rows: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(500) }).strict(), await readJson(req));
    await loadBatch(params.id, "kpi_xlsx");
    return tx(async (c) => {
      const batch = (await c.query("select * from import_batches where id = $1 for update", [params.id])).rows[0];
      if (batch.status !== "preview") throw new HttpError(409, "already_committed", "This import was already committed. Upload the file again to start a new preview.");
      if (new Date(batch.expires_at) < new Date()) throw new HttpError(409, "expired", "This preview expired. Upload the file again.");
      await assertKpiOwner(c, body.owner_id, body.brand_id);
      const rows = (batch.preview.rows as any[]).filter((r) => body.rows.includes(r.cid));
      if (rows.length !== new Set(body.rows).size) throw badRequest("Some selected rows are not in this preview.");
      let created = 0, skipped = 0;
      for (const r of rows) {
        // Idempotent per scorecard: the same row imported again for the same person and brand is skipped.
        const fp = fingerprint("kpi_xlsx", { owner: body.owner_id, brand: body.brand_id, metric: r.metric, sub: r.sub_metric, target: r.target });
        const rec = (await c.query(`insert into import_records (batch_id, record_kind, fingerprint, target_id) values ($1,'kpi',$2, gen_random_uuid())
                                    on conflict (record_kind, fingerprint) do nothing returning id, target_id`, [batch.id, fp])).rows[0];
        if (!rec) { skipped++; continue; }
        await c.query(`insert into kpi_definitions (id, owner_id, brand_id, metric, sub_metric, target, created_by, sort_order)
                       values ($1,$2,$3,$4,$5,$6,$7, coalesce((select max(sort_order) + 1 from kpi_definitions where owner_id = $2 and brand_id = $3), 0))`,
          [rec.target_id, body.owner_id, body.brand_id, r.metric, r.sub_metric, r.target, s.userId]);
        created++;
      }
      await c.query("update import_batches set status = 'committed', committed_at = now(), committed_by = $2 where id = $1", [batch.id, s.userId]);
      await audit(c, s.userId, "import.committed", "import", batch.id, { kind: "kpi_xlsx", created, skipped, owner_id: body.owner_id, brand_id: body.brand_id });
      return { created, already_imported: skipped };
    });
  }, true);
}
