/**
 * What needs you, across every device that runs AI (`docs/local-aggregator.md`
 * §6.4): one ledger, one set of counts, and the unread total the tab title and
 * the app badge show — computed from each device's session list as the page
 * already has it, never by asking a device for anything.
 *
 * A device's list is a {@link DeviceSessions}: its rows from its own feed
 * while the page is live on it, else from its offline copy's index (with how
 * current that is). On droppen.app that is every machine of the account; in
 * the local app it is only `local`, and the numbers come out exactly as the
 * single-machine ones did (`totalUnread`, `groupAttention`).
 *
 * The rules are the session list's own (`session-attention.ts`): a row needs
 * you when the agent is asking you something, when it holds messages you have
 * not read, or — the quietest — while it is working. Asking comes first, then
 * unread, then working; within each, the newest first. Only the sessions the
 * list shows count (no `external` row), as for the tab's count.
 *
 * Pure, and free of React. Each list's share is worked out once per list (its
 * rows are replaced when they change, never edited), so a change on one
 * device costs that device's rows and a merge, not every device's again: a
 * page holding twenty devices of a hundred sessions each stays cheap.
 */
import type { components } from "@/api/schema";
import { type MachineKey, type SessionRef, sessionKey } from "@/lib/machines/key";
import { activityBadge, residentOf } from "@/features/sessions/session-activity";
import { type GroupAttention, groupAttention, unreadCountOf } from "@/features/sessions/session-attention";

type SessionSummary = components["schemas"]["SessionSummary"];

/** One device's sessions, as the page has them without asking it. */
export interface DeviceSessions {
  readonly machine: MachineKey;
  /** Newest first; `null`: nothing of it yet (no copy on this device, no first snapshot). */
  readonly rows: readonly SessionSummary[] | null;
  /** `live`: the device's own feed; `copy`: its offline copy. */
  readonly from: "live" | "copy";
  /** How current a copy is: the newest time the device signed (ms); `null` live, or not known. */
  readonly asOf: number | null;
  /** A copy not read off this device yet: `rows` is `null` for now, not for want of a copy. */
  readonly pending?: boolean;
  /**
   * The device is not online now, or its copy has not been brought up to date
   * for a while ({@link stale}): its rows are shown at rest (nothing running,
   * nothing asking), and its unread messages stay on its panel and in the
   * ledger but are left out of the tab title and the app badge
   * ({@link unreadAcross}) — they cannot be read away until it is back.
   */
  readonly away?: boolean;
  /** The device says it is online, but its copy is older than its heartbeat allows: shown as of when it is. */
  readonly stale?: boolean;
}

/** Why a row is in the ledger. */
export type LedgerKind = "asking" | "unread" | "working";

/** The ledger's order: what only you can unblock, then what you have not read, then what is under way. */
export const LEDGER_ORDER: readonly LedgerKind[] = ["asking", "unread", "working"];

/** Why `row` needs you, if it does. */
export function ledgerKind(row: SessionSummary): LedgerKind | null {
  if (row.scope === "external") return null;
  const badge = activityBadge(row);
  if (badge.kind === "asking") return "asking";
  if (unreadCountOf(row) > 0) return "unread";
  if (badge.kind === "working" || badge.kind === "queued") return "working";
  return null;
}

/** A session that needs you, on its device. */
export interface LedgerEntry {
  /** `sessionKey(ref)`: unique across devices. */
  readonly key: string;
  readonly ref: SessionRef;
  readonly row: SessionSummary;
  readonly kind: LedgerKind;
  readonly unread: number;
  /** Since when it has needed you (ms): the question's turn, the newest unread message, the turn's start. */
  readonly at: number;
  /** Whether it was read off the device itself or off its copy. */
  readonly from: DeviceSessions["from"];
}

/** A device's sessions at a glance: the list's own folder counts, and how many sessions there are. */
export interface DeviceAttention extends GroupAttention {
  readonly sessions: number;
}

