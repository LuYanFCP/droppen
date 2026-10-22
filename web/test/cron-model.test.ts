import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCron,
  dailyExpr,
  describeCron,
  everyNHoursExpr,
  matchPreset,
  nextOccurrences,
  parseCron,
  weeklyExpr,
  type CronField,
} from "../src/features/schedule/cron-model.js";

/**
 * A wall-clock reading in whatever zone the test runner is in.
 *
 * Every date below is built and asserted this way on purpose: the module works
 * in local time, so pinning a zone here would either test a zone the runner is
 * not in or make the assertions depend on one it happens to be in.
 */
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function values(expr: string, field: keyof ReturnType<typeof fields>): readonly number[] {
  return fields(expr)[field].values;
}

function fields(expr: string): Record<"minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek", CronField> {
  const parsed = parseCron(expr);
  assert.ok(parsed, `expected ${expr} to parse`);
  return parsed;
}

test("five fields parse; four and six do not", () => {
  assert.ok(parseCron("0 9 * * *"));
  assert.ok(parseCron("  */15 * * * *  "), "surrounding space is not a syntax error");
  assert.deepEqual(checkCron("* * * *"), { kind: "invalid", reason: "fieldCount" });
  // Six fields is a seconds column, which the server refuses outright rather
  // than ignoring: `*/10 * * * * *` would fire six times a minute.
  assert.deepEqual(checkCron("*/10 * * * * *"), { kind: "invalid", reason: "fieldCount" });
  assert.deepEqual(checkCron(""), { kind: "invalid", reason: "empty" });
  assert.deepEqual(checkCron("   "), { kind: "invalid", reason: "empty" });
  assert.deepEqual(checkCron("not a cron"), { kind: "invalid", reason: "fieldCount" });
  assert.deepEqual(checkCron("a b c d e"), { kind: "invalid", reason: "field" });
  assert.equal(checkCron(`${"1,".repeat(120)}1 * * * *`).kind, "invalid");
});

test("out-of-range values are refused in the same places croner refuses them", () => {
  assert.equal(parseCron("60 * * * *"), null);
  assert.equal(parseCron("0 24 * * *"), null);
  assert.equal(parseCron("0 0 0 * *"), null, "day-of-month starts at 1");
  assert.equal(parseCron("0 0 32 * *"), null);
  assert.equal(parseCron("0 0 * 13 *"), null);
  assert.equal(parseCron("0 0 * * 8"), null);
  assert.equal(parseCron("17-5 * * * *"), null, "a range does not wrap around");
  assert.equal(parseCron("*/0 * * * *"), null, "a zero step names no values");
  // croner runs with `sloppy_ranges` off, so a step needs `*` or a range in
  // front of it; `0/15` is the spelling people bring from other cron dialects.
  assert.equal(parseCron("0/15 * * * *"), null);
  assert.equal(parseCron("/15 * * * *"), null);
});

