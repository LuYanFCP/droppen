/**
 * The cron expression, as the browser understands it.
 *
 * A second parser for a grammar the server already parses, which needs a
 * reason: the schedule form has to say what `*\/15 9-17 * * MON-FRI` means, and
 * when it next fires, *before* the task exists — and the alternative is a round
 * trip per keystroke to a preview route that would have to be invented for it.
 *
 * The rule that stops two parsers from drifting into disagreement is that this
 * one is never the authority. It previews; the server decides, and answers a
 * bad expression with croner's own message. So everything here is built to
 * under-claim: an expression this file cannot model completely is reported as
 * "no preview" rather than guessed at, because a form that confidently shows
 * the wrong next-run time is worse than one that admits it does not know.
 *
 * # What is deliberately not modelled
 *
 * croner's extensions — `L` (last day / last weekday), `W` (nearest weekday),
 * `#` (nth weekday of the month), the `+` day AND-modifier and the `@daily`
 * family of nicknames. All of them are accepted by the server, and all of them
 * would need real calendar work to preview correctly. They come back as
 * [`"unsupported"`], which the form renders as "this expression cannot be
 * previewed" while still letting it be saved: refusing to save an expression
 * the server accepts would be this file overruling the authority.
 *
 * Everything else follows croner exactly, including the parts of cron that are
 * surprising — see [`dayMatches`] for the day-of-month / day-of-week OR rule,
 * and note that a single number with a step (`0/15`) is *rejected*, because
 * croner runs with `sloppy_ranges` off and refuses it too.
 */

/** The longest expression the server stores; `MAX_EXPR` in `schedule/cron.rs`. */
export const MAX_EXPR = 200;

/** One parsed field: which values it matches, and how it was written. */
export interface CronField {
  /** Every value the field matches, ascending and de-duplicated. */
  values: readonly number[];
  /**
   * The field was written as a bare `*` (or `?`, which croner rewrites to `*`).
   *
   * Not the same question as "matches everything": `*\/1` matches every value
   * and is *not* a star, and the difference decides the day rule — see
   * [`dayMatches`]. Kept as its own flag rather than derived from `values` for
   * exactly that reason.
   */
  isStar: boolean;
  /** The `n` of a whole-range `*\/n`, and null for any other spelling. */
  wholeStep: number | null;
}

