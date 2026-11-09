// Database connections closed by the server (Neon closes them when the compute suspends, often while the function is
// frozen) must not crash the process, and the next request must work. Found in production on 2026-11-09: an idle
// pooled connection was terminated (57P01), pg emitted an "error" event with no listener, the function instance died
// and the dashboard's reporting pull got 502.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { freshDb, closePool } from "./helpers";
import { getPool, query, tx, beginTransaction, connectionLost } from "../server/db";

const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);
let admin: pg.Client;

beforeAll(async () => {
  await freshDb();
  process.on("uncaughtException", onUncaught);
  admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
});
afterAll(async () => { process.off("uncaughtException", onUncaught); await admin.end(); await closePool(); });
afterEach(() => { expect(uncaught).toEqual([]); });

const terminate = (pid: number) => admin.query("select pg_terminate_backend($1)", [pid]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("connections closed by the server", () => {
  it("an idle pooled connection terminated by the server is logged and dropped, not an uncaught exception", async () => {
    const [{ pid }] = await query<{ pid: number }>("select pg_backend_pid() pid");
    expect(getPool().idleCount).toBeGreaterThan(0);
    await terminate(pid);
    await sleep(300);                                   // the pool's "error" event fires here
    expect(uncaught).toEqual([]);
    expect((await query<{ ok: number }>("select 1 ok"))[0].ok).toBe(1);
    expect(await tx(async (c) => (await c.query("select 2 ok")).rows[0].ok)).toBe(2);
  });

  it("a connection terminated while checked out does not crash the process; the transaction fails and the pool recovers", async () => {
    await expect(tx(async (c) => {
      const pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
      await terminate(pid);
      await sleep(200);                                 // the client's "error" event fires between statements
      await c.query("select 1");
    })).rejects.toSatisfy(connectionLost);
    expect((await query<{ ok: number }>("select 3 ok"))[0].ok).toBe(3);
  });

  it("a statement on a dead connection is never retried automatically, even when it starts with SELECT", async () => {
    const pool = getPool();
    const real = pool.query.bind(pool);
    for (const text of ["select 4 ok", "select nextval('x')", "insert into rate_limits (bucket, window_start, hits) values ('t', now(), 1)"]) {
      let calls = 0;
      (pool as any).query = (...a: any[]) => (calls++ === 0 ? Promise.reject(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })) : (real as any)(...a));
      try {
        await expect(query(text)).rejects.toSatisfy(connectionLost);
        expect(calls, text).toBe(1);
      } finally { (pool as any).query = real; }
    }
    expect((await query<{ ok: number }>("select 4 ok"))[0].ok).toBe(4);   // the next request works normally
  });

  it("starting a transaction on a dead pooled connection retries once on a fresh connection", async () => {
    const pool = getPool();
    const realConnect = pool.connect.bind(pool);
    let first = true;
    (pool as any).connect = async () => {
      const c = await (realConnect as any)();
      if (first) {
        first = false;
        const realQ = c.query.bind(c);
        c.query = (...a: any[]) => { c.query = realQ; return Promise.reject(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })); };
      }
      return c;
    };
    try {
      const c = await beginTransaction();
      await c.query("rollback"); c.release();
      expect(first).toBe(false);
      expect(await tx(async (cl) => (await cl.query("select 5 ok")).rows[0].ok)).toBe(5);
    } finally { (pool as any).connect = realConnect; }
  });

  it("no BEGIN attempt starts once the deadline has passed: the retry is skipped and the expiry error is thrown", async () => {
    const pool = getPool();
    const realConnect = pool.connect.bind(pool);
    let connects = 0;
    (pool as any).connect = async () => {
      connects++;
      const c = await (realConnect as any)();
      const realQ = c.query.bind(c);
      // The first BEGIN fails as a dead connection only after the deadline has passed.
      c.query = (...a: any[]) => { c.query = realQ; return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })), 80)); };
      return c;
    };
    const expired = () => Object.assign(new Error("expired"), { code: "test_expired" });
    try {
      await expect(beginTransaction("begin", { deadline: Date.now() + 30, expired })).rejects.toMatchObject({ code: "test_expired" });
      expect(connects).toBe(1);
      await expect(beginTransaction("begin", { deadline: Date.now() - 1, expired })).rejects.toMatchObject({ code: "test_expired" });
      expect(connects).toBe(1);                       // an already-expired deadline does not even check out a client
    } finally { (pool as any).connect = realConnect; }
    expect(getPool().totalCount).toBeLessThanOrEqual(3);
    expect(await tx(async (cl) => (await cl.query("select 6 ok")).rows[0].ok)).toBe(6);
  });

  it("ordinary query errors are not treated as lost connections", () => {
    expect(connectionLost(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(connectionLost(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
  });
});
