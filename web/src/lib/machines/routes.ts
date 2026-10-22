/*
 * Which machine an address of the app is about (`docs/local-aggregator.md`
 * §6.6, §6.7 M-2).
 *
 * The app's paths from before machines had keys — `/sessions/claude/abc`,
 * `/terminals?id=…` — are the home's, and stay so: bookmarks, installed
 * home-screen apps and links from before keep opening where they did. Any
 * other machine's page is the same path under `/m/<machine>`:
 * `/m/d-7f3a/sessions/claude/abc`. One page has one address: the home's pages
 * are never written with `/m/<home>` (`app/machine-route.tsx` sends such an
 * address on to the plain one).
 *
 * Pure: the router's half (the routes, the hooks that read the address) is
 * in `app/machine-route.tsx`.
 */
import type { MachineKey } from "./key";
import { homeMachine } from "./registry";

/** The first segment of a machine's own pages. */
export const MACHINE_SEGMENT = "m";

/** `machine`'s pages' prefix: `/m/<machine>`. */
export function machinePrefix(machine: MachineKey): string {
  return `/${MACHINE_SEGMENT}/${encodeURIComponent(machine)}`;
}

/**
 * `path` — an app path as the home writes it, search and all — on `machine`:
 * unchanged on the home (`home`, by default the registry's), under
 * `/m/<machine>` on any other.
 */
export function machinePath(machine: MachineKey, path: string, home: MachineKey = homeMachine()): string {
  return machine === home ? path : `${machinePrefix(machine)}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The machine an address names, and the rest of it as the home would write
 * it: `/m/b/terminals` → `{machine: "b", path: "/terminals"}`; a home path →
 * `{machine: null, path}`. A bare `/m/b` is that machine's start (its
 * sessions).
 */
export function splitMachinePath(pathname: string): { machine: MachineKey | null; path: string } {
  const m = /^\/m\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return { machine: null, path: pathname };
  let machine: string;
  try {
    machine = decodeURIComponent(m[1]!);
  } catch {
    return { machine: null, path: pathname };
  }
  const rest = m[2] && m[2] !== "/" ? m[2] : "/sessions";
  return { machine, path: rest };
}

/** The machine an address is about: the one it names, else the home (`home`, by default the registry's). */
export function machineOfPath(pathname: string, home: MachineKey = homeMachine()): MachineKey {
  return splitMachinePath(pathname).machine ?? home;
}

/**
 * A route target — `to` as the home's route pattern (`/sessions/$source/$id`)
 * and its params — on `machine`: as it is on the home, the same pattern under
 * `/m/$machine` (with the machine as a param) on any other.
 */
export function machineTarget<P extends Record<string, string>>(
  machine: MachineKey,
  to: string,
  params?: P,
  home: MachineKey = homeMachine(),
): { to: string; params?: P | (P & { machine: string }) } {
  if (machine === home) return params ? { to, params } : { to };
  return { to: `/${MACHINE_SEGMENT}/$machine${to}`, params: { ...(params ?? ({} as P)), machine } };
}

/**
 * Where an address that names the home goes instead: the same page as the
 * home writes it (`/m/<home>/terminals?id=1` → `/terminals?id=1`); `null`
 * when the address does not name the home.
 */
export function plainHomeAddress(pathname: string, search: string, home: MachineKey = homeMachine()): string | null {
  const { machine, path } = splitMachinePath(pathname);
  return machine !== null && machine === home ? `${path}${search}` : null;
}
