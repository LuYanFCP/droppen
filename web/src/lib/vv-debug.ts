/**
 * A live readout of the viewport numbers the keyboard moves, for a phone whose
 * keyboard still covers the composer: focus the composer and screenshot. It
 * reads the same in both keyboard handlings (`lib/kb-mode.ts`): `native`, where
 * WebKit reveals the field and nothing is sized (`lib/kb-native.ts`), and
 * `legacy`, where `lib/kb-inset.ts` sizes the shell from these numbers. Its
 * "kb … → …" button switches between them for this browser and reloads.
 *
 * Off unless asked for:
 *  - `?vvdebug=1` on any address turns it on, and it stays on in this browser
 *    (localStorage `rh.vvdebug`) until `?vvdebug=0`;
 *  - the Home Screen app has no address bar, and keeps its storage apart from
 *    Safari's: there (and anywhere else), two fingers held still on the screen
 *    for two seconds turn it on, and again off;
 *  - its × turns it off.
 *
 * It is plain DOM outside React's tree, so nothing the app renders can reset
 * it, and it only reads: nothing either keyboard handling reads is ever
 * written here (the mode button stores a pick and reloads, nothing more). The
 * overlay follows the top of the visual viewport, so a pan cannot push it off
 * screen, and lets every touch through but the × and the mode button.
 *
 * What the lines say (px):
 *  - inner / client / fixed: `innerHeight`, the root's `clientHeight`, and the
 *    height of the box the shell fills (`fixedBoxHeight`, what the keyboard is
 *    measured against);
 *  - vv: the visual viewport's height, width, offsetTop, pageTop and scale, and
 *    `scrollY`;
 *  - kb, legacy: whether `kb-open` is on, the `--app-top`/`--app-height` it
 *    applied, the keyboard inset (`keyboardInset`) and frame computed from this
 *    reading, the resting height kb-inset measures against; native: the inset
 *    (0 once WebKit has panned to the bottom of the shell) and how many times
 *    the root was put back at the top;
 *  - active: the focused element, and whether it is a field;
 *  - composer: the bottom of the composer box against the bottom of what is on
 *    screen, both as getBoundingClientRect has them — "COVERED" when the
 *    keyboard is over it. What is on screen ends at pageTop - scrollY + height
 *    there: WebKit measures client rects from the visual viewport (scrollY is
 *    its pageTop), Chrome elsewhere from the layout viewport;
 *  - a log of the last readings, each after the events that came before it
 *    ("·" when the numbers moved with no event), timed from the last focus change.
 */

import { fixedBoxHeight, isEditable, keyboardFrame, keyboardInset, lastKbReading } from "./kb-inset";
import { type KbMode, kbMode, switchKbMode } from "./kb-mode";
import { rootResets } from "./kb-native";

const FLAG = "rh.vvdebug";
/** How long two fingers have to stay down. */
const HOLD_MS = 2000;
/** How far either may wander and still count as held still (a pinch moves more). */
const HOLD_SLOP_PX = 24;
const LOG_LINES = 14;

type FlagStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Whether the overlay is wanted, from the address's query and the stored flag;
 * `?vvdebug=1` and `?vvdebug=0` also store the answer.
 */
export function vvDebugWanted(search: string, storage: FlagStore | null): boolean {
  const asked = new URLSearchParams(search).get("vvdebug");
  try {
    if (asked === "1") storage?.setItem(FLAG, "1");
    else if (asked === "0") storage?.removeItem(FLAG);
    return asked === "1" || (asked !== "0" && storage?.getItem(FLAG) === "1");
  } catch {
    // Storage can be blocked; the query alone still works for this page.
    return asked === "1";
  }
}

