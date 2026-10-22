/**
 * The two ways a file on the host reaches the browser: a link the user clicks,
 * and a picture the page draws. Both need a `download` ticket in the URL on a
 * server that requires a login (neither an `<a>` nor an `<img>` can send an
 * `Authorization` header), and each needs it at a different moment, which is
 * the whole reason this file exists rather than five call sites building URLs.
 *
 * A **click** resolves its ticket at click time and never trusts the one baked
 * into `href` at render time. That is the bug this closes: a ticket lives a
 * minute and is bound to the session that minted it, the server forgets every
 * live ticket when it restarts,
 * and a phone freezes the whole tab in the background — so "the URL React last
 * rendered" and "a URL the server will accept" are routinely different strings,
 * and a click on the first one downloads nothing at all. `href` stays a
 * best-effort ticketed URL so that right-click → save, middle-click and
 * copy-link still do something sensible; the click path just does not depend on
 * it being right.
 *
 * A **picture** cannot await anything — it is a URL handed to the browser
 * during a render — so it draws with the last ticket we were given, subscribes
 * to the store so that a ticket landing after a miss repaints it, and repairs
 * the cache once if the load fails. See `lib/auth.ts` for why the store wakes
 * on as few changes as it does.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { blobErrorText, endTransfer, failTransfer, progressTransfer, startTransfer } from "@/components/blob-transfers";
import { ImageFallback, ImagePending, useObjectUrl } from "@/components/source-image";
import {
  authRequired,
  downloadTicketSnapshot,
  fetchTicket,
  freshDownloadTicket,
  healDownloadTicket,
  primeDownloadTicket,
  subscribeDownloadTicket,
} from "@/lib/auth";
import { basename } from "@/lib/format";
import { fileDownloadUrl } from "@/lib/fs-url";
import { useMachine, useMachineRuntime } from "@/lib/machines/context";
import type { MachineKey } from "@/lib/machines/key";
import { transportFor } from "@/lib/machines/registry";
import type { Transport } from "@/lib/transport";
import { BLOB_LIMITS, type BlobCache, fetchBlob, hostBlobKey, hostBlobs } from "@/lib/transport/blob";

/*
 * When the machine is reached through a channel (`tunneled`: cloud mode) none
 * of the above applies: the page's origin is the hub, not the machine, so
 * there is no URL to hand an `<img>` or an `<a>` and no ticket to put in one.
 * The same components then fetch the file over the machine channel's `blob`
 * lane (`lib/transport/blob.ts`) and draw or save it from a `blob:` URL; the
 * choice is made once per component, since a machine's transport is set
 * before the app mounts and never changes kind after.
 */

/** Whether `machine`'s files are fetched over its channel rather than linked to. */
export function hostFilesTunneled(machine: MachineKey): boolean {
  return transportFor(machine).tunneled === true;
}

/*
 * Bumped whenever a transport says where it reaches changed (cloud mode: the
 * machine came back, or went and the offline copy took over), so a picture
 * that could not be had on one side is asked for again on the other. One
 * count per transport, so one machine switching sides asks nothing of another.
 */
interface Epoch {
  value: number;
  readonly watchers: Set<() => void>;
}
const epochs = new WeakMap<Transport, Epoch>();

function epochOf(transport: Transport): Epoch {
  let epoch = epochs.get(transport);
  if (!epoch) {
    const made: Epoch = { value: 0, watchers: new Set() };
    transport.onChange?.(() => {
      made.value++;
      for (const watch of [...made.watchers]) watch();
    });
    epochs.set(transport, made);
    epoch = made;
  }
  return epoch;
}

/** Changes each time this view's machine's transport switches sides; constant on a transport that never does. */
export function useTransportEpoch(): number {
  const transport = useMachineRuntime().transport;
  const subscribe = useCallback(
    (notify: () => void) => {
      const { watchers } = epochOf(transport);
      watchers.add(notify);
      return () => {
        watchers.delete(notify);
      };
    },
    [transport],
  );
  const read = () => epochOf(transport).value;
  return useSyncExternalStore(subscribe, read, read);
}