test("steps, ranges and lists name exactly the values they say", () => {
  assert.deepEqual(values("*/15 * * * *", "minute"), [0, 15, 30, 45]);
  assert.deepEqual(values("0 9-17 * * *", "hour"), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(values("0,30 * * * *", "minute"), [0, 30]);
  assert.deepEqual(values("1-5,10 * * * *", "minute"), [1, 2, 3, 4, 5, 10]);
  assert.deepEqual(values("0-30/10 * * * *", "minute"), [0, 10, 20, 30]);
  // A list that happens to cover the whole range is still not a star, and the
  // day rule keys on the difference.
  assert.equal(fields("*/1 * * * *").minute.isStar, false);
  assert.equal(fields("* * * * *").minute.isStar, true);
  assert.equal(fields("*/15 * * * *").minute.wholeStep, 15);
  assert.equal(fields("0-30/10 * * * *").minute.wholeStep, null);
});

test("weekday and month names are read case-insensitively, as croner reads them", () => {
  assert.deepEqual(values("0 9 * * MON", "dayOfWeek"), [1]);
  assert.deepEqual(values("0 9 * * mon", "dayOfWeek"), [1]);
  assert.deepEqual(values("0 9 * * Mon-Fri", "dayOfWeek"), [1, 2, 3, 4, 5]);
  assert.deepEqual(values("0 0 1 jan *", "month"), [1]);
  assert.deepEqual(values("0 0 1 Mar-May *", "month"), [3, 4, 5]);
  // Sunday is both 0 and 7; croner folds 7 onto 0 after parsing, so a range
  // that ends on Sunday is written `5-7` and read as Friday, Saturday, Sunday.
  assert.deepEqual(values("0 9 * * FRI-SUN", "dayOfWeek"), [0, 5, 6]);
  assert.deepEqual(values("0 9 * * 7", "dayOfWeek"), [0]);
});

test("`?` is a synonym for `*` in the day fields", () => {
  const parsed = fields("0 9 ? * MON");
  assert.equal(parsed.dayOfMonth.isStar, true);
  assert.equal(parsed.dayOfMonth.values.length, 31);
});

test("croner's own extensions are unsupported, not invalid", () => {
  // The difference matters: the form disables saving on `invalid` and merely
  // drops the preview on `unsupported`, because the server accepts these.
  for (const expr of ["0 9 L * *", "0 9 * * 1#2", "0 9 1W * *", "@daily", "0 9 * * +MON"]) {
    assert.deepEqual(checkCron(expr), { kind: "unsupported" }, expr);
    assert.equal(parseCron(expr), null, expr);
    assert.deepEqual(nextOccurrences(expr, local(2024, 5, 1), 3), [], expr);
    assert.equal(describeCron(expr), null, expr);
  }
});

test("the next occurrence is strictly after `from`, not at it", () => {
  const at = local(2024, 5, 1, 9, 30);
  assert.deepEqual(nextOccurrences("30 9 * * *", at, 1), [local(2024, 5, 2, 9, 30)]);
  // A second into the minute is still that minute, and still already past.
  const mid = new Date(at.getTime() + 30_000);
  assert.deepEqual(nextOccurrences("30 9 * * *", mid, 1), [local(2024, 5, 2, 9, 30)]);
});

test("later today, else tomorrow", () => {
  assert.deepEqual(nextOccurrences("30 9 * * *", local(2024, 5, 1, 8, 0), 1), [local(2024, 5, 1, 9, 30)]);
  assert.deepEqual(nextOccurrences("30 9 * * *", local(2024, 5, 1, 10, 0), 1), [local(2024, 5, 2, 9, 30)]);
  // The hour matches but every minute in it has passed.
  assert.deepEqual(nextOccurrences("0,30 9 * * *", local(2024, 5, 1, 9, 45), 1), [
    local(2024, 5, 2, 9, 0),
  ]);
});

test("a day-of-month a month does not have is skipped, not clamped", () => {
  // April, June, September and November have no 31st; May and July do.
  assert.deepEqual(nextOccurrences("0 9 31 * *", local(2024, 4, 1), 3), [
    local(2024, 5, 31, 9, 0),
    local(2024, 7, 31, 9, 0),
    local(2024, 8, 31, 9, 0),
  ]);
});

test("the 29th of February waits for the leap year", () => {
  assert.deepEqual(nextOccurrences("0 9 29 2 *", local(2023, 3, 1), 2), [
    local(2024, 2, 29, 9, 0),
    local(2028, 2, 29, 9, 0),
  ]);
  // A date that never comes around returns nothing rather than looping.
  assert.deepEqual(nextOccurrences("0 9 30 2 *", local(2024, 1, 1), 1), []);
});

test("the search crosses the year boundary", () => {
  assert.deepEqual(nextOccurrences("0 0 1 1 *", local(2024, 6, 15, 12, 0), 2), [
    local(2025, 1, 1, 0, 0),
    local(2026, 1, 1, 0, 0),
  ]);
  assert.deepEqual(nextOccurrences("59 23 31 12 *", local(2024, 12, 31, 23, 58), 1), [
    local(2024, 12, 31, 23, 59),
  ]);
});

test("two restricted day fields are an OR, the way cron has always meant it", () => {
  // 2024-06-13 is a Thursday, so the 13th and the Fridays are different days.
  assert.deepEqual(nextOccurrences("0 9 13 * 5", local(2024, 6, 12), 3), [
    local(2024, 6, 13, 9, 0),
    local(2024, 6, 14, 9, 0),
    local(2024, 6, 21, 9, 0),
  ]);
  // With one of them a bare star, only the restricted one speaks.
  assert.deepEqual(nextOccurrences("0 9 13 * *", local(2024, 6, 14), 1), [local(2024, 7, 13, 9, 0)]);
});

test("asking for no occurrences, or for an unparseable expression, yields none", () => {
  assert.deepEqual(nextOccurrences("0 9 * * *", local(2024, 5, 1), 0), []);
  assert.deepEqual(nextOccurrences("* * * *", local(2024, 5, 1), 3), []);
});

test("a description is a shape, not a sentence", () => {
  assert.deepEqual(describeCron("* * * * *"), { kind: "everyMinute" });
  assert.deepEqual(describeCron("*/15 * * * *"), { kind: "everyNMinutes", n: 15 });
  assert.deepEqual(describeCron("0 * * * *"), { kind: "hourly", minute: 0 });
  assert.deepEqual(describeCron("30 */6 * * *"), { kind: "everyNHours", n: 6, minute: 30 });
  assert.deepEqual(describeCron("0 9 * * *"), { kind: "daily", hour: 9, minute: 0 });
  assert.deepEqual(describeCron("15 8 * * TUE"), { kind: "weekly", weekday: 2, hour: 8, minute: 15 });
  // Anything with a day-of-month or a month in it, or several hours listed out,
  // has no short phrasing worth inventing four translations of.
  assert.deepEqual(describeCron("0 9 1 * *"), { kind: "custom" });
  assert.deepEqual(describeCron("0 9,17 * * *"), { kind: "custom" });
  assert.deepEqual(describeCron("0 9 * * MON-FRI"), { kind: "custom" });
});

test("a preset survives the round trip through the expression it is stored as", () => {
  assert.equal(dailyExpr(9, 30), "30 9 * * *");
  assert.equal(everyNHoursExpr(6, 0), "0 */6 * * *");
  assert.equal(weeklyExpr(2, 8, 15), "15 8 * * 2");
  // `*/1` and `*` fire identically, but only one of them is a star; the builder
  // writes the star so no expression it emits lands in the day-OR branch.
  assert.equal(everyNHoursExpr(1, 5), "5 * * * *");

  assert.deepEqual(matchPreset(dailyExpr(9, 30)), {
    preset: "daily",
    hour: 9,
    minute: 30,
    n: 6,
    weekday: 1,
  });
  assert.deepEqual(matchPreset(everyNHoursExpr(4, 10)), {
    preset: "everyNHours",
    hour: 9,
    minute: 10,
    n: 4,
    weekday: 1,
  });
  assert.deepEqual(matchPreset(everyNHoursExpr(1, 10))?.n, 1);
  assert.deepEqual(matchPreset(weeklyExpr(5, 18, 0)), {
    preset: "weekly",
    hour: 18,
    minute: 0,
    n: 6,
    weekday: 5,
  });
  // The name spelling is the same schedule as the number, so opening the edit
  // form on one saved by hand still shows the preset controls.
  assert.deepEqual(matchPreset("0 9 * * MON")?.preset, "weekly");
  assert.equal(matchPreset("0 9 1 * *"), null, "a monthly schedule needs the raw field");
  assert.equal(matchPreset("@daily"), null);

  // The builders clamp rather than emitting an expression the server refuses.
  assert.equal(dailyExpr(99, -3), "0 23 * * *");
  assert.equal(everyNHoursExpr(48, 0), "0 */23 * * *");
  assert.equal(weeklyExpr(9, 0, 0), "0 0 * * 6");
});