/** Everything the overlay shows, read in one go. */
export interface VvSnapshot {
  innerHeight: number;
  clientHeight: number;
  fixedHeight: number;
  vvHeight: number;
  vvWidth: number;
  offsetTop: number;
  pageTop: number;
  scale: number;
  scrollY: number;
  safeBottom: number;
  active: string;
  editing: boolean;
  restHeight: number | null;
  kbOpen: boolean;
  appTop: string;
  appHeight: string;
  composerBottom: number | null;
  bodyTop: number;
  bodyBottom: number;
  /** Which keyboard handling runs (`lib/kb-mode.ts`); `legacy` where not given. */
  mode?: KbMode;
  /** Native mode: how many times the root has been put back at the top (`rootResets`). */
  resets?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The overlay's lines for a snapshot (without the log). */
export function describe(s: VvSnapshot): string[] {
  const reading = {
    fixedHeight: s.fixedHeight,
    restHeight: s.restHeight,
    height: s.vvHeight,
    offsetTop: s.offsetTop,
    scale: s.scale,
    editing: s.editing,
  };
  const frame = keyboardFrame(reading);
  const visibleBottom = s.pageTop - s.scrollY + s.vvHeight;
  const covered = s.composerBottom === null ? null : s.composerBottom - visibleBottom;
  return [
    `inner ${r1(s.innerHeight)}  client ${r1(s.clientHeight)}  fixed ${r1(s.fixedHeight)}  safeB ${r1(s.safeBottom)}`,
    `vv h ${r1(s.vvHeight)} w ${r1(s.vvWidth)} top ${r1(s.offsetTop)} pageTop ${r1(s.pageTop)} scale ${s.scale.toFixed(2)}  scrollY ${r1(s.scrollY)}`,
    s.mode === "native"
      ? // Nothing is measured or applied: the inset is what of the shell is
        // out of sight below the screen (0 once WebKit has panned to the
        // composer), and kb-open must never be on.
        `kb native  inset ${r1(keyboardInset(reading))}  root resets ${s.resets ?? 0}${s.kbOpen ? "  kb-open ON (?)" : ""}`
      : `kb ${s.kbOpen ? "OPEN" : "closed"} applied top ${s.appTop || "-"} h ${s.appHeight || "-"}  inset ${r1(keyboardInset(reading))}  ` +
        `frame ${frame === null ? "none" : `${r1(frame.top)}+${r1(frame.height)}`}  rest ${s.restHeight === null ? "-" : r1(s.restHeight)}`,
    `active ${s.active}${s.editing ? " (editing)" : ""}  body ${r1(s.bodyTop)}–${r1(s.bodyBottom)}`,
    s.composerBottom === null
      ? `composer none  visible bottom ${r1(visibleBottom)}`
      : `composer bottom ${r1(s.composerBottom)}  visible bottom ${r1(visibleBottom)}  ` +
        (covered !== null && covered > 0.5 ? `COVERED ${r1(covered)}` : "ok"),
  ];
}

/** One log line: the numbers that move when the keyboard does. */
export function logLine(ms: number, what: string, s: VvSnapshot): string {
  return (
    `+${Math.round(ms)} ${what} h${r1(s.vvHeight)} top${r1(s.offsetTop)} in${r1(s.innerHeight)} ` +
    `fx${r1(s.fixedHeight)} y${r1(s.scrollY)} kb${s.kbOpen ? 1 : 0} c${s.composerBottom === null ? "-" : r1(s.composerBottom)}` +
    (s.mode === "native" ? ` r${s.resets ?? 0}` : "")
  );
}

function describeElement(el: Element | null): string {
  if (el === null || el === document.body) return "body";
  const composer = el.closest("[data-composer]") !== null ? "[composer]" : "";
  const xterm = el.closest(".xterm") !== null ? "[xterm]" : "";
  return `${el.tagName}${composer}${xterm}`;
}

/** The composer box being typed in, or else the last one on the page. */
function composerBox(): Element | null {
  const active = document.activeElement?.closest("[data-composer]");
  if (active) return active;
  const all = document.querySelectorAll("[data-composer]");
  return all.length > 0 ? all[all.length - 1]! : null;
}

function standalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
}

