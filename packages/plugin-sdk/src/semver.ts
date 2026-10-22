/**
 * Versions and engine ranges, read exactly as the host's Rust side reads them
 * (the `semver` crate, i.e. Cargo's rules), so a range the build accepts is a
 * range the server accepts, and both agree on what it matches.
 *
 * A range is one or more comparators separated by **commas**:
 * `^0.1.0`, `>=0.1.0, <0.3.0`, `~0.1.2`, `0.1.*`, `*`. A comparator without an
 * operator is a caret requirement — `0.1.0` means `^0.1.0`, as in Cargo — not
 * npm's exact match. npm-only syntax (space-separated comparators, `||`,
 * hyphen ranges, a `v` prefix) is refused rather than guessed at.
 *
 * `test/engine-vectors.json` holds the cases both implementations are tested
 * against.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; `""` for a release. */
  prerelease: string;
}

type Op = "=" | ">" | ">=" | "<" | "<=" | "~" | "^" | "*";

interface Comparator {
  op: Op;
  major: number;
  minor: number | null;
  patch: number | null;
  prerelease: string;
}

class Cursor {
  constructor(public text: string) {}
  eat(prefix: string): boolean {
    if (!this.text.startsWith(prefix)) return false;
    this.text = this.text.slice(prefix.length);
    return true;
  }
  spaces() {
    this.text = this.text.replace(/^ +/, "");
  }
}

const fail = (): never => {
  throw new SyntaxError("not a version or range");
};

/** A numeric identifier: digits, no leading zero, a safe integer. */
function numeric(c: Cursor): number {
  const m = /^\d+/.exec(c.text);
  if (!m) return fail();
  const digits = m[0];
  if (digits.length > 1 && digits.startsWith("0")) fail();
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) fail();
  c.text = c.text.slice(digits.length);
  return value;
}

/** Dot-separated `[0-9A-Za-z-]+` segments; numeric pre-release segments may not lead with 0. */
function identifier(c: Cursor, pre: boolean): string {
  const m = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*/.exec(c.text);
  if (!m) return fail();
  if (c.text.charAt(m[0].length) === ".") fail();
  if (pre && m[0].split(".").some((s) => /^\d+$/.test(s) && s.length > 1 && s.startsWith("0"))) fail();
  c.text = c.text.slice(m[0].length);
  return m[0];
}

const isWildcard = (c: Cursor) => c.eat("*") || c.eat("x") || c.eat("X");

/** A full `major.minor.patch[-pre][+build]` version, or `null`. */
export function parseVersion(text: string): Version | null {
  try {
    const c = new Cursor(text);
    const major = numeric(c);
    if (!c.eat(".")) fail();
    const minor = numeric(c);
    if (!c.eat(".")) fail();
    const patch = numeric(c);
    const prerelease = c.eat("-") ? identifier(c, true) : "";
    if (c.eat("+")) identifier(c, false);
    if (c.text) fail();
    return { major, minor, patch, prerelease };
  } catch {
    return null;
  }
}

/** Order two pre-release strings as the spec (and the crate) do; `""` is a release, the greatest. */
function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < left.length; i++) {
    const l = left[i]!;
    const r = right[i];
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    let order: number;
    if (ln && rn) order = l.length - r.length || (l < r ? -1 : l > r ? 1 : 0);
    else if (ln) return -1;
    else if (rn) return 1;
    else order = l < r ? -1 : l > r ? 1 : 0;
    if (order) return order < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : -1;
}