/** The route a host picture is fetched (and cached) by in cloud mode. */
export const hostImageRoute = (path: string) => fileDownloadUrl(path, null, { inline: true });

/**
 * The last download ticket this tab was handed, repainting the caller when it
 * changes, and asking for one if there has never been one.
 *
 * The prime is here rather than in the store's read because `getSnapshot` has
 * to be free of side effects. Only on `null`: a ticket that has merely aged is
 * replaced by the store itself just before the server would refuse it (it
 * keeps them fifteen seconds longer than we spend them), and whatever finds
 * out otherwise repairs it.
 */
export function useDownloadTicket(): string | null {
  const ticket = useSyncExternalStore(
    subscribeDownloadTicket,
    downloadTicketSnapshot,
    downloadTicketSnapshot,
  );
  useEffect(() => {
    if (ticket === null) void primeDownloadTicket();
  }, [ticket]);
  return ticket;
}

/**
 * Whether a click on a download link has to be taken over from the browser.
 *
 * Taking it over costs the user gesture if a mint has to be awaited, so it is
 * only done when the `href` cannot be trusted:
 *
 *  * `required` false — an open server puts no ticket in any URL, so there is
 *    nothing this could improve.
 *  * `modified` — cmd/ctrl/shift/alt or a non-primary button means "open this
 *    somewhere else", and that is the browser's job to do with the `href`.
 *  * otherwise: only when the ticket in the rendered `href` is not the one the
 *    cache would spend right now. That is the common case for a link that was
 *    rendered before a restart or before a wake, and it is *not* the case for a
 *    link on a page that has been sitting there for ten seconds — which is why
 *    the ordinary click still goes through the browser synchronously, gesture
 *    intact.
 */
export function interceptDownloadClick(opts: {
  required: boolean;
  modified: boolean;
  /** The ticket baked into `href` when this link was last rendered. */
  rendered: string | null;
  /** The ticket the cache would spend right now, or null if it has none. */
  fresh: string | null;
}): boolean {
  if (!opts.required || opts.modified) return false;
  return opts.fresh === null || opts.fresh !== opts.rendered;
}

/** Whether this click means "open it somewhere else" rather than "follow it". */
function isModifiedClick(e: React.MouseEvent): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** How a download is actually started. A seam: see {@link startDownload}. */
export type OpenDownload = (url: string, name?: string) => void;

/**
 * Hand a URL to the browser to download, without navigating this document.
 *
 * A synthesized `<a>` rather than `location.assign`, because the `download`
 * attribute is what turns a response the browser could render — a PDF, a PNG,
 * anything the server marks `inline` — into a save, and because a navigation
 * that the server answers with a 401 would replace the app with an error page.
 * Attached to the document before the click and removed after: a detached
 * anchor works in Chrome and Safari but has historically been ignored by
 * Firefox, and the cost of being sure is two DOM operations.
 */
