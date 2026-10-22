/*
 * The local shell: the page its own server served, and nothing else
 * (`docs/local-aggregator.md` §6.2, `LocalShell`).
 *
 * One machine, {@link LOCAL}, reached directly — the same URLs, the same
 * tickets, the same sockets as before machines had keys. It is also what the
 * registry is before any shell boots, so starting it changes nothing; it is
 * here so the page says which shell it is rather than falling into one.
 */
import { directTransport } from "@/lib/transport/direct";
import { LOCAL } from "../key";
import { openMachine, setShell } from "../registry";

export function startLocalShell(): void {
  openMachine(LOCAL, directTransport);
  setShell("local", LOCAL);
}
