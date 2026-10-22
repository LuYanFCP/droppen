// The decisions the auth layer makes without a browser: how long a download
// ticket is worth reusing, where a `?next=` may point, and which 401 is worth
// navigating on. Each of these has a way of going wrong that no type catches —
// a ticket cache that never expires, an open redirect, a redirect loop — so
// they live in pure functions and are pinned here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  authIsOff,
  authRedirect,
  DOWNLOAD_TICKET_TTL_MS,
  freshTicket,
  loginHref,
  needsLogin,
  needsSetup,
  safeNext,
  setupOpenTo,
  shouldRedirectToLogin,
  unauthorizedHref,
} from "../src/lib/auth.js";
import { shouldVerifyAuth, withTicket, WS_AUTH_CHECK_AFTER } from "../src/lib/ws-url.js";

const NOW = 1_700_000_000_000;

test("a download ticket is reused until the cache window is up", () => {
  const entry = { ticket: "T", cachedAt: NOW };
  assert.equal(freshTicket(entry, NOW), "T");
  assert.equal(freshTicket(entry, NOW + DOWNLOAD_TICKET_TTL_MS - 1), "T");
  // The server gives it a minute and the cache holds it for forty-five
  // seconds, so the moment it is dropped there are fifteen left on the real one.
  assert.ok(DOWNLOAD_TICKET_TTL_MS < 60_000 && DOWNLOAD_TICKET_TTL_MS >= 30_000, `${DOWNLOAD_TICKET_TTL_MS}`);
  assert.equal(freshTicket(entry, NOW + DOWNLOAD_TICKET_TTL_MS), null);
  assert.equal(freshTicket(entry, NOW + 60 * 60_000), null);
});

test("no ticket, and a clock that jumped backwards, are both a miss", () => {
  assert.equal(freshTicket(null, NOW), null);
  // Negative age is not freshness: a rewound clock must not pin a stale ticket
  // in the cache for however long the jump was.
  assert.equal(freshTicket({ ticket: "T", cachedAt: NOW + 60_000 }, NOW), null);
});

test("freshTicket takes the window as an argument, so a ws ticket could never be cached by it", () => {
  assert.equal(freshTicket({ ticket: "T", cachedAt: NOW }, NOW + 5, 1), null);
});

test("safeNext only ever hands back a path on this origin", () => {
  assert.equal(safeNext("/sessions/claude/abc"), "/sessions/claude/abc");
  assert.equal(safeNext("/files?path=%2Froot"), "/files?path=%2Froot");
  assert.equal(safeNext(undefined), "/");
  assert.equal(safeNext(null), "/");
  assert.equal(safeNext(""), "/");
});

test("safeNext refuses everything that could leave the origin", () => {
  assert.equal(safeNext("https://evil.example/x"), "/");
  assert.equal(safeNext("//evil.example/x"), "/");
  // Browsers read a backslash here the same way they read a slash, so the
  // protocol-relative check has to cover it too.
  assert.equal(safeNext("/\\evil.example/x"), "/");
  assert.equal(safeNext("javascript:alert(1)"), "/");
  assert.equal(safeNext("sessions"), "/");
});

// A URL parser strips ASCII tab, CR and LF from anywhere in a URL before it
// parses it, so a check that reads the raw string is checking something the
// browser will never see. `/<tab>//evil.example` is `///evil.example` — i.e.
// `https://evil.example` — by the time `location.replace` is done with it, and
// that is an open redirect off the login page of a server on the public
// internet. Each of these was a live bypass.
test("safeNext strips the characters a URL parser would, before it checks anything", () => {
  for (const gap of ["\t", "\n", "\r"]) {
    assert.equal(safeNext(`/${gap}//evil.example/x`), "/");
    assert.equal(safeNext(`/${gap}/\\evil.example/x`), "/");
    assert.equal(safeNext(`/${gap}/${gap}/evil.example/x`), "/");
  }
  // And what survives is the cleaned string, so the caller navigates to exactly
  // what was inspected rather than to the original.
  assert.equal(safeNext("/sessions/\tclaude/abc"), "/sessions/claude/abc");
});

