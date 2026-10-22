import { createContext, useContext, useMemo, useReducer } from "react";
import {
  paneTreeApi,
  reducePaneTree,
  type PaneAction,
  type PaneTreeState,
  type PaneTreeApi,
} from "./pane-tree";

export type { LeafNode, PaneContent, PaneNode, SplitNode, SplitDirection } from "./pane-tree";

export const MAIN_PANE_ID = "main";

const PanesContext = createContext<PaneTreeApi | null>(null);

export function usePanes(): PaneTreeApi {
  const api = useContext(PanesContext);
  if (!api) throw new Error("usePanes outside PanesProvider");
  return api;
}

const INITIAL: PaneTreeState = {
  root: { type: "leaf", id: MAIN_PANE_ID, content: { kind: "main" } },
  focusedId: MAIN_PANE_ID,
};

const reduceRoutePanes = (state: PaneTreeState, action: PaneAction) => reducePaneTree(state, action, MAIN_PANE_ID);

/**
 * The ephemeral split layout around the routed main view. Unlike screens this
 * tree always contains the "main" leaf and is deliberately not persisted:
 * it is for throwaway side-by-side arrangements while browsing.
 */
export function PanesProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reduceRoutePanes, INITIAL);
  const api = useMemo(() => paneTreeApi(state, dispatch), [state, dispatch]);

  return <PanesContext.Provider value={api}>{children}</PanesContext.Provider>;
}
