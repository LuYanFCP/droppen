// Phase 1 of account rotation only shows which accounts are resting after a
// limit. What it shows is decided here: which family a model id belongs to
// (mirroring the server's rule, or a scoped rest silently misses its session),
// whether a rest concerns a session at all, how one reads in a chip, and the
// clock the chip prints.
import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRests,
  formatRestUntil,
  modelFamily,
  restAppliesToModel,
  restChipText,
  restTone,
  sessionRest,
  type AccountRest,
  type Translate,
} from "../src/features/accounts/account-rest.js";

// Keys come back untranslated, with their variables filled in, so the
// assertions read as the English UI does.
const t: Translate = (key, vars) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ""));

const NOW = new Date(2026, 8, 25, 10, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

function rest(over: Partial<AccountRest> = {}): AccountRest {
  return {
    scope: "all",
    class: "session",
    untilAt: at(2026, 9, 25, 14, 30),
    reason: "You've hit your session limit · resets 2:30pm",
    observedAt: at(2026, 9, 25, 9, 55),
    sessionId: "s-1",
    source: "claude",
    ...over,
  };
}

test("modelFamily maps a model id to its family the way the server does", () => {
  assert.equal(modelFamily("claude-fable-5-1"), "fable");
  assert.equal(modelFamily("claude-opus-4-1[1m]"), "opus");
  assert.equal(modelFamily("opus"), "opus");
  assert.equal(modelFamily("claude-sonnet-4-5-20250929"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5"), "haiku");
  // Anything else is its own scope, spelled exactly as given.
  assert.equal(modelFamily("gpt-5-codex"), "gpt-5-codex");
  assert.equal(modelFamily("glm-4.6"), "glm-4.6");
});

test("a rest scoped to all applies to every session, known model or not", () => {
  assert.equal(restAppliesToModel(rest({ scope: "all" }), "claude-sonnet-4-5"), true);
  assert.equal(restAppliesToModel(rest({ scope: "all" }), null), true);
});

test("a family-scoped rest applies only to sessions on that family", () => {
  const opus = rest({ scope: "opus", class: "weekly" });
  assert.equal(restAppliesToModel(opus, "claude-opus-4-1"), true);
  assert.equal(restAppliesToModel(opus, "claude-sonnet-4-5"), false);
  // A session whose model is not known yet is not claimed by a scoped rest.
  assert.equal(restAppliesToModel(opus, null), false);
  assert.equal(restAppliesToModel(opus, undefined), false);
});

test("a raw-id scope applies to that exact model", () => {
  const glm = rest({ scope: "glm-4.6", class: "rate" });
  assert.equal(restAppliesToModel(glm, "glm-4.6"), true);
  assert.equal(restAppliesToModel(glm, "glm-4.5"), false);
});

test("sessionRest picks the rest that concerns the session's model and skips expired ones", () => {
  const opusWeekly = rest({ scope: "opus", class: "weekly", untilAt: at(2026, 9, 28, 15, 0) });
  const expired = rest({ scope: "all", untilAt: at(2026, 9, 25, 9, 0) });
  const account = { rest: [expired, opusWeekly] };
  assert.equal(sessionRest(account, "claude-opus-4-1", NOW), opusWeekly);
  assert.equal(sessionRest(account, "claude-sonnet-4-5", NOW), null);
  assert.deepEqual(activeRests(account, NOW), [opusWeekly]);
  // An account from a server with no rest field, and no account at all.
  assert.equal(sessionRest({}, "claude-opus-4-1", NOW), null);
  assert.equal(sessionRest(undefined, "claude-opus-4-1", NOW), null);
  // A rest with no end lasts until it is cleared.
  assert.equal(activeRests({ rest: [rest({ class: "auth", untilAt: null })] }, NOW).length, 1);
});

test("formatRestUntil prints HH:mm today and M/D HH:mm on any other day", () => {
  assert.equal(formatRestUntil(at(2026, 9, 25, 14, 30), NOW), "14:30");
  assert.equal(formatRestUntil(at(2026, 9, 25, 2, 5), NOW), "02:05");
  assert.equal(formatRestUntil(at(2026, 9, 28, 15, 0), NOW), "9/28 15:00");
  assert.equal(formatRestUntil(at(2026, 10, 1, 0, 0), NOW), "10/1 00:00");
  assert.equal(formatRestUntil(null, NOW), "");
  assert.equal(formatRestUntil("not a date", NOW), "");
});

test("chip text per class", () => {
  assert.equal(restChipText(rest({ class: "session" }), t, NOW), "session limit · resumes 14:30");
  assert.equal(
    restChipText(rest({ class: "weekly", scope: "opus", untilAt: at(2026, 9, 28, 15, 0) }), t, NOW),
    "opus weekly limit · resumes 9/28 15:00",
  );
  assert.equal(restChipText(rest({ class: "credit" }), t, NOW), "out of credit · resumes 14:30");
  assert.equal(restChipText(rest({ class: "auth", untilAt: null }), t, NOW), "credential invalid · re-authorize needed");
  // A rate limit is minutes long, so it says how many, rounded up.
  assert.equal(
    restChipText(rest({ class: "rate", untilAt: new Date(NOW + 45_000).toISOString() }), t, NOW),
    "rate limited · 1 min",
  );
  assert.equal(
    restChipText(rest({ class: "rate", untilAt: new Date(NOW + 12 * 60_000 + 1).toISOString() }), t, NOW),
    "rate limited · 13 min",
  );
  assert.equal(restChipText(rest({ class: "other", untilAt: null }), t, NOW), "limit hit · until cleared");
});

test("chip tone per class", () => {
  for (const klass of ["session", "weekly", "credit"] as const) assert.match(restTone(klass), /warn/);
  assert.match(restTone("auth"), /danger/);
  assert.match(restTone("rate"), /muted/);
  assert.match(restTone("other"), /muted/);
});
