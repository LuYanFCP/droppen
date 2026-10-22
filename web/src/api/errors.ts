import i18next from "i18next";

/**
 * The refusals a client is meant to act on carry more than a sentence.
 *
 * `POST .../message` on somebody else's session answers `external_session` with
 * a `hint`; binding an account to a local session answers
 * `local_session_cannot_use_account` the same way. The generated schema
 * only knows about `error`, so the extra fields are read defensively here and
 * handed to the UI as one object instead of being re-parsed at each call site.
 */
export class ApiError extends Error {
  /** The machine-readable token; stable across wording changes. */
  readonly code: string;
  /** The server's own sentence for the user, when it wrote one. */
  readonly hint: string | null;
  /**
   * The whole error body, for the one route that sends something only its own
   * caller knows how to read — a `409 question_settled` carries the question
   * as the winner left it. Read through a helper next to that caller (see
   * `settledQuestionOf`), never at large: everything common is a field above.
   */
  readonly body: Readonly<Record<string, unknown>>;

  constructor(body: unknown) {
    const record = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const code = typeof record.error === "string" ? record.error : "request failed";
    // The bare token stays the message so existing error displays are unchanged.
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.hint = typeof record.hint === "string" ? record.hint : null;
    this.body = record;
  }
}

/** A send refused because the session belongs to another server. */
export const EXTERNAL_SESSION = "external_session";

/**
 * A message (or a new session's first) refused because one of its
 * attachments is no longer on the device — swept with the old uploads, or a
 * draft's kept past that. The words are the client's, in the user's language.
 */
export const ATTACHMENT_MISSING = "attachment_missing";

/**
 * A computer's refusal of a route that manages it, asked over the channel
 * (chain v3, local-aggregator §5.4), in words — `null` for anything else:
 * 403 `limited_device` (this device is a limited device, not chain v3's
 * admin) and 412 `stale`. A stale view is one no full device vouched for
 * lately; one this device has seen more of than the computer
 * (`reason: "behind"`) wants a sync, and one that conflicts with this
 * device's (`"fork"`) is not staleness at all — neither is helped by
 * vouching again.
 */
export function hostRefusalText(code: string | null | undefined, body?: unknown): string | null {
  // The key itself where no translation is set up (it is the English).
  const t = (key: string): string => (i18next.isInitialized ? i18next.t(key) : key) || key;
  if (code === "limited_device") return t("a limited device cannot do this: do it from a full device");
  if (code !== "stale") return null;
  const reason = body !== null && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
  if (reason === "behind") return t("this device has seen more of the account than the device it reaches: sync, then try again");
  if (reason === "fork") return t("the other device's view of the account conflicts with this device's");
  return t("no full device of yours has confirmed the other device's view of the account in the last 12 hours: open Droppen on one, then try again");
}

/** What to show a user: the server's sentence when it wrote one, else the code. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.code === ATTACHMENT_MISSING) {
    const said = "an attachment is no longer on this device; attach it again";
    return (i18next.isInitialized ? i18next.t(said) : said) || said;
  }
  if (error instanceof ApiError) return hostRefusalText(error.code, error.body) ?? error.hint ?? error.code;
  return error instanceof Error ? error.message : String(error);
}
