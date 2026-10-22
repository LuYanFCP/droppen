// An iPad asking for desktop sites (iPadOS Safari's default) sends what a
// Mac sends, so the hub would name it a Mac. Its page can tell — "Macintosh"
// with a touch screen, which no Mac has — and its own `GET /v1/me` says so
// with `?touch=1` (docs/hub-api/http.md); every other page asks as before.
import assert from "node:assert/strict";
import test from "node:test";
import { HubApi, touchScreenMac, type TouchEnv } from "../src/lib/hub/api.js";

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const WINDOWS_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.65";

const env = (userAgent: string | undefined, maxTouchPoints: number | undefined): TouchEnv => ({ navigator: { userAgent, maxTouchPoints } });

test("only a page that says Macintosh and has a touch screen is an iPad asking for desktop sites", () => {
  assert.equal(touchScreenMac(env(MAC_SAFARI, 5)), true, "iPadOS Safari, desktop sites");
  for (const [ua, points, why] of [
    [MAC_SAFARI, 0, "a Mac"],
    [MAC_SAFARI, 1, "one touch point is no touch screen"],
    [MAC_SAFARI, undefined, "a browser that does not say"],
    [IPAD_SAFARI, 5, "an iPad that says so itself"],
    [IPHONE_SAFARI, 5, "a phone"],
    [WINDOWS_EDGE, 10, "a touch screen on Windows"],
    [undefined, 5, "no User-Agent"],
  ] as const) {
    assert.equal(touchScreenMac(env(ua, points)), false, why);
  }
  assert.equal(touchScreenMac({}), false, "no navigator");
  const throwing = {
    get navigator(): never {
      throw new Error("no access");
    },
  };
  assert.equal(touchScreenMac(throwing as TouchEnv), false, "never throws");
});

test("GET /v1/me carries ?touch=1 from such a page only", async () => {
  const asked: string[] = [];
  const fetchImpl = async (url: RequestInfo | URL) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ account: "a-1", email: { address: "owner@example.com", verified: true, verification: "off" }, chain_seq: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new HubApi("https://hub.test", fetchImpl, undefined);
  await api.me("device-session", { env: env(MAC_SAFARI, 5) });
  await api.me("device-session", { env: env(MAC_SAFARI, 0) });
  await api.me("device-session", { env: env(IPAD_SAFARI, 5) });
  await api.me("device-session", { env: env(WINDOWS_EDGE, 10) });
  await api.me("device-session", { env: {} });
  assert.deepEqual(asked, [
    "https://hub.test/v1/me?touch=1",
    "https://hub.test/v1/me",
    "https://hub.test/v1/me",
    "https://hub.test/v1/me",
    "https://hub.test/v1/me",
  ]);
});
