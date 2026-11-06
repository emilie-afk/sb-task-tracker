import type { Db } from "./db";
import { getPool } from "./db";

/** Audit events never contain credentials, cookies or full request bodies; only ids and changed field names/values. */
export async function audit(db: Db | null, actorId: string | null, action: string, targetType?: string, targetId?: string, details?: unknown, actorLabel = "user") {
  await (db ?? getPool()).query(
    "insert into audit_events (actor_id, actor_label, action, target_type, target_id, details) values ($1,$2,$3,$4,$5,$6)",
    [actorId, actorLabel, action, targetType ?? null, targetId ?? null, details === undefined ? null : JSON.stringify(details)]);
}
