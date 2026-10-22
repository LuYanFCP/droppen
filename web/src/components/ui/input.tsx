import { cn } from "@/lib/cn";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-6.5 w-full border border-border bg-bg px-2 text-xs text-fg",
        "placeholder:text-faint focus:border-fg focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}
