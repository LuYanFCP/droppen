// A browser or phone's name in 「我的设备」 (`lib/hub/ua-label.ts`): what the
// hub made of its User-Agent (`/v1/me`'s `devices[].ua_label`), and — for the
// page's own device until the hub has said — the same made here, with the
// same words and the same order of checks as the hub's. Only those words are
// ever shown: a label of anything else is dropped.
import assert from "node:assert/strict";
import test from "node:test";
import { HubApi } from "../src/lib/hub/api.js";
import { UA_BROWSERS, UA_DEVICES, uaLabel, uaLabelOf } from "../src/lib/hub/ua-label.js";

const CASES: [string, string | null][] = [
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1", "iPhone · Chrome"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15", "iPhone · Firefox"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/123.0.2420.56 Mobile/15E148 Safari/605.1.15", "iPhone · Edge"],
  ["Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "iPad · Safari"],
  // iPadOS asking for the desktop site says it is a Mac: so does the hub.
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "Mac · Safari"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Mac · Chrome"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0", "Mac · Firefox"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51", "Windows · Edge"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/109.0.0.0", "Windows · Opera"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.54 Mobile Safari/537.36", "Android · Chrome"],
  ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36", "Android · Samsung Internet"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.2478.50", "Android · Edge"],
  // An app's own web view on Android is no browser.
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.54 Mobile Safari/537.36", "Android"],
  ["Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", "Linux · Firefox"],
  ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "ChromeOS · Chrome"],
  // The desktop app's WKWebView says no browser: the device alone.
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", "Mac"],
  ["Mozilla/5.0 (X11; FreeBSD amd64; rv:125.0) Gecko/20100101 Firefox/125.0", "Firefox"],
  ["curl/8.6.0", null],
  ["reqwest/0.12", null],
  ["", null],
];

test("a User-Agent's label: the device and the browser, the ones built on another first", () => {
  for (const [ua, label] of CASES) assert.equal(uaLabel(ua), label, ua);
  assert.equal(uaLabel(null), null);
  assert.equal(uaLabel(undefined), null);
});

test("an iPad asking for the desktop site says Macintosh: with a touch screen it is an iPad, as the hub corrects it from the page's hint", () => {
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  assert.equal(uaLabel(desktop, true), "iPad · Safari");
  assert.equal(uaLabel(desktop, false), "Mac · Safari", "no touch: a Mac");
  assert.equal(uaLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", true), "iPad", "an app's web view on an iPad that says Macintosh: the device alone");
  assert.equal(uaLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", true), "Windows · Chrome", "touch says nothing on another device");
});

test("a label is shown only when it is made of a label's words", () => {
  for (const [, label] of CASES) if (label) assert.equal(uaLabelOf(label), label);
  for (const device of UA_DEVICES) for (const browser of UA_BROWSERS) assert.equal(uaLabelOf(`${device} · ${browser}`), `${device} · ${browser}`);
  for (const bad of ["Safari · iPhone", "iPhone · Safari · Mac", "iPhone · ", "iphone · safari", "Click here to remove your Mac", "<b>Mac</b>", "Mac  · Safari", ""]) {
    assert.equal(uaLabelOf(bad), null, bad);
  }
  assert.equal(uaLabelOf(null), null);
  assert.equal(uaLabelOf(undefined), null, "an older hub leaves the field out");
});

test("/v1/me's devices carry `ua_label`, or nothing from a hub that does not say it; the plan's transfer says whether it is slowed", async () => {
  const body = {
    account: "a-1",
    email: { address: "kilerd@example.com", verified: true },
    plan: { id: "free", entitlements: {}, usage: { transfer: { period_end_ms: 9, bytes: 11, included: 10, overage_bytes: 1, throttled: true } } },
    chain_seq: 3,
    machines: [],
    devices: [
      { id: "d-1", created_ms: 1, last_seen_ms: 2, in_chain: true, kind: null, host: null, ua_label: "iPhone · Chrome" },
      { id: "d-2", created_ms: 1, last_seen_ms: 2, in_chain: true },
    ],
  };
  const api = new HubApi("https://hub.test", async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  const me = await api.me("token");
  assert.deepEqual(
    me.devices.map((d) => [d.id, d.uaLabel]),
    [
      ["d-1", "iPhone · Chrome"],
      ["d-2", null],
    ],
  );
  assert.equal(me.plan?.usage.transfer?.throttled, true);
  assert.equal(me.plan?.usage.transfer?.bytes, 11);
});
