// Client sign-out (src/session.ts, src/api.ts) with a simulated server: success is shown only after the server
// confirms revocation; failures are reported as unconfirmed; requests of an ended session never return data.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, startClientSession, clientSessionActive, StaleSessionError } from "../src/api";
import { signOut, SIGN_OUT_FAILED } from "../src/session";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); startClientSession("csrf-token-1"); });
afterEach(() => vi.unstubAllGlobals());

describe("sign-out", () => {
  it("a network failure is not presented as signed out, and the session stays usable for a retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await signOut()).toEqual({ confirmed: false, message: SIGN_OUT_FAILED });
    expect(clientSessionActive()).toBe(true);
    fetchMock.mockResolvedValueOnce(ok({ ok: true }));
    expect(await signOut()).toEqual({ confirmed: true });
    const [, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe("POST");
    expect(init.headers["x-csrf-token"]).toBe("csrf-token-1");
  });
  it("a server or database failure (5xx) is not presented as signed out", async () => {
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "server_error", message: "Something went wrong on the server." } }, 500));
    expect(await signOut()).toEqual({ confirmed: false, message: SIGN_OUT_FAILED });
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "unavailable" } }, 503));
    expect((await signOut()).confirmed).toBe(false);
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "bad_csrf" } }, 403));
    expect((await signOut()).confirmed).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response("<html>proxy error</html>", { status: 200 }));
    expect((await signOut()).confirmed).toBe(false);            // no explicit confirmation from the server
    expect(clientSessionActive()).toBe(true);
  });
  it("after confirmed sign-out, in-flight responses are discarded and no new requests are sent", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));      // slow task list
    const pending = api("/tasks");
    fetchMock.mockResolvedValueOnce(ok({ ok: true }));
    expect(await signOut()).toEqual({ confirmed: true });
    expect(clientSessionActive()).toBe(false);
    release(ok({ items: [{ title: "Private task" }] }));
    await expect(pending).rejects.toBeInstanceOf(StaleSessionError);
    const calls = fetchMock.mock.calls.length;
    await expect(api("/tasks")).rejects.toBeInstanceOf(StaleSessionError);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
