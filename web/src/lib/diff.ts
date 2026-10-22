import type { components } from "@/api/schema";

type PatchHunk = components["schemas"]["PatchHunk"];

export type DiffRow = {
  type: "add" | "del" | "ctx" | "hunk";
  text: string;
  /** Line number in the file as it was; absent on added rows. */
  oldLn?: number;
  /** Line number in the file as it now is; absent on removed rows. */
  newLn?: number;
};

/**
 * Above this many DP cells the quadratic LCS is abandoned. A 500×500 edit is
 * already an unusual paste; beyond it the browser would stall for a diff no
 * one reads line by line anyway.
 */
export const LINE_DIFF_CELL_LIMIT = 250_000;

/** How many rows a diff card draws before it says how many it left out. */
export const DIFF_MAX_ROWS = 400;

/** Tools whose calls are worth rendering as a diff rather than a blob. */
export const DIFF_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * Empty text is zero lines, not one blank one — otherwise creating a file
 * reports a removed line that never existed.
 */
const splitLines = (text: string): string[] =>
  text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n");

/**
 * Line-level LCS diff, used when the CLI recorded no structured patch (an
 * in-flight call, a codex session, an older transcript). Past
 * `LINE_DIFF_CELL_LIMIT` cells it degrades to "everything removed, everything
 * added", which is what the server's own one-line summary already shows.
 */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > LINE_DIFF_CELL_LIMIT) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  for (; i < m; i++) out.push({ type: "del", text: a[i]! });
  for (; j < n; j++) out.push({ type: "add", text: b[j]! });
  return out;
}

/**
 * The CLI's own hunks → display rows carrying real file line numbers, with the
 * context lines the naive old/new comparison cannot invent. Returns `null` when
 * there is nothing usable, so the caller can fall back to {@link lineDiff}.
 */
export function rowsFromPatch(hunks: PatchHunk[] | null | undefined): DiffRow[] | null {
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  const out: DiffRow[] = [];
  for (const hunk of hunks) {
    if (
      !hunk ||
      typeof hunk.oldStart !== "number" ||
      typeof hunk.newStart !== "number" ||
      !Array.isArray(hunk.lines)
    ) {
      return null;
    }
    // A gap between hunks is real skipped file, not an empty line.
    if (out.length > 0) out.push({ type: "hunk", text: "⋯" });
    let oldLn = hunk.oldStart;
    let newLn = hunk.newStart;
    for (const line of hunk.lines) {
      if (typeof line !== "string") continue;
      const mark = line[0];
      const text = line.slice(1);
      if (mark === "+") out.push({ type: "add", text, newLn: newLn++ });
      else if (mark === "-") out.push({ type: "del", text, oldLn: oldLn++ });
      else out.push({ type: "ctx", text, oldLn: oldLn++, newLn: newLn++ });
    }
  }
  return out.length > 0 ? out : null;
}

export interface EditPair {
  old: string;
  new: string;
}

/**
 * Undo the server's naive `- old… / + new…` rendering back into the two
 * strings it was built from. The format is strictly "every removed line, then
 * every added line", so the added block is the trailing run of `+ ` rows —
 * an original line that itself began with `+ ` still carries a `- ` prefix and
 * therefore ends the scan correctly.
 */
function parseNaiveEditDetail(detail: string): EditPair | null {
  const lines = detail.split("\n");
  let split = lines.length;
  while (split > 0 && lines[split - 1]!.startsWith("+ ")) split--;
  if (split === lines.length) return null; // nothing added: not this format
  for (let i = 0; i < split; i++) {
    if (!lines[i]!.startsWith("- ")) return null;
  }
  const strip = (from: number, to: number) =>
    lines.slice(from, to).map((l) => l.slice(2)).join("\n");
  return { old: strip(0, split), new: strip(split, lines.length) };
}

function parseMultiEditDetail(detail: string): EditPair[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const edits = (parsed as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const out: EditPair[] = [];
  for (const raw of edits) {
    if (typeof raw !== "object" || raw === null) return null;
    const edit = raw as { old_string?: unknown; new_string?: unknown };
    out.push({
      old: typeof edit.old_string === "string" ? edit.old_string : "",
      new: typeof edit.new_string === "string" ? edit.new_string : "",
    });
  }
  return out;
}

/**
 * The old/new pairs behind a tool call, recovered from the `detail` the server
 * already sends. `null` when the detail is not in a shape this understands.
 */
export function editsFromDetail(toolName: string, detail: string | null): EditPair[] | null {
  if (detail === null || detail === "") return null;
  if (toolName === "Write") return [{ old: "", new: detail }];
  if (toolName === "MultiEdit") return parseMultiEditDetail(detail);
  if (toolName === "Edit") {
    const pair = parseNaiveEditDetail(detail);
    return pair ? [pair] : null;
  }
  return null;
}

/**
 * Rows for one edit call: the CLI's structured patch when the result carried
 * one, otherwise a diff recomputed from the call's own detail. `null` means
 * neither source produced anything, and the caller should keep the plain
 * detail rendering.
 */
export function diffRowsFor(
  toolName: string | null,
  detail: string | null,
  hunks: PatchHunk[] | null | undefined,
): DiffRow[] | null {
  if (!toolName || !DIFF_TOOLS.has(toolName)) return null;
  const fromPatch = rowsFromPatch(hunks);
  if (fromPatch) return fromPatch;
  const edits = editsFromDetail(toolName, detail);
  if (!edits) return null;
  const rows = edits.flatMap((edit, i) => {
    const diff = lineDiff(edit.old, edit.new);
    return i > 0 ? [{ type: "hunk" as const, text: "⋯" }, ...diff] : diff;
  });
  return rows.length > 0 ? rows : null;
}

/** `+N −M` for a diff card's summary line. */
export function diffStats(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === "add") adds++;
    else if (row.type === "del") dels++;
  }
  return { adds, dels };
}
