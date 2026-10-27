import { useTranslation } from "react-i18next";
import type { components } from "@/api/schema";
import { LiveDot } from "@/components/live-dot";
import { cn } from "@/lib/cn";

type SessionChildStatus = components["schemas"]["SessionChildStatus"];

/**
 * How a subagent stands, as one character in a fixed slot.
 *
 * The same glyphs the transcript's subagent card ends on, so a row in the list
 * and the card it came from read alike. Only the states that want something
 * are coloured: work in flight, a question, a failure. Finished is the quiet
 * case, and most of a long fan-out.
 */
export function ChildStatusMark({ status, className }: { status: SessionChildStatus; className?: string }) {
  const { t } = useTranslation();
  const slot = cn("flex w-3 shrink-0 items-center justify-center font-mono text-2xs leading-none", className);
  switch (status) {
    case "working":
      return (
        <span className={slot}>
          <LiveDot className="bg-ok" title={t("this subagent is still running")} />
        </span>
      );
    case "waiting":
      return (
        <span data-signal="warn" title={t("this subagent is waiting for your answer")} className={cn(slot, "font-semibold text-warn-fg")}>
          ?
        </span>
      );
    case "failed":
      return (
        <span data-signal="failed" title={t("this subagent failed")} className={cn(slot, "text-danger")}>
          ✗
        </span>
      );
    case "done":
      return (
        <span title={t("this subagent finished")} className={cn(slot, "text-faint")}>
          ✓
        </span>
      );
  }
}

/** Something under here has not been read: the unread square, without a count. */
export function UnreadMark({ title, className }: { title: string; className?: string }) {
  return <span data-unread="1" title={title} aria-label={title} className={cn("size-1.5 shrink-0 bg-unread", className)} />;
}