function clickSyntheticAnchor(url: string, name?: string): void {
  const a = document.createElement("a");
  a.href = url;
  // Empty is meaningful: it still forces a download, and lets the server's
  // `Content-Disposition` name the file.
  a.download = name ?? "";
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Start downloading a host file, resolving a ticket first if the cache has none
 * worth spending.
 *
 * `open` is injectable for one reason: there is no headless browser in this
 * repo, so a test can prove that the mint happens before the download starts
 * and that the URL carries the ticket that mint returned, but it cannot click a
 * real link. Nothing in the app passes it.
 *
 * A mint that fails falls back to whatever the cache last held — worth a try,
 * and a 401 while minting has already sent the browser to the login page by the
 * time this line runs.
 */
export async function startDownload(
  machine: MachineKey,
  path: string,
  opts: { name?: string; inline?: boolean } = {},
  open: OpenDownload = clickSyntheticAnchor,
): Promise<void> {
  if (hostFilesTunneled(machine)) return downloadThroughChannel(machine, path, opts, open);
  let ticket: string | null = null;
  if (authRequired()) {
    try {
      ticket = await fetchTicket("download");
    } catch {
      ticket = downloadTicketSnapshot();
    }
  }
  open(fileDownloadUrl(path, ticket, { inline: opts.inline }), opts.name);
}

/** A timer that does not keep a test runner (or any non-browser host) alive. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/** How long the `blob:` URL a download was handed over in outlives the click. */
const DOWNLOAD_URL_MS = 60_000;

/**
 * A download in cloud mode: the bytes over the channel's `blob` lane, shown
 * on the way (`components/blob-transfers.tsx`), then handed to the browser as
 * a `blob:` URL. A picture already drawn on the page is the same bytes and is
 * not fetched again. The name: the caller's, else the machine's
 * `Content-Disposition`, else the path's last segment — a `blob:` URL has no
 * name of its own to fall back on.
 */
async function downloadThroughChannel(
  machine: MachineKey,
  path: string,
  opts: { name?: string; inline?: boolean },
  open: OpenDownload,
  cache: BlobCache = hostBlobs,
): Promise<void> {
  const fallback = basename(path) || "download";
  const id = startTransfer(opts.name || fallback, machine);
  try {
    const held = cache.get(hostBlobKey(machine, hostImageRoute(path)));
    const got = held
      ? { blob: held, name: null }
      : await fetchBlob(fileDownloadUrl(path, null, { inline: opts.inline }), {
          via: transportFor(machine),
          limit: BLOB_LIMITS.download,
          onProgress: (received, total) => progressTransfer(id, received, total),
        });
    const url = URL.createObjectURL(got.blob);
    open(url, opts.name || got.name || fallback);
    unref(setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_MS));
    endTransfer(id);
  } catch (error) {
    failTransfer(id, error);
  }
}

type DownloadLinkProps = {
  path: string;
  /** The filename to save as; omitted lets the server's header decide. */
  name?: string;
  inline?: boolean;
  title?: string;
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  children?: React.ReactNode;
};

/**
 * A link that downloads a file from the host.
 *
 * `onClick` is called first and its `defaultPrevented`/`stopPropagation` are
 * respected, so a row that navigates on click can still stop the link from
 * taking the whole row with it.
 */
export function DownloadLink(props: DownloadLinkProps) {
  return hostFilesTunneled(useMachine()) ? <TunneledDownloadLink {...props} /> : <TicketedDownloadLink {...props} />;
}

/**
 * Cloud mode: no URL reaches the machine, so the link points nowhere and every
 * click — plain or modified — is a download through the channel.
 */
function TunneledDownloadLink({ path, name, inline, title, className, onClick, children }: DownloadLinkProps) {
  const machine = useMachine();
  return (
    <a
      href="#"
      data-tunneled=""
      title={title}
      className={className}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        void startDownload(machine, path, { name, inline });
      }}
    >
      {children}
    </a>
  );
}

function TicketedDownloadLink({ path, name, inline, title, className, onClick, children }: DownloadLinkProps) {
  const machine = useMachine();
  const ticket = useDownloadTicket();
  return (
    <a
      href={fileDownloadUrl(path, ticket, { inline })}
      download={name ?? ""}
      title={title}
      className={className}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (
          !interceptDownloadClick({
            required: authRequired(),
            modified: isModifiedClick(e),
            rendered: ticket,
            fresh: freshDownloadTicket(),
          })
        ) {
          return;
        }
        e.preventDefault();
        void startDownload(machine, path, { name, inline });
      }}
    >
      {children}
    </a>
  );
}

