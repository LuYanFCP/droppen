/**
 * App-icon badge (Badging API), the page's half of it.
 *
 * While the page is open the badge is the unread count — summed over every
 * device that runs AI (`docs/local-aggregator.md` §6.4; the local app has only
 * its own), the same number as the tab title — and nothing once all is read.
 * public/sw.js flags the icon when a push lands with no count to give; the
 * page puts its own number back the moment the app is looked at again (on
 * load, and on every return to the foreground), so the flag never outlives a
 * look at the app.
 *
 * Installed PWAs on Chrome/Edge and home-screen apps on iOS 16.4+ / macOS
 * Safari 17+ implement it; Firefox does not, and even where it exists the
 * promise can reject, so every call is a no-throw and the feature is purely
 * additive.
 */
let count = 0;

/** The most the badge says, as the tab title's `99+` (`UNREAD_CAP`, `session-attention.ts`): the icon has no room for more. */
export const BADGE_CAP = 99;

export function clearAppBadge(): void {
  if (!("clearAppBadge" in navigator)) return;
  void navigator.clearAppBadge().catch(() => undefined);
}

/** The page's count on the icon: the number, or nothing for none. */
function showCount(): void {
  if (!("clearAppBadge" in navigator)) return;
  if (count > 0 && "setAppBadge" in navigator) void navigator.setAppBadge(count).catch(() => undefined);
  else clearAppBadge();
}

/** The unread count the badge shows from now on (the tab title's number). */
export function setAppBadgeCount(unread: number): void {
  const next = Number.isFinite(unread) ? Math.min(BADGE_CAP, Math.max(0, Math.floor(unread))) : 0;
  if (next === count) return;
  count = next;
  showCount();
}

/** Show the page's count now (none yet: a clear), and again whenever the app comes back into view. */
export function startBadgeSync(): void {
  if (!("clearAppBadge" in navigator)) return;
  showCount();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") showCount();
  });
  // visibilitychange does not fire when the window merely regains focus next to
  // another window, which on desktop is the common way to come back.
  window.addEventListener("focus", showCount);
}