export interface NeedsYou {
  /** In {@link LEDGER_ORDER}, newest first within each. */
  readonly entries: readonly LedgerEntry[];
  readonly asking: number;
  /** Unread messages, summed over every device: the tab title's and the app badge's number. */
  readonly unread: number;
  /** Sessions with a turn in flight or a queue. */
  readonly working: number;
  /** Per device (every list given, with or without rows). */
  readonly byMachine: ReadonlyMap<MachineKey, DeviceAttention>;
}

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** Since when `row` has needed you for `kind`. */
function needingSince(row: SessionSummary, kind: LedgerKind): number {
  if (kind === "unread") return time(row.attentionAt) || time(row.updatedAt);
  if (kind === "working") return time(residentOf(row)?.turnStartedAt as string | null | undefined) || time(row.updatedAt);
  return time(row.updatedAt);
}

interface Share {
  entries: LedgerEntry[];
  attention: DeviceAttention;
}

const EMPTY_ATTENTION: DeviceAttention = { working: 0, asking: 0, unread: 0, strongest: "idle", sessions: 0 };

/** Per rows array and device: rows are replaced when they change, so this is computed once per change. */
const shares = new WeakMap<readonly SessionSummary[], Map<string, Share>>();

function shareOf(list: DeviceSessions): Share {
  const rows = list.rows;
  if (!rows) return { entries: [], attention: EMPTY_ATTENTION };
  const tag = `${list.machine}\u0000${list.from}`;
  let held = shares.get(rows);
  const hit = held?.get(tag);
  if (hit) return hit;
  const shown = rows.filter((row) => row.scope !== "external");
  const entries: LedgerEntry[] = [];
  for (const row of shown) {
    const kind = ledgerKind(row);
    if (!kind) continue;
    const ref: SessionRef = { machine: list.machine, source: row.source, id: row.id };
    entries.push({ key: sessionKey(ref), ref, row, kind, unread: unreadCountOf(row), at: needingSince(row, kind), from: list.from });
  }
  const share: Share = { entries, attention: { ...groupAttention(shown), sessions: shown.length } };
  if (!held) {
    held = new Map();
    shares.set(rows, held);
  }
  held.set(tag, share);
  return share;
}

/** {@link LEDGER_ORDER}, then the newest first, then a stable tie-break. */
export function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  return LEDGER_ORDER.indexOf(a.kind) - LEDGER_ORDER.indexOf(b.kind) || b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** What needs you across `lists` (one per device). */
export function needsYou(lists: readonly DeviceSessions[]): NeedsYou {
  const entries: LedgerEntry[] = [];
  const byMachine = new Map<MachineKey, DeviceAttention>();
  let asking = 0;
  let unread = 0;
  let working = 0;
  for (const list of lists) {
    const share = shareOf(list);
    entries.push(...share.entries);
    byMachine.set(list.machine, share.attention);
    asking += share.attention.asking;
    unread += share.attention.unread;
    working += share.attention.working;
  }
  entries.sort(compareEntries);
  return { entries, asking, unread, working, byMachine };
}

/**
 * Unread messages across `lists`: what the tab title and the app badge say.
 *
 * Only devices that are up count here. A device away (offline, unknown, or
 * on a copy gone stale) keeps its unread on its panel and in the ledger, but
 * nothing read on this page can bring its number down until it is back — a
 * laptop left shut in a drawer must not hold the badge at `(N)` for good.
 */
export function unreadAcross(lists: readonly DeviceSessions[]): number {
  let total = 0;
  for (const list of lists) if (!list.away) total += shareOf(list).attention.unread;
  return total;
}

/**
 * The sessions of one device to show first: those asking you, then the rest
 * newest first — at most `n`, and only those the list shows.
 */
export function recentSessions(rows: readonly SessionSummary[] | null, n: number): SessionSummary[] {
  if (!rows || n <= 0) return [];
  const shown = rows.filter((row) => row.scope !== "external");
  const asking = shown.filter((row) => activityBadge(row).kind === "asking");
  const rest = shown.filter((row) => activityBadge(row).kind !== "asking");
  rest.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  return [...asking, ...rest].slice(0, n);
}
