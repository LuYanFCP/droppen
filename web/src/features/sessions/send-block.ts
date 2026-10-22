import type { components } from "@/api/schema";

type SessionScope = components["schemas"]["SessionScope"];

/** What the composer shows instead of an input when a session is not ours. */
export interface ExternalSendBlock {
  /** The server's own sentence, or `null` when neither source carried one. */
  reason: string | null;
}

/**
 * Whether the composer is blocked on ownership, and what to say about it.
 *
 * Two ways to learn a session is not this server's, and they must end in the
 * same place: the state frame said so, or a send lost the race and came back
 * with `external_session`. A refusal is a snapshot of a moment rather than a
 * state, so the caller has to drop it once the session is ours again — see the
 * reset in `Composer`. Passing a spent refusal here would keep the block up
 * over a session that can now be sent to.
 */
export function externalSendBlock(input: {
  scope: SessionScope;
  /** The state frame's reason, meaningful only while that frame says external. */
  sendBlockReason: string | null;
  /** The last send's `external_session` refusal, or `null` when there was none. */
  refusal: { hint: string | null } | null;
}): ExternalSendBlock | null {
  const stated = input.scope === "external";
  if (!stated && input.refusal === null) return null;
  return {
    reason: (stated ? input.sendBlockReason : null) ?? input.refusal?.hint ?? null,
  };
}
