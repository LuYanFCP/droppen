/**
 * What a session wants from you, at a glance: the one decision every surface
 * that shows a session — a list row, a folder heading, a pane frame, a screen's
 * rail icon, the browser tab — draws from.
 *
 * Two independent facts, kept apart on purpose:
 *
 * * **activity** — is it working, holding a queue, minding background work, or
 *   stopped on a question only you can answer ([`activityBadge`]). A turn
 *   that simply finished is none of these: it is idle, and draws nothing;
 * * **unread** — how many of the agent's messages you have not seen yet
 *   (`unreadCount`, counted by the server against your read marker).
 *
 * A working session can hold three unread answers, so the count is never
 * folded into the activity. Where only one thing fits — the coloured edge of a
 * row, a pane's border — the strongest of them wins, in the order of
 * [`ATTENTION_ORDER`].
 *
 * Pure, and free of React, so every rule here is a test away.
 */
import type { components } from "@/api/schema";
import type { PaneNode } from "@/app/pane-tree";
import { formatElapsed } from "@/lib/format";
import { sessionKey, type MachineKey, type SessionRef } from "@/lib/machines/key";
import { activityBadge, residentOf, type ActivityRow } from "./session-activity";

type SessionSummary = components["schemas"]["SessionSummary"];

/** The server caps a session's count here; the UI says `99+` from here up. */
export const UNREAD_CAP = 99;

/**
 * The single state a row is drawn in where only one fits.
 *
 * `asking` is the agent blocked on a question — the one state that needs you.
 * `working` covers a queue too: a turn that ended with your next message
 * already waiting is not finished. Background work ranks below unread: it
 * needs nothing from you, and must not hide an answer that does.
 */
export type AttentionState = "asking" | "working" | "unread" | "background" | "idle";

/** Strongest first. */
export const ATTENTION_ORDER: readonly AttentionState[] = ["asking", "working", "unread", "background", "idle"];

/** What the helpers here read off a row: its activity, and its unread facts. */
export type AttentionRow = ActivityRow & Partial<Pick<SessionSummary, "unread" | "unreadCount">>;

/**
 * How many messages the row holds that you have not read.
 *
 * A server one version behind sends only the `unread` flag; it reads as one,
 * which is the most that flag can honestly claim.
 */
export function unreadCountOf(row: AttentionRow): number {
  const count = row.unreadCount as number | undefined;
  if (typeof count === "number" && Number.isFinite(count)) return Math.max(0, Math.floor(count));
  return row.unread ? 1 : 0;
}

/** The strongest state a row is in. */
export function attentionState(row: AttentionRow): AttentionState {
  const badge = activityBadge(row);
  if (badge.kind === "asking") return "asking";
  if (badge.kind === "working" || badge.kind === "queued") return "working";
  if (unreadCountOf(row) > 0) return "unread";
  if (badge.kind === "background") return "background";
  return "idle";
}

/** The strongest of several states; `idle` for none. */
export function strongestState(states: Iterable<AttentionState>): AttentionState {
  let best = ATTENTION_ORDER.length - 1;
  for (const state of states) best = Math.min(best, ATTENTION_ORDER.indexOf(state));
  return ATTENTION_ORDER[best]!;
}

/** A count as a pill says it: nothing for none, `99+` at the cap and over. */
export function formatUnread(count: number): string {
  if (count <= 0) return "";
  return count >= UNREAD_CAP ? `${UNREAD_CAP}+` : String(count);
}

/**
 * The activity chip a list row draws, or null for a row with nothing going on.
 *
 * `label` is the English source string, which is also the i18n key; `detail`
 * is the part that is not translated — a duration or a count.
 */
export interface ActivityChip {
  kind: "asking" | "working" | "queued" | "background";
  label: string;
  detail: string | null;
}

/**
 * What a row's activity chip says.
 *
 * `now` is passed in rather than read, so the duration is testable and a
 * caller on a ticker re-renders it.
 */
export function activityChip(row: AttentionRow, now: number = Date.now()): ActivityChip | null {
  const badge = activityBadge(row);
  switch (badge.kind) {
    case "asking":
      return { kind: "asking", label: "asking you", detail: null };
    case "working": {
      // How long this turn has run, when the resident says when it began.
      // A turn under a minute says nothing rather than `<1m`: the dot already
      // says it has just started. A queue behind the turn is `+n`, as before.
      const since = (residentOf(row)?.turnStartedAt as string | null | undefined) ?? null;
      const elapsed = since ? formatElapsed(since, now) : "";
      const parts = [elapsed && elapsed !== "<1m" ? elapsed : null, badge.queued > 0 ? `+${badge.queued}` : null].filter(
        (part): part is string => part !== null,
      );
      return { kind: "working", label: "working", detail: parts.length ? parts.join(" · ") : null };
    }
    case "queued":
      return { kind: "queued", label: "queued", detail: badge.queued > 0 ? String(badge.queued) : null };
    case "background":
      return { kind: "background", label: "background", detail: badge.background > 0 ? String(badge.background) : null };
    default:
      return null;
  }
}

/**
 * The chip's whole text, through a translator: `工作中 · 3m`, `排队 2`,
 * `后台 3`, `在问你`.
 */
export function chipText(chip: ActivityChip, translate: (key: string) => string = (key) => key): string {
  const label = translate(chip.label);
  if (!chip.detail) return label;
  return chip.kind === "working" ? `${label} · ${chip.detail}` : `${label} ${chip.detail}`;
}

/** What a folder heading says about the sessions inside it. */
export interface GroupAttention {
  /** Sessions with a turn in flight or a queue (the green ones). */
  working: number;
  /** Sessions stopped on a question for you (the amber ones). */
  asking: number;
  /** Unread messages, summed over every session inside. */
  unread: number;
  /** The strongest state inside, for the heading's own edge. */
  strongest: AttentionState;
}

