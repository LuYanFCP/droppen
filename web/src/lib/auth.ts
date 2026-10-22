/**
 * The browser half of the server's bearer-token auth.
 *
 * One token per browser, in `localStorage`, sent as `Authorization: Bearer` on
 * every request by the middleware in `api/client.ts`. Two surfaces cannot carry
 * a header — websockets and `<img src>`/`<a href>` downloads — and those spend a
 * short-lived `?ticket=` minted here instead.
 *
 * Everything degrades to nothing on a server whose authentication is switched
 * off (`auth.enabled = false`, for development): `authRequired` is false, no
 * ticket is ever minted and no login page is drawn. Otherwise every caller
 * signs in. A device with no account yet (`setupRequired`) answers nothing but
 * its status, the setup route and the local-open route, and the page draws the
 * setup page: open it signed in from the device itself (`remote-hand-server
 * open`, or the desktop app), which makes the page this device's owner
 * ({@link LOCAL_OWNER}), or make the first account with the one-time code the
 * server printed.
 */
import { cacheClear, cacheUnseal } from "@/lib/local-cache";
import { ApiError } from "@/api/errors";
import type { components } from "@/api/schema";
import type { MachineKey } from "@/lib/machines/key";
import { apiFor, homeMachine } from "@/lib/machines/registry";
import { droppenCommand } from "@/lib/droppen-command";
import { takeLocalOpen } from "@/lib/local-open";

/**
 * The login is the page's own: its home machine's (`lib/machines/registry.ts`)
 * — the server that served the page in the local shell, the main device on
 * droppen.app — whichever machines a view is about.
 */
const pageApi = () => apiFor(homeMachine());

/**
 * Whether `machine` is the one the page's login — its token, its tickets, the
 * auth status it asks — is with: the home. Another machine's server
 * restarting, or its sockets failing, says nothing about that login, and must
 * not spend it. (On droppen.app no machine needs a ticket: each is reached
 * through its own end-to-end channel.)
 */
export function holdsPageLogin(machine: MachineKey): boolean {
  return machine === homeMachine();
}

/**
 * `GET /api/auth/status`'s answer. `authRequired` is true unless
 * authentication is switched off (`authOff`); `setupRequired` says the device
 * has no account yet. Those two are optional here because a page on
 * droppen.app asks devices running older servers too, whose answers lack them.
 * Only the fields read here are named, so the shape holds whatever else the
 * generated schema carries.
 */
type WireAuthStatus = components["schemas"]["AuthStatus"];
export type AuthStatus = Pick<WireAuthStatus, "authRequired" | "user" | "desktopApp"> & {
  setupRequired?: boolean;
  authOff?: boolean;
  droppenPath?: string | null;
  droppenEnv?: CommandEnv[] | null;
};
type CommandEnv = components["schemas"]["CommandEnv"];
type LoginResult = components["schemas"]["LoginResult"];
type TicketScope = components["schemas"]["TicketScope"];

/**
 * Where the token lives. No instance name in the key: `localStorage` is already
 * scoped to the origin, and one origin serves exactly one instance.
 */
export const TOKEN_KEY = "rh.auth.token";

/** The login page's route, and the one path a 401 must not bounce off. */
export const LOGIN_PATH = "/login";

/** The login endpoint. */
export const LOGIN_API_PATH = "/api/auth/login";

/**
 * The setup page's route: where every page of a server with no account yet
 * goes, and — like the login page — a path a 401 must not bounce off.
 */
export const SETUP_PATH = "/setup";

/** The endpoint that makes the first account with the one-time setup code. */
export const SETUP_API_PATH = "/api/auth/setup";

/** The endpoint that trades a `#local-open=` token for a session. */
export const LOCAL_OPEN_API_PATH = "/api/auth/local-open";

/**
 * Who a page opened signed in from the device itself is, while the device has
 * no account: its owner. The app is theirs; the setup page and the security
 * tab offer them the first account without the setup code.
 */
export const LOCAL_OWNER = "local:owner";

/** Whether `user` is this device's owner by a local-open session. */
export function isLocalOwner(user: string | null | undefined): boolean {
  return user === LOCAL_OWNER;
}

/**
 * The endpoints whose refusal belongs in the form that asked, not to a dead
 * token: logging in and re-typing the current password to change it, whose 401
 * means "wrong password", and making the first account, which refuses a wrong
 * code with a 403 but must not be read as a lost login whatever it answers.
 * Everything else that answers 401 is the middleware refusing the token itself.
 */
