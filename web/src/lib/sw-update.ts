/**
 * Ask the browser to look for a new service worker now.
 *
 * Called when the server reports a build this page was not loaded against: the
 * new worker's install precaches the new build's boot set (`public/sw.js`), so
 * the reload the version banner asks for finds it already here.
 */
export function checkForSwUpdate(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  void navigator.serviceWorker
    .getRegistration()
    .then((reg) => reg?.update())
    .catch(() => undefined);
}
