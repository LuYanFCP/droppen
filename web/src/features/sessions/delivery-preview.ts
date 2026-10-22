import type { components } from "@/api/schema";

type Item = Pick<components["schemas"]["TranscriptItem"], "role" | "kind" | "text">;
type Queued = components["schemas"]["QueuedMessage"];
type Receipt = components["schemas"]["MessageReceipt"];
type ReceiptStatus = components["schemas"]["ReceiptStatus"];

/**
 * How many transcript items may arrive after a message was handed to the agent
 * before its preview stops waiting for an echo.
 *
 * A message steered into a running claude turn can be folded into that turn:
 * answered, with no `user` line of its own ever written. Its receipt says it was
 * handed over, so after a few items of somebody's turn without it, the preview
 * has said everything it can.
 */
export const ECHO_GRACE_ITEMS = 3;
let receiptSequence = 0;
/** Display-only identity, including on non-secure LAN HTTP origins. */
export const nextDeliveryId = (): string => `local:${++receiptSequence}`;
export interface DeliveryFrame {
  items: readonly Item[];
  startIndex: number;
  totalItems: number;
  queue: readonly Queued[];
  /** What the server says became of named messages; absent from an older server. */
  receipts?: readonly Receipt[];
  /**
   * Whether server-queue rows this tab did not send become previews when they
   * leave the queue. Codex's transcript lags its acknowledgement, so it wants
   * them; claude's does not, and a claude message folded into a running turn
   * would never be echoed. Defaults to `true`.
   */
  adoptQueue?: boolean;
}
export interface DeliveryPreview {
  id: string;
  text: string;
  after: number;
  sending: boolean;
  queueId?: string;
  /** Queue payloads contain only the first 200 Unicode code points. */
  truncated?: boolean;
  echoed?: boolean;
  dropped?: boolean;
  attachments?: number;
  /** The id this tab sent it under; what its server receipt is found by. */
  clientMessageId?: string;
  /** What the server says became of it, once it has said. */
  receipt?: ReceiptStatus;
  /** The transcript length when it was handed to the agent and left the queue. */
  sentAt?: number;
  /** The whole message, for putting it back in the queue if the server drops it. */
  resend?: { text: string; images?: string[]; files?: string[] };
}
export interface DeliveryState {
  entries: DeliveryPreview[];
  claimed: number[];
  total: number;
}
export const emptyDeliveryState = (total: number): DeliveryState => ({ entries: [], claimed: [], total });

function matches(entry: DeliveryPreview, text: string): boolean {
  const expected = entry.text.trim();
  return entry.truncated ? text.trim().startsWith(expected) : text.trim() === expected;
}