const PASSWORD_PATHS = [LOGIN_API_PATH, "/api/auth/password", SETUP_API_PATH, LOCAL_OPEN_API_PATH];

/**
 * What a server with authentication switched off answers, and what an
 * unreachable one is read as.
 */
const OPEN_SERVER: AuthStatus = {
  authRequired: false,
  setupRequired: false,
  user: null,
  desktopApp: false,
  authOff: true,
  droppenPath: "",
  droppenEnv: [],
};

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

/** `undefined` until `localStorage` has been read once; `null` means logged out. */
let token: string | null | undefined;

export function getToken(): string | null {
  if (token === undefined) {
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      // Storage blocked (private mode, third-party iframe): this tab keeps the
      // token in memory instead and loses it on reload.
      token = null;
    }
  }
  return token;
}

export function setToken(next: string): void {
  token = next;
  try {
    localStorage.setItem(TOKEN_KEY, next);
  } catch {
    // memory-only for this tab
  }
}

/** Who wants to know that this page has lost its login; see {@link onSignedOut}. */
const signedOutListeners = new Set<() => void>();

/**
 * Hear about the token going away — a logout, or a 401 on the way to the login
 * page — before the page itself does. For whatever keeps running under the
 * token until the document is replaced: the page's socket above all, whose
 * frames would otherwise go on feeding the device copy being cleared.
 */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

export function clearToken(): void {
  token = null;
  // Tickets were minted by the token that just died; none of them outlive it.
  forgetDownloadTicket();
  // Nor does the copy of the session list and transcripts kept for a fast
  // start: it is the logged-in user's, not the device's. Sealed at once, so a
  // save already scheduled cannot put any of it back.
  void cacheClear();
  for (const listener of [...signedOutListeners]) {
    try {
      listener();
    } catch {
      // one listener failing must not keep the others from hearing
    }
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored to remove
  }
}

/** The `Authorization` header for a raw `fetch`, or nothing when logged out. */
export function authHeader(): Record<string, string> {
  const value = getToken();
  return value ? { Authorization: `Bearer ${value}` } : {};
}

// ---------------------------------------------------------------------------
// Whether this server wants a login at all
// ---------------------------------------------------------------------------

let status: AuthStatus | null = null;
let statusInFlight: Promise<AuthStatus> | null = null;

/**
 * `GET /api/auth/status`, asked once per page load.
 *
 * The route needs no token, so this is also how a browser holding a dead one
 * finds out. Asked after a `#local-open=` link has been traded for a session
 * ({@link startLocalOpen}), so the answer is about that session. A network failure reads as "open server": there is no password to
 * type at a server that cannot be reached, and the requests that follow fail
 * visibly on their own.
 */
export async function authStatus(): Promise<AuthStatus> {
  if (status) return status;
  statusInFlight ??= (async () => {
    // Who the page is depends on the token a `#local-open=` link is being
    // traded for, so that trade lands first.
    await localOpenFlight;
    try {
      const res = await pageApi().GET("/api/auth/status");
      status = res.data ?? OPEN_SERVER;
    } catch {
      status = OPEN_SERVER;
    } finally {
      statusInFlight = null;
    }
    return status ?? OPEN_SERVER;
  })();
  return statusInFlight;
}

/**
 * Whether a login is required, from the cached answer.
 *
 * Synchronous on purpose: the router guard resolves `authStatus()` before
 * anything renders, so every caller downstream of a render can just read it.
 * Before that first answer it reads as "open", which only ever means one extra
 * unticketed request that the 401 handler picks up.
 */
export function authRequired(): boolean {
  return status?.authRequired ?? false;
}

/**
 * Whether the Droppen desktop app runs this page's server and owns its login
 * (`desktop/` in the repository; `RH_DESKTOP_APP` on the server). The app made
 * the password nobody knows and signs in again by itself, so a password change
 * and a sign-out are dead ends there; and its window has no popups, so it signs
 * in to Droppen through the system browser (`features/link/browser-sign-in.tsx`).
 * Synchronous for the reason {@link authRequired} is.
 */
export function isDesktopApp(): boolean {
  return status?.desktopApp ?? false;
}

