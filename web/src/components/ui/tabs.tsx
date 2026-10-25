import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import { cn } from "@/lib/cn";

export const Tabs = BaseTabs.Root;

/**
 * A segmented control: joined boxes in one `border-strong` frame, the chosen
 * one inked in. 32px outside (36px on a phone's category strip), no inner
 * padding, 13px sans like every other field (docs/ui-spec.md §2).
 */
export function TabsList({ className, ...props }: React.ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn("flex h-8 items-stretch border border-border-strong bg-bg", className)}
      {...props}
    />
  );
}

export function TabsTab({ className, ...props }: React.ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "flex flex-1 items-center justify-center border-r border-border px-3 text-[13px] font-medium text-muted last:border-r-0",
        // The focus ring sits outside the tab (base layer, 2px ink, 1px off).
        // It used to be drawn 2px inside, on top of the active tab's ink fill,
        // so a keyboard user saw nothing (docs/ui-spec.md §7 V3).
        "select-none hover:text-fg",
        "data-[active]:border-fg data-[active]:bg-fg data-[active]:text-bg",
        className,
      )}
      {...props}
    />
  );
}
