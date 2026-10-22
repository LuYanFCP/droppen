/**
 * The first thing the page runs (the first import of `main.tsx`): a
 * `#local-open=` token comes off the address before any other module — the
 * router's included — can read it. See `local-open.ts`.
 */
import { captureLocalOpen } from "./local-open";

try {
  captureLocalOpen();
} catch {
  // No history to rewrite (a sandboxed frame): there is no token to keep either.
}
