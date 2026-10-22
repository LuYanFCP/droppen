import { cn } from "@/lib/cn";

/**
 * A machine label: mono, uppercase, 0.12em tracking, muted (docs/ui-spec.md §1).
 * Section titles, table heads, message roles. `data-label` lets a UI scan
 * check the rule (docs/ui-spec.md V6). Uppercase is a no-op on CJK.
 */
export function CapsLabel({
  className,
  size = "sm",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { size?: "sm" | "xs" }) {
  return (
    <span
      data-label=""
      className={cn("label-caps text-muted", size === "xs" ? "text-[10px] leading-[14px]" : "text-2xs", className)}
      {...props}
    />
  );
}
