import { type DownloadOs, osOfSearch } from "./get-droppen";

/*
 * Which device is reading the download page, so the right way onto it is
 * chosen before anyone looks for it (`download.tsx`). From what the browser
 * says of itself: `navigator.userAgentData` where there is one (platform and
 * mobile), else the user agent — and the touch points, because an iPad's
 * Safari says it is a Mac. A Mac's architecture is never guessed: the App is
 * universal. Linux's is read only where the browser offers it (the
 * high-entropy hints), and only said, never acted on.
 */

/** What the browser says of itself (all of it optional but the user agent). */
export interface EnvironmentHints {
  userAgent: string;
  /** `navigator.userAgentData.platform`: "macOS", "Windows", "Linux", "Android", "Chrome OS", … */
  platform?: string | null;
  /** `navigator.userAgentData.mobile`. */
  mobile?: boolean | null;
  /** `navigator.maxTouchPoints`: an iPad's Safari reports a Mac, with touch. */
  maxTouchPoints?: number | null;
}

/** What kind of device it is. */
export type DeviceKind = "mac" | "ipad" | "iphone" | "android" | "windows" | "linux" | "chromeos" | "unknown";

/** The kind of device `hints` describe. */
export function detectKind(hints: EnvironmentHints): DeviceKind {
  const ua = hints.userAgent ?? "";
  const platform = (hints.platform ?? "").toLowerCase();
  const touch = (hints.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  if (platform === "android" || /Android/.test(ua)) return "android";
  if (platform === "ios") return "iphone";
  if (platform === "chrome os" || platform === "chromeos" || /CrOS/.test(ua)) return "chromeos";
  if (platform === "macos" || /Macintosh|Mac OS X/.test(ua)) {
    // iPadOS asks for the desktop site and says it is a Mac; a Mac has no touch screen.
    return touch || hints.mobile === true ? "ipad" : "mac";
  }
  if (platform === "windows" || /Windows/.test(ua)) return "windows";
  if (platform === "linux" || /Linux|X11/.test(ua)) return hints.mobile === true ? "android" : "linux";
  if (hints.mobile === true) return "android";
  return "unknown";
}

/** The tab a kind of device opens on (a device it cannot be told: the Mac App, the way most people come in). */
export function osForKind(kind: DeviceKind): DownloadOs {
  switch (kind) {
    case "mac":
    case "unknown":
      return "macos-app";
    case "iphone":
    case "ipad":
    case "android":
      return "mobile";
    case "windows":
      return "windows";
    case "linux":
    case "chromeos":
      return "linux";
  }
}

/** What this browser says of itself, synchronously (`null` outside a browser). */
export function browserHints(): EnvironmentHints | null {
  if (typeof navigator === "undefined") return null;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData;
  return { userAgent: navigator.userAgent, platform: data?.platform ?? null, mobile: data?.mobile ?? null, maxTouchPoints: navigator.maxTouchPoints ?? 0 };
}

/** The processor family the browser reports ("x86", "arm"), where it offers the high-entropy hints; `null` otherwise. */
export async function browserArchitecture(): Promise<string | null> {
  if (typeof navigator === "undefined") return null;
  const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; platformVersion?: string }> } }).userAgentData;
  if (!data?.getHighEntropyValues) return null;
  try {
    const values = await data.getHighEntropyValues(["architecture", "platformVersion"]);
    return values.architecture || null;
  } catch {
    return null;
  }
}

/**
 * The tab the page opens on: the one the address names (shared, or linked
 * from the docs and the add-device guide), else the one chosen in this tab
 * earlier (`remembered`, the session's), else the detected one.
 */
export function initialOs(input: { search: string; remembered: DownloadOs | null; detected: DownloadOs }): DownloadOs {
  return osOfSearch(input.search) ?? input.remembered ?? input.detected;
}
