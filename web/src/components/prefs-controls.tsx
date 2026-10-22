import { Menu } from "@base-ui-components/react/menu";
import { Check, Globe, Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { applyLanguage, type LanguagePref } from "@/i18n";
import { cn } from "@/lib/cn";
import { applyThemeMode, storedThemeMode, type ThemeMode } from "@/lib/theme";

/*
 * Language and theme for the public pages (the landing page, sign-in and
 * sign-up), at the right of their header beside the way in: two compact
 * 36px controls with hairline frames. Language opens a square menu of the
 * four languages, each in its own script; theme cycles auto → light → dark,
 * as the app's own toggle does.
 */

const LANGUAGES: { id: Exclude<LanguagePref, "auto">; label: string }[] = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
];

const NEXT_MODE: Record<ThemeMode, ThemeMode> = { auto: "light", light: "dark", dark: "auto" };
const MODE_ICONS: Record<ThemeMode, typeof Sun> = { auto: Monitor, light: Sun, dark: Moon };

const control = "flex h-9 shrink-0 items-center justify-center gap-1.5 border border-border-strong bg-bg text-muted hover:bg-hover hover:text-fg";

export function PrefsControls() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      return storedThemeMode();
    } catch {
      return "auto";
    }
  });
  const active = LANGUAGES.find((l) => l.id === i18n.language) ?? LANGUAGES[LANGUAGES.length - 1]!;
  const Icon = MODE_ICONS[theme];
  const themeLabel = t("theme: {{mode}} (click for {{next}})", { mode: t(theme), next: t(NEXT_MODE[theme]) });
  return (
    <div data-prefs="" className="flex shrink-0 items-center gap-2">
      <Menu.Root>
        <Menu.Trigger aria-label={t("language")} title={t("language")} className={cn(control, "px-2.5 font-mono text-2xs")}>
          <Globe className="size-3.5" />
          <span>{active.id}</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
            <Menu.Popup className="min-w-36 border border-border-strong bg-bg py-1 outline-none">
              <Menu.RadioGroup value={active.id} onValueChange={(value: LanguagePref) => applyLanguage(value)}>
                {LANGUAGES.map((l) => (
                  <Menu.RadioItem
                    key={l.id}
                    value={l.id}
                    lang={l.id}
                    closeOnClick
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs text-fg outline-none data-[highlighted]:bg-hover"
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <Menu.RadioItemIndicator>
                        <Check className="size-3.5" />
                      </Menu.RadioItemIndicator>
                    </span>
                    {l.label}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button
        type="button"
        onClick={() => {
          const next = NEXT_MODE[theme];
          applyThemeMode(next);
          setTheme(next);
        }}
        title={themeLabel}
        aria-label={themeLabel}
        className={cn(control, "w-9")}
      >
        <Icon className="size-3.5" />
      </button>
    </div>
  );
}
