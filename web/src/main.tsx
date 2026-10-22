// First, before any other module can read the address: a `#local-open=` token
// comes off it (`lib/local-open.ts`), and so do the browser hand-off's
// fragments — before the router or the service worker reads it.
import "./lib/local-open-boot";
import { takeReturn } from "./features/link/fragment-boot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { CloudApp } from "./features/cloud/cloud-app";
import { isReturnPath } from "./features/link/handoff";
import { LinkReturnPage } from "./features/link/link-return";
import { isCloud } from "./lib/hub/config";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./app/router";
import { startBadgeSync } from "./lib/badge";
// Side-effect import: the module's `beforeinstallprompt` listener has to be in
// place before the browser fires it, which happens well before React mounts.
import "./lib/install";
import { startKbWatch } from "./lib/kb-inset";
import { kbMode } from "./lib/kb-mode";
import { startKbNative } from "./lib/kb-native";
import { startVvDebug } from "./lib/vv-debug";
import { startLocalOpen } from "./lib/auth";
import { startLocalShell } from "./lib/machines/shells/local";
import { registerSw } from "./lib/sw-register";
import "./i18n";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1 },
  },
});

registerSw();
// The phone keyboard: left to WebKit's own reveal of the focused field, or
// (`?kb=legacy`) measured and the shell sized above it (`lib/kb-mode.ts`).
if (kbMode() === "legacy") startKbWatch();
else startKbNative();
// Off unless asked for (`?vvdebug=1`): the keyboard's numbers, live on the phone.
startVvDebug();
startBadgeSync();

// Served by a remote-hand hub (cloud mode), the app runs behind the hub's
// sign-in, device setup and machine picker, and every request it makes goes
// to the picked machine end to end (`CloudApp` opens it). Served by a server,
// it is exactly as before: the one machine is the server itself
// (`lib/machines`), and nothing in `features/cloud` runs.
//
// `/link/return` on a server is the one page that stands alone, before the
// app's router and login: droppen.app sends the system browser there with its
// answer to a sign-in, and that browser has no login here
// (`features/link/link-return.tsx`).
const returning = !isCloud() && isReturnPath(location.pathname);
if (!isCloud() && !returning) {
  startLocalShell();
  // A page opened signed in from the device itself trades its token before
  // the router asks who it is (`lib/auth.ts`).
  startLocalOpen();
}
const root = createRoot(document.getElementById("root")!);
if (returning) {
  root.render(
    <StrictMode>
      <LinkReturnPage answer={takeReturn()} />
    </StrictMode>,
  );
} else {
  const app = <RouterProvider router={router} />;
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>{isCloud() ? <CloudApp>{app}</CloudApp> : app}</QueryClientProvider>
    </StrictMode>,
  );
}
