import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useScreens } from "@/app/screens";

/**
 * Routed placeholder for a screen. The actual pane tree lives in the
 * keep-alive <ScreenFrames> layer (see screen-frames.tsx) so it survives
 * route switches; this component only shows through when the screen is gone.
 */
export function ScreenView() {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/screens/$id" });
  const { screens } = useScreens();

  if (screens && !screens.some((s) => s.id === id)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <div className="font-mono text-xs text-muted">{t("this screen was deleted")}</div>
        <Link to="/sessions" className="font-mono text-2xs text-accent hover:underline">
          {t("back to sessions")}
        </Link>
      </div>
    );
  }

  return <div className="flex-1" />;
}
