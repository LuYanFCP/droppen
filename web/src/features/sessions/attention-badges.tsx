import { useTranslation } from "react-i18next";
import { LiveDot } from "@/components/live-dot";
import { cn } from "@/lib/cn";
import { useTicker } from "@/lib/ticker";
import { activityBadge, residentOf } from "./session-activity";
import { activityChip, chipText, formatUnread, type AttentionRow, type AttentionState } from "./session-attention";

/**
 * The colour of each state, as the 2px edge on a list row or a folder heading.
 *
 * Colour is kept for signals only (docs/ui-spec.md §7): green for work in
 * flight, amber for a question waiting on your answer, ink for unread
 * messages. Background work and an idle session — a turn that simply finished —
 * draw no edge at all.
 */
export const EDGE_CLASS: Record<AttentionState, string> = {
  asking: "bg-warn",
  working: "bg-ok",
  unread: "bg-unread",
  // Background work needs nothing from anyone: its chip says so, the edge stays quiet.
  background: "",
  idle: "",
};

/** The leading edge of a row: the strongest state it is in, readable without reading. */
export function EdgeBar({ state, className }: { state: AttentionState; className?: string }) {
  if (state === "idle" || state === "background") return null;
  return <span aria-hidden="true" data-edge={state} className={cn("pointer-events-none absolute inset-y-0 left-0 w-[2px]", EDGE_CLASS[state], className)} />;
}

/**
 * How many messages you have not read, as a count rather than a dot.
 *
 * Calm on purpose: it never blinks. Something waiting to be read is not
 * something happening, and only live work moves on this screen.
 */
export function UnreadPill({ count, className }: { count: number; className?: string }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  const label = t("{{n}} unread messages", { n: formatUnread(count) });
  return (
    <span
      title={label}
      aria-label={label}
      data-unread={count}
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center bg-unread px-1 font-mono text-[10px] leading-none font-semibold tabular-nums text-bg",
        className,
      )}
    >
      {formatUnread(count)}
    </span>
  );
}

const CHIP_CLASS = {
  // The loudest thing in the list: filled, because it is the one state that is
  // waiting on *you* — the agent stopped on a question. Ink on amber, both themes.
  asking: "bg-warn text-on-signal font-semibold",
  // Outlined = in progress, needs nothing from you (docs/ui-spec.md §7 V9).
  working: "text-ok shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ok)_60%,transparent)]",
  queued: "text-ok shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ok)_60%,transparent)]",
  background: "text-muted shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
} as const;

/**
 * What a session is doing, as a labelled chip: `工作中 · 3m`, `排队 2`,
 * `后台 3`, `在问你`. Null for a session doing nothing — including one whose
 * turn simply finished.
 *
 * Only a working turn blinks — the shared 1 Hz [`LiveDot`], never a CSS
 * animation, and still under reduced motion. A queue and background work are
 * busy too, but they need nothing from anyone, so their dot holds still.
 */
export function ActivityChipView({ row, className }: { row: AttentionRow; className?: string }) {
  const { t } = useTranslation();
  // The duration is minutes, so a 30s clock is plenty, and only a working row
  // with a known start runs one at all.
  const ticking = activityBadge(row).kind === "working" && !!residentOf(row)?.turnStartedAt;
  const now = useTicker(30_000, ticking);
  const chip = activityChip(row, now);
  if (!chip) return null;
  const badge = activityBadge(row);
  const title =
    chip.kind === "asking"
      ? t("the agent is asking you a question")
      : chip.kind === "background"
        ? t("{{n}} background tasks still running", { n: badge.kind === "background" ? badge.background : 0 })
        : chip.kind === "queued"
          ? t("{{n}} messages queued", { n: badge.kind === "queued" ? badge.queued : 0 })
          : t("agent is working");
  return (
    <span
      title={title}
      data-activity={chip.kind}
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 px-1 font-mono text-[10px] leading-none font-medium whitespace-nowrap",
        CHIP_CLASS[chip.kind],
        className,
      )}
    >
      {chip.kind === "working" ? (
        <LiveDot className="bg-ok" />
      ) : chip.kind === "queued" ? (
        <span aria-hidden="true" data-shape="dot" className="size-1.5 shrink-0 rounded-full bg-current" />
      ) : chip.kind === "background" ? (
        <span aria-hidden="true" data-shape="dot" className="size-1.5 shrink-0 rounded-full shadow-[inset_0_0_0_1.25px_currentColor]" />
      ) : null}
      <span className="tabular-nums">{chipText(chip, t)}</span>
    </span>
  );
}

/**
 * A state as the list's own chip, with how many sessions are in it — a
 * device's panel, the devices dashboard: `● 2` for work in flight (its dot
 * live), `在问你 1` for questions waiting on you. Without a count, the chip
 * names the state (`● 工作中`, `在问你`): a summary's key.
 */
export function StateCountChip({ kind, count, className }: { kind: "asking" | "working"; count?: number; className?: string }) {
  const { t } = useTranslation();
  if (count !== undefined && count <= 0) return null;
  const name = kind === "asking" ? t("asking you") : t("working");
  const title =
    count === undefined ? name : kind === "asking" ? t("{{n}} sessions are asking you", { n: count }) : t("{{n}} sessions are working", { n: count });
  const text = count === undefined ? name : kind === "asking" ? `${name} ${count}` : String(count);
  return (
    <span
      title={title}
      aria-label={title}
      data-activity={kind}
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 px-1 font-mono text-[10px] leading-none font-medium whitespace-nowrap",
        CHIP_CLASS[kind],
        className,
      )}
    >
      {kind === "working" &&
        // A key names the state, it does not report work: its dot holds still.
        (count === undefined ? <span aria-hidden="true" data-shape="dot" className="size-1.5 shrink-0 rounded-full bg-current" /> : <LiveDot className="bg-ok" />)}
      <span className="tabular-nums">{text}</span>
    </span>
  );
}
