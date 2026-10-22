import { createContext, useContext } from "react";
import { UnreadPill } from "@/features/sessions/attention-badges";
import type { PaneAttention } from "@/features/sessions/session-attention";

/**
 * What a pane tells the content inside it about where the reader is.
 *
 * `attentive` is the pane's half of "is this being read": its screen is the
 * one showing, and it has focus — or it is the only pane, which has focus by
 * default. The transcript supplies the other half (scrolled to the newest
 * message) and reports it back through `reportAtBottom`, which is how the
 * frame knows to stop showing unread for a pane that is being read.
 *
 * Null outside any pane — a phone, or a view that is not split — which reads
 * as attentive: there is nothing else on screen to be looking at instead.
 */
export interface PaneSeat {
  attentive: boolean;
  reportAtBottom: (atBottom: boolean) => void;
}

export const PaneSeatContext = createContext<PaneSeat | null>(null);

export function usePaneSeat(): PaneSeat | null {
  return useContext(PaneSeatContext);
}

/**
 * The pane's verdict on its own session, for the count in its header.
 *
 * Its own context so a count changing re-renders only the pill that shows it,
 * not the transcript the pill sits above.
 */
export const PaneBadgeContext = createContext<PaneAttention | null>(null);

/** The unread count in a pane's header; nothing outside a pane or once read. */
export function PaneUnreadPill() {
  const badge = useContext(PaneBadgeContext);
  if (!badge || badge.unread <= 0) return null;
  return <UnreadPill count={badge.unread} />;
}

/**
 * The pane's frame, drawn over its edges.
 *
 * An overlay rather than a border on the pane itself, because every pane fills
 * itself edge to edge with opaque content and an inset shadow on the container
 * paints underneath it. `pointer-events-none`, so it never takes a click.
 *
 * The drafting sheet keeps the two meanings on different pixels
 * (docs/ui-spec.md §4):
 *
 * * **state** is a static 2px inner frame in the state's colour — green for a
 *   turn in flight, amber for a question waiting on you, ink for unread. It no
 *   longer breathes: the LiveDot in the pane's header is the one thing that
 *   moves, and a frame that pulses beside it was a second animation saying the
 *   same thing.
 * * **focus** is four 18×4px ink corner marks, a viewfinder, drawn whether or
 *   not the pane has a state.
 */
export function PaneFrame({ state, focused }: { state: PaneAttention["state"]; focused: boolean }) {
  if (state === "idle" && !focused) return null;
  const colour =
    state === "working" ? "var(--color-ok)" : state === "asking" ? "var(--color-warn)" : state === "unread" ? "var(--color-unread)" : null;
  return (
    <>
      {colour && (
        <div
          aria-hidden="true"
          data-pane-state={state}
          className="pointer-events-none absolute inset-0 z-20"
          style={{ boxShadow: `inset 0 0 0 2px ${colour}` }}
        />
      )}
      {focused && (
        <div
          aria-hidden="true"
          data-pane-focus=""
          className="pointer-events-none absolute inset-0 z-20"
          style={{ background: FOCUS_CORNERS }}
        />
      )}
    </>
  );
}

const CORNER = "linear-gradient(var(--color-fg), var(--color-fg))";
const FOCUS_CORNERS = [
  `${CORNER} top left / 18px 4px no-repeat`,
  `${CORNER} top left / 4px 18px no-repeat`,
  `${CORNER} top right / 18px 4px no-repeat`,
  `${CORNER} top right / 4px 18px no-repeat`,
  `${CORNER} bottom left / 18px 4px no-repeat`,
  `${CORNER} bottom left / 4px 18px no-repeat`,
  `${CORNER} bottom right / 18px 4px no-repeat`,
  `${CORNER} bottom right / 4px 18px no-repeat`,
].join(", ");