test("loginHref carries the current page back, and says nothing when there is nothing to say", () => {
  assert.equal(loginHref("/"), "/login");
  assert.equal(loginHref("/terminals?id=x"), `/login?next=${encodeURIComponent("/terminals?id=x")}`);
  // A `next` that could not be navigated to is dropped rather than passed on.
  assert.equal(loginHref("https://evil.example/"), "/login");
});

test("a 401 sends the browser to the login page — except where that would loop", () => {
  assert.equal(shouldRedirectToLogin("/api/sessions", "/sessions"), true);
  // A refused login is a wrong password; it belongs in the form.
  assert.equal(shouldRedirectToLogin("/api/auth/login", "/login"), false);
  assert.equal(shouldRedirectToLogin("/api/auth/login", "/sessions"), false);
  // So is a refused password change: mistyping the current password must not
  // throw the user out of the settings page.
  assert.equal(shouldRedirectToLogin("/api/auth/password", "/settings"), false);
  // Anything else that 401s while the login page is open has nowhere to go.
  assert.equal(shouldRedirectToLogin("/api/prefs", "/login"), false);
});

test("a websocket that keeps failing asks whether we are still logged in, periodically", () => {
  // Nothing to ask on a server that needs no login.
  assert.equal(shouldVerifyAuth(WS_AUTH_CHECK_AFTER, false), false);
  // Not on the first failures: a server restart looks exactly like this.
  assert.equal(shouldVerifyAuth(0, true), false);
  assert.equal(shouldVerifyAuth(1, true), false);
  assert.equal(shouldVerifyAuth(WS_AUTH_CHECK_AFTER, true), true);
  // And again later, because an outage can outlive the token it started under.
  assert.equal(shouldVerifyAuth(WS_AUTH_CHECK_AFTER * 2, true), true);
  assert.equal(shouldVerifyAuth(WS_AUTH_CHECK_AFTER * 2 - 1, true), false);
});

test("withTicket joins onto whatever query string the URL already has", () => {
  assert.equal(withTicket("wss://h/api/events", "T"), "wss://h/api/events?ticket=T");
  assert.equal(withTicket("wss://h/api/events?x=1", "T"), "wss://h/api/events?x=1&ticket=T");
  // No ticket at all is the open-server path: the URL is untouched.
  assert.equal(withTicket("wss://h/api/events", null), "wss://h/api/events");
});

test("a 401 never bounces off either way in, and never off a form that asked for it", () => {
  assert.equal(shouldRedirectToLogin("/api/sessions", "/sessions"), true);
  assert.equal(shouldRedirectToLogin("/api/sessions", "/login"), false);
  // In the setup state everything but the setup route answers 401: the setup
  // page must not be thrown to the login page by a stray request.
  assert.equal(shouldRedirectToLogin("/api/sessions", "/setup"), false);
  assert.equal(shouldRedirectToLogin("/api/auth/login", "/sessions"), false);
  assert.equal(shouldRedirectToLogin("/api/auth/password", "/settings"), false);
  assert.equal(shouldRedirectToLogin("/api/auth/setup", "/sessions"), false);
  assert.equal(shouldRedirectToLogin("/api/auth/local-open", "/sessions"), false);
});

// The router guard's whole decision, for every answer the status route gives:
// whether authentication is on at all (`authOff`, `authRequired`), whether
// anybody is signed in and as whom (`user`: an account, this device's owner by
// a local-open session, a device bridged through Droppen), and whether the
// device has an account yet (`setupRequired`).
const status = (over: Partial<Parameters<typeof authRedirect>[0]>) => ({
  authRequired: true,
  setupRequired: false,
  user: null,
  authOff: false,
  ...over,
});
const SIGNED_IN = status({ user: "me" });
const SIGNED_OUT = status({});
const SETUP = status({ setupRequired: true });
const OWNER = status({ setupRequired: true, user: "local:owner" });
const OFF = status({ authRequired: false, authOff: true });
const HREF = "/terminals?id=x";

test("nobody signed in to a device with no account yet is sent to the setup page from everywhere", () => {
  assert.equal(needsSetup(SETUP), true);
  assert.deepEqual(authRedirect(SETUP, "/sessions", "/sessions"), { to: "/setup" });
  assert.deepEqual(authRedirect(SETUP, "/login", "/login"), { to: "/setup" });
  assert.deepEqual(authRedirect(SETUP, "/", "/"), { to: "/setup" });
  assert.equal(authRedirect(SETUP, "/setup", "/setup"), null, "and stays there");
});

