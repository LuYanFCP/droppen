import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeFiles,
  directoryInput,
  fileBreadcrumbs,
  isPreviewImage,
  joinFilePath,
} from "../src/features/files/files-model.js";

const entries = [
  { name: "image10.png", kind: "file", sizeBytes: 200, mtime: "2026-09-13" },
  { name: "image2.png", kind: "file", sizeBytes: 500, mtime: "2026-09-14" },
  { name: "z-directory", kind: "dir", sizeBytes: null, mtime: null },
  { name: "unknown", kind: "symlink", sizeBytes: null, mtime: null },
];
test("file sorting is natural, directories first, and leaves cached data untouched", () => {
  const before = structuredClone(entries);
  assert.deepEqual(
    arrangeFiles(entries, "", "name").map((e) => e.name),
    ["z-directory", "image2.png", "image10.png", "unknown"],
  );
  for (const sort of ["modified", "size"] as const) {
    assert.deepEqual(
      arrangeFiles(entries, "", sort).map((e) => e.name),
      ["z-directory", "image2.png", "image10.png", "unknown"],
    );
  }
  assert.deepEqual(entries, before);
  assert.deepEqual(
    arrangeFiles(entries, " IMAGE ", "name").map((e) => e.name),
    ["image2.png", "image10.png"],
  );
  assert.deepEqual(arrangeFiles(entries, "missing", "name"), []);
});
test("directory input preserves absolute and home paths, resolving relative paths at the pane", () => {
  assert.equal(directoryInput("  ", "/home/me"), null);
  assert.equal(directoryInput(" ~/Pictures ", "/home/me/code"), "~/Pictures");
  assert.equal(directoryInput("~", "/home/me/code"), "~");
  assert.equal(
    directoryInput("/home/me/other", "/home/me/code"),
    "/home/me/other",
  );
  assert.equal(
    directoryInput("../other folder", "/home/me/code"),
    "/home/me/code/../other folder",
  );
  assert.equal(joinFilePath("/", "notes.txt"), "/notes.txt");
});
test("breadcrumbs respect the home boundary and preserve spaces and Unicode", () => {
  assert.deepEqual(fileBreadcrumbs("/home/me/项目/my files", "/home/me"), [
    { label: "~", path: "/home/me" },
    { label: "项目", path: "/home/me/项目" },
    { label: "my files", path: "/home/me/项目/my files" },
  ]);
  assert.deepEqual(fileBreadcrumbs("/home/me2", "/home/me"), [
    { label: "/home/me2", path: "/home/me2" },
  ]);
});
test("only raster images get an inline image preview", () => {
  for (const path of ["a.PNG", "photo.jpeg", "animation.webp"])
    assert.equal(isPreviewImage(path), true);
  for (const path of ["a.svg", "a.html", "a.png.txt", "a.pdf"])
    assert.equal(isPreviewImage(path), false);
});