/**
 * The command a person types on this page's device to run its server
 * (`lib/droppen-command.ts`), from the cached status. Synchronous for the
 * reason {@link authRequired} is.
 */
export function pageDroppenCommand(): string {
  return droppenCommand(status);
}

/**
 * Who the cached status says is signed in: a name, `null` on an open server or
 * when nobody is, `undefined` while the status has not been asked yet.
 */
export function currentUser(): string | null | undefined {
  return status ? status.user : undefined;
}

/** Forget the cached status, so the next `authStatus()` asks again. */
export function forgetAuthStatus(): void {
  status = null;
  statusInFlight = null;
}

/**
 * Re-ask who we are, ignoring the cache, and send the browser to the login page
 * when the answer is "nobody".
 *
 * This is the escape hatch for the one refusal a script cannot read: a
 * websocket handshake rejected for want of a ticket closes with no status code,
 * so the only way to tell "the server is down" from "the token is dead" is to
 * ask a route that answers without one.
 */
export async function verifyStillAuthorized(): Promise<boolean> {
  const res = await pageApi().GET("/api/auth/status");
  if (!res.data) return true; // no answer is not an answer
  status = res.data;
  if (res.data.authRequired && !res.data.user) {
    noteUnauthorized("/api/auth/status");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Logging in and out
// ---------------------------------------------------------------------------

/** Keep the token a login (or the first account's setup) handed back. */
function signedIn(result: LoginResult): void {
  // A download ticket belongs to the session that minted it, which this one
  // replaces — and, after the setup, the server has just revoked.
  forgetDownloadTicket();
  setToken(result.token);
  status = {
    authRequired: true,
    setupRequired: false,
    user: result.username,
    desktopApp: status?.desktopApp ?? false,
    authOff: false,
    droppenPath: status?.droppenPath ?? "",
    droppenEnv: status?.droppenEnv ?? [],
  };
  // The device copy is this user's to fill from here on.
  cacheUnseal();
  void primeDownloadTicket();
}

/** Exchange a password for a token, and keep it. Throws `ApiError` on refusal. */
export async function login(username: string, password: string): Promise<LoginResult> {
  const res = await pageApi().POST(LOGIN_API_PATH, { body: { username, password } });
  if (!res.data) throw new ApiError(res.error);
  signedIn(res.data);
  return res.data;
}

/**
 * Make the first account of a server in its setup state, and keep the token
 * that comes back: the page that made the account is signed in to it, exactly
 * as after {@link login}.
 *
 * `code` is the one-time setup code the server printed, sent as typed (the
 * server ignores case, spaces and dashes, and reads O as 0 and I or L as 1).
 * `null` when the page is this device's owner ({@link LOCAL_OWNER}), whose
 * session is what the code would otherwise prove: it is not sent at all. The
 * server then revokes every owner session, so the new token is the page's only
 * one from here on.
 *
 * Throws `ApiError` on refusal — its `code` is one of `invalid_account`,
 * `code_required`, `wrong_setup_code`, `not_from_cloud`, `setup_done`,
 * `name_taken`, `auth_off`, `no_setup_code` or `too_many_attempts` (with
 * `retryAfterSeconds` in its body).
 */
export async function setupAccount(code: string | null, username: string, password: string): Promise<LoginResult> {
  const body: components["schemas"]["SetupRequest"] = code === null ? { username, password } : { code, username, password };
  const res = await pageApi().POST(SETUP_API_PATH, { body });
  if (!res.data) throw new ApiError(res.error);
  signedIn(res.data);
  return res.data;
}

// ---------------------------------------------------------------------------
// Opened signed in from the device itself
// ---------------------------------------------------------------------------

/**
 * The trade of a `#local-open=` token for a session, while it is under way —
 * {@link authStatus} waits for it — and how it ended when it did not work.
 */
let localOpenFlight: Promise<void> | null = null;
let localOpenError: unknown = null;

/**
 * Trade a local-open token for a session, and keep the session.
 *
 * `remote-hand-server open` on the device (or the desktop app's "open in
 * browser") opens this page with `#local-open=<token>`: single use, alive for
 * a minute, and good only while the device has no account. The token goes in
 * the body, never in a URL, and is never written anywhere: the fragment it came
 * in is gone from the address before anything else runs (`lib/local-open.ts`).
 * A refusal is kept for the page to show ({@link localOpenFailure}) and leaves
 * whatever token the browser already held alone.
 */
export function redeemLocalOpen(token: string): Promise<void> {
  localOpenError = null;
  localOpenFlight = (async () => {
    try {
      // Not a token at all (`local-open.ts` read it as ""): what the server
      // would say, without asking it.
      if (!token) throw new ApiError({ error: "invalid_local_open" });
      const res = await pageApi().POST(LOCAL_OPEN_API_PATH, { body: { token } });
      if (!res.data) throw new ApiError(res.error);
      // Whoever the old token was (a dead one, an earlier owner session), the
      // device copy and the tickets were theirs.
      if (getToken() !== null) clearToken();
      setToken(res.data.token);
      cacheUnseal();
      forgetAuthStatus();
    } catch (error) {
      localOpenError = error;
    }
  })();
  return localOpenFlight;
}

/**
 * At boot, before the router asks who the page is: trade the token a
 * `#local-open=` link brought, if it brought one. The local shell's only —
 * droppen.app reaches a device through Droppen, which a local-open never is.
 */
export function startLocalOpen(): void {
  const token = takeLocalOpen();
  if (token !== null) void redeemLocalOpen(token);
}

/** Why the last `#local-open=` link did not sign the page in, or null. */
export function localOpenFailure(): unknown {
  return localOpenError;
}

/**
 * Revoke this token server-side and drop it locally.
 *
 * The local half happens whatever the server said: a token the user asked to be
 * rid of must not survive a failed request.
 */
export async function logout(): Promise<void> {
  try {
    await pageApi().POST("/api/auth/logout");
  } catch {
    // revoked locally regardless
  }
  clearToken();
  forgetAuthStatus();
  // The caller navigates away next; the copy is gone before it does.
  await cacheClear();
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/**
 * How long a minted download ticket is spent before a fresh one is asked for.
 * The server gives it a minute, bound to the session that minted it; stopping
 * at forty-five seconds leaves fifteen of slack for a slow request and for a
 * URL rendered just before the end. Measured on the local clock from the mint
 * rather than read from `expiresAt`, so a skewed clock cannot shorten it to
 * nothing (and mint on every render) or stretch it past the server's.
 */
export const DOWNLOAD_TICKET_TTL_MS = 45 * 1000;

export interface CachedTicket {
  ticket: string;
  /** `Date.now()` when it was minted — elapsed local time, so clock skew is moot. */
  cachedAt: number;
}

/** The cached ticket if it is still worth spending at `now`, else null. */
export function freshTicket(
  entry: CachedTicket | null,
  now: number,
  ttlMs: number = DOWNLOAD_TICKET_TTL_MS,
): string | null {
  if (!entry) return null;
  const age = now - entry.cachedAt;
  // A clock that jumped backwards makes `age` negative; that is not freshness.
  return age >= 0 && age < ttlMs ? entry.ticket : null;
}

/**
 * The one download ticket this tab shares, as a store that can be subscribed to.
 *
 * A store rather than a plain variable because of the failure this file used to
 * have. `<img src>` is built during a render, a render cannot await a mint, and
 * so a render that found the cache empty baked a URL with no ticket in it — a
 * 401 and a broken thumbnail. The mint that the miss kicked off then landed in
 * a module variable nothing was watching, so React had no reason to re-render
 * and the broken URL stayed in the DOM until something unrelated re-rendered
 * that subtree; on an idle session page, never. A backgrounded tab — which is
 * how this app is used, since iOS freezes a PWA's timers and then its whole
 * JS — hit that path on the first render after every wake. Anything that reads
 * the ticket while rendering now goes through {@link subscribeDownloadTicket}
 * and {@link downloadTicketSnapshot} with `useSyncExternalStore`, so a ticket
 * that lands late still repaints.
 *
 * Two rules keep the repaints down to the ones that mean something, because an
 * `<img src>` that changes is an `<img>` the browser fetches again — on a phone,
 * over cellular:
 *
 *  * Watchers are woken by a change of *ticket string*, not of cache entry. An
 *    entry is also rewritten in place to expire it, and an expiry is not news to
 *    an image that has already loaded.
 *  * A replacement lands before the old one is dropped, never after: there is
 *    no window in which a render bakes a URL with no ticket at all.
 *
 * A ticket lives a minute, so while anything renders it, it is replaced just
 * before it stops being worth spending ({@link scheduleTicketRefresh}). That
 * costs a picture that has loaded nothing — `HostImage` keeps the URL that
 * worked — and keeps the ones that have not loaded yet, and every `href`, on a
 * live ticket. A tab nobody is looking at mints nothing; it catches up when it
 * is looked at again.
 */
let downloadTicket: CachedTicket | null = null;
let downloadInFlight: Promise<string> | null = null;
const ticketWatchers = new Set<() => void>();

/**
 * Bumped by anything that decides the cached ticket is dead.
 *
 * A mint already in flight at that moment was very likely answered by the server
 * instance that has since gone away, so its answer is compared against the epoch
 * it started in and dropped rather than cached.
 */
let ticketEpoch = 0;

/** Replace the cache, waking watchers only when the string they render changed. */
function setDownloadTicket(next: CachedTicket | null): void {
  const before = downloadTicket?.ticket ?? null;
  downloadTicket = next;
  scheduleTicketRefresh();
  if ((next?.ticket ?? null) === before) return;
  // Copied first: a watcher is free to unsubscribe as it runs, and a `Set`
  // mutated mid-iteration would skip whoever came after it.
  for (const watcher of [...ticketWatchers]) watcher();
}

/** Watch the download ticket; the returned function stops watching. */
export function subscribeDownloadTicket(onChange: () => void): () => void {
  ticketWatchers.add(onChange);
  scheduleTicketRefresh();
  return () => {
    ticketWatchers.delete(onChange);
    scheduleTicketRefresh();
  };
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let watchingVisibility = false;

/** Whether the page is hidden, where that can be known. */
function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Replace the cached ticket when it stops being worth spending, as long as
 * something renders it — a picture still to load, a download link — and the
 * page is being looked at.
 *
 * At most one timer, re-armed on every change of the cache and of who is
 * watching, so there is nothing to leak. A mint that fails is not retried
 * from here: the next thing that needs a ticket asks again, so a server that
 * is down cannot be turned into a loop. A hidden page mints nothing; when it
 * is shown again a stale ticket is replaced at once.
 */
function scheduleTicketRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!downloadTicket || ticketWatchers.size === 0) return;
  if (!watchingVisibility && typeof document !== "undefined" && typeof document.addEventListener === "function") {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", () => {
      if (!pageHidden() && ticketWatchers.size > 0 && downloadTicket && freshDownloadTicket() === null) void primeDownloadTicket();
    });
  }
  const due = downloadTicket.cachedAt + DOWNLOAD_TICKET_TTL_MS - Date.now();
  refreshTimer = setTimeout(
    () => {
      refreshTimer = null;
      if (ticketWatchers.size === 0 || pageHidden()) return;
      void primeDownloadTicket();
    },
    Math.max(0, due),
  );
  // Never what keeps a process alive (tests run this module under node).
  (refreshTimer as { unref?: () => void }).unref?.();
}

