/**
 * Settings › Plugins: what this build bundles, which are on for this
 * instance, and the settings blocks the running plugins contribute.
 *
 * Any signed-in user of the instance may switch a plugin (there are no roles);
 * a switch the configuration pins (`[plugins] enable/disable`) is read-only
 * and says so. Switching off keeps the plugin's data.
 */
import { localize } from "@droppen/plugin-sdk";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { distribution } from "virtual:droppen/bundled-plugins";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { PluginBoundary } from "./boundary";
import { hostLocale } from "./host";
import { usePluginRegistry } from "./registry";
import type { PluginStatus } from "./types";
import { useApi } from "@/lib/machines/context";

const row =
  "flex max-w-xl flex-col items-start gap-2 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-4";

function PluginRow({ id }: { id: string }) {
  const api = useApi();
  const { t } = useTranslation();
  const registry = usePluginRegistry();
  const bundled = registry.bundled.find((b) => b.id === id)!;
  const status = registry.statuses?.find((s) => s.id === id);
  const name = localize(bundled.manifest.name, hostLocale());
  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await api.PUT("/api/plugins/{id}/enabled", { params: { path: { id } }, body: { enabled } });
      if (!res.data) {
        const body = res.error as { error?: string; message?: string } | undefined;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.response.status}`);
      }
      return res.data as PluginStatus;
    },
    onSuccess: (next) => registry.adopt(next),
  });
  const failure = registry.errors[id];
  const notes = [
    status && !status.compatible ? t("not compatible with this version of Droppen") : null,
    status?.reason ?? null,
    status?.notice ?? null,
    failure ? t("could not start: {{error}}", { error: failure }) : null,
    toggle.isError ? toggle.error.message : null,
  ].filter((note): note is string => !!note);
  return (
    <div className={cn(row, "mt-3 first:mt-0")} data-plugin-row={id}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-xs">
          <span>{name}</span>
          <span className="font-mono text-2xs text-faint tabular-nums">
            {id} · v{bundled.manifest.version}
          </span>
        </div>
        {notes.map((note) => (
          <div key={note} data-signal={failure || toggle.isError ? "failed" : undefined} className={cn("text-2xs break-words", failure || toggle.isError ? "text-danger" : "text-faint")}>
            {note}
          </div>
        ))}
        {status?.forced && <div className="text-2xs text-faint">{t("set by the server configuration")}</div>}
      </div>
      {status ? (
        <Tabs
          className="max-w-full shrink-0"
          value={status.enabled ? "on" : "off"}
          onValueChange={(v) => {
            if (!status.forced && !toggle.isPending) toggle.mutate(v === "on");
          }}
        >
          <TabsList className={cn("w-40", (status.forced || !status.compatible) && "opacity-50")} aria-label={t("{{name}} plugin", { name })}>
            <TabsTab value="off" disabled={status.forced || toggle.isPending}>
              {t("disabled")}
            </TabsTab>
            <TabsTab value="on" disabled={status.forced || !status.compatible || toggle.isPending}>
              {t("enabled")}
            </TabsTab>
          </TabsList>
        </Tabs>
      ) : (
        <span className="font-mono text-2xs text-faint">…</span>
      )}
    </div>
  );
}

export function PluginsSection() {
  const { t } = useTranslation();
  const registry = usePluginRegistry();
  const settings = registry.active.flatMap((plugin) =>
    (plugin.contributions.settings ?? []).map((block, index) => ({ plugin, block, key: `${plugin.id}-${index}` })),
  );
  return (
    <>
      <section className="border-b border-border p-3">
        <h2 data-label="" className="label-caps -mx-3 -mt-3 mb-3 flex h-9 items-center border-b border-border px-3 text-2xs text-fg">
          {t("bundled plugins")}
        </h2>
        {registry.bundled.length === 0 ? (
          <p className="max-w-xl text-2xs text-faint">{t("This build of Droppen includes no plugins.")}</p>
        ) : (
          <>
            <p className="mb-3 max-w-xl text-2xs text-faint">
              {t("Plugins bundled with this build ({{distribution}}). Turning one off hides it on this instance and keeps its data.", {
                distribution,
              })}
            </p>
            {registry.bundled.map((b) => (
              <PluginRow key={b.id} id={b.id} />
            ))}
          </>
        )}
      </section>
      {settings.map(({ plugin, block, key }) => {
        const Block = block.component;
        const title = localize(block.title, hostLocale());
        return (
          <section key={key} className="border-b border-border p-3" data-plugin={plugin.id}>
            <h2 data-label="" className="label-caps -mx-3 -mt-3 mb-3 flex h-9 items-center border-b border-border px-3 text-2xs text-fg">
              {title}
            </h2>
            <PluginBoundary host={plugin.host} name={localize(plugin.bundled.manifest.name, hostLocale())}>
              <Block />
            </PluginBoundary>
          </section>
        );
      })}
    </>
  );
}