function mount(onClose: () => void): () => void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const box = document.createElement("div");
  box.dataset.vvDebug = "";
  box.setAttribute("aria-hidden", "true");
  box.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;" +
    "padding:22px 22px 3px 4px;max-height:55%;overflow:hidden;white-space:pre;" +
    "font:9px/1.3 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.8);";
  const text = document.createElement("div");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.style.cssText =
    "position:absolute;right:0;top:0;width:22px;height:22px;pointer-events:auto;border:0;padding:0;" +
    "font:16px/22px sans-serif;color:#fff;background:transparent;";
  close.addEventListener("click", onClose);
  // The other keyboard handling, for a Home Screen app that has no address
  // bar to put `?kb=` in: stored for this browser, and the page reloads into it.
  const mode = kbMode();
  const flip = document.createElement("button");
  flip.type = "button";
  flip.dataset.vvDebugKb = "";
  flip.textContent = `kb ${mode} → ${mode === "native" ? "legacy" : "native"}`;
  flip.style.cssText =
    "position:absolute;right:24px;top:2px;height:18px;pointer-events:auto;border:1px solid #fff;padding:0 4px;" +
    "font:9px/16px ui-monospace,Menlo,monospace;color:#fff;background:transparent;";
  flip.addEventListener("click", switchKbMode);
  // `env(safe-area-inset-bottom)` as a number: a box padded by it.
  const safe = document.createElement("div");
  safe.style.cssText = "position:absolute;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)";
  box.append(text, flip, close, safe);
  document.body.append(box);

  const head = `vvdebug  kb ${mode}  ${standalone() ? "home-screen app" : "browser tab"}  ${(navigator.userAgent.match(/OS [\d_]+|Version\/[\d.]+|CriOS\/[\d.]+/g) ?? []).join(" ")}`;
  const snapshot = (): VvSnapshot => {
    const body = document.body.getBoundingClientRect();
    const composer = composerBox();
    return {
      innerHeight: window.innerHeight,
      clientHeight: root.clientHeight,
      fixedHeight: fixedBoxHeight(),
      vvHeight: vv?.height ?? window.innerHeight,
      vvWidth: vv?.width ?? window.innerWidth,
      offsetTop: vv?.offsetTop ?? 0,
      pageTop: vv?.pageTop ?? window.scrollY,
      scale: vv?.scale ?? 1,
      scrollY: window.scrollY,
      safeBottom: parseFloat(getComputedStyle(safe).paddingBottom) || 0,
      active: describeElement(document.activeElement),
      editing: document.activeElement !== null && isEditable(document.activeElement),
      restHeight: lastKbReading()?.restHeight ?? null,
      kbOpen: root.classList.contains("kb-open"),
      appTop: root.style.getPropertyValue("--app-top"),
      appHeight: root.style.getPropertyValue("--app-height"),
      composerBottom: composer === null ? null : composer.getBoundingClientRect().bottom,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      mode,
      resets: rootResets(),
    };
  };

  const log: string[] = [];
  let since = performance.now();
  let pending: string[] = [];
  let lastKey = "";
  const note = (what: string) => () => {
    if (what === "focusin" || what === "focusout") since = performance.now();
    if (!pending.includes(what)) pending.push(what);
  };
  const listeners: [EventTarget, string, () => void][] = [
    ...(vv ? (["resize", "scroll"] as const).map((t): [EventTarget, string, () => void] => [vv, t, note(`vv.${t}`)]) : []),
    [window, "resize", note("resize")],
    [window, "scroll", note("scroll")],
    [document, "focusin", note("focusin")],
    [document, "focusout", note("focusout")],
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn, { passive: true });

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const s = snapshot();
    const lines = describe(s);
    const key = lines.join("\n");
    if (key !== lastKey || pending.length > 0) {
      lastKey = key;
      log.push(logLine(performance.now() - since, pending.length > 0 ? pending.join(",") : "·", s));
      if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
      pending = [];
      text.textContent = [head, ...lines, ...log].join("\n");
    }
    // On the visual viewport's top edge, wherever WebKit panned it.
    box.style.transform = `translateY(${Math.max(0, s.offsetTop)}px)`;
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    box.remove();
  };
}

/** Watch for the hold that toggles the overlay: two fingers, still, for `HOLD_MS`. */
function watchHold(onHold: () => void): void {
  let timer: number | undefined;
  let start = new Map<number, [number, number]>();
  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const opts = { passive: true, capture: true } as const;
  document.addEventListener(
    "touchstart",
    (e) => {
      cancel();
      if (e.touches.length !== 2) return;
      start = new Map([...e.touches].map((t) => [t.identifier, [t.clientX, t.clientY]]));
      timer = window.setTimeout(() => {
        timer = undefined;
        onHold();
      }, HOLD_MS);
    },
    opts,
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (timer === undefined) return;
      const wandered = [...e.touches].some((t) => {
        const s = start.get(t.identifier);
        return s === undefined || Math.hypot(t.clientX - s[0], t.clientY - s[1]) > HOLD_SLOP_PX;
      });
      if (wandered || e.touches.length !== 2) cancel();
    },
    opts,
  );
  document.addEventListener("touchend", cancel, opts);
  document.addEventListener("touchcancel", cancel, opts);
}

/** Show the overlay if it is wanted, and listen for the hold that toggles it. */
export function startVvDebug(): void {
  let storage: FlagStore | null = null;
  try {
    storage = window.localStorage;
  } catch {
    // Blocked storage: the query still works for this page.
  }
  let unmount: (() => void) | null = null;
  const set = (on: boolean) => {
    try {
      if (on) storage?.setItem(FLAG, "1");
      else storage?.removeItem(FLAG);
    } catch {
      // As above.
    }
    if (on && unmount === null) unmount = mount(() => set(false));
    if (!on && unmount !== null) {
      unmount();
      unmount = null;
    }
  };
  if (vvDebugWanted(location.search, storage)) unmount = mount(() => set(false));
  watchHold(() => set(unmount === null));
}