/**
 * The last download ticket this tab was handed, expired or not, or null.
 *
 * The `getSnapshot` half of the store, so it has to be free of side effects and
 * has to keep answering the same thing until a watcher has been woken — which
 * rules out both the "start a mint on a miss" its predecessor did and any
 * freshness check against the clock. Last known rather than live is also the
 * right answer for a URL: a ticket past its forty-five seconds is usually
 * still good (the server keeps it for sixty) and is about to be replaced, and
 * when it is not, the `<img>` that finds out says so. Callers that must have a
 * live one await {@link fetchTicket}.
 */
export function downloadTicketSnapshot(): string | null {
  return downloadTicket?.ticket ?? null;
}

/** The cached ticket if it is still worth spending right now, minting nothing. */
export function freshDownloadTicket(): string | null {
  return freshTicket(downloadTicket, Date.now());
}

async function mintTicket(scope: TicketScope): Promise<string> {
  const res = await pageApi().POST("/api/auth/ticket", { body: { scope } });
  if (!res.data) throw new ApiError(res.error);
  return res.data.ticket;
}

/** Mint a download ticket into the cache, sharing one request among callers. */
function mintDownloadTicket(): Promise<string> {
  if (downloadInFlight) return downloadInFlight;
  const epoch = ticketEpoch;
  const flight = mintTicket("download").then((ticket) => {
    if (epoch === ticketEpoch) setDownloadTicket({ ticket, cachedAt: Date.now() });
    return ticket;
  });
  // Cleared by identity rather than unconditionally: an invalidation clears this
  // slot itself, and the mint it abandoned must not then clear the one that
  // replaced it and leave two mints running with no dedup between them.
  const settle = () => {
    if (downloadInFlight === flight) downloadInFlight = null;
  };
  void flight.then(settle, settle);
  downloadInFlight = flight;
  return flight;
}

