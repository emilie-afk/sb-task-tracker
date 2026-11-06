import pg from "pg";

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
  }
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export type Db = pg.PoolClient | pg.Pool;

export async function query<T = any>(text: string, params: unknown[] = [], db: Db = getPool()): Promise<T[]> {
  return (await db.query(text, params as any[])).rows as T[];
}
export async function one<T = any>(text: string, params: unknown[] = [], db: Db = getPool()): Promise<T | null> {
  return (await query<T>(text, params, db))[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, isolation: "read committed" | "repeatable read" = "read committed"): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`begin isolation level ${isolation}`);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
