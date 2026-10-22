import { Check, CheckCheck, CircleHelp, CircleX, Loader2, RotateCw, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { DeliveryState } from "./send-receipts";

/**
 * The words and the icon for where an outgoing message is.
 *
 * One table for the three places a message is drawn — the preview over the
 * composer, this tab's queue and the server's queue — so the same state never
 * reads two ways. The label is short enough for a phone's row; the title says
 * what it means.
 */
const LOOK: Record<DeliveryState, { label: string; title: string; tone: string }> = {
  saved: { label: "saved", title: "only on this device — not sent yet", tone: "text-faint" },
  sending: { label: "sending", title: "sending — waiting for acceptance", tone: "text-muted" },
  delivered: { label: "delivered", title: "the server has it — waiting in its queue", tone: "text-accent" },
  executed: { label: "executed", title: "handed to the agent", tone: "text-ok" },
  unknown: {
    label: "unknown",
    title: "sent, but no answer came back — it may or may not have reached the server",
    tone: "text-warn-fg",
  },
  unsent: {
    label: "not delivered · safe to resend",
    title: "the server never received it, so sending it again cannot run it twice",
    tone: "text-warn-fg",
  },
  failed: { label: "failed", title: "not delivered — the server refused or dropped it", tone: "text-danger" },
};

function Icon({ state }: { state: DeliveryState }) {
  const className = "size-3 shrink-0";
  switch (state) {
    case "saved":
      return <Smartphone className={className} />;
    case "sending":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "delivered":
      return <Check className={className} />;
    case "executed":
      return <CheckCheck className={className} />;
    case "unknown":
      return <CircleHelp className={className} />;
    case "unsent":
      return <RotateCw className={className} />;
    case "failed":
      return <CircleX className={className} />;
  }
}

/** A message's delivery state, as a small icon and a word. */
export function ReceiptBadge({ state, className }: { state: DeliveryState; className?: string }) {
  const { t } = useTranslation();
  const look = LOOK[state];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 font-mono text-2xs", look.tone, className)}
      title={t(look.title)}
      data-delivery={state}
    >
      <Icon state={state} />
      {t(look.label)}
    </span>
  );
}
