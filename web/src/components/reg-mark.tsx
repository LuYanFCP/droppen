import { cn } from "@/lib/cn";

/**
 * A registration mark: the 9px "+" drawn where two hairlines meet on a large
 * surface (shell header seam, split gutters, document frames). Position it
 * with `className` so its centre pixel lands on the crossing; it never takes a
 * click, is hidden from assistive tech, and is not drawn on phones
 * (docs/ui-spec.md §4, V8).
 */
export function RegMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      data-regmark=""
      aria-hidden="true"
      className={cn("pointer-events-none absolute z-30 hidden size-[9px] text-mark md:block", className)}
      style={style}
    >
      <svg width="9" height="9" viewBox="0 0 9 9" className="block">
        <path d="M4.5 0v9M0 4.5h9" stroke="currentColor" strokeWidth="1" />
      </svg>
    </span>
  );
}