/**
 * A ticket for `scope`.
 *
 * `ws` tickets are single-use — redeeming one destroys it — so they are never
 * cached and every reconnect mints its own. `download` tickets are reusable for
 * a minute, so one is kept and shared: a transcript full of images would
 * otherwise mint a ticket per `<img>` and walk straight into the server's
 * live-ticket cap. Per click is the other side of that line and is fine — a
 * click is rare, and it is the one moment at which we know a URL is about to be
 * spent rather than merely rendered.
 */
export async function fetchTicket(scope: TicketScope): Promise<string> {
  if (scope !== "download") return mintTicket(scope);
  return freshDownloadTicket() ?? mintDownloadTicket();
}

/**
 * Warm the cache, so the first paint has a ticket to build `<img src>` from.
 *
 * Resolves either way — a failure only means the next URL goes out unticketed,
 * and the image that gets a 401 for it repairs the cache — which is why the
 * router guard can await this without a broken server hanging the app.
 */
export function primeDownloadTicket(): Promise<void> {
  if (!authRequired() || !getToken()) return Promise.resolve();
  return fetchTicket("download").then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Treat the cached ticket as dead and go and get another.
 *
 * Expired in place rather than dropped: everything that *renders* it keeps the
 * string it already has — which is worth trying, and is sitting in a DOM
 * attribute either way — while everything that *spends* it sees a stale entry
 * and mints. When the replacement lands the watchers wake exactly once, with a
 * ticket that works. Dropping it instead would repaint every image with a URL
 * carrying no ticket at all, which is a guaranteed 401 and then a second
 * repaint when the mint returns.
 */
export function invalidateDownloadTicket(): void {
  ticketEpoch += 1;
  downloadInFlight = null;
  if (downloadTicket) setDownloadTicket({ ...downloadTicket, cachedAt: 0 });
  void primeDownloadTicket();
}

/** Forget the ticket outright — for a token that no longer exists. */
function forgetDownloadTicket(): void {
  ticketEpoch += 1;
  downloadInFlight = null;
  setDownloadTicket(null);
}

/**
 * How long after a repair the next broken image is ignored.
 *
 * An image that is still broken after being given a brand new ticket is broken
 * for a reason a ticket cannot fix, and the repair costs a mint and a repaint
 * of every picture that has not loaded yet. Twenty seconds is far longer than
 * the round trip and well inside the ticket's minute, so a page of dead images
 * cannot turn into a mint loop against the server's live-ticket cap.
 */
export const HEAL_COOLDOWN_MS = 20 * 1000;

/** When the cached ticket was last replaced because an image said it was dead. */
let lastHealAt = 0;

/**
 * What an `<img>` that failed to load does about it.
 *
 * A broken image is the only report we ever get that a download ticket has
 * died, and it is a poor one: an error event carries no status code, so a 401
 * from a dead ticket and a 404 from a deleted file arrive here looking
 * identical. So this is deliberately cheap and self-limiting, in three ways
 * that between them make a loop impossible:
 *
 *  * Nothing happens unless `used` — the ticket that was in the URL that
 *    failed — is the one currently worth spending. A gallery whose images all
 *    fail at once therefore costs one mint: the first image condemns the ticket
 *    and the rest find it already condemned and only join the mint in flight.
 *  * A repair inside {@link HEAL_COOLDOWN_MS} of the last one is refused, so a
 *    file that is simply gone cannot mint over and over as it is repainted.
 *  * And the caller latches: one repair per mounted image, ever.
 */
export function healDownloadTicket(used: string | null): void {
  if (!authRequired() || !getToken()) return;
  const spendable = freshDownloadTicket();
  // No live ticket to condemn: either one has never been minted, or somebody
  // else has already condemned this one and a mint is on its way — which
  // `primeDownloadTicket` joins rather than duplicates.
  if (spendable === null) {
    void primeDownloadTicket();
    return;
  }
  // The failed URL was built with a ticket that has since been replaced, so
  // the picture is about to repaint with the new one on its own.
  if (used !== spendable) return;
  const now = Date.now();
  const since = now - lastHealAt;
  // Negative is a clock that jumped backwards, which is not a cooldown — the
  // same reading `freshTicket` takes of the same problem.
  if (since >= 0 && since < HEAL_COOLDOWN_MS) return;
  lastHealAt = now;
  invalidateDownloadTicket();
}

/**
 * Whether a `settings` frame means we are talking to a server that never minted
 * the ticket we are holding.
 *
 * Tickets live in a `HashMap` in the server's memory, so a restart forgets every
 * one of them while the browser goes on believing its copy is good — and nothing
 * on the client notices, because the websockets reconnect and mint themselves
 * fresh `ws` tickets while every download quietly 401s. `serverStartedAt`, which
 * the feed sends in a `settings` frame on every connect, is what tells the two
 * cases apart: a reconnect carrying a different start time is a restart, and one
 * carrying the same start time is a dropped connection that cost us nothing.
 * Comparing it rather than reacting to the socket opening is what stops a blip
 * on a phone's flaky connection from throwing away a good ticket and repainting
 * every image on the page.
 *
 * The first frame of a page load proves nothing and never counts. A server that
 * will not identify its boot at all (recorded as `""`) counts as a restart on
 * every frame after the first — the blunter, older behaviour, and the safe
 * direction to be wrong in.
 */
export function serverRestarted(prev: string | null, next: string | null | undefined): boolean {
  if (prev === null) return false;
  if (!prev || !next) return true;
  return prev !== next;
}

// ---------------------------------------------------------------------------
// What a 401 means
// ---------------------------------------------------------------------------

/**
 * Whether a 401 from `requestPath`, seen while the browser is on `currentPath`,
 * should send it to the login page.
 *
 * Two exceptions. A 401 from a password endpoint is a wrong password and belongs
 * in the form that asked for it — throwing the user out of the settings page for
 * mistyping their current password would be absurd, and on the login page itself
 * it is the loop. And a 401 that arrives while the login page is already open
 * has nowhere to go: the page it would navigate to is the page it is on.
 */
export function shouldRedirectToLogin(requestPath: string, currentPath: string): boolean {
  if (PASSWORD_PATHS.includes(requestPath)) return false;
  // The setup page is the other way in, and as much a dead end for a 401: in
  // the setup state everything but its own endpoint answers one.
  return currentPath !== LOGIN_PATH && currentPath !== SETUP_PATH;
}

type AuthAnswer = Pick<AuthStatus, "authRequired" | "setupRequired" | "user" | "authOff">;

/**
 * Whether this caller is one the setup page is for: it has to sign in, nobody
 * is signed in, and the server has no account yet to sign in to.
 */
export function needsSetup(answer: AuthAnswer): boolean {
  return answer.authRequired && !answer.user && answer.setupRequired === true;
}

/** Whether this caller has to sign in, and there is an account to sign in to. */
export function needsLogin(answer: AuthAnswer): boolean {
  return answer.authRequired && !answer.user && !answer.setupRequired;
}

/**
 * Whether authentication is switched off altogether. A server that does not
 * say (`authOff` absent) meant exactly this by `authRequired: false`.
 */
export function authIsOff(answer: AuthAnswer): boolean {
  return answer.authOff ?? !answer.authRequired;
}

/**
 * Whether the setup page has something for this caller: the device has no
 * account yet, and nobody is signed in — or the device's owner is, who makes
 * the first account there without the code.
 */
export function setupOpenTo(answer: AuthAnswer): boolean {
  return answer.setupRequired === true && !authIsOff(answer) && (!answer.user || isLocalOwner(answer.user));
}

/** The page the router guard sends a load to instead of the one asked for. */
export interface AuthRedirect {
  to: "/" | typeof LOGIN_PATH | typeof SETUP_PATH;
  /** For the login page: where to come back to afterwards. */
  next?: string;
}

/**
 * Where a page load goes, given the server's answer to `GET /api/auth/status`
 * and the path (`pathname`, and the whole `href` for coming back) it asked
 * for: nowhere (`null`, draw what was asked for) or one of the entrances.
 *
 *  * {@link needsSetup}: the setup page, from everywhere;
 *  * {@link needsLogin}: the login page, coming back to where it was asked
 *    from — but from the setup page, which is over once an account exists,
 *    with nowhere to come back to;
 *  * anybody else — signed in (`user`: an account, this device's owner by a
 *    local-open session, or a device reached through Droppen), or
 *    authentication off — the app. The login page sends them home; so does
 *    the setup page, unless it still has something for them
 *    ({@link setupOpenTo}: the owner, while the device has no account).
 */
export function authRedirect(answer: AuthAnswer, pathname: string, href: string): AuthRedirect | null {
  if (needsSetup(answer)) return pathname === SETUP_PATH ? null : { to: SETUP_PATH };
  if (needsLogin(answer)) {
    if (pathname === LOGIN_PATH) return null;
    if (pathname === SETUP_PATH) return { to: LOGIN_PATH };
    const next = safeNext(href);
    return next === "/" ? { to: LOGIN_PATH } : { to: LOGIN_PATH, next };
  }
  if (pathname === SETUP_PATH) return setupOpenTo(answer) ? null : { to: "/" };
  if (pathname === LOGIN_PATH) return { to: "/" };
  return null;
}

/** The login URL that comes back to `next` afterwards. */
export function loginHref(next: string): string {
  const target = safeNext(next);
  return target === "/" ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(target)}`;
}

/**
 * A `next=` turned into somewhere it is safe to go.
 *
 * Only a path on this origin: anything absolute, protocol-relative (`//host`,
 * and `/\host`, which browsers read the same way) or plain nonsense becomes the
 * home page, so a crafted link cannot use the login page as an open redirect.
 *
 * The strip on the first line is the part that is easy to miss and is the whole
 * defence. A URL parser removes ASCII tab, CR and LF from *anywhere* in a URL
 * before it parses it (WHATWG URL, "basic URL parser" step 2), so the string
 * this function inspects is not the string `location.replace` will act on:
 * `/<tab>//evil.example` passes a naive `startsWith("//")` test and is then
 * parsed as `///evil.example`, which is protocol-relative and leaves the origin.
 * Stripping first makes the two agree, and the cleaned string — not the
 * original — is what is handed back, so the caller navigates to what was
 * checked.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return "/";
  const cleaned = next.replace(/[\t\n\r]/g, "");
  if (!cleaned.startsWith("/")) return "/";
  // `\` is `/` to a URL parser once it is looking for an authority, so `/\host`
  // and `//host` are the same protocol-relative URL and both are refused.
  if (cleaned[1] === "/" || cleaned[1] === "\\") return "/";
  return cleaned;
}

