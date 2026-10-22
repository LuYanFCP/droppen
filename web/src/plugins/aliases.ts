import { bundledPlugins } from "virtual:droppen/bundled-plugins";

/** `"/tasks"` → `"tasks"`: every old top-level path a bundled plugin keeps. */
const ALIASES = new Map(bundledPlugins.flatMap((p) => p.manifest.aliases.map((alias) => [alias, p.id] as const)));

/** The plugin whose old path `pathname` is, if any. */
export function pluginAlias(pathname: string): string | undefined {
  if (!ALIASES.size) return undefined;
  return ALIASES.get(pathname.replace(/\/+$/, "") || "/");
}
