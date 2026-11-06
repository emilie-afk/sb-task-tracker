// Task Tracker client. Signed out, it shows only a generic Google sign-in button. Signed in, it loads every
// business record from the authenticated API; nothing about identity, roles, brands or tasks is kept in the
// browser beyond the current page.
import "./styles.css";
import { h, replace, initials } from "./dom";
import { api, startClientSession, endClientSession, whenSignedOut, errorText } from "./api";
import { signOut } from "./session";
import { msg } from "./ui";
import { tasksView } from "./views/tasks";
import { peopleView, brandsView, importsView, integrationsView } from "./views/admin";

export type Ctx = { me: { id: string; name: string; role: "administrator" | "staff" | "management" }; today: string };

const root = document.getElementById("root")!;

function signedOut(failed = false, confirmed = false) {
  document.title = "Task Tracker";
  for (const o of document.querySelectorAll(".overlay")) o.remove();      // dialogs from the old session
  replace(root, h("div", { class: "login-wrap" }, h("div", { class: "login-card" },
    h("div", { class: "login-title" }, "Task Tracker"),
    confirmed ? h("div", { class: "ok", role: "status" }, "You are signed out.") : null,
    h("div", { class: "login-sub" }, "Sign in with your approved Google account."),
    h("a", { class: "signin-btn", href: "/api/auth/login" }, "Sign in with Google"),
    failed ? h("div", { class: "signin-err", role: "alert" }, "Sign-in did not succeed. Use an approved account, or ask an administrator for access.") : null)));
}

async function start() {
  const params = new URLSearchParams(location.search);
  const failed = params.get("signin") === "failed";
  if (params.has("signin")) history.replaceState(null, "", location.pathname + location.hash);
  let me: any;
  try { me = await api("/me"); } catch (e) { replace(root, h("div", { class: "page" }, msg("error", errorText(e)))); return; }
  if (!me.signed_in) return signedOut(failed);
  startClientSession(me.csrf);
  // The server reports the session gone (expired, revoked, archived): drop all session state and views.
  whenSignedOut(() => { teardown(); endClientSession(); signedOut(); });
  const ctx: Ctx = { me: me.user, today: me.today };
  const admin = ctx.me.role === "administrator";
  const routes: [string, string, (root: HTMLElement, ctx: Ctx) => Promise<unknown>][] = [
    ["tasks", "Tasks", tasksView],
    ...(admin ? [["people", "People", peopleView], ["brands", "Brands", brandsView], ["imports", "Imports", importsView], ["integrations", "Integrations", integrationsView]] as [string, string, any][] : []),
  ];
  const nav = h("nav", { class: "nav" });
  const main = h("main");
  const signOutNotice = h("div");
  const signOutButton = h("button", { class: "signout", on: { click: () => doSignOut() } }, "Sign out");
  // Signed-out is shown only after the server confirms the session was revoked. On failure the page stays as it is
  // and says so, with a retry.
  async function doSignOut() {
    signOutButton.disabled = true;
    replace(signOutNotice);
    const r = await signOut();
    if (r.confirmed) { teardown(); signedOut(false, true); return; }
    signOutButton.disabled = false;
    replace(signOutNotice, h("div", { class: "page" }, h("div", { class: "error row", role: "alert" }, r.message,
      h("button", { class: "btn-sm", on: { click: () => doSignOut() } }, "Retry sign-out"))));
  }
  replace(root, h("div", { class: "app on" },
    h("div", { class: "topbar" },
      h("div", { class: "app-title" }, "☐ Task Tracker"), nav,
      h("div", { class: "topbar-right" },
        h("div", { class: "user-chip" }, h("span", { class: "av" }, initials(ctx.me.name)), ctx.me.name, ctx.me.role === "management" ? h("span", { class: "view-only" }, "Management · view only") : null),
        signOutButton)),
    signOutNotice,
    main));

  let current = "";
  let openTask: ((id: string) => void) | undefined;
  async function route() {
    const key = (/^#\/([a-z]+)/.exec(location.hash)?.[1]) ?? "tasks";
    const r = routes.find(([k]) => k === key) ?? routes[0];
    replace(nav, ...routes.map(([k, label]) => h("a", { href: `#/${k}`, class: k === r[0] ? "on" : "" }, label)));
    if (r[0] === current && r[0] === "tasks" && /^#\/tasks\/[0-9a-f-]{36}$/.test(location.hash)) { openTask?.(location.hash.slice(8)); return; }
    current = r[0];
    document.title = `${r[1]} · Task Tracker`;
    const out: any = await r[2](main, ctx);
    openTask = out?.openDetail;
  }
  // Removes authenticated route handling; called once the session has ended.
  function teardown() {
    window.removeEventListener("hashchange", route);
    openTask = undefined;
    current = "";
  }
  window.addEventListener("hashchange", route);
  await route();
}

start();
