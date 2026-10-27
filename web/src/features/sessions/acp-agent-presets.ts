import presets from "./acp-agent-presets.json";

/**
 * A known ACP agent the settings can fill in: how it is started in ACP mode
 * over stdio. Data, not code — the list is `acp-agent-presets.json`, and
 * nothing here names an agent.
 */
export interface AcpAgentPreset {
  /** Stable key for the picker. */
  id: string;
  /** What the agent is called; shown as is, never translated. */
  name: string;
  /** The executable, as found on the `PATH`. */
  command: string;
  /** The arguments that put it into ACP mode. */
  args: string[];
  /** Its mark: a file in `presets/icons/`, drawn as path data. */
  icon?: string;
  /** Where its ACP setup is documented. */
  homepage?: string;
  /** A short hint: what it needs before it can run. */
  note?: string;
}

/** Every preset, in the order the picker offers them. */
export const ACP_AGENT_PRESETS: readonly AcpAgentPreset[] = presets;

/** The picker's "no preset" choice: whatever is typed. */
export const CUSTOM_PRESET = "custom";

export function presetById(id: string): AcpAgentPreset | undefined {
  return ACP_AGENT_PRESETS.find((preset) => preset.id === id);
}

/** The settings form's unsaved edits: `null` is a field left as saved. */
export interface AcpAgentDraft {
  name: string | null;
  command: string | null;
  args: string | null;
}

/**
 * The draft after picking `id`: a preset fills in its name, executable and
 * arguments, which stay editable; the custom choice leaves every field alone.
 * Nothing is saved either way.
 */
export function applyPreset(draft: AcpAgentDraft, id: string, presets: readonly AcpAgentPreset[] = ACP_AGENT_PRESETS): AcpAgentDraft {
  const preset = presets.find((candidate) => candidate.id === id);
  if (!preset) return draft;
  return { name: preset.name, command: preset.command, args: preset.args.join(" ") };
}

/** The preset a saved configuration was made from, if its command line is one. */
export function matchingPreset(
  saved: { command: string; args: readonly string[] } | undefined,
  presets: readonly AcpAgentPreset[] = ACP_AGENT_PRESETS,
): AcpAgentPreset | undefined {
  if (!saved?.command) return undefined;
  return presets.find(
    (preset) => preset.command === saved.command && preset.args.join(" ") === saved.args.join(" "),
  );
}
