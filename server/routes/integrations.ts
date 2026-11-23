// Marketing dashboard reporting configuration (administrators only). The reporting secret is random, shown once
// when generated, stored only as a hash, and revocable. Generating a new one revokes the previous one.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Router } from "../router";
import { ADMIN } from "../router";
import { query, one, tx } from "../db";
import { badRequest, readJson } from "../http";
import { parse } from "../validate";
import { audit } from "../audit";
import { instanceId, supportedDashboardBusinesses, dashboardOrigin } from "../config";
import { hit, accountKey, RATE } from "../rateLimit";
import { now as clockNow } from "../../shared/dates";

export function registerIntegrations(r: Router) {
  r.get("/integrations/reporting", ADMIN, async () => {
    const cred = await one(`select c.created_at, c.last_used_at, c.allowed_business_ids, u.display_name created_by
                              from reporting_credentials c left join users u on u.id = c.created_by where c.revoked_at is null`);
    const allowed: string[] = cred?.allowed_business_ids ?? [];
    const brands = (await query<any>("select id, display_name, status, reporting_enabled, dashboard_business_id from brands order by lower(display_name)")).map((b) => ({
      id: b.id, name: b.display_name, archived: b.status === "archived", reporting_enabled: b.reporting_enabled, dashboard_business_id: b.dashboard_business_id,
      included: !!cred && b.reporting_enabled && allowed.includes(b.dashboard_business_id),
      reason: !b.dashboard_business_id ? "Not mapped to a dashboard business."
        : !b.reporting_enabled ? "Reporting is turned off for this brand."
        : !cred ? "No reporting credential exists yet."
        : !allowed.includes(b.dashboard_business_id) ? `The reporting credential does not include the "${b.dashboard_business_id}" business.`
        : b.status === "archived" ? "Included; shown as archived in the dashboard." : "Included.",
    }));
    return { configured: !!cred && !!instanceId(), instance_id_configured: !!instanceId(), credential: cred, brands, supported_dashboard_businesses: supportedDashboardBusinesses() };
  });

  r.post("/integrations/reporting/credential", ADMIN, async ({ req, session: s }) => {
    await hit({ bucket: `sens:${accountKey(s.userId)}`, ...RATE.sensitive });
    const b = parse(z.object({ allowed_business_ids: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).min(1).max(10).default(["sb"]) }).strict(), await readJson(req));
    const bad = b.allowed_business_ids.filter((x) => !supportedDashboardBusinesses().includes(x));
    if (bad.length) throw badRequest("Unsupported dashboard business.");
    const secret = "ttr_" + randomBytes(32).toString("base64url");
    await tx(async (c) => {
      await c.query("update reporting_credentials set revoked_at = now(), revoked_by = $1 where revoked_at is null", [s.userId]);
      await c.query("insert into reporting_credentials (key_hash, allowed_business_ids, created_by) values ($1,$2,$3)",
        [createHash("sha256").update(secret).digest(), [...new Set(b.allowed_business_ids)], s.userId]);
      await audit(c, s.userId, "integration.reporting_credential_created", "integration", "reporting", { allowed_business_ids: b.allowed_business_ids });
    });
    // Shown once. Store it only as a server-side setting of the marketing dashboard.
    return { secret, allowed_business_ids: b.allowed_business_ids };
  }, true);

  r.delete("/integrations/reporting/credential", ADMIN, async ({ session: s }) => {
    await tx(async (c) => {
      const n = (await c.query("update reporting_credentials set revoked_at = now(), revoked_by = $1 where revoked_at is null", [s.userId])).rowCount;
      if (n) await audit(c, s.userId, "integration.reporting_credential_revoked", "integration", "reporting");
    });
    return { ok: true };
  }, true);

  // ---- Marketing planning (dashboard -> tracker task creation). The credential acts as the administrator who
  // creates it, through the task editor's own rules.
  r.get("/integrations/planning", ADMIN, async () => {
    const cred = await one(`select c.created_at, c.last_used_at, c.allowed_business_ids, u.display_name acting_as, u.status acting_status, u.role acting_role
                              from planning_credentials c join users u on u.id = c.acting_user_id where c.revoked_at is null`);
    const brands = (await query<any>("select display_name, status, reporting_enabled, dashboard_business_id from brands order by lower(display_name)")).map((b) => ({
      name: b.display_name, available: !!cred && b.status === "active" && b.reporting_enabled && (cred.allowed_business_ids as string[]).includes(b.dashboard_business_id),
    }));
    return { credential: cred ? { ...cred, acting_ok: cred.acting_status !== "archived" && cred.acting_role === "administrator" } : null,
      dashboard_url_configured: !!dashboardOrigin(), brands, supported_dashboard_businesses: supportedDashboardBusinesses() };
  });

  r.post("/integrations/planning/credential", ADMIN, async ({ req, session: s }) => {
    await hit({ bucket: `sens:${accountKey(s.userId)}`, ...RATE.sensitive });
    const b = parse(z.object({ allowed_business_ids: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).min(1).max(10).default(["sb"]) }).strict(), await readJson(req));
    if (b.allowed_business_ids.some((x) => !supportedDashboardBusinesses().includes(x))) throw badRequest("Unsupported dashboard business.");
    const secret = "tpl_" + randomBytes(32).toString("base64url");
    await tx(async (c) => {
      await c.query("update planning_credentials set revoked_at = now(), revoked_by = $1 where revoked_at is null", [s.userId]);
      await c.query("insert into planning_credentials (key_hash, acting_user_id, allowed_business_ids, created_by) values ($1,$2,$3,$2)",
        [createHash("sha256").update(secret).digest(), s.userId, [...new Set(b.allowed_business_ids)]]);
      await audit(c, s.userId, "integration.planning_credential_created", "integration", "planning", { allowed_business_ids: b.allowed_business_ids });
    });
    return { secret, allowed_business_ids: b.allowed_business_ids };
  }, true);

  r.delete("/integrations/planning/credential", ADMIN, async ({ session: s }) => {
    await tx(async (c) => {
      const n = (await c.query("update planning_credentials set revoked_at = now(), revoked_by = $1 where revoked_at is null", [s.userId])).rowCount;
      if (n) await audit(c, s.userId, "integration.planning_credential_revoked", "integration", "planning");
    });
    return { ok: true };
  }, true);

  // ---- Slack task intake (scheduled Slack reader -> tracker). The credential acts as the administrator who creates
  // it; creating the first credential starts monitoring from that moment (the checkpoint).
  r.get("/integrations/slack", ADMIN, async () => {
    const cred = await one(`select c.created_at, c.last_used_at, u.display_name acting_as, u.status acting_status, u.role acting_role
                              from slack_intake_credentials c join users u on u.id = c.acting_user_id where c.revoked_at is null`);
    const state = await one<{ checkpoint_ts: string | null; activated_ts: string | null; updated_at: string }>("select checkpoint_ts, activated_ts, updated_at from slack_intake_state where id = 1");
    const people = await query(`select l.slack_user_id, u.id user_id, u.display_name name, u.status, u.role from slack_user_links l join users u on u.id = l.user_id order by lower(u.display_name)`);
    const channels = await query(`select m.channel_id, m.label, m.brand_id, b.display_name brand_name from slack_channel_brands m left join brands b on b.id = m.brand_id order by m.label nulls last, m.channel_id`);
    const reviews = await query(`select r.id, r.kind, r.task_id, t.title task_title, r.permalink, r.note, r.created_at from slack_review_items r left join tasks t on t.id = r.task_id
                                  where r.resolved_at is null order by r.created_at desc limit 100`);
    return { credential: cred ? { ...cred, acting_ok: cred.acting_status !== "archived" && cred.acting_role === "administrator" } : null,
      checkpoint_ts: state?.checkpoint_ts ?? null, activated_ts: state?.activated_ts ?? null, checkpoint_updated_at: state?.updated_at ?? null, people, channels, reviews };
  });

  r.post("/integrations/slack/credential", ADMIN, async ({ session: s }) => {
    await hit({ bucket: `sens:${accountKey(s.userId)}`, ...RATE.sensitive });
    const secret = "tsl_" + randomBytes(32).toString("base64url");
    await tx(async (c) => {
      await c.query("update slack_intake_credentials set revoked_at = now(), revoked_by = $1 where revoked_at is null", [s.userId]);
      await c.query("insert into slack_intake_credentials (key_hash, acting_user_id, created_by) values ($1,$2,$2)", [createHash("sha256").update(secret).digest(), s.userId]);
      // Monitoring starts now: messages before the first activation never become tasks. Replacing the credential later
      // keeps both the checkpoint and the activation time.
      const at = clockNow();
      const ts = `${Math.floor(at / 1000)}.${String(at % 1000).padStart(3, "0")}000`;
      await c.query("update slack_intake_state set checkpoint_ts = coalesce(checkpoint_ts, $1), activated_ts = coalesce(activated_ts, $1), updated_at = now() where id = 1", [ts]);
      await audit(c, s.userId, "integration.slack_credential_created", "integration", "slack");
    });
    // Shown once. Store it only in the scheduled reader's private key file.
    return { secret };
  }, true);

  r.delete("/integrations/slack/credential", ADMIN, async ({ session: s }) => {
    await tx(async (c) => {
      const n = (await c.query("update slack_intake_credentials set revoked_at = now(), revoked_by = $1 where revoked_at is null", [s.userId])).rowCount;
      if (n) await audit(c, s.userId, "integration.slack_credential_revoked", "integration", "slack");
    });
    return { ok: true };
  }, true);

  r.put("/integrations/slack/people", ADMIN, async ({ req, session: s }) => {
    const b = parse(z.object({ slack_user_id: z.string().regex(/^[UW][A-Z0-9]{6,15}$/), user_id: z.string().uuid() }).strict(), await readJson(req));
    await tx(async (c) => {
      const u = (await c.query("select role, status from users where id = $1", [b.user_id])).rows[0];
      if (!u || u.status === "archived" || u.role !== "staff") throw badRequest("Link Slack members to active staff only.");
      await c.query("delete from slack_user_links where user_id = $1 or slack_user_id = $2", [b.user_id, b.slack_user_id]);
      await c.query("insert into slack_user_links (slack_user_id, user_id, created_by) values ($1,$2,$3)", [b.slack_user_id, b.user_id, s.userId]);
      await audit(c, s.userId, "integration.slack_person_linked", "user", b.user_id);
    });
    return { ok: true };
  }, true);

  r.delete("/integrations/slack/people/:slackId", ADMIN, async ({ params, session: s }) => {
    if (!/^[UW][A-Z0-9]{6,15}$/.test(params.slackId)) throw badRequest("Invalid Slack member id.");
    await tx(async (c) => {
      const n = (await c.query("delete from slack_user_links where slack_user_id = $1 returning user_id", [params.slackId])).rows[0];
      if (n) await audit(c, s.userId, "integration.slack_person_unlinked", "user", n.user_id);
    });
    return { ok: true };
  }, true);

  r.put("/integrations/slack/channels", ADMIN, async ({ req, session: s }) => {
    const b = parse(z.object({ channel_id: z.string().regex(/^[CG][A-Z0-9]{6,15}$/), label: z.string().trim().min(1).max(80).nullable().optional(), brand_id: z.string().uuid().nullable() }).strict(), await readJson(req));
    await tx(async (c) => {
      if (b.brand_id && !(await c.query("select 1 from brands where id = $1 and status = 'active'", [b.brand_id])).rowCount) throw badRequest("Choose an active brand.");
      await c.query(`insert into slack_channel_brands (channel_id, label, brand_id) values ($1,$2,$3)
                     on conflict (channel_id) do update set label = excluded.label, brand_id = excluded.brand_id, updated_at = now()`, [b.channel_id, b.label ?? null, b.brand_id]);
      await audit(c, s.userId, "integration.slack_channel_brand_set", "integration", "slack", { channel_id: b.channel_id, brand_id: b.brand_id });
    });
    return { ok: true };
  }, true);

  r.delete("/integrations/slack/channels/:channelId", ADMIN, async ({ params, session: s }) => {
    if (!/^[CG][A-Z0-9]{6,15}$/.test(params.channelId)) throw badRequest("Invalid Slack channel id.");
    await tx(async (c) => {
      await c.query("delete from slack_channel_brands where channel_id = $1", [params.channelId]);
      await audit(c, s.userId, "integration.slack_channel_brand_removed", "integration", "slack", { channel_id: params.channelId });
    });
    return { ok: true };
  }, true);

  r.post("/integrations/slack/review/:id/resolve", ADMIN, async ({ params, session: s }) => {
    if (!/^[0-9a-f-]{36}$/.test(params.id)) throw badRequest("Invalid review item.");
    await query("update slack_review_items set resolved_at = now(), resolved_by = $2 where id = $1 and resolved_at is null", [params.id, s.userId]);
    return { ok: true };
  }, true);
}
