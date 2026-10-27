import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import presets from "../src/features/sessions/acp-agent-presets.json";
import { parseSvgGlyph } from "../src/components/glyph.js";
import {
  ACP_AGENT_PRESETS,
  applyPreset,
  CUSTOM_PRESET,
  matchingPreset,
  type AcpAgentDraft,
} from "../src/features/sessions/acp-agent-presets.js";

const ICONS = fileURLToPath(new URL("../src/features/sessions/presets/icons/", import.meta.url));

test("every preset is well-formed: a unique id, a name, one executable and its arguments", () => {
  assert.ok(Array.isArray(presets) && presets.length > 0, "at least one preset");
  const ids = new Set<string>();
  for (const entry of presets as unknown[]) {
    assert.equal(typeof entry, "object");
    const preset = entry as Record<string, unknown>;
    const known = ["id", "name", "command", "args", "icon", "homepage", "note"];
    assert.deepEqual(Object.keys(preset).filter((key) => !known.includes(key)), [], `no unknown fields: ${JSON.stringify(preset)}`);
    assert.ok(typeof preset.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(preset.id), `id: ${String(preset.id)}`);
    assert.notEqual(preset.id, CUSTOM_PRESET, "the custom choice is not a preset");
    assert.ok(!ids.has(preset.id), `duplicate id ${preset.id}`);
    ids.add(preset.id);
    assert.ok(typeof preset.name === "string" && preset.name.trim() === preset.name && preset.name.length > 0, `name of ${preset.id}`);
    // One executable, looked up on the PATH: no arguments folded into it.
    assert.ok(typeof preset.command === "string" && /^[^\s/]+$/.test(preset.command), `command of ${preset.id}`);
    // Arguments are split on whitespace when typed, so none may hold any.
    assert.ok(Array.isArray(preset.args), `args of ${preset.id}`);
    for (const arg of preset.args as unknown[]) {
      assert.ok(typeof arg === "string" && arg.length > 0 && !/\s/.test(arg), `an argument of ${preset.id}: ${String(arg)}`);
    }
    if ("icon" in preset) {
      assert.ok(typeof preset.icon === "string" && /^[a-z0-9-]+\.svg$/.test(preset.icon), `icon of ${preset.id}: a file name`);
      assert.ok(readdirSync(ICONS).includes(preset.icon), `icon of ${preset.id}: ${preset.icon} is in presets/icons/`);
    }
    if ("homepage" in preset) {
      assert.ok(typeof preset.homepage === "string" && new URL(preset.homepage).protocol === "https:", `homepage of ${preset.id}`);
    }
    if ("note" in preset) {
      assert.ok(typeof preset.note === "string" && preset.note.length > 0 && !preset.note.includes("\n"), `note of ${preset.id}`);
    }
  }
});

test("choosing a preset fills in the name, executable and arguments, and nothing else", () => {
  const draft: AcpAgentDraft = { name: null, command: "/typed/before", args: null };
  const preset = ACP_AGENT_PRESETS[0]!;
  assert.deepEqual(applyPreset(draft, preset.id), {
    name: preset.name,
    command: preset.command,
    args: preset.args.join(" "),
  });
  const two = { id: "two", name: "Two", command: "two", args: ["--acp", "--stdio"] };
  assert.deepEqual(applyPreset(draft, "two", [two]), { name: "Two", command: "two", args: "--acp --stdio" });
});

test("the custom choice leaves every field as it is", () => {
  const typed: AcpAgentDraft = { name: "Mine", command: "/opt/mine", args: "serve --acp" };
  assert.equal(applyPreset(typed, CUSTOM_PRESET), typed);
  const untouched: AcpAgentDraft = { name: null, command: null, args: null };
  assert.deepEqual(applyPreset(untouched, CUSTOM_PRESET), untouched);
});

test("a saved command line is recognised as the preset it came from; nothing saved is no preset", () => {
  const two = { id: "two", name: "Two", command: "two", args: ["acp"] };
  assert.equal(matchingPreset({ command: "two", args: ["acp"] }, [two])?.id, "two");
  assert.equal(matchingPreset({ command: "two", args: [] }, [two]), undefined);
  assert.equal(matchingPreset({ command: "", args: [] }, [two]), undefined);
  assert.equal(matchingPreset(undefined, [two]), undefined);
});

test("every preset icon is path data on a view box, and nothing else", () => {
  const files = readdirSync(ICONS).filter((file) => file.endsWith(".svg"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const glyph = parseSvgGlyph(file, readFileSync(ICONS + file, "utf8"));
    assert.ok(glyph, `${file} parses as a glyph`);
    assert.equal(glyph.viewBox, "0 0 24 24", `${file} draws on the 24-unit box the other marks use`);
  }
  // Markup beyond paths is refused rather than drawn.
  assert.equal(parseSvgGlyph("x", '<svg viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0h1Z"/></svg>'), null);
  assert.equal(parseSvgGlyph("x", '<svg viewBox="0 0 24 24"><path d="M0 0h1Z" onclick="x"/></svg>'), null);
  assert.deepEqual(parseSvgGlyph("x", '<svg viewBox="0 0 24 24">\n<!-- source -->\n<path d="M0 0h1Z"/></svg>\n')?.paths, ["M0 0h1Z"]);
});
