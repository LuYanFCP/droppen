/**
 * "Add to home screen", and knowing whether we are already there.
 *
 * `beforeinstallprompt` fires once, very early, and only on Chromium. The
 * listener therefore has to be installed at module scope and the module
 * imported from main.tsx before React mounts — a listener attached from a
 * settings component would miss the event and the install button would never
 * appear. preventDefault() also suppresses Chrome's own mini-infobar, which is
 * the price of deferring the prompt to our button.
 *
 * Nothing here exists on iOS: Safari has no install API at all, so the settings
 * section falls back to telling the user where the Share sheet is.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  // Installed by any route (our button, or the browser's own menu): the stashed
  // event is spent and the offer must go away.
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

/** Fires whenever `installPromptAvailable()` may have changed. */
export function subscribeInstall(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function installPromptAvailable(): boolean {
  return deferred !== null;
}

/**
 * Show the browser's install dialog. Must be called from a user gesture, and
 * the event is single-use whatever the user picks — a dismissed prompt is not
 * offered again until the browser decides to fire a fresh one.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (event === null) return false;
  deferred = null;
  emit();
  await event.prompt();
  return (await event.userChoice).outcome === "accepted";
}

/** Running from the home screen / app window rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's pre-standards flag, still the only signal it gives.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPadOS 13+ reports MacIntel, hence the touch-point check — same sniff as
 *  index.html's boot script. Split out from `navigator` so it is testable. */
export function isIosPlatform(ua: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function isIos(): boolean {
  return isIosPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
}

/**
 * What the settings section should offer. `hidden` is the desktop-browser and
 * already-dismissed case: there is no prompt to give and no manual recipe worth
 * printing, so the section renders nothing at all.
 */
export type InstallState = "installed" | "promptable" | "ios-hint" | "hidden";

export function installState(env: {
  standalone: boolean;
  promptable: boolean;
  ios: boolean;
}): InstallState {
  if (env.standalone) return "installed";
  if (env.promptable) return "promptable";
  return env.ios ? "ios-hint" : "hidden";
}
