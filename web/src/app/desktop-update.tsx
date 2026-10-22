import { ArrowUpCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/*
 * Inside the Droppen desktop app, once the app has downloaded and verified its
 * next version: a quiet entry at the bottom of the rail — 「新版本已就绪 ·
 * 重启」 — that never covers content and can be put away. The app installs the
 * update at its next quit anyway; the entry only offers to do it now.
 *
 * The app tells the page through a small bridge its init script sets up
 * (`desktop/src-tauri/src/init.js`, part 4), until the app↔server control
 * channel replaces it: `window.__droppenDesktop.updateState()` is the app's
 * update status (only the app, which knows the launch's nonce, can set it),
 * a `droppen:update` event says it changed, and `restartToUpdate()` asks the
 * app to restart into the new version — which it does only if one is ready.
 * In a browser, or under an app without the bridge, there is nothing here.
 */

/** What the app's bridge offers the page. */
type DesktopBridge = {
  updateState?: () => unknown;
  restartToUpdate?: () => void;
};

/** Where a dismissal is kept: the version put away, so a newer one shows again. */
const DISMISSED_KEY = "droppen.desktop.update-dismissed";

/** The version ready to restart into, from the app's update status, unless that version was put away. */
export function readyVersion(status: unknown, dismissed: string | null): string | null {
  if (!status || typeof status !== "object") return null;
  const { state, release } = status as { state?: unknown; release?: unknown };
  if (state !== "ready" || !release || typeof release !== "object") return null;
  const version = (release as { version?: unknown }).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  return version === dismissed ? null : version;
}

function bridge(): DesktopBridge | undefined {
  return (window as unknown as { __droppenDesktop?: DesktopBridge }).__droppenDesktop;
}

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** The version ready to restart into, following the app's bridge; null in a browser. */
export function useDesktopUpdate(): { version: string | null; dismiss: () => void } {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setVersion(readyVersion(bridge()?.updateState?.(), dismissedVersion()));
    read();
    window.addEventListener("droppen:update", read);
    return () => window.removeEventListener("droppen:update", read);
  }, []);
  const dismiss = () => {
    if (!version) return;
    try {
      localStorage.setItem(DISMISSED_KEY, version);
    } catch {
      // put away for this page only
    }
    setVersion(null);
  };
  return { version, dismiss };
}

/** The entry itself, given the version; split out so it renders without the app. */
export function DesktopUpdateEntry({ version, onRestart, onDismiss }: { version: string; onRestart: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const title = t("Droppen {{version}} is ready · restart to update", { version });
  return (
    <div className="group relative md:mb-1" data-testid="desktop-update">
      <button
        type="button"
        onClick={onRestart}
        title={title}
        aria-label={title}
        className="flex items-center gap-1 border border-border-strong px-1.5 py-1 text-fg hover:bg-hover max-md:h-7 md:w-10 md:flex-col md:gap-0.5 md:px-0"
      >
        <ArrowUpCircle className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="font-mono text-[9px] leading-none">{t("restart")}</span>
      </button>
      <button
        type="button"
        title={t("dismiss")}
        aria-label={t("dismiss")}
        onClick={onDismiss}
        className="absolute -top-1.5 -right-1.5 hidden size-3.5 items-center justify-center bg-fg text-bg group-hover:flex group-focus-within:flex"
      >
        <X className="size-2.5" />
      </button>
    </div>
  );
}

/** At the bottom of the rail, when the desktop app has an update ready. */
export function DesktopUpdate() {
  const { version, dismiss } = useDesktopUpdate();
  if (!version) return null;
  return <DesktopUpdateEntry version={version} onRestart={() => bridge()?.restartToUpdate?.()} onDismiss={dismiss} />;
}
