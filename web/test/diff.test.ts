import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../src/api/schema.js";
import {
  diffRowsFor,
  diffStats,
  editsFromDetail,
  lineDiff,
  LINE_DIFF_CELL_LIMIT,
  rowsFromPatch,
} from "../src/lib/diff.js";

type PatchHunk = components["schemas"]["PatchHunk"];

const hunk = (partial: Partial<PatchHunk>): PatchHunk => ({
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 0,
  lines: [],
  ...partial,
});

test("rowsFromPatch numbers rows from the hunk's own file offsets", () => {
  const rows = rowsFromPatch([
    hunk({
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      lines: [" keep", "-gone", "+added", " tail"],
    }),
  ]);
  assert.deepEqual(rows, [
    { type: "ctx", text: "keep", oldLn: 10, newLn: 10 },
    { type: "del", text: "gone", oldLn: 11 },
    { type: "add", text: "added", newLn: 11 },
    { type: "ctx", text: "tail", oldLn: 12, newLn: 12 },
  ]);
});

test("rowsFromPatch tracks the two sides independently across a lopsided hunk", () => {
  // Two removals and one addition: the old side must run ahead of the new one.
  const rows = rowsFromPatch([
    hunk({ oldStart: 5, newStart: 5, lines: ["-a", "-b", "+c", " d"] }),
  ])!;
  assert.deepEqual(
    rows.map((r) => [r.type, r.oldLn ?? null, r.newLn ?? null]),
    [
      ["del", 5, null],
      ["del", 6, null],
      ["add", null, 5],
      ["ctx", 7, 6],
    ],
  );
});

test("rowsFromPatch separates hunks with a gap marker", () => {
  const rows = rowsFromPatch([
    hunk({ oldStart: 1, newStart: 1, lines: ["+one"] }),
    hunk({ oldStart: 90, newStart: 91, lines: ["+two"] }),
  ])!;
  assert.equal(rows.length, 3);
  assert.equal(rows[1]!.type, "hunk");
  assert.equal(rows[2]!.newLn, 91);
});

test("rowsFromPatch declines anything it cannot number", () => {
  assert.equal(rowsFromPatch(null), null);
  assert.equal(rowsFromPatch(undefined), null);
  assert.equal(rowsFromPatch([]), null);
  // A hunk with no usable rows is not a diff worth drawing.
  assert.equal(rowsFromPatch([hunk({ lines: [] })]), null);
  const broken = [{ oldStart: 1, newStart: "nope", lines: [] }] as unknown as PatchHunk[];
  assert.equal(rowsFromPatch(broken), null);
});

test("lineDiff keeps the common lines as context", () => {
  const rows = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(rows, [
    { type: "ctx", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "B" },
    { type: "ctx", text: "c" },
  ]);
});

test("lineDiff treats empty text as no lines at all", () => {
  assert.deepEqual(lineDiff("", "only"), [{ type: "add", text: "only" }]);
  assert.deepEqual(lineDiff("", ""), []);
});

test("lineDiff normalises CRLF before comparing", () => {
  assert.deepEqual(lineDiff("a\r\nb", "a\nb"), [
    { type: "ctx", text: "a" },
    { type: "ctx", text: "b" },
  ]);
});

test("lineDiff degrades to all-removed + all-added past the cell guard", () => {
  // 501 × 501 = 251_001 cells, just over the limit, on texts that are almost
  // identical — so the guard is what produces the result, not the content.
  const side = 501;
  assert.ok(side * side > LINE_DIFF_CELL_LIMIT);
  const oldText = Array.from({ length: side }, (_, i) => `line ${i}`).join("\n");
  const newText = `${oldText}\nextra`.split("\n").slice(1).join("\n");
  const rows = lineDiff(oldText, newText);
  assert.equal(rows.length, side + side);
  assert.ok(!rows.some((r) => r.type === "ctx"), "the guard emits no context rows");
  assert.equal(rows[0]!.type, "del");
  assert.equal(rows[side]!.type, "add");
});

test("lineDiff still does real work just under the guard", () => {
  const side = 400; // 160_000 cells
  assert.ok(side * side < LINE_DIFF_CELL_LIMIT);
  const text = Array.from({ length: side }, (_, i) => `line ${i}`).join("\n");
  const rows = lineDiff(text, text);
  assert.equal(rows.length, side);
  assert.ok(rows.every((r) => r.type === "ctx"));
});

test("editsFromDetail recovers the two strings from the server's naive rendering", () => {
  // What the server sends for Edit: every removed line, then every added one.
  const detail = ["- old one", "- old two", "+ new one"].join("\n");
  assert.deepEqual(editsFromDetail("Edit", detail), [
    { old: "old one\nold two", new: "new one" },
  ]);
});

test("editsFromDetail is not fooled by an original line that starts with a plus", () => {
  // "+ x" as file content arrives prefixed as "- + x", so the trailing-plus
  // scan stops at it rather than stealing it for the added side.
  const detail = ["- a", "- + x", "+ b"].join("\n");
  assert.deepEqual(editsFromDetail("Edit", detail), [{ old: "a\n+ x", new: "b" }]);
});

test("editsFromDetail reads Write as a pure insertion and MultiEdit as JSON", () => {
  assert.deepEqual(editsFromDetail("Write", "hello\nworld"), [
    { old: "", new: "hello\nworld" },
  ]);
  const multi = JSON.stringify({
    file_path: "/x.ts",
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  });
  assert.deepEqual(editsFromDetail("MultiEdit", multi), [
    { old: "a", new: "b" },
    { old: "c", new: "d" },
  ]);
});

test("editsFromDetail declines details it does not understand", () => {
  assert.equal(editsFromDetail("Edit", null), null);
  assert.equal(editsFromDetail("Edit", "not a diff at all"), null);
  assert.equal(editsFromDetail("MultiEdit", "{not json"), null);
  assert.equal(editsFromDetail("Bash", "ls -la"), null);
});

test("diffRowsFor prefers the CLI's hunks over recomputing the diff", () => {
  const detail = ["- gone", "+ added"].join("\n");
  const rows = diffRowsFor("Edit", detail, [
    hunk({ oldStart: 42, newStart: 42, lines: [" ctx", "-gone", "+added"] }),
  ])!;
  // Real line numbers and a context row: only the patch can supply those.
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.oldLn, 42);
});

test("diffRowsFor falls back to a recomputed diff without hunks", () => {
  const rows = diffRowsFor("Edit", ["- a", "- b", "+ a", "+ c"].join("\n"), null)!;
  assert.deepEqual(rows, [
    { type: "ctx", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "c" },
  ]);
  assert.ok(rows.every((r) => r.oldLn === undefined && r.newLn === undefined));
});

test("diffRowsFor joins a MultiEdit's edits with a gap marker", () => {
  const multi = JSON.stringify({
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  });
  const rows = diffRowsFor("MultiEdit", multi, null)!;
  assert.equal(rows.filter((r) => r.type === "hunk").length, 1);
});

test("diffRowsFor leaves non-edit tools alone", () => {
  assert.equal(diffRowsFor("Bash", "ls", null), null);
  assert.equal(diffRowsFor(null, "whatever", null), null);
  assert.equal(diffRowsFor("Edit", null, null), null);
});

test("diffStats counts the whole change, not just the drawn rows", () => {
  const rows = diffRowsFor("Write", "one\ntwo\nthree", null)!;
  assert.deepEqual(diffStats(rows), { adds: 3, dels: 0 });
});
