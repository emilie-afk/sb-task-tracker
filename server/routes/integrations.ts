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
import { instanceId, supportedDashboardBusinesses } from "../config";
import { hit, accountKey, RATE } from "../rateLimit";

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
}
