/**
 * The settings page's one skeleton (docs/ui-spec.md §3/§4), shared by every
 * section so they cannot drift apart again:
 *
 * - one content column, 48rem;
 * - from a 36rem container up, a two-column row with a 16rem label, a 14rem
 *   control and a 16px gap — every control in a section shares both edges;
 * - 44px rows, 56px when the row carries a hint;
 * - label 13/18 at 500, hint 12/18 muted, value 13/18;
 * - section titles 8px above their content, on the same left edge as the page
 *   title (`settings-view.tsx` puts both at a 12px inset).
 *
 * These are strings, not components: the sections keep their own markup and
 * the classes only pin the measurements.
 */

/** The column every section's content sits in. */
export const SETTINGS_COLUMN = "w-full max-w-3xl";

/** A section's title strip: full-bleed hairline, 8px below. */
export const SECTION_TITLE =
  "label-caps -mx-3 -mt-3 mb-2 flex h-9 items-center border-b border-border px-3 text-2xs text-fg";

/**
 * One preference row. Below 36rem the hint sits above the control; from 36rem
 * the control is a fixed 14rem column, so the page reads as a form.
 */
export const PREFERENCE_ROW =
  "flex min-h-14 w-full max-w-3xl flex-col items-start gap-2 py-2 @min-[36rem]/settings:grid @min-[36rem]/settings:grid-cols-[16rem_14rem] @min-[36rem]/settings:items-center @min-[36rem]/settings:gap-4";

/** A row without a hint: 44px. */
export const PREFERENCE_ROW_TIGHT =
  "flex min-h-11 w-full max-w-3xl flex-col items-start gap-2 py-2 @min-[36rem]/settings:grid @min-[36rem]/settings:grid-cols-[16rem_14rem] @min-[36rem]/settings:items-center @min-[36rem]/settings:gap-4";

/** The label/value type of a setting row. */
export const ROW_LABEL = "text-[13px] leading-[18px] font-medium text-fg";
export const ROW_HINT = "text-xs leading-[18px] text-muted";
export const ROW_VALUE = "text-[13px] leading-[18px] text-fg";

/** A form field in a settings section: 32px desktop, 40px on a phone, 13px. */
export const SETTINGS_FIELD =
  "h-8 w-full border border-border bg-bg px-3 text-[13px] text-fg placeholder:text-faint hover:border-border-strong focus:border-fg max-md:h-10 max-md:text-base";

/** A settings action: 28px, sans 12/500 (not hand-written mono 11). */
const ACTION = "flex h-7 items-center justify-center gap-1.5 border px-3 text-xs font-medium disabled:opacity-40";
export const SETTINGS_ACTION = `${ACTION} border-border-strong bg-bg text-fg hover:bg-hover`;
export const SETTINGS_ACTION_PRIMARY = `${ACTION} border-fg bg-fg text-bg hover:bg-fg/85`;
export const SETTINGS_ACTION_DANGER = `${ACTION} border-danger/55 bg-bg text-danger hover:bg-hover`;
