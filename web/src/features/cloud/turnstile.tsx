import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TurnstileConfig } from "@/lib/hub/api";
import { cn } from "@/lib/cn";
import { ErrorLine, quiet } from "./ui";

/*
 * Cloudflare Turnstile, kept off this page's origin. The page holds the
 * device keys (any script running here can use them, and read them out), so
 * Cloudflare's script never loads in it: the hub serves the widget on its own
 * origin (`<turnstile origin>/turnstile?action=…`), this page frames it, and
 * the frame hands its token up with `postMessage` aimed at this page's origin
 * (docs/relay-and-plans.md §4.2). The page's CSP frames that origin only.
 *
 * A message counts only if it comes from that origin, from that very frame,
 * and names the action the frame was opened for; anything else is ignored.
 */

export type TurnstileAction = "signup" | "login" | "resend";

/** What the widget said: a token, or none (it expired, or the widget hit an error). */
export interface TurnstileAnswer {
  token: string | null;
  expired: boolean;
  error: boolean;
}

/** A token longer than this is not one (the hub refuses more than 2048 bytes). */
const MAX_TOKEN = 2048;

/**
 * The widget's answer in a `message` event, or `null` when the event is not
 * one: another origin, another window (even on the widget's origin), another
 * action, or not the widget's shape.
 */
export function turnstileAnswer(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; source: unknown; action: TurnstileAction },
): TurnstileAnswer | null {
  if (!expected.origin || event.origin !== expected.origin) return null;
  if (expected.source == null || event.source !== expected.source) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.t !== "turnstile" || m.action !== expected.action) return null;
  if (typeof m.token === "string") {
    return m.token.length > 0 && m.token.length <= MAX_TOKEN ? { token: m.token, expired: false, error: false } : null;
  }
  if (m.token === null || m.token === undefined) return { token: null, expired: m.expired === true, error: m.error === true };
  return null;
}

/** The widget's page for `action`, in the page's theme. */
export function turnstileSrc(origin: string, action: TurnstileAction, dark: boolean): string {
  return `${origin}/turnstile?action=${action}&theme=${dark ? "dark" : "light"}`;
}

/**
 * The widget, framed from its own origin. `onToken` gets each token (and
 * `null` when it expires or fails); bump `reset` after a submit that spent the
 * token, and the widget asks again.
 */
export function Turnstile({
  config,
  action,
  onToken,
  reset = 0,
}: {
  config: TurnstileConfig;
  action: TurnstileAction;
  onToken: (token: string | null) => void;
  reset?: number;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  // The theme the widget opens in (a later switch keeps it: reloading would lose a token).
  const [dark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  const latest = useRef(onToken);
  useEffect(() => {
    latest.current = onToken;
  });

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const answer = turnstileAnswer(event, { origin: config.origin, source: frame.current?.contentWindow ?? null, action });
      if (!answer) return;
      setFailed(answer.error);
      latest.current(answer.token);
    };
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  }, [config.origin, action]);

  const resetWidget = () => {
    setFailed(false);
    frame.current?.contentWindow?.postMessage({ t: "turnstile-reset" }, config.origin);
  };

  // Each bump of `reset` (not the first value): the token was spent, ask again.
  const seen = useRef(reset);
  useEffect(() => {
    if (seen.current === reset) return;
    seen.current = reset;
    setFailed(false);
    frame.current?.contentWindow?.postMessage({ t: "turnstile-reset" }, config.origin);
  }, [reset, config.origin]);

  return (
    <div className="flex flex-col gap-1.5">
      <iframe
        ref={frame}
        title={t("human check")}
        src={turnstileSrc(config.origin, action, dark)}
        width={300}
        height={65}
        sandbox="allow-scripts allow-same-origin allow-popups"
        referrerPolicy="no-referrer"
        className="block h-[65px] w-[300px] max-w-full border-0"
      />
      {failed && (
        <div className="flex flex-wrap items-center gap-2">
          <ErrorLine message={t("the human check hit an error")} />
          <button type="button" className={cn(quiet, "h-7 px-2")} onClick={resetWidget}>
            {t("retry")}
          </button>
        </div>
      )}
    </div>
  );
}
