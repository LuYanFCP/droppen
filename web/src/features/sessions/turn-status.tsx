import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "@/lib/format";
import { approxTokens, type DraftStore, type Thinking } from "./stream-draft";
import type { TurnProgress } from "./session-activity";

const NO_STORE = () => () => {};
const NOT_THINKING: Thinking = { tokens: null, movedAt: null };
const notThinking = () => NOT_THINKING;

/**
 * A session's think as its draft store has it — the count of the one in
 * flight, and when the count last moved — or nothing for a view with no store
 * (a test).
 *
 * The store hands back the same object until something in it changes, so a
 * frame that says what the last one did wakes nothing, and one that moves the
 * count wakes only the words that print it.
 */
export function useThinking(store: DraftStore | undefined): Thinking {
  return useSyncExternalStore(store?.subscribe ?? NO_STORE, store?.get ?? notThinking, store?.get ?? notThinking);
}

/**
 * The words beside a working turn's dot: how much it has written, what it is
 * doing, how long it has run — `28 messages · last activity 3s ago · 7m14s`,
 * and while the agent thinks, `28 messages · thinking… ~50 tokens · 7m14s`.
 *
 * A think is said here and nowhere else. It used to be a line in a dashed box
 * below the transcript, which came and went and grew a line at a time while
 * the agent worked, and moved everything the reader was looking at; this bar
 * is one line tall whatever it says. The count takes the place of "last
 * activity" rather than joining it: the count moving is the activity, and the
 * bar has room on a phone for three parts, not four.
 *
 * And when the think is over, "last activity" counts it: a long think writes
 * nothing to the transcript, so the transcript's newest timestamp would call
 * the whole of it silence. The count's last move is taken when it falls inside
 * this turn — the store outlives turns, and a move from the one before is not
 * this one's activity.
 *
 * Its own component so the count — up to a dozen frames a second during a
 * long think — re-renders these few words and not the composer around them.
 */
export function TurnStatus({
  drafts,
  progress,
  now,
}: {
  drafts?: DraftStore;
  /** How the running turn is going; null when nothing can date it. */
  progress: TurnProgress | null;
  /** The clock the bar ticks by. */
  now: number;
}) {
  const { t } = useTranslation();
  const { tokens, movedAt } = useThinking(drafts);
  const started = progress?.startedAt ? Date.parse(progress.startedAt) : Number.NaN;
  const written = progress?.lastActivityAt ? Date.parse(progress.lastActivityAt) : Number.NaN;
  // `movedAt` is this page's clock and `started` the agent's, so the two can
  // be off by clock skew plus latency — harmless: at worst a think right at
  // the turn's start is counted, or not, a second either way.
  const thought = movedAt !== null && movedAt >= started ? movedAt : Number.NaN;
  const last = Number.isNaN(written) ? thought : Number.isNaN(thought) ? written : Math.max(written, thought);
  const parts: ReactNode[] = [];
  if (progress) parts.push(t("{{n}} messages", { n: progress.messages }));
  if (tokens !== null) parts.push(<ThinkingCount tokens={tokens} />);
  else if (!Number.isNaN(last)) parts.push(t("last activity {{ago}} ago", { ago: formatDuration(now - last) }));
  if (!Number.isNaN(started)) parts.push(formatDuration(now - started));
  // Without a clock to read or a think to count, the old sentence is still the truth.
  if (parts.length === 0) return <>{t("agent is working on your message…")}</>;
  return (
    <>
      {parts.map((part, at) => (
        <Fragment key={at}>
          {at > 0 && " · "}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The widest count [`approxTokens`] writes below a million: five characters,
 * which in the bar's monospace are as wide as any other five.
 */
const WIDEST_COUNT = "~0.0k";

/**
 * `thinking… ~1.2k tokens`, at a width that does not move while it counts.
 *
 * The count sits in a slot held at its widest by an invisible copy of
 * `~0.0k` in the same grid cell, and is right-aligned in it, like a meter:
 * `~50` and `~1.2k` take the same room, the number grows to the left, and
 * neither the unit nor the elapsed time after it moves while the count runs.
 * The word "tokens" is drawn only in a bar at least 26rem wide; a narrower
 * one — a phone, a narrow split pane — shows the count alone, so the line
 * still ends with the elapsed time instead of an ellipsis.
 */
function ThinkingCount({ tokens }: { tokens: number }) {
  const { t } = useTranslation();
  return (
    <span data-thinking="">
      {`${t("thinking…")} `}
      <span className="inline-grid tabular-nums">
        <span data-thinking-tokens="" className="col-start-1 row-start-1 justify-self-end">
          {approxTokens(tokens)}
        </span>
        <span aria-hidden="true" data-ghost="" className="invisible col-start-1 row-start-1">
          {WIDEST_COUNT}
        </span>
      </span>
      <span className="hidden @min-[26rem]/activity:inline">{` ${t("tokens")}`}</span>
    </span>
  );
}
