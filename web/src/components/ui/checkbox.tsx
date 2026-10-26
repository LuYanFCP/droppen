import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A square checkbox, drawn on the drafting sheet: a 14px `border-strong` box,
 * an ink fill and a 10px ink-on-paper check when chosen, a 2px ink ring on
 * keyboard focus, 16px under a finger. The real `<input type="checkbox">`
 * stays at the call site (its label, consent, `onChange` and form behaviour
 * are the page's), visually hidden; {@link CheckboxMark} is its sibling, so
 * `peer-*` reads the input's state.
 *
 * These are strings, not a wrapper component, for the same reason the settings
 * skeleton is (`features/settings/layout.ts`): a call site keeps the native
 * input in its own element tree, where tests and forms find it. Never leave a
 * native checkbox to the browser's own drawing, which is the one rounded, blue
 * control left on a square monochrome page.
 */
export const CHECKBOX_LABEL = "flex cursor-pointer items-start gap-2 text-2xs text-muted";
export const CHECKBOX_INPUT = "peer sr-only";
export const CHECKBOX_BOX = cn(
  "mt-0.5 flex size-3.5 shrink-0 items-center justify-center border border-border-strong bg-bg text-bg",
  "peer-checked:border-fg peer-checked:bg-fg peer-checked:[&>svg]:opacity-100",
  "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-fg",
  "peer-disabled:border-border pointer-coarse:size-4",
);

/** The box beside a `CHECKBOX_INPUT`; put it immediately after the input so `peer-*` matches. */
export function CheckboxMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" data-audit-checkbox="" className={cn(CHECKBOX_BOX, className)}>
      <Check className="size-2.5 opacity-0" />
    </span>
  );
}
