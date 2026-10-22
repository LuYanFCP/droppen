/* Droppen service worker (PWA). Deliberately conservative:
 *
 * - the live surfaces (`/api/**`, which carries the websockets too, and the
 *   `/embed/**` app iframes) NEVER enter the fetch handler — not calling
 *   respondWith leaves the browser's own networking untouched, which is the
 *   only safe thing to do with streaming and upgrade requests;
 * - SPA navigations are network-first: online you always get the server's
 *   current index.html (a stale shell against a fresh API is an outage), and
 *   offline you get the last cached shell instead of the browser error page;
 * - `/assets/**` is cache-first: vite writes a content hash into every one of
 *   those filenames, so they are immutable by construction;
 * - versioning: the browser installs a new worker only when sw.js's bytes
 *   change (sw-register.ts also calls update() on every foreground, and when
 *   the server reports a new build), and CACHE is bumped by hand when the
 *   caching logic itself changes so activate can drop the old one;
 * - precache: the build writes the assets it boots from into PRECACHE, and
 *   every asset it has into ASSETS (vite.config.ts), which also makes every
 *   release a new sw.js. Installing it fetches whatever of the boot set is not
 *   cached yet — the release's new app chunk, in the background, before the
 *   reload that needs it — and notes that each of ASSETS was listed by a
 *   build today. Activate lets go of an asset only once no build has listed
 *   it for a week: a lazy chunk a release did not change stays, and a tab
 *   still running last week's build keeps the chunks it knows;
 * - only real assets are kept under /assets/: never the HTML a server answers
 *   for a path it does not have, which cached under a script's name would be
 *   handed to the module loader for good.
 */

const CACHE = "rh-sw-v1";

/* Filled in by the build; empty under `vite dev`, which never registers this. */
const PRECACHE = [];
const ASSETS = [];

/* The cache entry recording when each asset was last listed by a build. */
const LISTED = "/__rh-sw/listed";

/* What may be cached under /assets/: what vite emits, and never a page. */
const ASSET_TYPE = /^(?:text\/javascript|application\/javascript|text\/css|font\/|image\/|application\/(?:wasm|json|font))/i;
function cacheableAsset(res) {
  return res.ok && ASSET_TYPE.test(res.headers.get("content-type") ?? "");
}

async function readListed(cache) {
  try {
    const hit = await cache.match(LISTED);
    const value = hit ? await hit.json() : {};
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeListed(cache, listed) {
  return cache.put(LISTED, new Response(JSON.stringify(listed), { headers: { "content-type": "application/json" } }));
}

/* How long an asset outside the current boot set is kept: long enough for a
 * tab still running the previous build to load the lazy chunks it knows. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/* The SPA's full route set (app/router.tsx), plus cloud mode's sign-in,
 * sign-up and e-mail verification pages (features/landing/route.ts) and its
 * 「我的设备」 (features/cloud/devices-route.ts), and every other device's pages
 * under `/m/<device>/` (lib/machines/routes.ts). Only these navigations get the
 * offline shell: a `/embed/…` or download URL that fails should fail, not be
 * answered with an HTML shell that cannot possibly serve it. */
const SPA_ROUTE =
  /^\/(?:$|sessions(?:\/|$)|chat(?:\/|$)|terminals(?:\/|$)|files(?:\/|$)|settings(?:\/|$)|stats(?:\/|$)|apps\/|screens\/|signin$|signup$|verify$|devices\/?$|m\/[^/]+(?:\/|$))/;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // Best effort, and never a reason to fail the install: offline, the assets
  // are fetched on first use as before.
  e.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const listed = await readListed(cache);
        const now = Date.now();
        for (const path of ASSETS) listed[path] = now;
        await writeListed(cache, listed);
        for (const url of PRECACHE) {
          if ((await cache.match(url)) !== undefined) continue;
          const res = await fetch(url);
          if (cacheableAsset(res)) await cache.put(url, res);
        }
      } catch {
        /* offline, or the build moved on again */
      }
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      // Assets no build has listed for a week — by when no open tab can
      // still be asking for them. One cached before builds listed anything
      // goes by when it was fetched instead.
      try {
        const cache = await caches.open(CACHE);
        const listed = await readListed(cache);
        const keep = new Set(ASSETS);
        const now = Date.now();
        for (const req of await cache.keys()) {
          const path = new URL(req.url).pathname;
          if (!path.startsWith("/assets/") || keep.has(path)) continue;
          const res = await cache.match(req);
          const at = listed[path] ?? Date.parse(res?.headers.get("date") ?? "");
          if (!Number.isFinite(at) || now - at > PRUNE_AFTER_MS || (res && !cacheableAsset(res))) {
            await cache.delete(req);
            delete listed[path];
          }
        }
        for (const path of Object.keys(listed)) {
          if (!keep.has(path) && now - listed[path] > PRUNE_AFTER_MS) delete listed[path];
        }
        await writeListed(cache, listed);
      } catch {
        /* nothing to prune */
      }
      // Seed the offline shell. Failure is fine — the first successful
      // navigation fills it in.
      try {
        const res = await fetch("/sessions");
        if (res.ok) await (await caches.open(CACHE)).put("/", res);
      } catch {
        /* offline */
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // `/v1/` is a Droppen hub's own API (cloud mode): never cached either.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/embed") || url.pathname.startsWith("/v1/")) return;

  if (req.mode === "navigate") {
    if (!SPA_ROUTE.test(url.pathname)) return;
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          // Refresh the offline shell as we go. Every SPA route is served the
          // same index.html, so one cache entry under "/" covers all of them.
          if (res.ok) {
            const copy = res.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put("/", copy)));
          }
          return res;
        } catch (err) {
          const hit = await caches.match("/");
          if (hit !== undefined) return hit;
          throw err;
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit !== undefined) return hit;
        const res = await fetch(req);
        if (cacheableAsset(res)) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })(),
    );
  }
});

/* Web Push arrival. Payload (server-rs push module): {title, body, tag, url}.
 * tag is the session key, so a chatty session collapses into one notification
 * rather than a column of them.
 *
 * The worker's badge is a flag, not a count: it has no idea how much of this
 * the user has already read. The page puts its own unread count (summed over
 * every device) back the moment the app is looked at (lib/badge.ts).
 * setAppBadge is absent in Firefox and may reject even where it exists, so it
 * gets its own waitUntil — a rejection there must not fail the push event and
 * lose the notification. */
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data !== null ? e.data.json() : {};
  } catch {
    data = { body: e.data !== null ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title : "Droppen",
      {
        body: typeof data.body === "string" ? data.body : "",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        data: { url: typeof data.url === "string" ? data.url : "/sessions" },
        icon: "/icon-192.png",
        badge: "/icon-192.png",
      },
    ),
  );
  if ("setAppBadge" in navigator) {
    e.waitUntil(navigator.setAppBadge().catch(() => undefined));
  }
});

/* Tapping a notification: focus an existing window and let the SPA route
 * internally (sw-register.ts listens for {type:"nav"}), so the transcript and
 * every open websocket survive. With no window open, launch straight at it. */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url ?? "/sessions";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((c) => "focus" in c);
      if (win !== undefined) {
        await win.focus();
        win.postMessage({ type: "nav", url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