export interface CronFields {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/** Why an expression was refused, in the terms the form apologises in. */
export type CronInvalidReason = "empty" | "tooLong" | "fieldCount" | "field";

export type CronVerdict =
  | { kind: "ok"; fields: CronFields }
  /** Five fields the server will accept, written with syntax this file does not model. */
  | { kind: "unsupported" }
  /** Refused outright, and the server would refuse it too. */
  | { kind: "invalid"; reason: CronInvalidReason };

const WEEKDAY_NAMES: readonly [string, string][] = [
  // `-SUN` first, and for croner's own reason: the alias table is applied as a
  // plain string replace over the whole pattern, so `FRI-SUN` must become `5-7`
  // and not `5-0`, which would be a backwards range.
  ["-SUN", "-7"],
  ["SUN", "0"],
  ["MON", "1"],
  ["TUE", "2"],
  ["WED", "3"],
  ["THU", "4"],
  ["FRI", "5"],
  ["SAT", "6"],
];

const MONTH_NAMES: readonly [string, string][] = [
  ["JAN", "1"],
  ["FEB", "2"],
  ["MAR", "3"],
  ["APR", "4"],
  ["MAY", "5"],
  ["JUN", "6"],
  ["JUL", "7"],
  ["AUG", "8"],
  ["SEP", "9"],
  ["OCT", "10"],
  ["NOV", "11"],
  ["DEC", "12"],
];

/** Characters croner allows anywhere; anything else is a syntax error, not an extension. */
const BASE_CHARS = /^[*/\d,-]+$/;
/** The extensions this file refuses to guess at, per field. */
const DOM_EXTENSIONS = /[LW]/;
const DOW_EXTENSIONS = /[L#]/;

function applyAliases(field: string, table: readonly [string, string][]): string {
  let out = field;
  for (const [name, value] of table) out = out.split(name).join(value);
  return out;
}

function integer(text: string): number | null {
  // `Number` would accept `1e2`, ` 1 ` and `0x10`; a cron field is decimal digits.
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * One field, already alias-substituted, into the values it matches.
 *
 * Null means "the server would refuse this too" — every acceptance here is
 * checked against croner's own bounds, so a range that runs backwards, a step
 * of zero and a value past the field's maximum all fail in both parsers.
 */
function parseField(raw: string, min: number, max: number): CronField | null {
  if (raw === "*") {
    const values: number[] = [];
    for (let v = min; v <= max; v += 1) values.push(v);
    return { values, isStar: true, wholeStep: null };
  }
  const parts = raw.split(",").filter((p) => p !== "");
  if (parts.length === 0) return null;
  const hit = new Set<number>();
  let wholeStep: number | null = null;
  for (const part of parts) {
    let start: number;
    let end: number;
    let step = 1;
    const slash = part.indexOf("/");
    const rangeText = slash < 0 ? part : part.slice(0, slash);
    if (slash >= 0) {
      const parsedStep = integer(part.slice(slash + 1));
      if (parsedStep === null || parsedStep === 0) return null;
      step = parsedStep;
      // A single number in front of a step (`0/15`) is the one common cron
      // spelling croner refuses: it runs with `sloppy_ranges` off, so the only
      // starting points a step accepts are `*` and an explicit range.
      if (rangeText === "*") {
        start = min;
        end = max;
        if (parts.length === 1) wholeStep = step;
      } else if (rangeText.includes("-")) {
        const bounds = rangeText.split("-");
        if (bounds.length !== 2) return null;
        const lo = integer(bounds[0] ?? "");
        const hi = integer(bounds[1] ?? "");
        if (lo === null || hi === null) return null;
        start = lo;
        end = hi;
      } else {
        return null;
      }
    } else if (part.includes("-")) {
      const bounds = part.split("-");
      if (bounds.length !== 2) return null;
      const lo = integer(bounds[0] ?? "");
      const hi = integer(bounds[1] ?? "");
      if (lo === null || hi === null) return null;
      start = lo;
      end = hi;
    } else {
      const only = integer(part);
      if (only === null) return null;
      start = only;
      end = only;
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) hit.add(v);
  }
  return { values: [...hit].sort((a, b) => a - b), isStar: false, wholeStep };
}

/** Day-of-week `7` and `0` are both Sunday; croner folds 7 onto 0 and so do we. */
function foldSunday(field: CronField): CronField {
  if (!field.values.includes(7)) return field;
  const values = [...new Set(field.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);
  return { ...field, values };
}

/**
 * Classify an expression: previewable, previewable-by-the-server-only, or junk.
 *
 * The three answers exist because the form does two different things with them.
 * `invalid` disables saving — the server would refuse it and there is nothing to
 * be gained from the round trip. `unsupported` does not: it only turns off the
 * preview, because the expression is very likely fine and this file simply does
 * not do `L`/`W`/`#`/`@daily`.
 */
export function checkCron(expr: string): CronVerdict {
  const trimmed = expr.trim();
  if (trimmed === "") return { kind: "invalid", reason: "empty" };
  // Counted in characters rather than UTF-16 units, as the server does.
  if ([...trimmed].length > MAX_EXPR) return { kind: "invalid", reason: "tooLong" };
  const upper = trimmed.toUpperCase();
  if (upper.includes("@")) return { kind: "unsupported" };
  const parts = upper.split(/\s+/);
  // Exactly five. Six is the seconds field the server refuses outright, and a
  // four-field expression is a five-field one with something missing.
  if (parts.length !== 5) return { kind: "invalid", reason: "fieldCount" };
  const [rawMinute = "", rawHour = "", rawDom = "", rawMonth = "", rawDow = ""] = parts;
  if (rawDow.startsWith("+")) return { kind: "unsupported" };
  const dom = rawDom.split("?").join("*");
  const dow = applyAliases(rawDow, WEEKDAY_NAMES).split("?").join("*");
  const month = applyAliases(rawMonth, MONTH_NAMES);
  if (DOM_EXTENSIONS.test(dom) || DOW_EXTENSIONS.test(dow)) return { kind: "unsupported" };
  for (const field of [rawMinute, rawHour, dom, month, dow]) {
    if (!BASE_CHARS.test(field)) return { kind: "invalid", reason: "field" };
  }
  const minute = parseField(rawMinute, 0, 59);
  const hour = parseField(rawHour, 0, 23);
  const dayOfMonth = parseField(dom, 1, 31);
  const monthField = parseField(month, 1, 12);
  // 0-7 rather than 0-6: cron has always spelled Sunday both ways.
  const dayOfWeek = parseField(dow, 0, 7);
  if (!minute || !hour || !dayOfMonth || !monthField || !dayOfWeek) {
    return { kind: "invalid", reason: "field" };
  }
  return {
    kind: "ok",
    fields: { minute, hour, dayOfMonth, month: monthField, dayOfWeek: foldSunday(dayOfWeek) },
  };
}

/** The fields of a fully previewable expression, and null for anything else. */
export function parseCron(expr: string): CronFields | null {
  const verdict = checkCron(expr);
  return verdict.kind === "ok" ? verdict.fields : null;
}

/**
 * Does this calendar day fire?
 *
 * The day-of-month / day-of-week rule is the part of cron nobody remembers, and
 * it is an OR, not an AND: with both day fields restricted, `0 9 13 * FRI` runs
 * on every 13th *and* on every Friday. A restricted field beside a bare `*` is
 * the only one that speaks. Transcribed from croner's `CronPattern::day_match`
 * so the two agree on the trap as well as on the ordinary case — including the
 * one that catches people out, that `*\/1` is not a `*` and so switches a day
 * pair into the OR branch.
 */
function dayMatches(fields: CronFields, date: Date): boolean {
  const domMatch = fields.dayOfMonth.values.includes(date.getDate());
  const dowMatch = fields.dayOfWeek.values.includes(date.getDay());
  if ((domMatch && fields.dayOfWeek.isStar) || (dowMatch && fields.dayOfMonth.isStar)) return true;
  if (!fields.dayOfMonth.isStar && !fields.dayOfWeek.isStar) return domMatch || dowMatch;
  return false;
}

/** The first `hh:mm` at or after `from`'s time of day that this expression names. */
function timeOnOrAfter(fields: CronFields, hour: number, minute: number): { hour: number; minute: number } | null {
  for (const h of fields.hour.values) {
    if (h < hour) continue;
    const floor = h === hour ? minute : 0;
    for (const m of fields.minute.values) {
      if (m >= floor) return { hour: h, minute: m };
    }
  }
  return null;
}

/** How far ahead the search will look before giving up; see [`nextOccurrences`]. */
const SEARCH_YEARS = 5;

/**
 * The next `count` firing times, strictly after `from`, in **local** time.
 *
 * Local is the browser's zone, and the expression's authority is the *server's*
 * — the two agree only when the two machines do. That is not something this
 * function can fix, so the form states it beside the preview rather than
 * pretending the numbers are unconditional.
 *
 * The walk is by day and not by minute, because a minute-by-minute scan for
 * `0 0 29 2 *` is two million steps to find one leap day. A day that cannot
 * match is skipped whole; a day that can is asked for its first qualifying
 * time. The search stops after five years, which is what an expression with no
 * future occurrence at all (`0 0 30 2 *`) needs to terminate — such an
 * expression returns fewer results than asked for, including none.
 *
 * Daylight saving is left to the platform's own local-time arithmetic, with one
 * correction: a wall-clock time inside an hour that spring-forward skipped does
 * not exist, and `new Date(y, m, d, 2, 30)` silently answers 03:30 instead.
 * That reading is dropped rather than shown, because croner drops it too — an
 * hour that did not happen has no occurrence in it.
 */
export function nextOccurrences(expr: string, from: Date, count: number): Date[] {
  const fields = parseCron(expr);
  if (!fields || count <= 0) return [];
  const out: Date[] = [];
  const deadline = new Date(from.getFullYear() + SEARCH_YEARS, from.getMonth(), from.getDate()).getTime();
  // Strictly after `from`: a task whose time is this very minute fires next
  // minute at the earliest, which is also how the server's `find_next` reads it.
  let cursor = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    from.getHours(),
    from.getMinutes() + 1,
    0,
    0,
  );
  while (out.length < count && cursor.getTime() <= deadline) {
    // A month that cannot match is skipped whole rather than a day at a time.
    // `getMonth` is zero-based and cron's month field is not, hence the +1 here
    // and the bare `+ 1` in the jump, which lands on the 1st of the next month.
    if (!fields.month.values.includes(cursor.getMonth() + 1)) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }
    const found = dayMatches(fields, cursor)
      ? timeOnOrAfter(fields, cursor.getHours(), cursor.getMinutes())
      : null;
    if (!found) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
      continue;
    }
    const when = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), found.hour, found.minute, 0, 0);
    if (when.getHours() === found.hour && when.getMinutes() === found.minute) out.push(when);
    cursor = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate(),
      found.hour,
      found.minute + 1,
      0,
      0,
    );
  }
  return out;
}

