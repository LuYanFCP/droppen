/** The route contribution for `subpath`, by longest prefix; `""` matches everything. */
export function matchRoute<R extends { path: string }>(routes: readonly R[], subpath: string): R | undefined {
  const clean = subpath.replace(/^\/+|\/+$/g, "");
  return routes
    .map((route) => ({ route, path: route.path.replace(/^\/+|\/+$/g, "") }))
    .filter(({ path }) => path === "" || clean === path || clean.startsWith(path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0]?.route;
}
