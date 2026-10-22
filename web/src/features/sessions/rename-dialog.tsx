import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "@/api/schema";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { isImeKeydown } from "@/lib/ime";
import { useApi } from "@/lib/machines/context";

type Source = components["schemas"]["Source"];

export interface RenameTarget {
  source: Source;
  id: string;
  title: string;
}

/** Shared rename modal for the session list and detail header. */
export function RenameSessionDialog({
  target,
  onOpenChange,
}: {
  target: RenameTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const rename = useMutation({
    mutationFn: async (title: string) => {
      if (!target) return;
      const res = await api.PUT("/api/sessions/{source}/{id}/title", {
        params: { path: { source: target.source, id: target.id } },
        body: { title },
      });
      if (res.error) throw new Error(res.error.error);
    },
    onSuccess: () => onOpenChange(false),
  });

  // Focus + select once the dialog opens (after Base UI settles initial focus).
  useEffect(() => {
    if (!target) return;
    rename.reset();
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on each open only
  }, [target]);

  if (!target) return null;

  const submit = () => {
    if (!rename.isPending) rename.mutate(inputRef.current?.value ?? "");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent title={t("rename session")}>
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            defaultValue={target.title}
            autoFocus
            placeholder={t("session title")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeKeydown(e)) {
                e.preventDefault();
                submit();
              }
            }}
            className="h-6.5 w-full border border-border bg-bg px-2 text-xs text-fg placeholder:text-faint focus:border-fg focus:outline-none"
          />
          <p className="font-mono text-2xs text-faint">{t("leave empty to reset to the auto title")}</p>
          {rename.isError && <p data-signal="failed" className="font-mono text-2xs text-danger">{rename.error.message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex h-7 items-center rounded px-3 font-mono text-2xs text-muted hover:bg-hover hover:text-fg"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              disabled={rename.isPending}
              onClick={submit}
              data-variant="primary" className="flex h-7 items-center bg-fg px-3 text-xs font-medium text-bg hover:bg-fg/85 disabled:opacity-40"
            >
              {rename.isPending ? t("saving…") : t("save")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