/**
 * A description of a schedule with no words in it.
 *
 * Deliberately structured rather than a sentence: the sentence has to exist in
 * four languages, and word order for "every Tuesday at 09:30" is not the same
 * in all of them. The React layer owns the phrasing; this module owns the
 * reading of the expression, and `custom` is its honest answer for the ones
 * that have no short phrasing at all.
 */
export type CronDescription =
  | { kind: "everyMinute" }
  | { kind: "everyNMinutes"; n: number }
  | { kind: "hourly"; minute: number }
  | { kind: "everyNHours"; n: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "custom" };

/** The single value a field names, or null when it names none or several. */
function only(field: CronField): number | null {
  return field.values.length === 1 ? (field.values[0] ?? null) : null;
}

export function describeCron(expr: string): CronDescription | null {
  const fields = parseCron(expr);
  if (!fields) return null;
  // Everything below describes a schedule that repeats on the plain calendar;
  // a restricted day-of-month or month is by definition not one of those.
  if (!fields.dayOfMonth.isStar || !fields.month.isStar) return { kind: "custom" };
  const minute = only(fields.minute);
  const hour = only(fields.hour);
  const weekday = only(fields.dayOfWeek);

  if (fields.dayOfWeek.isStar) {
    if (fields.minute.isStar && fields.hour.isStar) return { kind: "everyMinute" };
    if (fields.minute.wholeStep !== null && fields.hour.isStar) {
      return { kind: "everyNMinutes", n: fields.minute.wholeStep };
    }
    if (minute === null) return { kind: "custom" };
    if (fields.hour.isStar) return { kind: "hourly", minute };
    if (fields.hour.wholeStep !== null) {
      return { kind: "everyNHours", n: fields.hour.wholeStep, minute };
    }
    if (hour === null) return { kind: "custom" };
    return { kind: "daily", hour, minute };
  }
  if (minute !== null && hour !== null && weekday !== null) {
    return { kind: "weekly", weekday, hour, minute };
  }
  return { kind: "custom" };
}

