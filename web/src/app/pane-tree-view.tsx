import { Component, createContext, useCallback, useContext, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRouterState } from "@tanstack/react-router";
import type { components } from "@/api/schema";
import { paneAttention } from "@/features/sessions/session-attention";
import { feedRow, useMachineFeedSelector, type GlobalFeedState } from "./global-feed";
import { PaneBadgeContext, PaneFrame, PaneSeatContext, usePaneSeat, type PaneSeat } from "./pane-seat";
import { RegMark } from "@/components/reg-mark";
import { useHomeMachine, useOpenMachines } from "@/lib/machines/context";
import { isOpen } from "@/lib/machines/registry";
import type { MachineKey } from "@/lib/machines/key";
import { paneMachine, treeMachines, type LeafNode, type PaneContent, type PaneNode, type PaneTreeApi, type SplitNode } from "./pane-tree";

/**
 * Whether the tree a pane is in shows more than one device: then every pane
 * says which device it is on (`docs/local-aggregator.md` §6.5), not only the
 * ones off the home.
 */
const PaneTreeMixedContext = createContext(false);

export function usePaneTreeMixed(): boolean {
  return useContext(PaneTreeMixedContext);
}

type SessionSummary = components["schemas"]["SessionSummary"];

function SplitDivider({ split, api }: { split: SplitNode; api: PaneTreeApi }) {
  const direction = split.direction;
  return (
    <div
      onPointerDown={(e) => {
        e.preventDefault();
        const container = e.currentTarget.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const total = direction === "row" ? rect.width : rect.height;
        const origin = direction === "row" ? rect.left : rect.top;
        const target = e.currentTarget;
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // synthetic or stale pointer: dragging still works via listeners
        }
        const onMove = (ev: PointerEvent) => {
          const pos = direction === "row" ? ev.clientX : ev.clientY;
          if (total > 0) api.resizeSplit(split.id, (pos - origin) / total);
        };
        const onUp = () => {
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
      }}
      // A 1px hairline you can see, with a 7px band you can grab.
      className={`relative z-10 shrink-0 bg-border before:absolute before:content-[''] hover:bg-fg/40 active:bg-fg ${
        direction === "row"
          ? "w-px cursor-col-resize before:inset-y-0 before:-right-[3px] before:-left-[3px]"
          : "h-px cursor-row-resize before:inset-x-0 before:-top-[3px] before:-bottom-[3px]"
      }`}
    />
  );
}

/**
 * Registration marks where this split's gutter meets another: the T where a
 * child split's gutter runs into this one, and — for a side-by-side split — the
 * shared 32px header line. Positioned from the ratios, so they follow a drag.
 * A gutter sits at (size − 1px) × ratio; the mark's centre pixel goes on it.
 */
function SplitMarks({ node }: { node: SplitNode }) {
  const at = (ratio: number) => `calc((100% - 1px) * ${ratio} - 4px)`;
  const marks: React.CSSProperties[] = [];
  for (const child of node.children) {
    if (child.type !== "split" || child.direction === node.direction) continue;
    marks.push(
      node.direction === "row"
        ? { left: at(node.ratio), top: at(child.ratio) }
        : { left: at(child.ratio), top: at(node.ratio) },
    );
  }
  if (node.direction === "row") marks.push({ left: at(node.ratio), top: "27px" });
  return (
    <>
      {marks.map((style, i) => (
        <RegMark key={i} style={style} />
      ))}
    </>
  );
}

/** The feed row for a pane's session, or undefined for any other content. */
function usePaneSessionRow(content: PaneContent): SessionSummary | undefined {
  // A pane's session is on the pane's machine: the one its content names,
  // else the home's (docs/local-aggregator.md §6.5) — read from that
  // machine's list, which the pane's content keeps running.
  const machine = paneMachine(content, useHomeMachine());
  const source = content.kind === "session" ? content.source : null;
  const id = content.kind === "session" ? content.id : null;
  // The row object itself: the feed keeps a row's identity until that row is
  // upserted, so this wakes the frame for its own session's changes only.
  const select = useCallback(
    (state: GlobalFeedState) => (source && id ? feedRow(state, { machine, source, id }) : undefined),
    [machine, source, id],
  );
  return useMachineFeedSelector(machine, select);
}

function PaneLeaf({
  leaf,
  api,
  renderLeaf,
  active,
}: {
  leaf: LeafNode;
  api: PaneTreeApi;
  renderLeaf: (leaf: LeafNode) => React.ReactNode;
  active: boolean;
}) {
  const focused = api.hasSplit && api.focusedId === leaf.id;
  // Being read needs all three: this tree is showing, this pane has the focus
  // (an unsplit one always does), and so does every pane it is nested in.
  const parent = usePaneSeat();
  const attentive = active && (!api.hasSplit || focused) && (parent?.attentive ?? true);
  const [atBottom, setAtBottom] = useState(true);
  const seat = useMemo<PaneSeat>(() => ({ attentive, reportAtBottom: setAtBottom }), [attentive]);
  const row = usePaneSessionRow(leaf.content);
  const pane = useMemo(() => paneAttention({ row, focused: attentive, atBottom }), [row, attentive, atBottom]);
  // The content is built once per leaf, not once per frame update: the frame
  // re-renders whenever its session's row moves, and the transcript inside it
  // must not re-render with it.
  const content = useMemo(() => renderLeaf(leaf), [renderLeaf, leaf]);
  return (
    <div
      onPointerDownCapture={() => api.setFocused(leaf.id)}
      onFocusCapture={() => api.setFocused(leaf.id)}
      data-pane-id={leaf.id}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <PaneSeatContext.Provider value={seat}>
        <PaneBadgeContext.Provider value={pane.unread > 0 ? pane : null}>
          {leaf.content.kind === "main" ? (
            // The routed view is the router's: its own boundary resets as the
            // address moves (`RoutedViewBoundary`, around the outlet alone, so
            // the screens and apps layered over it stay).
            content
          ) : (
            <PaneErrorBoundary
              resetKey={leaf.content}
              onReset={() => api.setPaneContent(leaf.id, { kind: "picker" })}
              onClose={() => api.closePane(leaf.id)}
            >
              {content}
            </PaneErrorBoundary>
          )}
        </PaneBadgeContext.Provider>
      </PaneSeatContext.Provider>
      <PaneFrame state={pane.state} focused={focused} />
    </div>
  );
}