/** One transcript row can acknowledge only one send, and never a send made later. */
export function reconcileDeliveries(state: DeliveryState, frame: DeliveryFrame): DeliveryState {
  const entries = state.entries.map((entry) => ({ ...entry }));
  const claimed = new Set(state.claimed);
  const listed = (queueId: string | undefined) => queueId !== undefined && frame.queue.some((queued) => queued.id === queueId);
  // A receipt is the server's word, so it outranks every guess below: it names
  // the queue row exactly, and says whether the agent has the message yet.
  for (const entry of entries) {
    const receipt = entry.clientMessageId
      ? frame.receipts?.find((candidate) => candidate.clientMessageId === entry.clientMessageId)
      : undefined;
    if (!receipt) continue;
    entry.receipt = receipt.status;
    entry.sending = false;
    if (receipt.qid && !entry.queueId) entry.queueId = receipt.qid;
    if (receipt.status === "sent" && entry.sentAt === undefined && !listed(entry.queueId)) entry.sentAt = frame.totalItems;
  }
  for (const queued of frame.queue) {
    if (entries.some((entry) => entry.queueId === queued.id)) continue;
    const local = entries.find((entry) => !entry.queueId && !entry.echoed && !entry.dropped
      && Array.from(entry.text).slice(0, 200).join("") === queued.text);
    if (local) local.queueId = queued.id;
    else if (frame.adoptQueue !== false) entries.push({ id: `queue:${queued.id}`, queueId: queued.id, text: queued.text,
      truncated: Array.from(queued.text).length === 200, after: state.total, sending: false });
  }
  for (const entry of entries) {
    if (entry.echoed || entry.dropped) continue;
    const found = frame.items.findIndex((item, offset) => {
      const index = frame.startIndex + offset;
      return index >= entry.after && !claimed.has(index) && item.role === "user" && item.kind === "text" && matches(entry, item.text);
    });
    if (found >= 0) {
      entry.echoed = true;
      claimed.add(frame.startIndex + found);
    }
  }
  // Handed to the agent, out of the queue, and the turn has moved on without
  // ever echoing it: folded into somebody else's turn. Nothing more will come.
  for (const entry of entries) {
    if (entry.echoed || entry.dropped || entry.receipt !== "sent" || entry.sentAt === undefined) continue;
    if (!listed(entry.queueId) && frame.totalItems - entry.sentAt >= ECHO_GRACE_ITEMS) entry.echoed = true;
  }
  // Keep a tombstone while an old queue frame still lists the message. Otherwise
  // a fast transcript / slow state frame would resurrect an already shown send.
  const remaining = entries.filter((entry) => !(entry.echoed || entry.dropped)
    || frame.queue.some((queued) => queued.id === entry.queueId));
  const earliest = Math.min(frame.totalItems, ...remaining.map((entry) => entry.after));
  return { entries: remaining, claimed: [...claimed].filter((index) => index >= earliest), total: Math.max(state.total, frame.totalItems) };
}

export function visibleDeliveries(state: DeliveryState, queue: readonly Queued[]): DeliveryPreview[] {
  return state.entries.filter((entry) => !entry.echoed && !entry.dropped
    && !queue.some((queued) => queued.id === entry.queueId));
}

export type DeliveryAction =
  | { type: "start"; entry: DeliveryPreview }
  | { type: "accepted"; id: string; queueId?: string }
  | { type: "failed" | "dismiss"; id: string }
  | { type: "drop"; queueId: string };

export function changeDelivery(state: DeliveryState, action: DeliveryAction): DeliveryState {
  if (action.type === "start") {
    // One preview per named message: a send whose answer was lost and that the
    // server later turned out to have is the same message, not a second one.
    const named = action.entry.clientMessageId;
    if (named && state.entries.some((entry) => entry.clientMessageId === named)) {
      return { ...state, entries: state.entries.map((entry) =>
        entry.clientMessageId === named ? { ...entry, ...action.entry, id: entry.id } : entry) };
    }
    return { ...state, entries: [...state.entries, action.entry] };
  }
  return { ...state, entries: state.entries.flatMap((entry) => {
    if (action.type === "drop") return [{ ...entry, dropped: entry.dropped || entry.queueId === action.queueId }];
    if (entry.id !== action.id) return [entry];
    if (action.type === "dismiss") return [];
    // If a network error raced an observed server queue, that queue remains the
    // authority. This is a display receipt, never permission to retry a send.
    if (action.type === "failed" && !entry.queueId) return [];
    if (action.type === "failed") return [{ ...entry, sending: false }];
    const named = action.type === "accepted" ? action.queueId : undefined;
    const queueId = named ?? entry.queueId;
    // Accepted under a queue id is the server saying it has it; an older server
    // names none, and the preview keeps saying only that it was sent.
    const receipt = entry.receipt ?? (named ? "queued" : undefined);
    return [{ ...entry, sending: false, ...(queueId ? { queueId } : {}), ...(receipt ? { receipt } : {}) }];
  }) };
}

/** Shared by multiple panes and kept through a layout/route remount. Never sends. */
export function createDeliveryStore(total: number) {
  let state = emptyDeliveryState(total);
  const listeners = new Set<() => void>();
  const publish = (next: DeliveryState) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change: (action: DeliveryAction) => publish(changeDelivery(state, action)),
    reconcile: (frame: DeliveryFrame) => publish(reconcileDeliveries(state, frame)),
    idle: () => !state.entries.length && !listeners.size,
  };
}