/** The three shapes the form offers without sending anyone to the raw field. */
export type CronPreset = "daily" | "everyNHours" | "weekly";

export const PRESETS: readonly CronPreset[] = ["daily", "everyNHours", "weekly"];

/**
 * Every control the preset row has, whichever preset is selected.
 *
 * One object rather than one per preset, because switching from "every day at
 * 09:00" to "every week on" should keep the 09:00 the user already picked
 * rather than resetting it — the fields the new preset does not read simply
 * wait, unchanged, for the next switch.
 */
export interface PresetState {
  preset: CronPreset;
  hour: number;
  minute: number;
  /** The `N` of "every N hours". */
  n: number;
  /** 0 = Sunday, as `Date.getDay` and cron both number it. */
  weekday: number;
}

export const DEFAULT_PRESET: PresetState = {
  preset: "daily",
  hour: 9,
  minute: 0,
  n: 6,
  weekday: 1,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function dailyExpr(hour: number, minute: number): string {
  return `${clamp(minute, 0, 59)} ${clamp(hour, 0, 23)} * * *`;
}

/**
 * `n` of 1 is written `*` and not `*\/1`: they fire identically, but `*\/1` is
 * not a star, and a non-star day field would flip an unrelated expression into
 * the day-OR branch. Writing the plain spelling keeps every expression this
 * builder emits the boring kind.
 */
export function everyNHoursExpr(n: number, minute: number): string {
  const step = clamp(n, 1, 23);
  return `${clamp(minute, 0, 59)} ${step === 1 ? "*" : `*/${step}`} * * *`;
}

export function weeklyExpr(weekday: number, hour: number, minute: number): string {
  return `${clamp(minute, 0, 59)} ${clamp(hour, 0, 23)} * * ${clamp(weekday, 0, 6)}`;
}

export function presetExpr(state: PresetState): string {
  if (state.preset === "everyNHours") return everyNHoursExpr(state.n, state.minute);
  if (state.preset === "weekly") return weeklyExpr(state.weekday, state.hour, state.minute);
  return dailyExpr(state.hour, state.minute);
}

/**
 * Read a stored expression back into the preset controls, or null when it needs
 * the raw field.
 *
 * The point of the round trip: opening the edit form on a task saved as "every
 * day at 09:00" must show that, not drop the user into an advanced text box
 * holding `0 9 * * *`. Matching goes through [`describeCron`] rather than
 * through the expression's text, so `0 9 * * MON` and `0 9 * * 1` are the same
 * weekly schedule — which they are.
 *
 * The unfilled slots come from [`DEFAULT_PRESET`], so switching preset after
 * opening an existing task lands on something sensible rather than on midnight.
 */
export function matchPreset(expr: string): PresetState | null {
  const described = describeCron(expr);
  if (!described) return null;
  switch (described.kind) {
    case "daily":
      return { ...DEFAULT_PRESET, preset: "daily", hour: described.hour, minute: described.minute };
    case "hourly":
      return { ...DEFAULT_PRESET, preset: "everyNHours", n: 1, minute: described.minute };
    case "everyNHours":
      return { ...DEFAULT_PRESET, preset: "everyNHours", n: described.n, minute: described.minute };
    case "weekly":
      return {
        ...DEFAULT_PRESET,
        preset: "weekly",
        weekday: described.weekday,
        hour: described.hour,
        minute: described.minute,
      };
    default:
      return null;
  }
}
