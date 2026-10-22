import type { components } from "@/api/schema";
import { formatExactTime } from "@/lib/format";
import type { MachineKey } from "@/lib/machines/key";
import { mq } from "@/lib/machines/query";

/**
 * Accounts resting after a CLI turn under them hit a quota, rate or credential
 * limit, as the server reports them. Phase 1 only *shows* them: nothing here
 * decides what a session runs under.
 *
 * Kept free of React so the rules — which rest a session is affected by, how a
 * rest reads in one line — are pinned by plain tests.
 */

export type AccountRest = components["schemas"]["AccountRest"];
export type AccountLimitEvent = components["schemas"]["AccountLimitEvent"];
/** What kind of limit a rest came from; indexed so no schema name is assumed. */
export type RestClass = AccountRest["class"];

/** Anything that turns an English key into the current language. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Shared query key for a machine's limit log, so the panel and a clear can share it. */
export const limitEventsKey = (machine: MachineKey) => mq(machine, "account-limit-events");

/** The scope a rest uses to cover every model. */
export const REST_SCOPE_ALL = "all";

/**
 * The family a model id belongs to, the way the server spells a rest's scope:
 * the first of `fable`, `opus`, `sonnet`, `haiku` the id contains, otherwise
 * the id itself. Mirrors the server so a rest scoped to `opus` matches
 * `claude-opus-4-1[1m]` here exactly as it does there.
 */
export function modelFamily(model: string): string {
  const lower = model.toLowerCase();
  for (const family of ["fable", "opus", "sonnet", "haiku"]) {
    if (lower.includes(family)) return family;
  }
  return model;
}

/**
 * Whether a rest covers a turn on this model. `all` covers everything; any
 * other scope is a family or a raw id, and a session whose model is not known
 * yet is only covered by `all` — claiming more would be a guess.
 */
export function restAppliesToModel(rest: Pick<AccountRest, "scope">, model: string | null | undefined): boolean {
  if (rest.scope === REST_SCOPE_ALL) return true;
  if (!model) return false;
  const scope = rest.scope.toLowerCase();
  return scope === modelFamily(model).toLowerCase() || scope === model.toLowerCase();
}

/**
 * Whether a rest is still running. The server lists active rests only, but a
 * cached list can outlive one, and a chip that says "resumes 02:30" at 02:45
 * is wrong. A rest with no end lasts until someone clears it.
 */
export function restIsActive(rest: Pick<AccountRest, "untilAt">, now: number = Date.now()): boolean {
  if (rest.untilAt === null) return true;
  const until = Date.parse(rest.untilAt);
  return Number.isNaN(until) || until > now;
}

/**
 * An account's active rests. `?? []` for the window where a new web build talks
 * to a server that has no rest field yet.
 */
export function activeRests(account: { rest?: AccountRest[] } | undefined, now: number = Date.now()): AccountRest[] {
  return (account?.rest ?? []).filter((rest) => restIsActive(rest, now));
}

/**
 * The rest that affects a session on this model, if any: the first active one
 * whose scope is `all` or the model's own family. A rest on a model the session
 * is not using says nothing about the session.
 */
export function sessionRest(
  account: { rest?: AccountRest[] } | undefined,
  model: string | null | undefined,
  now: number = Date.now(),
): AccountRest | null {
  return activeRests(account, now).find((rest) => restAppliesToModel(rest, model)) ?? null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * When a rest ends, as a clock reading: `HH:mm` today, `M/D HH:mm` on any other
 * day. Local time, 24-hour, and deliberately locale-free so it is as short in
 * Japanese as in English. Empty for a missing or unreadable instant.
 */
export function formatRestUntil(untilAt: string | null, now: number = Date.now()): string {
  if (!untilAt) return "";
  const at = new Date(untilAt);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date(now);
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay ? clock : `${at.getMonth() + 1}/${at.getDate()} ${clock}`;
}

/** English keys for each class; the components translate them. */
export const REST_CLASS_KEY: Record<RestClass, string> = {
  session: "session limit",
  weekly: "weekly limit",
  rate: "rate limited",
  credit: "out of credit",
  auth: "credential invalid",
  other: "limit hit",
};

/**
 * Chip colours per class: a quota or credit rest is a real wait (amber), a
 * credential rest needs a person (red), a rate limit or an unclassified one is
 * usually over in minutes (muted).
 */
export function restTone(klass: RestClass): string {
  switch (klass) {
    case "session":
    case "weekly":
    case "credit":
      return "bg-warn/15 text-warn-fg";
    case "auth":
      return "bg-danger/15 text-danger";
    default:
      return "bg-raised text-muted";
  }
}

/** `opus weekly limit` — the class, prefixed with the scope unless it is `all`. */
export function restLabel(rest: Pick<AccountRest, "class" | "scope">, t: Translate): string {
  const label = t(REST_CLASS_KEY[rest.class] ?? REST_CLASS_KEY.other);
  return rest.scope === REST_SCOPE_ALL ? label : `${rest.scope} ${label}`;
}

/**
 * When a rest ends, in the words the chip uses. A rate limit is minutes long,
 * so it says how many; anything else says the clock time it resumes; a rest
 * with no end says what ends it.
 */
export function restUntilText(
  rest: Pick<AccountRest, "class" | "untilAt">,
  t: Translate,
  now: number = Date.now(),
): string {
  if (rest.untilAt === null || Number.isNaN(Date.parse(rest.untilAt))) {
    return rest.class === "auth" ? t("re-authorize needed") : t("until cleared");
  }
  const left = Date.parse(rest.untilAt) - now;
  if (rest.class === "rate" && left < 60 * 60_000) {
    return t("{{n}} min", { n: Math.max(1, Math.ceil(left / 60_000)) });
  }
  return t("resumes {{at}}", { at: formatRestUntil(rest.untilAt, now) });
}

/** The whole chip: `session limit · resumes 02:30`, `rate limited · 1 min`. */
export function restChipText(
  rest: Pick<AccountRest, "class" | "scope" | "untilAt">,
  t: Translate,
  now: number = Date.now(),
): string {
  return `${restLabel(rest, t)} · ${restUntilText(rest, t, now)}`;
}

/** The hover text: the server's reason, then where and when it was seen. */
export function restTitle(rest: Pick<AccountRest, "reason" | "sessionId" | "observedAt">, t: Translate): string {
  const lines = [rest.reason];
  if (rest.sessionId) lines.push(t("session: {{id}}", { id: rest.sessionId }));
  lines.push(t("observed: {{at}}", { at: formatExactTime(rest.observedAt) || rest.observedAt }));
  return lines.join("\n");
}
