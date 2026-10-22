/**
 * Host files are served by one endpoint that takes the path as a query
 * parameter. Keeping the path out of the URL path matters in front of a CDN:
 * an unknown /root/... URL hits the SPA fallback and returns HTML instead of
 * the file.
 *
 * On a server that requires a login the URL also has to carry a `download`
 * ticket, because the two things it is used for — `<img src>` and `<a href>` —
 * cannot send an `Authorization` header. The ticket is a *parameter* here
 * rather than something this function goes and finds, which is the whole point:
 * a URL builder that reached into a cache could only ever build the URL that
 * cache happened to hold at render time, and the caller is the only one that
 * knows whether it is painting a picture (last known ticket, repaired if it
 * turns out to be dead) or spending a click (a live one, awaited). See
 * `components/host-file.tsx`, which is where both callers now live, and
 * `lib/auth.ts` for the store the ticket comes out of.
 *
 * Pass `null` with authentication switched off: there is no ticket to carry.
 */
export function fileDownloadUrl(
  path: string,
  ticket: string | null,
  opts?: { inline?: boolean },
): string {
  const url = `/api/fs/download?path=${encodeURIComponent(path)}${opts?.inline ? "&inline=true" : ""}`;
  return ticket ? `${url}&ticket=${encodeURIComponent(ticket)}` : url;
}

/**
 * The host path a markdown href points at, or null when it is a real link.
 * Agents write plain filesystem paths ("/root/notes.md", "~/report.pdf");
 * anything else — external URLs, anchors, our own /api routes — is left alone.
 *
 * The href arrives percent-encoded (markdown normalises non-ASCII link targets
 * into a valid URI), so it has to be decoded back into a path before it is
 * handed to fileDownloadUrl — otherwise the escapes get encoded a second time
 * and the server looks up a literal "/root/%E9%98%B2..." that does not exist.
 *
 * A `file://` URL is the same path spelled as a URL ("file:///root/a.png", or
 * with `localhost` as the host); one naming any other host is not ours to open.
 */
export function localFilePath(url: string | undefined): string | null {
  if (!url) return null;
  const file = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(url);
  if (!file && /^file:/i.test(url)) return null;
  const href = file?.[1] ?? url;
  // "//host/x" is protocol-relative, not a path.
  const isPath = href === "~" || href.startsWith("~/") || (href.startsWith("/") && !href.startsWith("//"));
  if (!isPath || href.startsWith("/api/")) return null;
  try {
    return decodeURIComponent(href);
  } catch {
    return href; // malformed escape: a literal '%' in the name, so take it as-is
  }
}