export function groupAttention(rows: readonly AttentionRow[]): GroupAttention {
  let working = 0;
  let asking = 0;
  let unread = 0;
  const states: AttentionState[] = [];
  for (const row of rows) {
    const state = attentionState(row);
    states.push(state);
    if (state === "working") working++;
    if (state === "asking") asking++;
    unread += unreadCountOf(row);
  }
  return { working, asking, unread, strongest: strongestState(states) };
}

/**
 * How a pane showing a session is framed.
 *
 * Background work does not colour a frame — it is calm by design — so a pane
 * is one of four things. Unread only counts as long as you are not already
 * reading it: a pane that has focus and is scrolled to the newest message *is*
 * being read (and the seen report is on its way), so it shows nothing even
 * before the server's zero arrives.
 */
export interface PaneAttention {
  state: "asking" | "working" | "unread" | "idle";
  /** The count for the pane's header; zero while the pane is being read. */
  unread: number;
}

export const PANE_IDLE: PaneAttention = { state: "idle", unread: 0 };

export function paneAttention(input: {
  row: AttentionRow | null | undefined;
  /** The pane has focus (or is the only one) and its screen is showing. */
  focused: boolean;
  /** Its transcript is scrolled to the newest message. */
  atBottom: boolean;
}): PaneAttention {
  const { row, focused, atBottom } = input;
  if (!row) return PANE_IDLE;
  const reading = focused && atBottom;
  const unread = reading ? 0 : unreadCountOf(row);
  const badge = activityBadge(row);
  if (badge.kind === "asking") return { state: "asking", unread };
  if (badge.kind === "working" || badge.kind === "queued") return { state: "working", unread };
  if (unread > 0) return { state: "unread", unread };
  return { state: "idle", unread: 0 };
}

/**
 * Every session a pane layout of `machine` shows, in pane order, each once — a
 * session open in two panes of one screen is still one session's worth of
 * unread. (A pane does not name a machine of its own yet; it is the screen's.)
 */
export function sessionsInLayout(node: PaneNode | null | undefined, machine: MachineKey): SessionRef[] {
  const seen = new Set<string>();
  const out: SessionRef[] = [];
  const walk = (at: PaneNode | null | undefined) => {
    if (!at) return;
    if (at.type === "split") {
      walk(at.children[0]);
      walk(at.children[1]);
      return;
    }
    if (at.content.kind !== "session") return;
    const ref: SessionRef = { machine, source: at.content.source, id: at.content.id };
    if (seen.has(sessionKey(ref))) return;
    seen.add(sessionKey(ref));
    out.push(ref);
  };
  walk(node);
  return out;
}

/** What a screen's rail icon says about the panes on it. */
export interface ScreenAttention {
  working: boolean;
  /** How many of its sessions are stopped on a question for you. */
  asking: number;
  unread: number;
}

export function screenAttention(rows: readonly (AttentionRow | null | undefined)[]): ScreenAttention {
  let working = false;
  let asking = 0;
  let unread = 0;
  for (const row of rows) {
    if (!row) continue;
    const kind = activityBadge(row).kind;
    if (kind === "working" || kind === "queued") working = true;
    if (kind === "asking") asking++;
    unread += unreadCountOf(row);
  }
  return { working, asking, unread };
}

/**
 * Unread messages across the sessions the sidebar lists.
 *
 * Owned only, like the sidebar: the feed also carries every transcript this
 * machine has ever seen, and a never-opened terminal session would otherwise
 * put a permanent `99+` in the tab for a list that does not even show it.
 */
export function totalUnread(rows: readonly (AttentionRow & Partial<Pick<SessionSummary, "scope">>)[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.scope === "external") continue;
    total += unreadCountOf(row);
  }
  return total;
}

/** A row as it reads while somebody is reading it: nothing unread. */
const readCopies = new WeakMap<SessionSummary, SessionSummary>();

/**
 * The feed's rows with every session that is being read *right now* showing
 * nothing unread — an optimistic local read.
 *
 * The count is the server's and is not suppressed while a turn runs, so a
 * session being watched as it works would otherwise flash `1` — a pill, a bold
 * title, `(1)` in the tab, a folder and a rail badge — on every answer, for the
 * round trip it takes the seen report to come back as `0`. Being read is
 * judged by the reader exactly as the seen report judges it (`useReportSeen`),
 * so the two cannot disagree for longer than that round trip.
 *
 * Identity is kept wherever it can be: an untouched row is the same object, a
 * read row is the same copy for as long as its source row is unchanged, and
 * with nothing to change the input array itself comes back — the feed's
 * selectors compare by `Object.is`, and a fresh object per call would wake
 * every one of them.
 */
export function readLocally(rows: SessionSummary[], reading: ReadonlySet<string>, machine: MachineKey): SessionSummary[] {
  if (reading.size === 0) return rows;
  let changed = false;
  const out = rows.map((row) => {
    if (!reading.has(sessionKey({ machine, source: row.source, id: row.id })) || (unreadCountOf(row) === 0 && !row.unread)) return row;
    changed = true;
    let copy = readCopies.get(row);
    if (!copy) {
      copy = { ...row, unread: false, unreadCount: 0 };
      readCopies.set(row, copy);
    }
    return copy;
  });
  return changed ? out : rows;
}

/** The browser tab's title: `(3) Droppen`, and just the name when all is read. */
export function tabTitle(base: string, unread: number): string {
  const bare = stripTabCount(base);
  return unread > 0 ? `(${formatUnread(unread)}) ${bare}` : bare;
}

/** A title without a count this module put in front of it. */
export function stripTabCount(title: string): string {
  return title.replace(/^\(\d+\+?\) /, "");
}
