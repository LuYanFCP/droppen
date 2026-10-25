import { cn } from "@/lib/cn";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        // A form field on the drafting sheet: 32px desktop / 40px under a
        // finger, 12px in, 13px sans. Keyboard focus is the base layer's 2px
        // ink ring (index.css); the border darkening is an extra, never the
        // only indicator.
        "h-8 w-full border border-border bg-bg px-3 text-[13px] text-fg max-md:h-10",
        "placeholder:text-faint hover:border-border-strong focus:border-fg",
        className,
      )}
      {...props}
    />
  );
}
