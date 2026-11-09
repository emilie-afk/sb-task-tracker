import pg from "pg";
import { logServerError } from "./redact";

// DATE columns are returned as 'YYYY-MM-DD' strings (no timezone shifting); bigint/numeric as numbers.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 15_000,
      ssl: local || process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: true },
    });
    // The database can close a connection while it sits idle in the pool (Neon closes connections when the compute
    // suspends, often while this function is frozen between requests). pg reports that as an "error" event on the
    // pool; without a listener Node treats it as an uncaught exception and the whole function instance crashes.
    // Log it and let the pool drop that connection; the next query opens a new one.
    pool.on("error", (e) => logServerError("db-idle-connection", e));
  }
  return pool;
}

const LOST_CODES = new Set(["57P01", "57P02", "57P03", "08000", "08003", "08006", "ECONNRESET", "EPIPE"]);

/** True when the error means the connection itself was gone (closed by the server or the network), not a query error. */
export function connectionLost(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  return LOST_CODES.has(String(err.code)) || /Connection terminated|terminating connection|Client has encountered a connection error/i.test(String(err.message));
}

/**
 * Checks out a client and starts a transaction on it. A pooled connection that the server closed while idle fails
 * on its first statement; that client is discarded and a fresh one is tried once. Nothing has run yet at that point,
 * so retrying can never apply work twice. With `deadline`, no attempt (first or retry) starts once it has passed:
 * `expired()` is thrown instead.
 */
export async function beginTransaction(begin = "begin", opts: { deadline?: number; expired?: () => Error } = {}): Promise<pg.PoolClient> {
  const { deadline = Infinity, expired = () => new Error("Deadline passed before the transaction started.") } = opts;
  for (let attempt = 0; ; attempt++) {
    if (Date.now() >= deadline) throw expired();
    const client = await getPool().connect();
    // A connection that drops while checked out (between statements) is reported as an "error" event on the client;
    // keep it from becoming an uncaught exception. The pending or next statement fails and the caller sees that.
    if (!(client as { __lostHandler?: boolean }).__lostHandler) {
      client.on("error", (e) => logServerError("db-active-connection", e));
      (client as { __lostHandler?: boolean }).__lostHandler = true;
    }
    if (Date.now() >= deadline) { client.release(); throw expired(); }   // waiting for a client can use up the budget
    try {
      await client.query(begin);
      return client;
    } catch (e) {
      client.release(e instanceof Error ? e : true);
      if (attempt > 0 || !connectionLost(e)) throw e;
    }
  }
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export type Db = pg.PoolClient | pg.Pool;

export async function query<T = any>(text: string, params: unknown[] = [], db: Db = getPool()): Promise<T[]> {
  // No automatic retry here: a statement can have side effects even when it starts with SELECT (nextval, functions
  // that write, multi-statement batches), so a dropped connection is reported to the caller, never re-run.
  return (await db.query(text, params as any[])).rows as T[];
}
export async function one<T = any>(text: string, params: unknown[] = [], db: Db = getPool()): Promise<T | null> {
  return (await query<T>(text, params, db))[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, isolation: "read committed" | "repeatable read" = "read committed"): Promise<T> {
  const client = await beginTransaction(`begin isolation level ${isolation}`);
  let lost = false;
  try {
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    lost = connectionLost(e);
    if (!lost) await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release(lost ? true : undefined);   // never return a dead connection to the pool
  }
}
