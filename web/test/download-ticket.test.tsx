// Downloads on a server that requires a login, and the three ways they used to
// break.
//
// Neither an `<a href>` nor an `<img src>` can send an `Authorization` header,
// so both spend a short-lived `?ticket=` that lives in one module-level cache.
// The cache was read synchronously while rendering, which meant the URL in the
// DOM was only ever as good as the cache had been at the moment React last drew
// it — and it went stale in three ways that a user meets constantly:
//
//  1. the server restarts and forgets every live ticket, while the client goes
//     on believing its copy is good for another eight minutes;
//  2. the tab is backgrounded (this is a PWA on a phone; iOS freezes the JS),
//     the cached ticket expires unattended, and the first render after the wake
//     bakes a URL with no ticket in it at all;
//  3. the eight-minute refresh dropped the ticket before minting its
//     replacement, so a render in between baked the same unticketed URL.
//
// In every case the mint that followed landed in a variable nothing was
// watching, so nothing re-rendered and the broken URL stayed in the DOM.
//
// What is pinned here is the shape of the fix: a click resolves its own ticket
// and never trusts what was rendered, the ticket is a store with subscribers,
// and an image that fails repairs the cache once and cannot make a loop of it.
// There is no headless browser in this repo, so what a real click or a real
// broken `<img>` does cannot be tested — the seams those two paths call into
// are tested instead, and the rendered markup is checked with
// `react-dom/server` so the wiring between them is at least real.
//
// `import * as React` because the test directory is outside the tsconfig's
// `include`, so tsx compiles JSX here with the classic runtime.
import * as React from "react";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCAL } from "../src/lib/machines/key.js";

// ---------------------------------------------------------------------------
// A server, and a clock
// ---------------------------------------------------------------------------

/** Movable, so a tab can be frozen for ten minutes between two lines. */
let now = 1_700_000_000_000;
Date.now = () => now;

/** How many tickets the "server" has been asked for. */
let mints = 0;
/**
 * When true, a mint does not answer until it is released by hand, and the
 * releases are collected in order — so a test can land two mints in the
 * opposite order to the one they were asked in, which is exactly what a restart
 * in the middle of a request looks like.
 */
let manual = false;
const pending: Array<() => void> = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// `openapi-fetch` builds a `Request` before it calls `fetch`, and node cannot
// parse the relative URL this app's client is configured with ("/api/..."), so
// the constructor is replaced with one that just holds the fields the auth
// middleware touches. Both stubs have to be in place before the client module
// is first imported, which is why the imports below are dynamic.
class FakeRequest {
  url: string;
  method: string;
  headers: Headers;
  constructor(url: string, init: { method?: string; headers?: HeadersInit } = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.headers = new Headers(init.headers);
  }
}
(globalThis as unknown as { Request: unknown }).Request = FakeRequest;

(globalThis as unknown as { fetch: unknown }).fetch = async (req: { url?: string } | string) => {
  const url = typeof req === "string" ? req : (req.url ?? "");
  if (url === "/api/auth/status") return json({ authRequired: true, setupRequired: false, user: "svc", desktopApp: false });
  if (url === "/api/auth/login") return json({ token: "token-2", expiresAt: new Date(now + 86_400_000).toISOString(), username: "svc" });
  if (url === "/api/auth/ticket") {
    // Numbered when it is asked for rather than when it answers, so `T1` is
    // always the first ticket requested however the releases are ordered.
    mints += 1;
    const ticket = `T${mints}`;
    if (manual) await new Promise<void>((resolve) => pending.push(resolve));
    return json({ ticket, expiresAt: new Date(now + 600_000).toISOString() });
  }
  throw new Error(`unexpected request: ${url}`);
};

const {
  clearToken,
  DOWNLOAD_TICKET_TTL_MS,
  downloadTicketSnapshot,
  fetchTicket,
  freshDownloadTicket,
  healDownloadTicket,
  HEAL_COOLDOWN_MS,
  invalidateDownloadTicket,
  primeDownloadTicket,
  serverRestarted,
  setToken,
  subscribeDownloadTicket,
  authStatus,
  login,
} = await import("../src/lib/auth.js");
const { DownloadLink, HostImage, interceptDownloadClick, startDownload, useDownloadTicket } =
  await import("../src/components/host-file.js");

// The status is cached for the life of the module, so one call arms
// `authRequired()` for every test in this file.
await authStatus();

