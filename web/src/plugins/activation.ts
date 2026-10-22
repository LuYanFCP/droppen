/**
 * Loading and activating a bundled plugin: once per machine and plugin, for
 * the life of the page, whatever remounts.
 *
 * A plugin's host is bound to a machine — its storage reads and writes that
 * machine's documents (`httpStorage(id, machine)`). The machine is the home
 * (`lib/machines/registry.ts`), and on droppen.app the home moves when the
 * person switches machines; an activation kept by plugin alone would go on
 * reading and writing the first machine's documents after the switch. So an
 * activation is kept per (machine, plugin), and the page's other machine gets
 * its own host when it is the home. A machine closed on the page takes its
 * activations with it (`perMachine`).
 */
import type { PluginContributions, PluginDefinition, PluginHost } from "@droppen/plugin-sdk";
import i18n from "i18next";
import type { BundledPlugin } from "virtual:droppen/bundled-plugins";
import type { MachineKey } from "@/lib/machines/key";
import { perMachine } from "@/lib/machines/registry";
import { createPluginHost, pluginNamespace } from "./host";

export type Activation = { ok: true; definition: PluginDefinition; host: PluginHost; contributions: PluginContributions } | { ok: false; error: string };

/** Each machine's activations, by plugin id; dropped when the machine is closed. */
const activationsOf = perMachine(() => new Map<string, Promise<Activation>>());

/** The activation of `bundled` on `machine`: loaded, checked and activated on first ask, then the same one. */
export function activatePlugin(bundled: BundledPlugin, navigate: (id: string, path: string) => void, machine: MachineKey): Promise<Activation> {
  const activations = activationsOf(machine);
  const key = bundled.id;
  let pending = activations.get(key);
  if (!pending) {
    pending = (async (): Promise<Activation> => {
      try {
        const mod = await bundled.load();
        const definition = mod.default;
        if (!definition || typeof definition.activate !== "function") throw new Error("the entry module has no default definePlugin(...) export");
        if (definition.manifest?.id !== bundled.id)
          throw new Error(`the package says it is "${definition.manifest?.id}", the build bundled it as "${bundled.id}"`);
        const host = createPluginHost(bundled.id, { navigate: (path) => navigate(bundled.id, path), machine });
        const contributions = definition.activate(host) ?? {};
        for (const [locale, strings] of Object.entries(contributions.i18n ?? {})) {
          if (strings) i18n.addResourceBundle(locale, pluginNamespace(bundled.id), strings, true, true);
        }
        return { ok: true, definition, host, contributions };
      } catch (error) {
        // A chunk that failed to download may succeed on the next attempt.
        activations.delete(key);
        const message = error instanceof Error ? error.message : String(error);
        console.error(`plugin ${bundled.id} failed to start:`, error);
        return { ok: false, error: message };
      }
    })();
    activations.set(key, pending);
  }
  return pending;
}
