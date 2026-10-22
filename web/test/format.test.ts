import assert from "node:assert/strict";
import test from "node:test";
import { durationBetween, formatDuration, formatResetAt, shortenHome } from "../src/lib/format.js";

test("shortenHome replaces the home prefix with a tilde", () => {
  assert.equal(shortenHome("/Users/ada/Projects/x", "/Users/ada"), "~/Projects/x");
  assert.equal(shortenHome("/Users/ada", "/Users/ada"), "~");
});

test("shortenHome leaves paths that only look like the home directory", () => {
  // A sibling whose name starts with the home directory's is not inside it.
  assert.equal(shortenHome("/Users/ada2/x", "/Users/ada"), "/Users/ada2/x");
  assert.equal(shortenHome("/opt/src", "/Users/ada"), "/opt/src");
});

test("shortenHome is a no-op when the server reported no home", () => {
  assert.equal(shortenHome("/opt/src", ""), "/opt/src");
});

test("formatDuration reads at the resolution the span deserves", () => {
  // The three shapes a tool row has to print, including the ninety-two-minute
  // Agent call that used to render as an ordinary line.
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(92_000), "1m32s");
  assert.equal(formatDuration(92 * 60_000), "92m");
  // Whole minutes drop the empty seconds; a negative span cannot happen but
  // must not print a minus sign if it does.
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(-1), "0s");
});

test("durationBetween refuses anything it cannot subtract", () => {
  assert.equal(durationBetween("2026-08-30T04:00:00Z", "2026-08-30T04:00:07Z"), 7000);
  assert.equal(durationBetween(null, "2026-08-30T04:00:07Z"), null);
  assert.equal(durationBetween("2026-08-30T04:00:00Z", null), null);
  assert.equal(durationBetween("nonsense", "2026-08-30T04:00:07Z"), null);
  // A result stamped before its call is a clock problem, not a negative call.
  assert.equal(durationBetween("2026-08-30T04:00:07Z", "2026-08-30T04:00:00Z"), null);
});

// Built from local calendar parts so the today/other-day split is the same
// assertion in every timezone the test might run in.
const NOW = new Date(2026, 8, 10, 9, 15).getTime();
const TIME_ONLY = { hour: "2-digit", minute: "2-digit" } as const;
const WITH_DAY = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } as const;
const WITH_WEEKDAY = { weekday: "short", hour: "2-digit", minute: "2-digit" } as const;

test("formatResetAt prints a clock reading for a window resetting today", () => {
  const at = new Date(2026, 8, 10, 14, 30);
  const out = formatResetAt(at.toISOString(), NOW);
  assert.equal(out, at.toLocaleTimeString(undefined, TIME_ONLY));
  // A time, and only a time: the date would be noise for the common case.
  assert.match(out, /\d{1,2}[:.]\d{2}/);
  assert.equal(out, formatResetAt(at.toISOString(), new Date(2026, 8, 10, 23, 59).getTime()));
});

test("formatResetAt names the weekday for a window resetting later this week", () => {
  const at = new Date(2026, 8, 13, 7, 30);
  const out = formatResetAt(at.toISOString(), NOW);
  assert.equal(out, at.toLocaleString(undefined, WITH_WEEKDAY));
  // "resets at 07:30" three days out would be a lie by omission — but the day
  // is worth only a weekday's width, which is what a phone popover can pay.
  assert.notEqual(out, at.toLocaleTimeString(undefined, TIME_ONLY));
  assert.notEqual(out, at.toLocaleString(undefined, WITH_DAY));
  // The last day a weekday still means one thing, and the first it does not.
  const sixDays = new Date(2026, 8, 16, 7, 30);
  assert.equal(formatResetAt(sixDays.toISOString(), NOW), sixDays.toLocaleString(undefined, WITH_WEEKDAY));
});

test("formatResetAt dates a window resetting a week or more away", () => {
  // A week out lands on today's weekday: "Thu 07:30" would read as tomorrow.
  const week = new Date(2026, 8, 17, 7, 30);
  const out = formatResetAt(week.toISOString(), NOW);
  assert.equal(out, week.toLocaleString(undefined, WITH_DAY));
  assert.ok(out.includes("17"), `expected the day of the month in ${out}`);
  // Yesterday is another day too, and a weekday name behind us is no clearer.
  const past = new Date(2026, 8, 9, 23, 30);
  assert.equal(formatResetAt(past.toISOString(), NOW), past.toLocaleString(undefined, WITH_DAY));
});

test("formatResetAt prints nothing it cannot read", () => {
  assert.equal(formatResetAt(null, NOW), "");
  assert.equal(formatResetAt("", NOW), "");
  assert.equal(formatResetAt("nonsense", NOW), "");
});