test("signed out with an account to sign in to: the login page, coming back where it was", () => {
  assert.equal(needsLogin(SIGNED_OUT), true);
  assert.deepEqual(authRedirect(SIGNED_OUT, "/terminals", HREF), { to: "/login", next: HREF });
  assert.deepEqual(authRedirect(SIGNED_OUT, "/", "/"), { to: "/login" });
  assert.equal(authRedirect(SIGNED_OUT, "/login", "/login"), null);
  // Setup is over once an account exists, and it is no place to come back to.
  assert.deepEqual(authRedirect(SIGNED_OUT, "/setup", "/setup"), { to: "/login" });
});

test("signed in: the app, and both ways in lead home", () => {
  assert.equal(authRedirect(SIGNED_IN, "/sessions", "/sessions"), null);
  assert.deepEqual(authRedirect(SIGNED_IN, "/login", "/login"), { to: "/" });
  assert.deepEqual(authRedirect(SIGNED_IN, "/setup", "/setup"), { to: "/" });
  // A page reached through Droppen is signed in as the cloud, whatever the device's accounts.
  const cloud = status({ user: "cloud:d-1", setupRequired: true });
  assert.equal(authRedirect(cloud, "/sessions", "/sessions"), null);
  assert.equal(setupOpenTo(cloud), false);
  assert.deepEqual(authRedirect(cloud, "/setup", "/setup"), { to: "/" });
});

test("this device's owner by a local-open session: the app, with the setup page still open to them", () => {
  assert.equal(needsSetup(OWNER), false);
  assert.equal(needsLogin(OWNER), false);
  assert.equal(setupOpenTo(OWNER), true);
  assert.equal(authRedirect(OWNER, "/sessions", "/sessions"), null);
  assert.equal(authRedirect(OWNER, "/", "/"), null);
  // The code-less first account is made there.
  assert.equal(authRedirect(OWNER, "/setup", "/setup"), null);
  // Nobody to sign in as.
  assert.deepEqual(authRedirect(OWNER, "/login", "/login"), { to: "/" });
  // Once the device has an account, the owner session is over and so is the setup page.
  assert.deepEqual(authRedirect(status({ user: "local:owner" }), "/setup", "/setup"), { to: "/" });
});

test("authentication switched off: the app, and no login or setup page at all", () => {
  assert.equal(authIsOff(OFF), true);
  assert.equal(authRedirect(OFF, "/sessions", "/sessions"), null);
  assert.deepEqual(authRedirect(OFF, "/login", "/login"), { to: "/" });
  assert.deepEqual(authRedirect(OFF, "/setup", "/setup"), { to: "/" });
  // A server from before `authOff` said `authRequired: false` for exactly this.
  const old = { authRequired: false, user: null };
  assert.equal(authIsOff(old), true);
  assert.deepEqual(authRedirect(old, "/login", "/login"), { to: "/" });
  assert.deepEqual(authRedirect(old, "/setup", "/setup"), { to: "/" });
});

test("a 401 goes to the setup page only where there is no account — never under the desktop app", () => {
  // A browser whose last status said the device has no account: the setup page.
  assert.equal(unauthorizedHref({ ...SETUP, desktopApp: false }, HREF), "/setup");
  // Otherwise the login page, coming back here.
  assert.equal(unauthorizedHref({ ...SIGNED_IN, desktopApp: false }, HREF), `/login?next=${encodeURIComponent(HREF)}`);
  assert.equal(unauthorizedHref(null, "/"), "/login");
  // The desktop app's window: its own account does not end the setup state, so
  // the server says `setupRequired` to it too — and the app answers the login
  // page with a fresh login, never the setup page, which asks for a code.
  assert.equal(unauthorizedHref({ ...SETUP, desktopApp: true }, HREF), `/login?next=${encodeURIComponent(HREF)}`);
  assert.equal(unauthorizedHref({ ...SETUP, desktopApp: true }, "/"), "/login");
});
