import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import { cn } from "@/lib/cn";

export const Tabs = BaseTabs.Root;

/**
 * A segmented control: joined boxes in one `border-strong` frame, the chosen
 * one inked in. 26px outside, no inner padding (docs/ui-spec.md §2).
 */
export function TabsList({ className, ...props }: React.ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn("flex h-6.5 items-stretch border border-border-strong bg-bg", className)}
      {...props}
    />
  );
}

export function TabsTab({ className, ...props }: React.ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "flex flex-1 items-center justify-center border-r border-border px-2 font-mono text-2xs font-medium text-muted last:border-r-0",
        "select-none hover:text-fg focus-visible:-outline-offset-2",
        "data-[active]:border-fg data-[active]:bg-fg data-[active]:text-bg",
        className,
      )}
      {...props}
    />
  );
}
