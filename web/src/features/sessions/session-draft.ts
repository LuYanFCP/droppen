import type { SessionRef } from "@/lib/machines/key";
import { claimMachineItem, machineStorageKey } from "@/lib/machines/storage";

export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface SessionDraftSnapshot {
  text: string;
  revision: string | null;
  pending: boolean;
}

export interface SubmittedSessionDraft {
  text: string;
  revision: string;
}

interface StoredSessionDraft {
  version: 1;
  text: string;
  revision: string;
}

type DraftListener = (snapshot: SessionDraftSnapshot) => void;

const listeners = new Map<string, Set<DraftListener>>();
const pendingRevisions = new Map<string, string>();
let revisionSequence = 0;

function nextRevision(): string {
  revisionSequence += 1;
  return `${Date.now().toString(36)}-${revisionSequence.toString(36)}`;
}

function decodeSessionDraft(raw: string | null): SessionDraftSnapshot {
  if (raw === null) return { text: "", revision: null, pending: false };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSessionDraft>;
    if (
      parsed.version === 1 &&
      typeof parsed.text === "string" &&
      typeof parsed.revision === "string"
    ) {
      return { text: parsed.text, revision: parsed.revision, pending: false };
    }
  } catch {
    // Drafts written before the versioned format were plain strings.
  }
  return { text: raw, revision: null, pending: false };
}

function notifySessionDraft(key: string, snapshot: SessionDraftSnapshot): void {
  for (const listener of listeners.get(key) ?? []) listener(snapshot);
}

/** What a session's draft is kept under on its machine (`lib/machines/storage.ts`). */
const draftName = (session: SessionRef) => `draft.${session.source}.${session.id}`;

/** The storage key of a session's draft: `rh.draft.<source>.<id>` on the local machine, as it always was. */
export function sessionDraftKey(session: SessionRef): string {
  return machineStorageKey(session.machine, draftName(session));
}

/**
 * When a stored draft was written, from its revision ({@link nextRevision}:
 * `<Date.now() base36>-<seq base36>`). The time is parsed rather than the
 * strings compared, since base36 strings of different lengths do not sort.
 * A draft with no revision — plain text, from before the versioned format —
 * is older than any with one, and one whose revision does not parse is older
 * than any whose does.
 */
function draftWrittenAt(raw: string): number {
  const { revision } = decodeSessionDraft(raw);
  if (revision === null) return -Infinity;
  const time = /^([0-9a-z]+)-[0-9a-z]+$/.exec(revision);
  return time ? parseInt(time[1]!, 36) : 0;
}

/**
 * The newer of the machine's draft (`mine`) and one under the key from before
 * machines had keys (`old`), when a claim finds both (`lib/machines/storage.ts`).
 *
 * Either can be the newer: this build writes straight to the key
 * {@link claimSessionDraft} returned, without claiming again, and a tab still on
 * an older build writes the old key. Both tabs are in one browser, so their
 * clocks agree. A tie stays the machine's. Clearing a draft removes its key
 * ({@link writeSessionDraft}, {@link clearSessionDraft}) rather than storing
 * an empty one, so a draft cleared after the move is not here to compare: an
 * old key found then is text an older tab wrote since, and it is kept.
 */
export function newerSessionDraft(mine: string, old: string): string {
  return draftWrittenAt(old) > draftWrittenAt(mine) ? old : mine;
}

/**
 * {@link sessionDraftKey}, after taking over a draft kept from before
 * machines had keys where that is this machine's to take (droppen.app),
 * keeping the newer of the two when the machine has one too.
 */
export function claimSessionDraft(storage: DraftStorage, session: SessionRef): string {
  return claimMachineItem(storage, session.machine, draftName(session), newerSessionDraft);
}

export function readSessionDraftSnapshot(
  storage: DraftStorage,
  key: string,
): SessionDraftSnapshot {
  try {
    const snapshot = decodeSessionDraft(storage.getItem(key));
    return {
      ...snapshot,
      pending:
        snapshot.revision !== null &&
        pendingRevisions.get(key) === snapshot.revision,
    };
  } catch {
    return { text: "", revision: null, pending: false };
  }
}

export function readSessionDraft(storage: DraftStorage, key: string): string {
  return readSessionDraftSnapshot(storage, key).text;
}

export function writeSessionDraft(
  storage: DraftStorage,
  key: string,
  value: string,
): SessionDraftSnapshot {
  const snapshot: SessionDraftSnapshot = {
    text: value,
    revision: value ? nextRevision() : null,
    pending: false,
  };
  pendingRevisions.delete(key);
  try {
    if (value) {
      const stored: StoredSessionDraft = {
        version: 1,
        text: value,
        revision: snapshot.revision!,
      };
      storage.setItem(key, JSON.stringify(stored));
    } else {
      storage.removeItem(key);
    }
  } catch {
    // storage unavailable: callers keep their in-memory value
  }
  notifySessionDraft(key, snapshot);
  return snapshot;
}

/** Remove only the exact draft revision that was submitted successfully. */
export function clearSessionDraft(
  storage: DraftStorage,
  key: string,
  expectedRevision: string,
): boolean {
  try {
    const current = decodeSessionDraft(storage.getItem(key));
    if (current.revision !== expectedRevision) return false;
    storage.removeItem(key);
    pendingRevisions.delete(key);
    notifySessionDraft(key, { text: "", revision: null, pending: false });
    return true;
  } catch {
    pendingRevisions.delete(key);
    notifySessionDraft(key, { text: "", revision: null, pending: false });
    return false;
  }
}

export function markSessionDraftPending(
  key: string,
  submitted: SubmittedSessionDraft,
): void {
  pendingRevisions.set(key, submitted.revision);
  notifySessionDraft(key, { ...submitted, pending: true });
}

export function restoreSessionDraftAfterFailure(
  storage: DraftStorage,
  key: string,
  submitted: SubmittedSessionDraft,
): boolean {
  if (pendingRevisions.get(key) !== submitted.revision) return false;
  pendingRevisions.delete(key);

  let current: SessionDraftSnapshot;
  try {
    current = decodeSessionDraft(storage.getItem(key));
  } catch {
    current = { ...submitted, pending: false };
  }
  if (current.revision !== submitted.revision) {
    notifySessionDraft(key, current);
    return false;
  }
  notifySessionDraft(key, { ...submitted, pending: false });
  return true;
}

export function subscribeSessionDraft(key: string, listener: DraftListener): () => void {
  const keyListeners = listeners.get(key) ?? new Set<DraftListener>();
  keyListeners.add(listener);
  listeners.set(key, keyListeners);
  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) listeners.delete(key);
  };
}
