/*
 * Which devices' sessions the list shows, in the local app when its gateway
 * shows the account's other devices too (`docs/local-aggregator.md` §6.4,
 * S1-7): 「需要你」 (what needs you, across every device, asking first), every
 * device mixed as one list, or one device's.
 *
 * Each device says its state with a square (online, offline, not known); a
 * device that is not online says how current its copy is — 「离线副本 · 截至
 * 14:02」 (in the app's language) — since that is all the page has of it.
 * The choice is remembered per browser when it is 「需要你」, 「全部」 or this
 * device; another device's id is kept for this page only (nothing of the
 * other devices is written down on this one).
 */
import i18n from "i18next";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { formatMoment } from "@/lib/format";
import { LOCAL, type MachineKey } from "@/lib/machines/key";
import type { MachineInfo } from "@/lib/machines/runtime";
import { readMachineItem, writeMachineItem } from "@/lib/machines/storage";
import { deviceLabel } from "@/features/machines/device-picker";

/** What the list shows: what needs you, every device's sessions, or one device's. */
export type DeviceChoice = "needs" | "all" | MachineKey;

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Where the choice is kept (on the home's keys: it is about the page, not a device). */
const CHOICE = "sessions.device";

/** Another device chosen, for this page only. */
let remoteChoice: MachineKey | null = null;

/** Whether a choice may be written down: not another device's id. */
const keepable = (choice: DeviceChoice) => choice === "needs" || choice === "all" || choice === LOCAL;

export function loadDeviceChoice(): DeviceChoice {
  if (remoteChoice) return remoteChoice;
  try {
    const kept = readMachineItem(localStorage, LOCAL, CHOICE);
    return kept && keepable(kept) ? kept : "all";
  } catch {
    return "all";
  }
}

export function saveDeviceChoice(choice: DeviceChoice): void {
  remoteChoice = keepable(choice) ? null : choice;
  try {
    // Another device: 「全部」 is what a later page starts from.
    writeMachineItem(localStorage, LOCAL, CHOICE, keepable(choice) ? choice : "all");
  } catch {
    // storage full or blocked: the choice still holds for this page
  }
}

export { deviceLabel };

/**
 * What the list says of a device besides its name: how current its copy is,
 * when it is not online (`null` while it is, or with nothing to say).
 */
export function copyNote(info: MachineInfo, t: T, lang: string = i18n.language): string | null {
  if (info.state === "online" || info.key === LOCAL) return null;
  const time = info.copyAsOf ? formatMoment(info.copyAsOf, lang) : null;
  if (info.state === "offline") return time ? t("offline copy · as of {{time}}", { time }) : t("offline");
  return time ? t("as of {{time}}", { time }) : t("unknown");
}

/** The bar's own short word for it: 「截至 14:02」, the day too when not today (the long one is its tooltip). */
export function chipNote(info: MachineInfo, t: T, lang: string = i18n.language, now = Date.now()): string | null {
  if (info.state === "online" || info.key === LOCAL) return null;
  return info.copyAsOf ? t("as of {{time}}", { time: formatMoment(info.copyAsOf, lang, true, now) }) : t(info.state);
}

/** A device's state as a square that takes the colour of its text (it is inked in when chosen). */
function StateSquare({ info }: { info: MachineInfo }) {
  const { t } = useTranslation();
  return (
    <span
      aria-hidden="true"
      data-signal={info.state === "offline" ? "offline" : undefined}
      title={t(info.state)}
      className={cn(
        "size-[7px] shrink-0",
        info.state === "online" ? "bg-current" : info.state === "offline" ? "bg-danger" : "shadow-[inset_0_0_0_1.25px_currentColor]",
      )}
    />
  );
}

/**
 * The bar: 「需要你 n」 (only while something needs you), 「全部」, then each
 * device, this one first — boxes that wrap onto more lines rather than hide
 * a device, so an offline one always says how current its copy is.
 */
export function DeviceFilterBar({
  value,
  onChange,
  devices,
  needs,
}: {
  value: DeviceChoice;
  onChange: (choice: DeviceChoice) => void;
  /** This device first, then the others. */
  devices: readonly MachineInfo[];
  /** How many sessions need you, across every device. */
  needs: number;
}) {
  const { t, i18n: { language } } = useTranslation();
  const choice = (key: DeviceChoice, children: React.ReactNode, extra: Record<string, string | undefined> = {}) => (
    <button
      key={key}
      type="button"
      aria-pressed={value === key}
      data-device-choice={key}
      onClick={() => value !== key && onChange(key)}
      className={cn(
        "flex h-6.5 max-w-full min-w-0 items-center gap-1.5 border px-2 font-mono text-2xs font-medium whitespace-nowrap",
        value === key ? "border-fg bg-fg text-bg" : "border-border-strong bg-bg text-muted hover:text-fg",
      )}
      {...extra}
    >
      {children}
    </button>
  );
  return (
    <div data-testid="device-filter" role="group" aria-label={t("show the sessions of")} className="flex min-w-0 flex-wrap gap-1">
      {needs > 0 &&
        choice(
          "needs",
          <>
            {t("what needs you")}
            <span className="tabular-nums">{needs}</span>
          </>,
        )}
      {choice("all", t("every device"))}
      {devices.map((info) => {
        const note = chipNote(info, t, language);
        return choice(
          info.key,
          <>
            <StateSquare info={info} />
            <span className="min-w-0 truncate">{deviceLabel(info, t)}</span>
            {note && (
              <span data-signal={info.state === "offline" ? "offline" : undefined} data-copy-note="" className="shrink-0 opacity-70">
                {note}
              </span>
            )}
          </>,
          { "data-device-state": info.state, title: copyNote(info, t, language) ?? undefined },
        );
      })}
    </div>
  );
}
