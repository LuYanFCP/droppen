/**
 * The page's unread count where you see it without looking at the page: the
 * browser tab — `(3) Droppen` — and the app icon's badge. One number, summed
 * over every device that runs AI and is up (`unreadAcross`, `needs-you.ts`):
 * inside the app, the device it is live on from its feed and the others from
 * their copies; on droppen.app's dashboard, all of them from their copies; in
 * the local app, `local` alone, as it always was.
 */
import { useEffect } from "react";
import { setAppBadgeCount } from "@/lib/badge";
import { stripTabCount, tabTitle } from "@/features/sessions/session-attention";

/** How many are mounted: the dashboard and the app hand over to each other. */
let mounted = 0;
let letGo: ReturnType<typeof setTimeout> | undefined;

/**
 * How long the last number stays once nothing counts any more. Going from the
 * dashboard into the app (or from one machine to another) unmounts one and
 * mounts the next a few tasks later, once the app's router has loaded: the
 * tab must not drop its number in between.
 */
const HANDOVER_MS = 1_500;

/** Say `unread` in the tab title and on the app badge while mounted. */
export function UnreadSignals({ unread }: { unread: number }) {
  useEffect(() => {
    document.title = tabTitle(document.title, unread);
    setAppBadgeCount(unread);
  }, [unread]);
  useEffect(() => {
    mounted++;
    clearTimeout(letGo);
    return () => {
      mounted--;
      if (mounted > 0) return;
      // Nothing counting any more (signed out, the device removed): neither
      // place keeps the old number — unless the next one to count comes first.
      clearTimeout(letGo);
      letGo = setTimeout(() => {
        if (mounted > 0) return;
        document.title = stripTabCount(document.title);
        setAppBadgeCount(0);
      }, HANDOVER_MS);
    };
  }, []);
  return null;
}
