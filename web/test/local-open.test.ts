// A page opened signed in from the device itself: `remote-hand-server open`
// (or the desktop app's "open in browser") opens `/#local-open=<token>`, and
// the page trades the token for a session before it asks who it is.
//
// What is pinned: the token comes off the address before any other module can
// read it — `local-open-boot` is the first import of `main.tsx`, and
// `local-open.ts` imports nothing for anything to run first — and the path and
// query stay; only something shaped like a token is ever sent, in the body of
// a POST, never in a URL; the router's status question waits for the trade and
// carries the new token; a refusal is kept for the setup page to show and
// leaves the browser's old token alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ---------------------------------------------------------------------------
// A server
// ---------------------------------------------------------------------------

type Sent = { url: string; method: string; body: unknown; auth: string | null };
const sent: Sent[] = [];
/** What `POST /api/auth/local-open` answers next. */
let answer: { status: number; body: unknown } = { status: 500, body: { error: "no answer set" } };

// `openapi-fetch` builds a `Request` before it calls `fetch`, and node cannot
// parse the app's relative URLs, so the constructor is replaced with one that
// keeps what the test reads. In place before the client is first imported.
class FakeRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  constructor(url: string, init: { method?: string; headers?: HeadersInit; body?: unknown } = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.headers = new Headers(init.headers);
    this.body = init.body;
  }
}
(globalThis as unknown as { Request: unknown }).Request = FakeRequest;

(globalThis as unknown as { fetch: unknown }).fetch = async (req: FakeRequest) => {
  sent.push({
    url: req.url,
    method: req.method,
    body: typeof req.body === "string" ? JSON.parse(req.body) : req.body,
    auth: req.headers.get("Authorization"),
  });
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (req.url === "/api/auth/local-open") return reply(answer.status, answer.body);
  if (req.url === "/api/auth/status") {
    return reply(200, { authRequired: true, setupRequired: true, authOff: false, desktopApp: false, user: "local:owner" });
  }
  if (req.url === "/api/auth/ticket") return reply(200, { ticket: "T1", expiresAt: "2026-10-19T00:01:00Z" });
  return reply(404, { error: `unexpected request: ${req.url}` });
};

const { captureLocalOpen, localOpenToken, takeLocalOpen } = await import("../src/lib/local-open.js");
const { ApiError } = await import("../src/api/errors.js");
const { authStatus, getToken, localOpenFailure, redeemLocalOpen, setToken, startLocalOpen } = await import("../src/lib/auth.js");

const TOKEN = "local-open-token-for-tests".padEnd(43, "x"); // 43 base64url characters

/** A stand-in address bar: what is in it, and every rewrite of it. */
function addressBar(href: { pathname: string; search: string; hash: string }) {
  const rewrites: string[] = [];
  const loc = { ...href };
  const hist = {
    state: { key: "k" },
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      rewrites.push(String(url));
      loc.hash = "";
    },
  };
  return { loc, hist, rewrites };
}

// ---------------------------------------------------------------------------
// Off the address, first
// ---------------------------------------------------------------------------

test("the token is read from the fragment, and only something shaped like one", () => {
  assert.equal(localOpenToken(`#local-open=${TOKEN}`), TOKEN);
  assert.equal(localOpenToken(`#x=1&local-open=${TOKEN}`), TOKEN);
  assert.equal(localOpenToken(""), null);
  assert.equal(localOpenToken("#t=verify-token"), null, "another fragment is somebody else's");
  // A `local-open=` that is not a token is still a local-open link: taken off, and never sent.
  assert.equal(localOpenToken("#local-open="), "");
  assert.equal(localOpenToken("#local-open=<script>"), "");
  assert.equal(localOpenToken(`#local-open=${"a".repeat(300)}`), "");
});

test("the fragment comes off the address at once, and the path and query stay", () => {
  const bar = addressBar({ pathname: "/sessions", search: "?x=1", hash: `#local-open=${TOKEN}` });
  captureLocalOpen(bar.loc, bar.hist);
  assert.deepEqual(bar.rewrites, ["/sessions?x=1"]);
  assert.equal(bar.loc.hash, "");
  // Kept in memory for the trade, handed over once.
  assert.equal(takeLocalOpen(), TOKEN);
  assert.equal(takeLocalOpen(), null);
  // No `local-open=`, no rewrite.
  const other = addressBar({ pathname: "/", search: "", hash: "#t=abc" });
  captureLocalOpen(other.loc, other.hist);
  assert.deepEqual(other.rewrites, []);
  assert.equal(takeLocalOpen(), null);
});

test("nothing runs before the fragment comes off", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const imports = [...main.matchAll(/^import\s.*?["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  assert.equal(imports[0], "./lib/local-open-boot", "the first import of main.tsx");
  const boot = readFileSync(new URL("../src/lib/local-open-boot.ts", import.meta.url), "utf8");
  assert.deepEqual([...boot.matchAll(/^import\s.*?["']([^"']+)["']/gm)].map((m) => m[1]), ["./local-open"]);
  assert.match(boot, /captureLocalOpen\(\)/);
  const module = readFileSync(new URL("../src/lib/local-open.ts", import.meta.url), "utf8");
  assert.doesNotMatch(module, /^import\s/m, "local-open.ts imports nothing that could run first");
  // And the trade starts before the app renders, so the router's question waits for it.
  assert.ok(main.indexOf("startLocalOpen()") < main.indexOf("createRoot("));
});

// ---------------------------------------------------------------------------
// Traded for a session
// ---------------------------------------------------------------------------

test("the token is posted in the body, kept, and the status asked after it with the new session", async () => {
  setToken("stale-token");
  sent.length = 0;
  answer = { status: 200, body: { token: "owner-session", expiresAt: "2026-10-20T00:00:00Z", username: "local:owner" } };
  const bar = addressBar({ pathname: "/", search: "", hash: `#local-open=${TOKEN}` });
  captureLocalOpen(bar.loc, bar.hist);
  startLocalOpen();
  const status = await authStatus();
  assert.equal(status.user, "local:owner");
  // The trade first, the question second — with the session the trade gave.
  assert.deepEqual(
    sent.map((s) => `${s.method} ${s.url}`).slice(0, 2),
    ["POST /api/auth/local-open", "GET /api/auth/status"],
  );
  assert.deepEqual(sent[0]!.body, { token: TOKEN });
  assert.ok(!sent[0]!.url.includes(TOKEN), "never in a URL");
  assert.equal(sent[1]!.auth, "Bearer owner-session");
  assert.equal(getToken(), "owner-session");
  assert.equal(localOpenFailure(), null);
});

test("a refused link is kept for the setup page, and leaves the browser's token alone", async () => {
  setToken("kept-token");
  sent.length = 0;
  answer = { status: 403, body: { error: "invalid_local_open", hint: "that link was already used or has expired" } };
  await redeemLocalOpen(TOKEN);
  const failure = localOpenFailure();
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.code, "invalid_local_open");
  assert.equal(getToken(), "kept-token");

  // Something that is not a token is refused the same way, without a request.
  sent.length = 0;
  await redeemLocalOpen("");
  assert.deepEqual(sent, []);
  assert.equal((localOpenFailure() as InstanceType<typeof ApiError>).code, "invalid_local_open");

  // A link that works clears the last failure.
  answer = { status: 200, body: { token: "owner-2", expiresAt: "2026-10-20T00:00:00Z", username: "local:owner" } };
  await redeemLocalOpen(TOKEN);
  assert.equal(localOpenFailure(), null);
  assert.equal(getToken(), "owner-2");
});
