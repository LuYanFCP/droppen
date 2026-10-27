import { parseSvgGlyph, type Glyph } from "@/components/glyph";
import { useAcpSettings } from "./acp-agent";
import { matchingPreset, type AcpAgentPreset } from "./acp-agent-presets";

/**
 * Every preset icon, by file name, as the build bundles them. Vite replaces
 * the call at build time; outside Vite (the unit tests run the sources
 * directly) there is no such function, and no icons.
 */
function bundledIcons(): Record<string, string> {
  try {
    return import.meta.glob<string>("./presets/icons/*.svg", { query: "?raw", import: "default", eager: true });
  } catch {
    return {};
  }
}
const FILES = bundledIcons();

const GLYPHS = new Map<string, Glyph>();
for (const [path, svg] of Object.entries(FILES)) {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const glyph = parseSvgGlyph(`acp-preset:${file}`, svg);
  if (glyph) GLYPHS.set(file, glyph);
}

/** The generic mark of an ACP agent: a terminal prompt, for any agent without one of its own. */
export const ACP_GLYPH: Glyph = {
  id: "acp",
  viewBox: "0 0 24 24",
  paths: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h16V6ZM6.3 9.4 7.7 8l4 4-4 4-1.4-1.4 2.6-2.6ZM12 14.5h5.5v1.8H12Z"],
};

/** A preset's icon, when it names one the build has. */
export function presetGlyph(preset: AcpAgentPreset | undefined): Glyph | undefined {
  return preset?.icon ? GLYPHS.get(preset.icon) : undefined;
}

/**
 * How the configured ACP agent is shown: the name it was given (or its
 * preset's), and its preset's icon when its command line is a preset's.
 * `glyph` is absent for anything else, which draws the generic mark.
 */
export function useAcpAgentLook(): { name: string | null; glyph: Glyph | undefined } {
  const { data: settings } = useAcpSettings();
  const preset = matchingPreset(settings);
  return { name: settings?.name || preset?.name || null, glyph: presetGlyph(preset) };
}