/** `-1`, `0` or `1`, ordering `a` against `b`. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

const OPS: [string, Op][] = [
  [">=", ">="],
  ["<=", "<="],
  ["=", "="],
  [">", ">"],
  ["<", "<"],
  ["~", "~"],
  ["^", "^"],
];

function comparator(c: Cursor): Comparator {
  let op: Op = "^";
  let explicit = false;
  for (const [token, value] of OPS) {
    if (c.eat(token)) {
      op = value;
      explicit = true;
      break;
    }
  }
  c.spaces();
  const major = numeric(c);
  let minor: number | null = null;
  let patch: number | null = null;
  let wildcard = false;
  if (c.eat(".")) {
    if (isWildcard(c)) {
      wildcard = true;
      if (!explicit) op = "*";
    } else minor = numeric(c);
  }
  if (c.eat(".")) {
    if (isWildcard(c)) {
      if (!explicit) op = "*";
    } else if (wildcard) fail();
    else patch = numeric(c);
  }
  let prerelease = "";
  if (patch !== null && c.eat("-")) prerelease = identifier(c, true);
  if (patch !== null && c.eat("+")) identifier(c, false);
  c.spaces();
  return { op, major, minor, patch, prerelease };
}

/** The comparators of `range` (`[]` for `*`), or `null` when it does not parse. */
function parseRange(range: string): Comparator[] | null {
  try {
    const c = new Cursor(range);
    c.spaces();
    if (/^[*xX] *$/.test(c.text)) return [];
    const out: Comparator[] = [];
    for (;;) {
      if (/^[*xX]/.test(c.text)) fail(); // a wildcard must be the only comparator
      out.push(comparator(c));
      if (!c.text) return out;
      if (!c.eat(",")) fail();
      c.spaces();
      if (out.length === 32) fail();
    }
  } catch {
    return null;
  }
}

function exact(c: Comparator, v: Version): boolean {
  if (v.major !== c.major) return false;
  if (c.minor !== null && v.minor !== c.minor) return false;
  if (c.patch !== null && v.patch !== c.patch) return false;
  return v.prerelease === c.prerelease;
}

function greater(c: Comparator, v: Version): boolean {
  if (v.major !== c.major) return v.major > c.major;
  if (c.minor === null) return false;
  if (v.minor !== c.minor) return v.minor > c.minor;
  if (c.patch === null) return false;
  if (v.patch !== c.patch) return v.patch > c.patch;
  return comparePrerelease(v.prerelease, c.prerelease) > 0;
}

function less(c: Comparator, v: Version): boolean {
  if (v.major !== c.major) return v.major < c.major;
  if (c.minor === null) return false;
  if (v.minor !== c.minor) return v.minor < c.minor;
  if (c.patch === null) return false;
  if (v.patch !== c.patch) return v.patch < c.patch;
  return comparePrerelease(v.prerelease, c.prerelease) < 0;
}

function tilde(c: Comparator, v: Version): boolean {
  if (v.major !== c.major) return false;
  if (c.minor !== null && v.minor !== c.minor) return false;
  if (c.patch !== null && v.patch !== c.patch) return v.patch > c.patch;
  return comparePrerelease(v.prerelease, c.prerelease) >= 0;
}

function caret(c: Comparator, v: Version): boolean {
  if (v.major !== c.major) return false;
  if (c.minor === null) return true;
  if (c.patch === null) return c.major > 0 ? v.minor >= c.minor : v.minor === c.minor;
  if (c.major > 0) {
    if (v.minor !== c.minor) return v.minor > c.minor;
    if (v.patch !== c.patch) return v.patch > c.patch;
  } else if (c.minor > 0) {
    if (v.minor !== c.minor) return false;
    if (v.patch !== c.patch) return v.patch > c.patch;
  } else if (v.minor !== c.minor || v.patch !== c.patch) return false;
  return comparePrerelease(v.prerelease, c.prerelease) >= 0;
}

function matches(c: Comparator, v: Version): boolean {
  switch (c.op) {
    case "=":
    case "*":
      return exact(c, v);
    case ">":
      return greater(c, v);
    case ">=":
      return exact(c, v) || greater(c, v);
    case "<":
      return less(c, v);
    case "<=":
      return exact(c, v) || less(c, v);
    case "~":
      return tilde(c, v);
    case "^":
      return caret(c, v);
  }
}

/** Whether `range` is a range the host accepts. */
export function validRange(range: string): boolean {
  return parseRange(range) !== null;
}

/**
 * Whether `version` lies in `range`. An unreadable version or range is `false`,
 * never an exception. A pre-release matches only a range with a comparator that
 * names a pre-release of the same `major.minor.patch`.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const comparators = parseRange(range);
  if (!v || !comparators) return false;
  if (!comparators.every((c) => matches(c, v))) return false;
  if (!v.prerelease) return true;
  return comparators.some((c) => c.major === v.major && c.minor === v.minor && c.patch === v.patch && c.prerelease !== "");
}
