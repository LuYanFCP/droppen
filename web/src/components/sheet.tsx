import { cn } from "@/lib/cn";
import { RegMark } from "@/components/reg-mark";

/**
 * A document page on the drafting sheet: a scroll area whose content sits in a
 * centred column framed by two hairlines, with registration marks where the
 * 32px header line meets the frame (docs/ui-spec.md §3–4). Settings, the task
 * ledger and other reading pages use it; the session views do not.
 *
 * The marks only appear once the column is narrower than its container — below
 * that the frame runs along the pane's own edges and there is no seam to mark.
 */
export function Sheet({
  children,
  className,
  width = 1000,
  scrollClassName,
}: {
  children: React.ReactNode;
  className?: string;
  /** The column's maximum width in px, frame included. */
  width?: number;
  scrollClassName?: string;
}) {
  const half = width / 2;
  return (
    <div className="@container/sheet relative flex min-h-0 flex-1 flex-col">
      <div className={cn("min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]", scrollClassName)}>
        <div
          data-sheet=""
          className={cn("relative mx-auto min-h-full w-full md:border-x md:border-border", className)}
          style={{ maxWidth: width }}
        >
          {children}
        </div>
      </div>
      <RegMark className={`-top-[5px] sheet-mark sheet-mark-${width}`} style={{ left: `calc(50% - ${half + 4}px)` }} />
      <RegMark className={`-top-[5px] sheet-mark sheet-mark-${width}`} style={{ left: `calc(50% + ${half - 5}px)` }} />
    </div>
  );
}
