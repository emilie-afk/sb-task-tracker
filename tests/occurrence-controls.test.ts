// Recurring-task controls follow occurrence ownership (review finding, round 3). After archiving the original
// assignee and reassigning a daily series with unfinished older occurrences, the replacement's card selects their
// own occurrence and can complete it; the previous owner's backlog stays theirs and is never completable by the
// replacement. Includes a browser test of the real UI. Fictional data only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { freshDb, q, call, person, brand, login, task, closePool, type Who } from "./helpers";
import { _setClockForTests } from "../shared/dates";
import { createPreviewServer } from "../scripts/preview-server";
import { sessionCookieFor } from "../server/auth";

let admin: Who, ann: Who, ben: Who, cara: Who, SB: string, series: any;
const card = async (who: Who) => (await call(who, "GET", "/tasks?q=Daily%20inbox")).body.items[0];

beforeAll(async () => {
  await freshDb();
  _setClockForTests(() => Date.parse("2026-11-10T03:00:00Z"));           // Tue 10 Nov, Vietnam
  SB = await brand("Alpha Plants");
  admin = await login(await person("admin@example.test", "Ada Admin", "administrator"));
  ann = await login(await person("ann@example.test", "Ann Original", "staff", "active", [SB]));
  ben = await login(await person("ben@example.test", "Ben Replacement", "staff", "active", [SB]));
  cara = await login(await person("cara@example.test", "Cara Colleague", "staff", "active", [SB]));
  series = await task(admin, { title: "Daily inbox", brand_id: SB, assignee_id: ann.id, recurrence: "daily", due_date: "2026-11-03" });
  // Ann finishes only 5 Nov; 3, 4 and 6–9 Nov stay unfinished.
  expect((await call(ann, "POST", `/tasks/${series.id}/completion`, { done: true, occurrence_date: "2026-11-05" })).status).toBe(200);
  const p = (await call(admin, "GET", `/people/${ann.id}`)).body.person;
  const r = await call(admin, "POST", `/people/${ann.id}/archive`, { version: p.version, reassign: [{ task_id: series.id, assignee_id: ben.id }] });
  expect(r.body.reassigned[0].ok).toBe(true);
});
afterAll(async () => { _setClockForTests(null); await closePool(); });

