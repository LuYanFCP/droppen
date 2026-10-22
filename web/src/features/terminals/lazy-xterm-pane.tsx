import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The terminal, loaded when one is first shown rather than with the app.
 *
 * xterm is ~450 kB of script — on a weak link a second or more of the cold
 * start — and most visits never open a terminal. The pane's own chunk is
 * fetched the first time one mounts, and the browser keeps it from then on.
 *
 * Fetching it can fail: the link drops, or a release has replaced the build
 * this page was loaded from and its chunks are gone from the server. Either
 * way the pane says so and offers both ways out — try the chunk again, or
 * reload into the current build — rather than taking the page down with it.
 */
const load = () => import("./xterm-pane").then((m) => ({ default: m.XtermPane }));

export function XtermPane(props: { id: string; visible: boolean }) {
  // A failed `lazy` remembers its failure, so a retry is a new one.
  const [attempt, setAttempt] = useState(0);
  const [Pane, setPane] = useState(() => lazy(load));
  return (
    <LoadFailure
      key={attempt}
      onRetry={() => {
        setPane(() => lazy(load));
        setAttempt((n) => n + 1);
      }}
    >
      <Suspense fallback={null}>
        <Pane {...props} />
      </Suspense>
    </LoadFailure>
  );
}

class LoadFailure extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <LoadFailureNotice onRetry={this.props.onRetry} />;
  }
}

function LoadFailureNotice({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  const button = "rounded border border-border px-2 py-0.5 hover:bg-hover";
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 font-mono text-xs text-muted">
      <span>{t("the terminal could not be loaded")}</span>
      <div className="flex gap-2">
        <button type="button" className={button} onClick={onRetry}>
          {t("retry")}
        </button>
        <button type="button" className={button} onClick={() => location.reload()}>
          {t("reload")}
        </button>
      </div>
    </div>
  );
}
