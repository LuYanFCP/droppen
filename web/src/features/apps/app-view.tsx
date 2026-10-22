import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useApi, useMachine } from "@/lib/machines/context";
import { mq } from "@/lib/machines/query";

/**
 * Routed placeholder for an embedded app. The actual iframe lives in the
 * keep-alive <AppFrames> layer (see app-frames.tsx) so it survives route
 * switches; this component only shows through when the instance is closed.
 */
export function AppView() {
  const api = useApi();
  const machine = useMachine();
  const { t } = useTranslation();
  const { id } = useParams({ from: "/apps/$id" });

  const { data: apps } = useQuery({
    queryKey: mq(machine, "apps"),
    queryFn: async () => (await api.GET("/api/apps")).data?.apps ?? [],
  });
  const app = apps?.find((a) => a.id === id);

  if (apps && !app) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <div className="font-mono text-xs text-muted">{t("this app instance is closed")}</div>
        <Link to="/sessions" className="font-mono text-2xs text-accent hover:underline">
          {t("back to sessions")}
        </Link>
      </div>
    );
  }

  return <div className="flex-1" />;
}
