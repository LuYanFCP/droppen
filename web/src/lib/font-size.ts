export type FontSize = "small" | "default" | "large" | "xlarge";

/**
 * Applied to the document root, so Tailwind's rem-based sizing scales the
 * whole UI coherently. Embedded apps (vscode, terminals) size themselves.
 */
export const FONT_SIZE_PCT: Record<FontSize, string> = {
  small: "87.5%",
  default: "100%",
  large: "112.5%",
  xlarge: "125%",
};

const KEY = "rh.fontSize";

/**
 * The server pref is the source of truth; localStorage only caches the last
 * applied value so the index.html boot script can avoid a resize flash.
 */
export function applyFontSize(size: FontSize): void {
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // storage unavailable: size still applies for this page
  }
  document.documentElement.style.fontSize = FONT_SIZE_PCT[size] ?? "100%";
}