/** What a pane shows instead of content that failed to draw. */
function PaneFailed({ error, onReset, onClose }: { error: unknown; onReset: (() => void) | null; onClose: (() => void) | null }) {
  const { t } = useTranslation();
  return (
    <div data-pane-failed="" className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <span data-signal="failed" className="font-mono text-xs text-danger">{t("this pane could not be drawn")}</span>
      <span className="max-w-sm truncate font-mono text-2xs text-faint">{error instanceof Error ? error.message : String(error)}</span>
      {(onReset || onClose) && (
        <span className="flex gap-2">
          {onReset && (
            <button type="button" onClick={onReset} className="border border-border px-2 py-1 font-mono text-2xs text-accent hover:bg-hover">
              {t("pick new content")}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="border border-border px-2 py-1 font-mono text-2xs text-muted hover:bg-hover">
              {t("close pane")}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** The state of a {@link PaneErrorBoundary}: the error it caught, and under which reset key. */
interface BoundaryState {
  error: unknown;
  failed: boolean;
  of: unknown;
  seen: boolean;
}

/**
 * One view's content, kept from taking the page down with it: whatever it
 * throws while drawing stays in its place, which offers to pick something
 * else or close (where there is something to do). Given a new `resetKey` — a
 * pane's new content, the routed view's new address — it tries again.
 */
export class PaneErrorBoundary extends Component<
  { resetKey: unknown; onReset: (() => void) | null; onClose: (() => void) | null; children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null, failed: false, of: undefined, seen: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: unknown }, state: BoundaryState) {
    if (state.seen && Object.is(state.of, props.resetKey)) return null;
    // Something new to show: draw it afresh.
    return { error: null, failed: false, of: props.resetKey, seen: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("pane:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) return <PaneFailed error={this.state.error} onReset={this.props.onReset} onClose={this.props.onClose} />;
    return this.props.children;
  }
}

/**
 * The routed view's boundary: an error in one page stays in the routed view
 * — the screens and apps layered over it keep drawing — and the next address
 * (a link, the rail, Back) draws afresh.
 */
export function RoutedViewBoundary({ children }: { children: ReactNode }) {
  const href = useRouterState({ select: (s) => s.location.href });
  return (
    <PaneErrorBoundary resetKey={href} onReset={null} onClose={null}>
      {children}
    </PaneErrorBoundary>
  );
}

function PaneTreeNode({
  node,
  api,
  renderLeaf,
  active,
}: {
  node: PaneNode;
  api: PaneTreeApi;
  renderLeaf: (leaf: LeafNode) => React.ReactNode;
  active: boolean;
}) {
  if (node.type === "leaf") return <PaneLeaf leaf={node} api={api} renderLeaf={renderLeaf} active={active} />;
  const pct = node.ratio * 100;
  return (
    <div className={`relative flex min-h-0 min-w-0 flex-1 ${node.direction === "column" ? "flex-col" : ""}`}>
      <SplitMarks node={node} />
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `1 1 ${pct}%` }}>
        <PaneTreeNode node={node.children[0]} api={api} renderLeaf={renderLeaf} active={active} />
      </div>
      <SplitDivider split={node} api={api} />
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `1 1 ${100 - pct}%` }}>
        <PaneTreeNode node={node.children[1]} api={api} renderLeaf={renderLeaf} active={active} />
      </div>
    </div>
  );
}

/**
 * Renders a pane tree; the caller decides what a leaf's content looks like.
 *
 * `active` is false for a tree that is mounted but not on screen — a screen
 * kept alive behind another route — so nothing in it counts as being read.
 */
export function PaneTreeView({
  api,
  renderLeaf,
  active = true,
  mainMachine,
}: {
  api: PaneTreeApi;
  renderLeaf: (leaf: LeafNode) => React.ReactNode;
  active?: boolean;
  /** The device the `main` leaf (the routed view) is about; the home's by default. */
  mainMachine?: MachineKey;
}) {
  const home = useHomeMachine();
  // Devices the page has: a pane of one it does not have says so itself, and
  // does not make every other pane name its device.
  const open = useOpenMachines();
  const mixed = useMemo(
    () => [...treeMachines(api.root, home, mainMachine ?? home)].filter((machine) => isOpen(machine)).length > 1,
    // `open`: re-counted as devices come and go.
    [api.root, home, mainMachine, open],
  );
  return (
    <PaneTreeMixedContext.Provider value={mixed}>
      <PaneTreeNode node={api.root} api={api} renderLeaf={renderLeaf} active={active} />
    </PaneTreeMixedContext.Provider>
  );
}
