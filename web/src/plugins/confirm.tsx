/**
 * `host.ui.confirm` — a yes/no question in the app's own dialog, as a promise.
 *
 * Plugins used to call `window.confirm`, which a desktop webview may not
 * implement and which looks like nothing else in the app. Questions queue: a
 * second one waits for the first to be answered.
 */
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

export interface ConfirmOptions {
  title?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface Question extends ConfirmOptions {
  message: string;
  answer: (yes: boolean) => void;
}

let queue: Question[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of [...listeners]) listener();
};

/** Ask; resolves `true` for yes. */
export function requestConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, message, answer: resolve }];
    changed();
  });
}

function settle(yes: boolean) {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  changed();
  first.answer(yes);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Mounted once, by the plugin registry. */
export function ConfirmHost() {
  const { t } = useTranslation();
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null);
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && settle(false)}>
      {current && (
        <DialogContent title={current.title ?? t("please confirm")} closeLabel={t("cancel")}>
          <p className="text-xs break-words whitespace-pre-wrap text-fg">{current.message}</p>
          <div className="flex justify-end gap-2 pt-3">
            <button
              type="button"
              onClick={() => settle(false)}
              className="flex h-7 items-center px-3 font-mono text-2xs text-muted hover:bg-hover hover:text-fg"
            >
              {current.cancelLabel ?? t("cancel")}
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => settle(true)}
              data-variant={current.danger ? "danger" : "primary"}
              data-signal={current.danger ? "danger" : undefined}
              className={cn(
                "flex h-7 items-center px-3 text-xs font-medium",
                current.danger ? "border border-danger/55 text-danger hover:bg-hover" : "bg-fg text-bg hover:bg-fg/85",
              )}
            >
              {current.confirmLabel ?? t("confirm")}
            </button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
