import { localize } from "@droppen/plugin-sdk";
import { Link } from "@tanstack/react-router";
import { RailHint } from "@/components/ui/rail-hint";
import { PluginIcon } from "./boundary";
import { hostLocale } from "./host";
import { usePluginRegistry } from "./registry";

/** The running plugins' navigation entries, in the shell's rail style. */
export function PluginNav({ className }: { className: string }) {
  const { active } = usePluginRegistry();
  const locale = hostLocale();
  return active.flatMap((plugin) =>
    (plugin.contributions.nav ?? []).map((item, index) => {
      const label = localize(item.label, locale);
      return (
        <RailHint
          key={`${plugin.id}-${index}`}
          label={label}
          render={
            <Link
              to="/p/$plugin/$"
              params={{ plugin: plugin.id, _splat: (item.path ?? "").replace(/^\/+/, "") }}
              aria-label={label}
              data-plugin={plugin.id}
              className={className}
              activeProps={{ className: "!bg-fg !text-bg" }}
            />
          }
        >
          <PluginIcon host={plugin.host} icon={item.icon} className="size-4" />
        </RailHint>
      );
    }),
  );
}
