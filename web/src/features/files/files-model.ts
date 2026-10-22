export interface FilesLocation {
  path?: string;
  file?: string;
}
export type FileSort = "name" | "modified" | "size";
interface Entry {
  name: string;
  kind: string;
  sizeBytes: number | null;
  mtime: string | null;
}

/** Directories stay first, regardless of the selected sort; never mutate query data. */
export function arrangeFiles<T extends Entry>(
  entries: readonly T[],
  query: string,
  sort: FileSort,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries
    .filter((e) => e.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      const directory = Number(b.kind === "dir") - Number(a.kind === "dir");
      if (directory) return directory;
      const delta =
        sort === "size"
          ? (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1)
          : sort === "modified"
            ? (b.mtime ?? "").localeCompare(a.mtime ?? "")
            : 0;
      return (
        delta ||
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
    });
}
export function joinFilePath(dir: string, name: string): string {
  return `${dir.replace(/\/$/, "")}/${name}`;
}
export function directoryInput(value: string, current: string): string | null {
  const input = value.trim();
  if (!input) return null;
  return input.startsWith("/") || input === "~" || input.startsWith("~/")
    ? input
    : joinFilePath(current, input);
}
export function fileBreadcrumbs(
  path: string,
  home: string,
): { label: string; path: string }[] {
  if (!home || (path !== home && !path.startsWith(`${home}/`)))
    return [{ label: path, path }];
  const parts = path.slice(home.length).split("/").filter(Boolean);
  return [
    { label: "~", path: home },
    ...parts.map((label, index) => ({
      label,
      path: `${home}/${parts.slice(0, index + 1).join("/")}`,
    })),
  ];
}
/** Restrict inline previews to raster images; HTML/SVG remain inert text. */
export function isPreviewImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path);
}
