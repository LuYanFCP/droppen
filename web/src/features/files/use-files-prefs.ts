import { useCallback, useSyncExternalStore } from "react";
import {
  readShowHiddenFiles,
  subscribeShowHiddenFiles,
  writeShowHiddenFiles,
} from "@/features/files/files-prefs";

function currentShowHidden(): boolean {
  return readShowHiddenFiles(localStorage);
}

/**
 * The "show hidden files" switch, subscribed rather than read once: flipping it
 * in settings reaches an already-open file list (and any other tab) without a
 * reload.
 */
export function useShowHiddenFiles(): [boolean, (value: boolean) => void] {
  const showHidden = useSyncExternalStore(subscribeShowHiddenFiles, currentShowHidden, () => false);
  const setShowHidden = useCallback((value: boolean) => writeShowHiddenFiles(localStorage, value), []);
  return [showHidden, setShowHidden];
}
