/*
 * A browser or phone's name in 「我的设备」: the kind of device and the
 * browser, "iPhone · Chrome", as the hub makes it of the User-Agent on that
 * device's own requests (`/v1/me`'s `devices[].ua_label`, docs/hub-api) — and,
 * for the page's own device, as this page makes it of its own User-Agent until
 * the hub has said (the same words, the same order of checks).
 *
 * Only these words, so a label never carries anything else a User-Agent (or a
 * hub) might say: a label of other words is not shown (`uaLabelOf`). A name
 * to know a device by, never a reason to trust it: the fingerprint is that.
 */

/** What a device is, as a label names it. */
export const UA_DEVICES = ["iPhone", "iPad", "Mac", "Windows", "Android", "Linux", "ChromeOS"] as const;
/** The browser, as a label names it. */
export const UA_BROWSERS = ["Safari", "Chrome", "Firefox", "Edge", "Opera", "Samsung Internet"] as const;

/** Between the device and the browser. */
export const UA_SEPARATOR = " · ";

const DEVICES = new Set<string>(UA_DEVICES);
const BROWSERS = new Set<string>(UA_BROWSERS);

/**
 * `label` when it is one a hub may send — a device, a browser, or a device
 * and a browser, of the words above — else `null` (an older hub leaves the
 * field out: that is `null` too).
 */
export function uaLabelOf(label: string | null | undefined): string | null {
  if (typeof label !== "string") return null;
  const parts = label.split(UA_SEPARATOR);
  if (parts.length === 1) return DEVICES.has(parts[0]!) || BROWSERS.has(parts[0]!) ? label : null;
  if (parts.length === 2) return DEVICES.has(parts[0]!) && BROWSERS.has(parts[1]!) ? label : null;
  return null;
}

const has = (ua: string, tokens: string[]) => tokens.some((token) => ua.includes(token));

/** The kind of device a User-Agent says (iPadOS asking for the desktop site says Mac, as the hub hears it too). */
function deviceOf(ua: string): string | null {
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("CrOS")) return "ChromeOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Windows")) return "Windows";
  if (has(ua, ["Macintosh", "Mac OS X"])) return "Mac";
  if (ua.includes("Linux")) return "Linux";
  return null;
}

/**
 * The browser a User-Agent says: the ones built on another say theirs first
 * (Edge and Opera say Chrome too, every iOS browser says Safari). An Android
 * app's own web view (`; wv)`) is no browser; Safari is Apple's only.
 */
function browserOf(ua: string, device: string | null): string | null {
  if (device === "Android" && ua.includes("; wv)")) return null;
  if (has(ua, ["SamsungBrowser/"])) return "Samsung Internet";
  if (has(ua, ["EdgiOS/", "EdgA/", "Edg/", "Edge/"])) return "Edge";
  if (has(ua, ["OPR/", "OPiOS/", "OPT/", "Opera"])) return "Opera";
  if (has(ua, ["FxiOS/", "Firefox/"])) return "Firefox";
  if (has(ua, ["CriOS/", "Chrome/"])) return "Chrome";
  if ((device === "iPhone" || device === "iPad" || device === "Mac") && has(ua, ["Safari/"]) && has(ua, ["Version/"])) return "Safari";
  return null;
}

/**
 * A User-Agent's label ("iPhone · Chrome", "Mac", "Firefox"), or `null` when
 * it says nothing known. `touch`: the page's own screen takes touch
 * (`navigator.maxTouchPoints > 1`) — iPadOS asking for the desktop site says
 * Macintosh, and a Mac has no touch screen, so it is an iPad (the hub makes
 * the same correction from the page's hint).
 */
export function uaLabel(ua: string | null | undefined, touch = false): string | null {
  if (!ua) return null;
  const said = deviceOf(ua);
  const device = said === "Mac" && touch ? "iPad" : said;
  const browser = browserOf(ua, device);
  if (device && browser) return `${device}${UA_SEPARATOR}${browser}`;
  return device ?? browser;
}
