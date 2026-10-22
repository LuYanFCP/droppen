import type { ReactNode } from "react";

/**
 * One title/action row and one metadata row, including inside split panes.
 *
 * The title row is the shared 32px header line (docs/ui-spec.md §3): its bottom
 * hairline continues the rail's and the list's, which is where the shell's
 * registration marks sit. The metadata row below is mono and muted.
 */
export function SessionHeader({
  titleRow,
  metadata,
  paneActions,
}: {
  titleRow: ReactNode;
  metadata?: ReactNode;
  paneActions?: ReactNode;
}) {
  return (
    <header className="min-w-0 shrink-0 bg-bg">
      <div className="flex h-8 min-w-0 items-center gap-2 border-b border-border pr-1.5 pl-4 max-md:h-11 max-md:pl-1">
        {titleRow}
        {paneActions && <div className="flex shrink-0 items-center gap-1">{paneActions}</div>}
      </div>
      {metadata && (
        <div className="flex min-h-7 items-center gap-2 overflow-hidden border-b border-border px-4 py-1 font-mono text-2xs text-muted max-md:px-3">
          {metadata}
        </div>
      )}
    </header>
  );
}