/** A logged-in tab with an empty ticket cache and a cooldown that has expired. */
function reset(): void {
  clearToken();
  setToken("token");
  mints = 0;
  manual = false;
  pending.length = 0;
  now += HEAL_COOLDOWN_MS + 1;
}

/** Let every pending microtask and one timer turn run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const DOWNLOAD = "/api/fs/download?path=%2Froot%2Fa.txt";

// ---------------------------------------------------------------------------
// A click does not trust what was rendered
// ---------------------------------------------------------------------------

test("a click with a stale cache mints before the download starts", async () => {
  reset();
  await primeDownloadTicket();
  assert.equal(downloadTicketSnapshot(), "T1");

  // The tab was frozen for longer than the cache window: this is the state a
  // phone comes back in, and "T1" is what a render before the freeze baked into
  // every `href` on the page.
  now += DOWNLOAD_TICKET_TTL_MS + 1;
  assert.equal(downloadTicketSnapshot(), "T1");
  assert.equal(freshDownloadTicket(), null);

  const opened: Array<{ url: string; name: string | undefined }> = [];
  await startDownload(LOCAL, "/root/a.txt", { name: "a.txt" }, (url, name) => opened.push({ url, name }));

  assert.equal(mints, 2, "the click minted rather than spending the stale ticket");
  assert.deepEqual(opened, [{ url: `${DOWNLOAD}&ticket=T2`, name: "a.txt" }]);
});

test("the download does not start until the mint it is waiting for lands", async () => {
  reset();
  manual = true;

  const opened: string[] = [];
  const started = startDownload(LOCAL, "/root/a.txt", {}, (url) => opened.push(url));
  await settle();
  assert.deepEqual(opened, [], "nothing was handed to the browser without a ticket");

  pending[0]!();
  await started;
  assert.deepEqual(opened, [`${DOWNLOAD}&ticket=T1`]);
});

test("a warm cache spends the ticket it already has, so a click costs no request", async () => {
  reset();
  await primeDownloadTicket();
  const opened: string[] = [];
  await startDownload(LOCAL, "/root/a.txt", {}, (url) => opened.push(url));
  assert.equal(mints, 1);
  assert.deepEqual(opened, [`${DOWNLOAD}&ticket=T1`]);
});

test("a click is only taken over from the browser when the rendered href cannot be trusted", () => {
  // The ordinary case: the href carries the ticket the cache would spend, so
  // the browser follows it and the user gesture is never handed back.
  assert.equal(
    interceptDownloadClick({ required: true, modified: false, rendered: "T1", fresh: "T1" }),
    false,
  );
  // Rendered before a restart, or before a wake: the href is a 401.
  assert.equal(
    interceptDownloadClick({ required: true, modified: false, rendered: "T1", fresh: "T2" }),
    true,
  );
  // Rendered during the window where there was no ticket at all.
  assert.equal(
    interceptDownloadClick({ required: true, modified: false, rendered: null, fresh: "T1" }),
    true,
  );
  // Nothing worth spending: mint one.
  assert.equal(
    interceptDownloadClick({ required: true, modified: false, rendered: "T1", fresh: null }),
    true,
  );
  // "Open in a new tab" is the browser's to do with the href, whatever we think
  // of it — and an open server has no ticket in any URL to get wrong.
  assert.equal(
    interceptDownloadClick({ required: true, modified: true, rendered: "T1", fresh: null }),
    false,
  );
  assert.equal(
    interceptDownloadClick({ required: false, modified: false, rendered: null, fresh: null }),
    false,
  );
});

// ---------------------------------------------------------------------------
// The ticket is something a render can subscribe to
// ---------------------------------------------------------------------------

test("a subscriber is woken when a ticket lands after a miss", async () => {
  reset();
  let woken = 0;
  const stop = subscribeDownloadTicket(() => (woken += 1));
  try {
    assert.equal(downloadTicketSnapshot(), null, "the miss a frozen tab wakes up to");
    await fetchTicket("download");
    assert.equal(woken, 1, "the render that drew nothing gets a chance to draw it again");
    assert.equal(downloadTicketSnapshot(), "T1");

    // A hit changes no string, so it wakes nobody: an `<img src>` that changes
    // is an `<img>` the browser fetches again.
    await fetchTicket("download");
    assert.equal(woken, 1);
  } finally {
    stop();
  }
});

test("a subscription that has stopped is not woken, and one that stops another mid-wake does not skip it", async () => {
  reset();
  const seen: string[] = [];
  // Subscribed and stopped before anything happened.
  subscribeDownloadTicket(() => seen.push("stopped"))();
  let stopB!: () => void;
  const stopA = subscribeDownloadTicket(() => {
    seen.push("a");
    stopB();
  });
  stopB = subscribeDownloadTicket(() => seen.push("b"));
  try {
    await fetchTicket("download");
    // "b" was removed from the set while the set was being walked; it is woken
    // anyway, because the walk is over a copy. A `Set` mutated mid-iteration
    // would have skipped it — and a component that unsubscribes in a cleanup
    // during a render is not exotic.
    assert.deepEqual(seen, ["a", "b"]);
  } finally {
    stopA();
    stopB();
  }
});

// ---------------------------------------------------------------------------
// A ticket lives a minute
// ---------------------------------------------------------------------------

test("a ticket something renders is replaced before the server's minute is up, and not otherwise", async () => {
  // The server keeps a download ticket for sixty seconds; the cache spends it
  // for fewer, so a replacement is in hand before the old one is refused.
  assert.ok(DOWNLOAD_TICKET_TTL_MS < 60_000, `${DOWNLOAD_TICKET_TTL_MS}`);
  reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  let woken = 0;
  const stop = subscribeDownloadTicket(() => (woken += 1));
  try {
    await primeDownloadTicket();
    assert.equal(downloadTicketSnapshot(), "T1");
    assert.equal(mints, 1);

    // Just short of due: nothing.
    now += DOWNLOAD_TICKET_TTL_MS - 1_000;
    mock.timers.tick(DOWNLOAD_TICKET_TTL_MS - 1_000);
    await settle();
    assert.equal(mints, 1);

    // Due — still well inside the server's minute: a fresh one, drawn at once.
    now += 1_000;
    mock.timers.tick(1_000);
    await settle();
    assert.equal(mints, 2);
    assert.equal(downloadTicketSnapshot(), "T2");
    assert.equal(woken, 2, "the first ticket, then its replacement");
    assert.equal(freshDownloadTicket(), "T2");

    // And again, a minute later, for as long as something renders it.
    now += DOWNLOAD_TICKET_TTL_MS;
    mock.timers.tick(DOWNLOAD_TICKET_TTL_MS);
    await settle();
    assert.equal(downloadTicketSnapshot(), "T3");
  } finally {
    stop();
  }
  try {
    // Nothing renders it any more: nothing is minted, however long it sits.
    const before = mints;
    now += 10 * DOWNLOAD_TICKET_TTL_MS;
    mock.timers.tick(10 * DOWNLOAD_TICKET_TTL_MS);
    await settle();
    assert.equal(mints, before);
  } finally {
    mock.timers.reset();
  }
});

test("a new session drops the old session's ticket", async () => {
  reset();
  await primeDownloadTicket();
  assert.equal(downloadTicketSnapshot(), "T1");
  // A ticket is bound to the session that minted it; a login replaces that session.
  await login("svc", "a long password here");
  await settle();
  assert.equal(mints, 2);
  assert.equal(downloadTicketSnapshot(), "T2");
});

// ---------------------------------------------------------------------------
// A restart is the one thing that wipes every ticket at once
// ---------------------------------------------------------------------------

test("only a settings frame from a different server counts as a restart", () => {
  // The first frame of a page load proves nothing: there is nothing to compare.
  assert.equal(serverRestarted(null, "2026-01-01T00:00:00.000Z"), false);
  // A reconnect to the same instance — a phone changing networks — must not
  // throw away a ticket that still works.
  assert.equal(
    serverRestarted("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    false,
  );
  // A different start time is the case this exists for.
  assert.equal(
    serverRestarted("2026-01-01T00:00:00.000Z", "2026-01-01T09:30:00.000Z"),
    true,
  );
  // A server that will not say counts as a restart on every frame after the
  // first: blunt, and the safe direction to be wrong in.
  assert.equal(serverRestarted("2026-01-01T00:00:00.000Z", undefined), true);
  assert.equal(serverRestarted("", "2026-01-01T00:00:00.000Z"), true);
  assert.equal(serverRestarted(null, undefined), false);
});

test("invalidating condemns the cached ticket without repainting anything, and mints a replacement", async () => {
  reset();
  await primeDownloadTicket();
  let woken = 0;
  const stop = subscribeDownloadTicket(() => (woken += 1));
  try {
    invalidateDownloadTicket();
    // Nothing that renders the ticket has been woken: the string in the DOM is
    // no worse than it was, and repainting it with *no* ticket would be.
    assert.equal(woken, 0);
    assert.equal(downloadTicketSnapshot(), "T1");
    // But nothing will spend it again.
    assert.equal(freshDownloadTicket(), null);

    await settle();
    assert.equal(mints, 2);
    assert.equal(downloadTicketSnapshot(), "T2");
    assert.equal(woken, 1, "one repaint, when there is something better to draw");
  } finally {
    stop();
  }
});

test("a ticket minted before the invalidation cannot land in the cache after it", async () => {
  reset();
  manual = true;
  const inFlight = fetchTicket("download");
  await settle();

  // The server restarts while that mint is on the wire: whatever it eventually
  // answers was written by an instance that no longer exists.
  invalidateDownloadTicket();
  await settle();
  assert.equal(mints, 2, "the invalidation asked the new server for one of its own");

  // The replacement lands first, and then the ghost of the old request.
  pending[1]!();
  await settle();
  assert.equal(downloadTicketSnapshot(), "T2");
  pending[0]!();
  assert.equal(await inFlight, "T1");
  await settle();

  assert.equal(
    downloadTicketSnapshot(),
    "T2",
    "the late answer from the server that has gone away did not overwrite the live ticket",
  );
});

// ---------------------------------------------------------------------------
// A broken image repairs the ticket once, and cannot loop
// ---------------------------------------------------------------------------

test("a gallery of images failing at once costs one mint", async () => {
  reset();
  await primeDownloadTicket();
  const used = downloadTicketSnapshot();

  // Ten `<img>` elements built from the same ticket all error in the same tick.
  for (let i = 0; i < 10; i += 1) healDownloadTicket(used);
  await settle();

  assert.equal(mints, 2, "one replacement, not one per picture");
  assert.equal(downloadTicketSnapshot(), "T2");
});

test("an image that is still broken with a fresh ticket does not mint again", async () => {
  reset();
  await primeDownloadTicket();
  healDownloadTicket(downloadTicketSnapshot());
  await settle();
  assert.equal(mints, 2);

  // The file is simply gone: the new ticket does not fix it, and the repaint
  // the mint caused produces another error event immediately.
  for (let i = 0; i < 5; i += 1) {
    healDownloadTicket(downloadTicketSnapshot());
    await settle();
  }
  assert.equal(mints, 2, "the cooldown holds the loop shut");

  // And it is a cooldown, not a latch: a ticket that dies half an hour later is
  // still repaired.
  now += HEAL_COOLDOWN_MS + 1;
  healDownloadTicket(downloadTicketSnapshot());
  await settle();
  assert.equal(mints, 3);
});

test("an image built with no ticket at all asks for one", async () => {
  reset();
  assert.equal(downloadTicketSnapshot(), null);
  healDownloadTicket(null);
  await settle();
  assert.equal(mints, 1);
  assert.equal(downloadTicketSnapshot(), "T1");
});

test("a logged-out tab heals nothing", async () => {
  reset();
  clearToken();
  healDownloadTicket(null);
  await settle();
  assert.equal(mints, 0);
});

// ---------------------------------------------------------------------------
// What the components actually render
// ---------------------------------------------------------------------------

test("a link and an image both carry the ticket the store holds", async () => {
  reset();
  await primeDownloadTicket();

  const link = renderToStaticMarkup(
    <DownloadLink path="/root/a.txt" name="a.txt" className="chip">
      a.txt
    </DownloadLink>,
  );
  assert.match(link, /href="\/api\/fs\/download\?path=%2Froot%2Fa\.txt&amp;ticket=T1"/);
  assert.match(link, /download="a\.txt"/);

  const img = renderToStaticMarkup(<HostImage path="/root/shot.png" alt="shot" />);
  assert.match(img, /src="\/api\/fs\/download\?path=%2Froot%2Fshot\.png&amp;inline=true&amp;ticket=T1"/);
});

test("the hook is wired to the store, not to a copy of it taken at import time", async () => {
  reset();
  function Probe() {
    return <span>{useDownloadTicket() ?? "none"}</span>;
  }
  assert.equal(renderToStaticMarkup(<Probe />), "<span>none</span>");
  await primeDownloadTicket();
  assert.equal(renderToStaticMarkup(<Probe />), "<span>T1</span>");
});
