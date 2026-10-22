/**
 * Plugin news from the global feed, for the host's registry and storage.
 *
 * The feed (`app/global-feed.tsx`) hands every `plugin-doc` and `plugins` frame
 * here, and says when it has reconnected (a `sessions:snapshot`), after which
 * anything a plugin is watching may have changed unseen and is re-read.
 * Module-level like the feed itself: there is one socket per page.
 */
import type { PluginStatus } from "./types";

export interface PluginDocEvent {
  plugin: string;
  name: string;
  /** `null` after a reconnect: re-read, the revision is unknown. */
  revision: number | null;
}

type DocListener = (event: PluginDocEvent) => void;
type StatusListener = (statuses: PluginStatus[]) => void;

const docListeners = new Set<DocListener>();
const statusListeners = new Set<StatusListener>();

export const pluginEvents = {
  onDoc(listener: DocListener): () => void {
    docListeners.add(listener);
    return () => docListeners.delete(listener);
  },
  onStatuses(listener: StatusListener): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
  /** A frame off the feed; `true` when it was a plugin frame. */
  takeFrame(frame: { type?: unknown; [key: string]: unknown }): boolean {
    if (frame.type === "plugin-doc") {
      const { plugin, name, revision } = frame;
      if (typeof plugin !== "string" || typeof name !== "string") return true;
      const event = { plugin, name, revision: typeof revision === "number" ? revision : null };
      for (const listener of [...docListeners]) listener(event);
      return true;
    }
    if (frame.type === "plugins") {
      if (Array.isArray(frame.plugins)) {
        for (const listener of [...statusListeners]) listener(frame.plugins as PluginStatus[]);
      }
      return true;
    }
    return false;
  },
  /** The feed reconnected: every watched document may have moved. */
  resync(): void {
    for (const listener of [...docListeners]) listener({ plugin: "*", name: "*", revision: null });
  },
};