/**
 * An `<img>` of a file on the host.
 *
 * Two pieces of state that are not obvious:
 *
 * `loadedWith` pins the ticket that produced a load that worked, so that an
 * image already on screen is not re-fetched every time the shared ticket
 * changes. Without it, one dead thumbnail — or one server restart — re-writes
 * the `src` of every picture in the transcript and the browser downloads the
 * lot again. `undefined` means "nothing has loaded yet", which is the only
 * state in which this follows the live ticket; `null` is a legitimate pinned
 * value, from an open server that puts no ticket in the URL at all.
 *
 * `healed` allows exactly one repair per mounted image, ever. An error event
 * carries no status code, so a dead ticket and a deleted file are the same
 * event here; without the latch, a file that is simply gone would fail, mint,
 * repaint, fail again and mint forever. One attempt costs at most one wasted
 * ticket for a genuinely missing file and fixes the case that matters.
 */
type HostImageProps = {
  path: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
  /** Called when the picture is past repairing, so the caller can say so — with why, when that is known. */
  onFail?: (reason?: string) => void;
};

export function HostImage(props: HostImageProps) {
  return hostFilesTunneled(useMachine()) ? <TunneledHostImage {...props} /> : <TicketedHostImage {...props} />;
}

/** A host picture's bytes in cloud mode: held, or fetched once over this view's machine's channel and kept a while. */
export function useHostBlob(path: string, cache: BlobCache = hostBlobs): { blob?: Blob; error?: unknown } {
  const runtime = useMachineRuntime();
  const route = hostImageRoute(path);
  const key = hostBlobKey(runtime.key, route);
  // A switch between the machine and its copy asks again for what failed.
  const epoch = useTransportEpoch();
  const [state, setState] = useState<{ key: string; blob?: Blob; error?: unknown }>(() => ({ key, blob: cache.get(key) }));
  useEffect(() => {
    let live = true;
    const held = cache.get(key);
    if (held) {
      setState({ key, blob: held });
      return;
    }
    setState({ key });
    cache
      .load(key, async () => (await fetchBlob(route, { via: runtime.transport, limit: BLOB_LIMITS.image })).blob)
      .then(
        (blob) => live && setState({ key, blob }),
        (error: unknown) => live && setState({ key, error }),
      );
    return () => {
      live = false;
    };
  }, [key, route, runtime, cache, epoch]);
  return state.key === key ? state : {};
}

/**
 * Cloud mode: the picture from a `blob:` URL of bytes fetched over the
 * channel, a placeholder while they come, and the reason in place of the
 * picture when they do not — the machine is offline (the offline copy's own
 * sentence), the file is too large, it is not there.
 */
function TunneledHostImage({ path, alt, className, onFail }: HostImageProps) {
  const { t } = useTranslation();
  const { blob, error } = useHostBlob(path);
  const src = useObjectUrl(blob);
  const reason = error === undefined ? null : blobErrorText(error, t);
  useEffect(() => {
    if (reason !== null) onFail?.(reason);
    // Once per failure, not per render of the caller (`onFail` is often a fresh closure).
  }, [reason]);
  if (reason !== null) return <ImageFallback alt={alt} reason={reason} className={className} />;
  if (!src) return <ImagePending alt={alt} />;
  return <img src={src} alt={alt} className={className} onError={() => onFail?.()} />;
}

function TicketedHostImage({ path, alt, className, loading, onFail }: HostImageProps) {
  const live = useDownloadTicket();
  const [loadedWith, setLoadedWith] = useState<string | null | undefined>(undefined);
  const [healed, setHealed] = useState(false);
  // A different file behind the same element is a different picture: it has
  // loaded nothing and has spent no repair.
  useEffect(() => {
    setLoadedWith(undefined);
    setHealed(false);
  }, [path]);
  const used = loadedWith === undefined ? live : loadedWith;
  return (
    <img
      src={fileDownloadUrl(path, used, { inline: true })}
      alt={alt}
      className={className}
      loading={loading}
      onLoad={() => setLoadedWith(used)}
      onError={() => {
        // An open server puts no ticket in the URL, so there is nothing a
        // repair could change and the first failure is the answer.
        if (healed || !authRequired()) {
          onFail?.();
          return;
        }
        setHealed(true);
        // Back to following the live ticket, and ask for a live one to follow.
        setLoadedWith(undefined);
        healDownloadTicket(used);
      }}
    />
  );
}
