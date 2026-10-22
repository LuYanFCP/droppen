import { Tooltip } from "@base-ui-components/react/tooltip";
import { useSyncExternalStore, type ReactElement, type ReactNode } from "react";

/** Where the rail is a column (`md:` and up, as in `app/root-layout.tsx`); below it is a bar along the bottom. */
const COLUMN = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(COLUMN);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isColumn = () => window.matchMedia(COLUMN).matches;

/**
 * The name of an icon-only rail entry, shown beside it on hover and focus.
 *
 * Drawn in the page, to the right of the rail, rather than as the browser's
 * own `title` tooltip. A `title` tooltip is a window of the operating system's,
 * placed wherever it likes: in the desktop app the rail's top entry sits just
 * under the title bar, and macOS put its tooltip over the window's
 * close / minimise / zoom buttons. A hint that belongs to the page can never
 * leave it, and on the right of a 44px rail it covers nothing the pointer is
 * on its way to.
 *
 * Beside the entry while the rail is a column, above it while the rail is the
 * bar along the bottom of a narrow window (the app's smallest window is one).
 *
 * `render` is the entry itself (a link or a button that forwards its ref and
 * props); `children` is what it shows. The entry keeps its own `aria-label`:
 * the hint is for the eye, the label for assistive technology.
 */
export function RailHint({ label, render, children }: { label: string; render: ReactElement<Record<string, unknown>>; children: ReactNode }) {
  const column = useSyncExternalStore(subscribe, isColumn, () => true);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={400} closeDelay={0} render={render}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side={column ? "right" : "top"} align="center" sideOffset={6} className="z-50 outline-none">
          <Tooltip.Popup data-rail-hint="" className="border border-border-strong bg-bg px-2 py-1 font-mono text-2xs whitespace-nowrap text-fg">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