/**
 * Where a 401 sends this page, given the last status it had and where it is:
 * the setup page when the server has no account to sign in to, otherwise the
 * login page, coming back here afterwards.
 *
 * Under the desktop app always the login page: its window signs in with the
 * app's own account, which does not end the setup state, so the server says
 * `setupRequired` to the window too — and the app answers a move to the
 * login page with a fresh login (`desktop/core/src/web.rs`), never one to the
 * setup page, which asks for a code its user does not have. A browser on the
 * same device that heads for the login page is sent on to the setup page by
 * the guard of the page that loads, which asks the server again.
 */
export function unauthorizedHref(last: Pick<AuthStatus, "authRequired" | "setupRequired" | "user" | "authOff" | "desktopApp"> | null, here: string): string {
  if (last && needsSetup(last) && !last.desktopApp) return SETUP_PATH;
  return loginHref(here);
}

/** One navigation per page, however many requests fail at once. */
let redirecting = false;

/**
 * Act on a 401: drop the dead token and go and get a new one.
 *
 * A hard navigation rather than a router push, because everything running under
 * the dead token — websockets, their reconnect timers, react-query retries —
 * has to stop, and a document swap is the one thing that stops all of it.
 *
 * To the setup page rather than the login page when the last status said the
 * server has no account (as {@link verifyStillAuthorized} finds a server whose
 * accounts are gone): there is nobody to sign in as — but never under the
 * desktop app ({@link unauthorizedHref}). Either way the guard of the page
 * that loads asks again and has the last word.
 */
export function noteUnauthorized(requestPath: string): void {
  if (redirecting) return;
  if (!shouldRedirectToLogin(requestPath, location.pathname)) return;
  clearToken();
  redirecting = true;
  const href = unauthorizedHref(status, location.pathname + location.search);
  // After the device copy is gone, not before: an unload interrupts the
  // clear. Bounded, so a hung database cannot keep the page here.
  void cacheClear().finally(() => location.replace(href));
}
