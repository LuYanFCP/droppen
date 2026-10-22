import assert from "node:assert/strict";
import test from "node:test";
import { isScreenEmoji, SCREEN_EMOJIS } from "../src/features/screens/screen-emoji.js";

test("the screen palette contains unique, valid single emoji", () => {
  assert.equal(new Set(SCREEN_EMOJIS).size, SCREEN_EMOJIS.length);
  for (const emoji of SCREEN_EMOJIS) assert.ok(isScreenEmoji(emoji), emoji);
});

test("custom screen emoji preserve joined glyphs, skin tones, flags and keycaps", () => {
  for (const emoji of ["🐙", "🛠️", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇯🇵", "1️⃣", "#️⃣", "🏳️‍🌈"]) {
    assert.ok(isScreenEmoji(emoji), emoji);
    assert.ok(isScreenEmoji(`  ${emoji}  `), "surrounding whitespace is trimmed");
  }
});

test("screen icons reject text, multiple emoji, partial flags and oversized graphemes", () => {
  for (const invalid of ["", "  ", "work", "1", "#", "🇯", "🐙🚀", "🐙 work", "🐙\n🚀", "<script>", `🐙${"\uFE0F".repeat(32)}`]) {
    assert.equal(isScreenEmoji(invalid), false, JSON.stringify(invalid));
  }
});