describe("API: occurrence owner and completion permission", () => {
  it("the replacement's card selects their own occurrence and may complete it", async () => {
    const c = await card(ben);
    expect(c.can_edit).toBe(true);
    expect(c.can_complete).toBe(true);
    expect(c.occurrence).toMatchObject({ date: "2026-11-10", done: false, overdue: false, can_complete: true, owner: { id: ben.id, name: "Ben Replacement", archived: false } });
    expect((await call(ben, "POST", `/tasks/${series.id}/completion`, { done: true, occurrence_date: c.occurrence.date })).status).toBe(200);
    const after = await card(ben);
    expect(after).toMatchObject({ status: "done", occurrence: { date: "2026-11-10", done: true } });
    // List and detail agree for the replacement.
    expect((await call(ben, "GET", `/tasks/${series.id}`)).body.task.occurrence).toEqual(after.occurrence);
    await call(ben, "POST", `/tasks/${series.id}/completion`, { done: false, occurrence_date: "2026-11-10" });
  });
  it("the administrator sees the previous owner's backlog, labelled with its owner, and may complete it", async () => {
    const c = await card(admin);
    expect(c.occurrence).toMatchObject({ date: "2026-11-03", overdue: true, can_complete: true, owner: { id: ann.id, name: "Ann Original", archived: true } });
  });
  it("a colleague reading the card gets no completion control", async () => {
    const c = await card(cara);
    expect(c).toMatchObject({ can_edit: false, can_complete: false, occurrence: { can_complete: false, owner: { id: ann.id } } });
  });
  it("every card that offers completion can actually complete (no can_complete followed by 403)", async () => {
    for (const who of [admin, ben, cara]) {
      const c = await card(who);
      const r = await call(who, "POST", `/tasks/${series.id}/completion`, { done: !c.occurrence.done, occurrence_date: c.occurrence.date });
      expect(r.status, `viewer ${who.id}`).toBe(c.can_complete ? 200 : 403);
      if (r.status === 200) await call(who, "POST", `/tasks/${series.id}/completion`, { done: c.occurrence.done, occurrence_date: c.occurrence.date });
    }
  });
  it("the occurrence list labels each occurrence with its owner and permission; historical ownership is unchanged", async () => {
    const items = (await call(ben, "GET", `/tasks/${series.id}/occurrences?from=2026-11-08&to=2026-11-11`)).body.items;
    expect(items.map((o: any) => [o.date, o.owner.name, o.owner.archived, o.can_complete])).toEqual([
      ["2026-11-08", "Ann Original", true, false], ["2026-11-09", "Ann Original", true, false],
      ["2026-11-10", "Ben Replacement", false, true], ["2026-11-11", "Ben Replacement", false, true]]);
    expect((await call(ben, "POST", `/tasks/${series.id}/completion`, { done: true, occurrence_date: "2026-11-09" })).status).toBe(403);
    expect((await q("select count(*)::int n from task_occurrences where task_id = $1 and occurrence_date between '2026-11-06' and '2026-11-09'", [series.id]))[0].n).toBe(0);
    expect((await q("select assignee_id, effective_from::text e from task_assignments where task_id = $1 order by effective_from", [series.id])).map((r) => r.assignee_id)).toEqual([ann.id, ben.id]);
  });
  it("when the reassignment takes effect later, the replacement's card shows their next own occurrence", async () => {
    const dana = await login(await person("dana@example.test", "Dana Early", "staff", "active", [SB]));
    const t = await task(admin, { title: "Daily intake", brand_id: SB, assignee_id: dana.id, recurrence: "daily", due_date: "2026-11-09" });
    await call(dana, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-11" });      // done ahead
    const cur = (await call(admin, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(admin, "POST", `/tasks/${t.id}/reassign`, { assignee_id: ben.id, version: cur.version })).body.effective_from).toBe("2026-11-12");
    const c = (await call(ben, "GET", "/tasks?q=Daily%20intake")).body.items[0];
    expect(c.occurrence).toMatchObject({ date: "2026-11-12", upcoming: true, can_complete: true, owner: { id: ben.id } });
    // Dana (still active) keeps her own unfinished occurrences and can complete them.
    const d = (await call(dana, "GET", "/tasks?q=Daily%20intake")).body.items[0];
    expect(d).toMatchObject({ can_edit: false, can_complete: true, occurrence: { date: "2026-11-09", owner: { id: dana.id } } });
    expect((await call(dana, "POST", `/tasks/${t.id}/completion`, { done: true, occurrence_date: "2026-11-09" })).status).toBe(200);
  });
});

describe("API: one completion rule (ownership and the 31-day limit) for cards, occurrence lists and completion", () => {
  // Today is 10 Nov (Vietnam): 11 Dec is today + 31 (allowed), 12 Dec is today + 32 (disabled and rejected).
  let mgmt: Who, near: any, far: any;
  const cardOf = async (who: Who, title: string) => (await call(who, "GET", `/tasks?q=${encodeURIComponent(title)}`)).body.items[0];
  beforeAll(async () => {
    mgmt = await login(await person("mgmt@example.test", "Mia Management", "management"));
    near = await task(admin, { title: "Monthly edge near", brand_id: SB, assignee_id: ben.id, recurrence: "monthly", due_date: "2026-12-11" });
    far = await task(admin, { title: "Monthly edge far", brand_id: SB, assignee_id: ben.id, recurrence: "monthly", due_date: "2026-12-12" });
  });
  it("today + 31: the card offers completion to the owner and the administrator, and completion succeeds", async () => {
    for (const who of [admin, ben]) {
      const c = await cardOf(who, "Monthly edge near");
      expect(c, `viewer ${who.id}`).toMatchObject({ can_complete: true, occurrence: { date: "2026-12-11", upcoming: true, can_complete: true, completion_blocked: null } });
      expect((await call(who, "POST", `/tasks/${near.id}/completion`, { done: true, occurrence_date: "2026-12-11" })).status).toBe(200);
      expect((await call(who, "POST", `/tasks/${near.id}/completion`, { done: false, occurrence_date: "2026-12-11" })).status).toBe(200);
    }
  });
  it("today + 32: the card stays visible with completion disabled and explained, and completion is rejected", async () => {
    for (const who of [admin, ben]) {
      const c = await cardOf(who, "Monthly edge far");
      expect(c, `viewer ${who.id}`).toMatchObject({ can_complete: false,
        occurrence: { date: "2026-12-12", upcoming: true, can_complete: false, completion_blocked: "too_far_ahead", completable_from: "2026-11-11" } });
      expect((await call(who, "POST", `/tasks/${far.id}/completion`, { done: true, occurrence_date: "2026-12-12" })).status).toBe(400);
    }
    expect((await q("select count(*)::int n from task_occurrences where task_id = $1", [far.id]))[0].n).toBe(0);
  });
  it("ownership is checked before the date: others see their own reason", async () => {
    expect((await cardOf(cara, "Monthly edge far")).occurrence).toMatchObject({ can_complete: false, completion_blocked: "other_owner" });
    expect((await cardOf(mgmt, "Monthly edge far")).occurrence).toMatchObject({ can_complete: false, completion_blocked: "view_only" });
    expect((await call(cara, "POST", `/tasks/${far.id}/completion`, { done: true, occurrence_date: "2026-12-12" })).status).toBe(403);
    expect((await call(mgmt, "POST", `/tasks/${far.id}/completion`, { done: true, occurrence_date: "2026-12-12" })).status).toBe(403);
  });
  it("the occurrence list applies the same boundary, and every offered control succeeds while every withheld one is refused", async () => {
    for (const who of [admin, ben, cara, mgmt]) {
      const items = (await call(who, "GET", `/tasks/${series.id}/occurrences?from=2026-12-10&to=2026-12-13`)).body.items;
      const expected = who === admin || who === ben
        ? [["2026-12-10", true, null], ["2026-12-11", true, null], ["2026-12-12", false, "too_far_ahead"], ["2026-12-13", false, "too_far_ahead"]]
        : items.map((o: any) => [o.date, false, who === cara ? "other_owner" : "view_only"]);
      expect(items.map((o: any) => [o.date, o.can_complete, o.completion_blocked]), `viewer ${who.id}`).toEqual(expected);
      for (const o of items) {
        const r = await call(who, "POST", `/tasks/${series.id}/completion`, { done: true, occurrence_date: o.date });
        expect(r.status, `viewer ${who.id} ${o.date}`).toBe(o.can_complete ? 200 : o.completion_blocked === "too_far_ahead" ? 400 : 403);
        if (r.status === 200) await call(who, "POST", `/tasks/${series.id}/completion`, { done: false, occurrence_date: o.date });
      }
    }
  });
});

// ------------------------------------------------------------------ browser
let chromium: any = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }

describe("browser: the replacement completes their own occurrence; others' are disabled", () => {
  it("works in the real interface under the production CSP", async (ctx) => {
    let browser: any;
    try { browser = await chromium?.launch(); } catch { browser = null; }
    if (!browser) { console.warn("Skipping browser test: no Playwright Chromium available (set PLAYWRIGHT_BROWSERS_PATH)."); ctx.skip(); return; }
    const root = join(import.meta.dirname, "..");
    if (!existsSync(join(root, "dist", "index.html"))) execSync("npx vite build", { cwd: root, stdio: "ignore" });
    const server = createPreviewServer({ port: 0 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const base = `http://localhost:${port}`;
    const savedBase = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = base;
    const asUser = async (userId: string, everyone = false) => {
      const c = await browser.newContext();
      const { cookie } = await sessionCookieFor(userId, new Request(`${base}/`));
      const [name, value] = cookie.split("=");
      await c.addCookies([{ name, value, url: base, httpOnly: true, sameSite: "Lax" }]);
      const page = await c.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(String(e)));
      page.on("requestfailed", (r: any) => errors.push(`failed ${r.url()} ${r.failure()?.errorText}`));
      page.on("response", (r: any) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
      page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      const completions: string[] = [];
      page.on("request", (r: any) => { if (r.url().includes("/completion")) completions.push(r.postData() ?? ""); });
      await page.goto(base);
      await page.waitForSelector(".toolbar");
      // Staff lists start filtered to their own tasks; a colleague switches to Everyone to see the card.
      if (everyone) await page.locator(".fchip", { hasText: "Everyone" }).click();
      await page.waitForSelector(".tc");
      const tc = page.locator(".tc", { hasText: "Daily inbox" });
      return { c, page, errors, completions, tc };
    };
    try {
      // Replacement: control enabled, completes today's own occurrence.
      const b = await asUser(ben.id);
      const chk = b.tc.locator(".chk");
      expect(await chk.getAttribute("aria-disabled")).toBeNull();
      await chk.click();
      await b.page.waitForFunction(() => [...document.querySelectorAll(".tc")].some((e) => e.textContent?.includes("Daily inbox") && e.querySelector(".chk.on")));
      expect(await b.page.locator(".tc", { hasText: "Daily inbox" }).textContent()).toContain("Done for Nov 10");
      expect(b.completions.length).toBe(1);
      // An occurrence more than 31 days ahead stays visible with a disabled, explained control.
      const farCard = b.page.locator(".tc", { hasText: "Monthly edge far" });
      expect(await farCard.locator(".chk").getAttribute("aria-disabled")).toBe("true");
      expect(await farCard.textContent()).toContain("Can be completed from Nov 11");
      await farCard.locator(".chk").click({ force: true });
      await b.page.waitForTimeout(200);
      expect(b.completions.length).toBe(1);
      // Detail: older occurrences are labelled with Ann (archived) and have no control; Ben's have one.
      await b.page.locator(".tc .tt a", { hasText: "Daily inbox" }).click();
      await b.page.waitForSelector(".occ-tbl");
      const row = (d: string) => b.page.locator(`.occ-tbl tr[data-date="${d}"]`);
      expect(await row("2026-11-09").textContent()).toContain("Ann Original");
      expect(await row("2026-11-09").textContent()).toContain("Archived");
      expect(await row("2026-11-09").locator(".occ-toggle").count()).toBe(0);
      expect(await row("2026-11-11").locator(".occ-toggle").count()).toBe(1);
      await row("2026-11-11").locator(".occ-toggle").click();
      await b.page.waitForFunction(() => document.querySelector('.occ-tbl tr[data-date="2026-11-11"]')?.textContent?.includes("Done"));
      expect(b.errors).toEqual([]);
      await b.c.close();
      // Colleague: control disabled, clicking sends nothing.
      const c = await asUser(cara.id, true);
      expect(await c.tc.locator(".chk").getAttribute("aria-disabled")).toBe("true");
      expect(await c.tc.textContent()).toContain("Ann Original's occurrence (archived)");
      await c.tc.locator(".chk").click({ force: true });         // a forced click still sends nothing
      await c.page.waitForTimeout(300);
      expect(c.completions).toEqual([]);
      expect(c.errors).toEqual([]);
      await c.c.close();
      // Administrator: Ann's backlog shown with its owner label and an enabled control.
      const a = await asUser(admin.id);
      expect(await a.tc.textContent()).toContain("Ann Original's occurrence (archived)");
      expect(await a.tc.locator(".chk").getAttribute("aria-disabled")).toBeNull();
      await a.c.close();
    } finally {
      await browser.close();
      process.env.APP_BASE_URL = savedBase;
      await new Promise((r) => server.close(r));
    }
    // Server state matches what the UI showed.
    const done = (await q("select occurrence_date::text d, completed_by from task_occurrences where task_id = $1 order by 1", [series.id]));
    expect(done).toEqual([{ d: "2026-11-05", completed_by: ann.id }, { d: "2026-11-10", completed_by: ben.id }, { d: "2026-11-11", completed_by: ben.id }]);
  }, 60_000);
});
