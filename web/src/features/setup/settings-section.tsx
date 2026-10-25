import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PREFERENCE_ROW, ROW_LABEL, SECTION_TITLE } from "@/features/settings/layout";
import { isDesktopApp } from "@/lib/auth";
import { useHomeMachine, useMachine } from "@/lib/machines/context";

/**
 * Settings → General → Setup, in the Droppen app: runs the first-run guide
 * again from step 01 (`/welcome?rerun=1`).
 * What is set up stays set up; each step shows it as it is now.
 */
export function SetupSection() {
  const navigate = useNavigate();
  const machine = useMachine();
  const home = useHomeMachine();
  if (!isDesktopApp() || machine !== home) return null;
  return <SetupSectionView onRerun={() => void navigate({ to: "/welcome", search: { rerun: 1 } })} />;
}

/** The section itself (the render tests draw it directly). */
export function SetupSectionView({ onRerun }: { onRerun: () => void }) {
  const { t } = useTranslation();
  return (
    <section data-testid="setup-section" className="border-b border-border p-3">
      <h2 data-label="" className={SECTION_TITLE}>
        {t("Setup")}
      </h2>
      <div className={PREFERENCE_ROW}>
        <div className={ROW_LABEL}>{t("Check Claude Code and Codex, change where you use Droppen, pick a first folder again.")}</div>
        {/* The shared 28px action: sans 12/500. */}
        <Button data-testid="setup-rerun" onClick={onRerun}>
          {t("Run setup again")}
        </Button>
      </div>
    </section>
  );
}
