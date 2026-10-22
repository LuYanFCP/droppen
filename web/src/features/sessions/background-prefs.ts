/**
 * Whether the floating background-task panel lists its children or just counts
 * them.
 *
 * The panel is `sticky` over the transcript, so its height is taken *from* the
 * messages it is reporting on. One or three rows is a fair trade; the fan-out
 * that made this necessary — a lead session minding a dozen agents — is a wall
 * of monospace across the top of a phone, and the thing you scrolled up to read
 * is behind it. So past a handful of children the list folds down to the one
 * line that says the work exists, and opens on a tap.
 *
 * Every decision here is a pure function over a storage handle and a row count,
 * so it can be tested without a DOM.
 */

export interface FoldStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * How many children fit before the list is folded by default.
 *
 * Three, because that is about what fits over a phone's transcript without the
 * panel becoming the screen — and because the common session has one or two
 * children, which must not cost a tap to read.
 */
export const BACKGROUND_FOLD_THRESHOLD = 3;

/**
 * One global key, not one per session.
 *
 * The question this answers is "how much of my screen may this thing take",
 * which is a fact about the device in your hand rather than about any one
 * session — the phone that needed the fold needs it in every session, and a
 * per-session key would make the user re-fold each one. It would also grow
 * without bound: sessions are created constantly and never garbage collected,
 * so a per-session preference is a localStorage leak with a UI in front of it.
 *
 * The cost of going global is that a choice made in a busy session follows you
 * into a quiet one — which [`backgroundFold`] then declines to apply, because
 * the stored bit only ever governs panels big enough to be in anybody's way.
 */
export const BACKGROUND_PANEL_OPEN_KEY = "rh.sessions.backgroundPanelOpen";

/** What the panel should draw: a list, or the one line standing for it. */
export interface BackgroundFold {
  /**
   * Whether a fold control is drawn at all.
   *
   * False for a short list, which is then exactly what it was before this
   * existed: rows and no headline over them. "3 background tasks" is the
   * question, not the answer, and spending the top line of the panel on it
   * while the answer already fits underneath is a strictly worse panel.
   */
  foldable: boolean;
  /** Whether the rows are drawn. Always true when `foldable` is false. */
  open: boolean;
}

/**
 * The fold state for a panel of `rows` children.
 *
 * `stored` is an *override*, not the state: null means nobody has expressed a
 * preference and the row count decides. That is what keeps one global key
 * honest — a user who folded a twelve-agent fan-out has said nothing about the
 * two-row panel in the next session, and a short list is drawn open either way.
 */
export function backgroundFold(rows: number, stored: boolean | null): BackgroundFold {
  if (rows <= BACKGROUND_FOLD_THRESHOLD) return { foldable: false, open: true };
  return { foldable: true, open: stored ?? false };
}

/** The stored override, or null when there is none to apply. */
export function readBackgroundPanelOpen(storage: FoldStorage): boolean | null {
  try {
    const raw = storage.getItem(BACKGROUND_PANEL_OPEN_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    // Absent, or written by some other build: no preference, let the count
    // decide rather than guessing at what a corrupt value meant.
    return null;
  } catch {
    // storage unavailable: the default fold is still the right answer
    return null;
  }
}

export function writeBackgroundPanelOpen(storage: FoldStorage, open: boolean): void {
  try {
    storage.setItem(BACKGROUND_PANEL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // storage unavailable: the fold still holds for this page
  }
}

/**
 * How long the oldest child has been out, in ms, or null when none can say.
 *
 * The folded line has room for exactly one number beyond the count, and this is
 * the one worth printing: a panel folded shut hides the per-row stopwatches,
 * and "twelve tasks" alone cannot tell a fan-out that started a minute ago from
 * one that has been wedged since lunch.
 *
 * Same precedence as the rows themselves — the CLI's own `durationMs` over
 * `now - startedAt`, because `startedAt` is when this *server* first heard of
 * the task and after a restart that is the restart.
 */
export function oldestElapsedMs(
  rows: readonly { durationMs?: number; startedAt: string | null }[],
  now: number,
): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const elapsed =
      typeof row.durationMs === "number"
        ? row.durationMs
        : row.startedAt
          ? now - Date.parse(row.startedAt)
          : Number.NaN;
    if (!Number.isFinite(elapsed)) continue;
    if (oldest === null || elapsed > oldest) oldest = elapsed;
  }
  return oldest;
}
