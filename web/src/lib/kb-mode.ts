/**
 * Which keyboard handling the page runs: `native` (`lib/kb-native.ts`) or
 * `legacy` (`lib/kb-inset.ts`). Both stay in the build so the two can be
 * compared on a phone without a redeploy:
 *  - `?kb=native` or `?kb=legacy` on any address picks one, and it stays
 *    picked in this browser (localStorage `rh.kb`);
 *  - `?kb=default` (or any other value) forgets the pick;
 *  - the Home Screen app has no address bar and keeps its storage apart from
 *    Safari's: there the readout (`?vvdebug=1`, or two fingers held still for
 *    two seconds) has a button that flips it.
 * The mode is read once, before the app starts; a change takes a reload.
 */

export type KbMode = "native" | "legacy";

/**
 * `native`: WebKit's own reveal of the focused field, which is what kept the
 * composer above the keyboard until the keyboard was measured by the page
 * (see `lib/kb-native.ts` for why measuring it went wrong on iOS 27).
 */
export const DEFAULT_KB_MODE: KbMode = "native";

const KEY = "rh.kb";

type ModeStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isMode = (v: string | null | undefined): v is KbMode => v === "native" || v === "legacy";

/** The mode for this page, from the address's `?kb=` and the stored pick; the query also stores (or forgets) the pick. */
export function resolveKbMode(search: string, storage: ModeStore | null): KbMode {
  const asked = new URLSearchParams(search).get("kb");
  try {
    if (isMode(asked)) storage?.setItem(KEY, asked);
    else if (asked !== null) storage?.removeItem(KEY);
    if (isMode(asked)) return asked;
    if (asked !== null) return DEFAULT_KB_MODE;
    const stored = storage?.getItem(KEY);
    return isMode(stored) ? stored : DEFAULT_KB_MODE;
  } catch {
    // Storage can be blocked; the query alone still picks for this page.
    return isMode(asked) ? asked : DEFAULT_KB_MODE;
  }
}

function browserStorage(): ModeStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let current: KbMode | null = null;

/** The mode this page runs, read once. */
export function kbMode(): KbMode {
  current ??= resolveKbMode(location.search, browserStorage());
  return current;
}

/** Pick the other mode for this browser and reload into it. */
export function switchKbMode(): void {
  // Through the address, which also stores the pick (`resolveKbMode`): where
  // storage is blocked the reloaded page still runs the other mode.
  const url = new URL(location.href);
  url.searchParams.set("kb", kbMode() === "native" ? "legacy" : "native");
  location.replace(url.toString());
}
