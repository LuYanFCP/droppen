// Which route a session binding goes to. The path carries the CLI now, and
// getting it wrong is invisible in the UI: a Codex bind sent to the Claude
// route answers 404 (or worse, binds nothing) long after the popover closed.
// The typed client is exercised for real here, against a stubbed transport.
import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL } from "../src/lib/machines/key.js";

type Sent = { path: string; body: unknown };

/**
 * The typed client builds a `Request` from a root-relative URL, which Node's
 * own `Request` refuses to parse. It reads both `globalThis.Request` and
 * `globalThis.fetch` once, when the module is first imported — so the stubs go
 * in before the dynamic import below, and the import is why this file has no
 * static one.
 */
async function withStubbedTransport(run: (sent: Sent[]) => Promise<void>): Promise<void> {
  const sent: Sent[] = [];
  const realRequest = globalThis.Request;
  const realFetch = globalThis.fetch;

  class StubRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly bodyText: string;
    constructor(url: string, init: RequestInit = {}) {
      this.url = url;
      this.method = init.method ?? "GET";
      this.headers = new Headers(init.headers ?? {});
      this.bodyText = typeof init.body === "string" ? init.body : "";
    }
  }

  globalThis.Request = StubRequest as unknown as typeof Request;
  globalThis.fetch = (async (request: StubRequest) => {
    sent.push({ path: request.url, body: request.bodyText ? JSON.parse(request.bodyText) : null });
    return new Response(request.bodyText || "null", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    await run(sent);
  } finally {
    globalThis.Request = realRequest;
    globalThis.fetch = realFetch;
  }
}

test("a bind names the CLI the session belongs to, in the path", async () => {
  await withStubbedTransport(async (sent) => {
    const { bindSessionAccount } = await import("../src/features/accounts/use-accounts.js");
    await bindSessionAccount({ machine: LOCAL, source: "codex", id: "sess-1" }, "acct-1");
    await bindSessionAccount({ machine: LOCAL, source: "claude", id: "sess-2" }, null);

    assert.deepEqual(sent, [
      { path: "/api/sessions/codex/sess-1/account", body: { accountId: "acct-1" } },
      // `null` is the unbind, and it must survive the round trip as null rather
      // than being dropped for an absent field.
      { path: "/api/sessions/claude/sess-2/account", body: { accountId: null } },
    ]);
  });
});
