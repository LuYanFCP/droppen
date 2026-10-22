// When the server moves a session off an account that hit a limit, the session
// view says so: a composer notice for a day, and a marker on the header's
// account name while the session is still on the account it was moved to. What
// each outcome reads as, how long a rotation counts as news, and when the
// header marks the account are decided here.
import assert from "node:assert/strict";
import test from "node:test";
import type { Translate } from "../src/features/accounts/account-rest.js";
import {
  accountRefName,
  aheadPercentText,
  aheadWindowLabel,
  ROTATION_NOTICE_WINDOW_MS,
  rotationDismissed,
  rotationDismissName,
  rotationIsRecent,
  rotationMarkerShown,
  rotationMarkerTitle,
  rotationNotice,
  rotationUntilText,
  rotationWasAhead,
  type SessionRotation,
} from "../src/features/accounts/session-rotation.js";
import {
  accountRotationToggleShown,
  withAccount,
  type Account,
  type AccountList,
} from "../src/features/accounts/use-accounts.js";

// Keys come back untranslated, with their variables filled in, so the
// assertions read as the English UI does.
const t: Translate = (key, vars) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ""));

const NOW = new Date(2026, 8, 29, 10, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

function rotation(over: Partial<SessionRotation> = {}): SessionRotation {
  return {
    from: { id: "acct-a", label: "work" },
    to: { id: "acct-b", label: "spare" },
    at: at(2026, 9, 29, 9, 40),
    class: "session",
    scope: "all",
    untilAt: at(2026, 9, 29, 14, 30),
    interruptedTasks: 0,
    outcome: "switched",
    trigger: "limit",
    usedPercent: null,
    ...over,
  };
}

/** A move ahead of the five-hour window, at 96 %, resetting at 14:30. */
function ahead(over: Partial<SessionRotation> = {}): SessionRotation {
  return rotation({ trigger: "ahead", usedPercent: 96.4, ...over });
}

test("a switch reads calmly, naming both accounts, the limit and when it lifts", () => {
  const notice = rotationNotice(rotation(), t, NOW);
  assert.equal(notice?.tone, "info");
  assert.equal(notice?.text, "switched automatically from work to spare · work: session limit, resumes 14:30");
  assert.equal(notice?.title, "work: session limit · 09:40");
});

test("a switch that cut background subtasks short says how many", () => {
  const notice = rotationNotice(rotation({ interruptedTasks: 2 }), t, NOW);
  assert.equal(
    notice?.text,
    "switched automatically from work to spare · work: session limit, resumes 14:30 · 2 background subtasks were interrupted",
  );
});

test("a model-scoped limit carries its family, as the rest chip does", () => {
  const notice = rotationNotice(rotation({ class: "weekly", scope: "opus", untilAt: at(2026, 10, 2, 9, 0) }), t, NOW);
  assert.equal(notice?.text, "switched automatically from work to spare · work: opus weekly limit, resumes 10/2 09:00");
});

test("no free account is a warning with the old account's end time", () => {
  const notice = rotationNotice(rotation({ outcome: "no_candidate" }), t, NOW);
  assert.equal(notice?.tone, "warn");
  assert.equal(notice?.text, "work ran out and no account is free to switch to · resumes 14:30");
});

test("running out of attempts is a warning that says it paused", () => {
  const notice = rotationNotice(rotation({ outcome: "cap_reached" }), t, NOW);
  assert.equal(notice?.tone, "warn");
  assert.equal(notice?.text, "still failing after 3 switches in a row, so it has paused · resumes 14:30");
});

test("a limit with no known end says what ends it instead of a time", () => {
  assert.equal(
    rotationNotice(rotation({ untilAt: null }), t, NOW)?.text,
    "switched automatically from work to spare · work: session limit, until cleared",
  );
  assert.equal(
    rotationNotice(rotation({ outcome: "no_candidate", class: "auth", untilAt: null }), t, NOW)?.text,
    "work ran out and no account is free to switch to · re-authorize needed",
  );
});

test("a rate limit still running reads in minutes; one already over reads as its clock time", () => {
  const rate = rotation({ class: "rate", untilAt: new Date(NOW + 4 * 60_000).toISOString() });
  assert.equal(rotationUntilText(rate, t, NOW), "4 min");
  // The notice outlives the limit it reports; "1 min" of something that ended
  // an hour ago would be wrong.
  const over = rotation({ class: "rate", untilAt: at(2026, 9, 29, 9, 45) });
  assert.equal(rotationUntilText(over, t, NOW), "resumes 09:45");
});

test("an outcome this build does not know earns no notice", () => {
  const unknown = rotation({ outcome: "retried_later" as SessionRotation["outcome"] });
  assert.equal(rotationNotice(unknown, t, NOW), null);
});

test("a missing account ref is named rather than crashing the line", () => {
  assert.equal(accountRefName(null), "?");
  assert.equal(accountRefName({ id: "acct-x", label: "" }), "acct-x");
  assert.equal(rotationNotice(rotation({ to: null }), t, NOW)?.text.startsWith("switched automatically from work to ?"), true);
});

test("a rotation counts as news for 24 hours", () => {
  assert.equal(rotationIsRecent(rotation(), NOW), true);
  assert.equal(rotationIsRecent(rotation({ at: new Date(NOW - ROTATION_NOTICE_WINDOW_MS + 60_000).toISOString() }), NOW), true);
  assert.equal(rotationIsRecent(rotation({ at: new Date(NOW - ROTATION_NOTICE_WINDOW_MS).toISOString() }), NOW), false);
  assert.equal(rotationIsRecent(rotation({ at: at(2026, 9, 27, 10, 0) }), NOW), false);
  // A clock slightly behind the server's is not an old event.
  assert.equal(rotationIsRecent(rotation({ at: new Date(NOW + 30_000).toISOString() }), NOW), true);
  assert.equal(rotationIsRecent(rotation({ at: "not a date" }), NOW), false);
  assert.equal(rotationIsRecent(null, NOW), false);
  assert.equal(rotationIsRecent(undefined, NOW), false);
});

test("a dismissal covers the rotation it closed, and not the next one", () => {
  const first = rotation();
  assert.equal(rotationDismissed(null, first), false);
  assert.equal(rotationDismissed(first.at, first), true);
  assert.equal(rotationDismissed(first.at, rotation({ at: at(2026, 9, 29, 9, 55) })), false);
  // Per session: two sessions never share a dismissal.
  assert.notEqual(rotationDismissName("claude", "s1"), rotationDismissName("claude", "s2"));
});

test("the header marks the account only after a recent switch onto it", () => {
  const moved = rotation();
  assert.equal(rotationMarkerShown(moved, "acct-b", NOW), true);
  // Switched back or onward by hand: the marker would describe another account.
  assert.equal(rotationMarkerShown(moved, "acct-a", NOW), false);
  assert.equal(rotationMarkerShown(moved, null, NOW), false);
  // Only a move that worked moved anything.
  assert.equal(rotationMarkerShown(rotation({ outcome: "no_candidate", to: { id: "acct-b", label: "spare" } }), "acct-b", NOW), false);
  assert.equal(rotationMarkerShown(rotation({ outcome: "cap_reached" }), "acct-b", NOW), false);
  // Old news is not marked.
  assert.equal(rotationMarkerShown(rotation({ at: at(2026, 9, 27, 9, 40) }), "acct-b", NOW), false);
  assert.equal(rotationMarkerShown(null, "acct-b", NOW), false);
  assert.equal(rotationMarkerShown(rotation({ to: null }), "acct-b", NOW), false);
});

test("the header marker's hover says where the session came from and why", () => {
  assert.equal(
    rotationMarkerTitle(rotation(), t, NOW),
    "switched here automatically from work at 09:40 · work: session limit, resumes 14:30",
  );
});

test("a move ahead of the limit reads calmly, with how full the window was and when it resets", () => {
  const notice = rotationNotice(ahead(), t, NOW);
  assert.equal(notice?.tone, "info");
  assert.equal(notice?.text, "switched ahead of the limit from work to spare · work: 5-hour window 96% used, resets 14:30");
  assert.equal(notice?.title, "work: 5-hour window 96% used · 09:40");
});

test("a move ahead names the weekly window, and a family's own", () => {
  assert.equal(
    rotationNotice(ahead({ class: "weekly", scope: "all", usedPercent: 97, untilAt: at(2026, 10, 2, 9, 0) }), t, NOW)?.text,
    "switched ahead of the limit from work to spare · work: weekly window 97% used, resets 10/2 09:00",
  );
  assert.equal(
    rotationNotice(ahead({ class: "weekly", scope: "fable", usedPercent: 95 }), t, NOW)?.text,
    "switched ahead of the limit from work to spare · work: Fable weekly window 95% used, resets 14:30",
  );
  assert.equal(aheadWindowLabel({ class: "session", scope: "all" }, t), "5-hour window");
});

test("a move ahead with no known reset leaves the clause out, and a missing percent is not a number", () => {
  assert.equal(
    rotationNotice(ahead({ untilAt: null }), t, NOW)?.text,
    "switched ahead of the limit from work to spare · work: 5-hour window 96% used",
  );
  assert.equal(aheadPercentText({ usedPercent: null }), "?");
  assert.equal(aheadPercentText({}), "?");
  assert.equal(aheadPercentText({ usedPercent: 100.4 }), "100");
});

test("an ahead outcome this build does not expect earns no notice", () => {
  assert.equal(rotationNotice(ahead({ outcome: "no_candidate" }), t, NOW), null);
});

test("a rotation from a server too old to name its trigger reads as a limit", () => {
  const old = rotation();
  delete (old as Partial<SessionRotation>).trigger;
  assert.equal(rotationWasAhead(old), false);
  assert.equal(rotationNotice(old, t, NOW)?.text, "switched automatically from work to spare · work: session limit, resumes 14:30");
  assert.equal(rotationWasAhead(ahead()), true);
});

test("the header marker says a move ahead was made before the limit", () => {
  assert.equal(rotationMarkerShown(ahead(), "acct-b", NOW), true);
  assert.equal(
    rotationMarkerTitle(ahead(), t, NOW),
    "switched here ahead of the limit from work at 09:40 · work: 5-hour window 96% used, resets 14:30",
  );
  assert.equal(
    rotationMarkerTitle(ahead({ untilAt: null }), t, NOW),
    "switched here ahead of the limit from work at 09:40 · work: 5-hour window 96% used",
  );
});

function account(over: Partial<Account> = {}): Account {
  return {
    id: "acct-a",
    label: "work",
    kind: "oauth_token",
    provider: "claude",
    usageEnabled: true,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    rest: [],
    rotation: true,
    ...over,
  };
}

test("the rotation toggle is offered on claude accounts, env ones included, and never on codex", () => {
  assert.equal(accountRotationToggleShown(account()), true);
  assert.equal(accountRotationToggleShown(account({ kind: "env", rotation: false })), true);
  assert.equal(accountRotationToggleShown(account({ provider: "codex", kind: "env", rotation: false })), false);
  // A server too old to rotate sends no field, and a toggle there does nothing.
  const old = account();
  delete (old as Partial<Account>).rotation;
  assert.equal(accountRotationToggleShown(old), false);
});

test("a toggled account replaces its own entry in the cached list", () => {
  const list: AccountList = {
    accounts: [account(), account({ id: "acct-b", label: "spare" })],
    defaultAccountId: "acct-a",
  } as AccountList;
  const next = withAccount(list, account({ rotation: false }));
  assert.equal(next.accounts[0]?.rotation, false);
  assert.equal(next.accounts[1], list.accounts[1]);
  assert.equal(next.defaultAccountId, "acct-a");
  // An account the list does not hold is left to the next fetch.
  assert.equal(withAccount(list, account({ id: "acct-z" })), list);
});
