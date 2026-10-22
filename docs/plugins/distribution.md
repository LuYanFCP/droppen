# Plugins and distributions

Droppen's core ships **no plugins**. A *distribution* is the core plus a list of
plugin packages, composed when the web app is built; the server binary embeds
the result. Which plugins a running instance actually shows is then a
per-instance switch (Settings › Plugins, the `plugin` CLI, or the
configuration).

## Pieces

| Piece | Where | Licence |
|---|---|---|
| `@droppen/plugin-sdk` — types, `definePlugin`, `usePluginHost`, `createTestHost()` | `packages/plugin-sdk` | MIT OR Apache-2.0 |
| `droppen-plugin-sdk` — manifest, ids, engines, store wire format | `server-rs/crates/droppen-plugin-sdk` | MIT OR Apache-2.0 |
| The host: registry, `/p/<id>/` routes, panes, Settings › Plugins, `PluginHost` | `web/src/plugins`, `server-rs/src/plugins` | the core's |
| The build step: `droppenPlugins()` | `web/build/droppen-plugins.ts` | the core's |
| The document store protocol | [`storage-protocol.md`](storage-protocol.md) | with the SDK |

The SDK and the host are open core: `scripts/check-plugin-boundary.mjs` (TS
imports) and `scripts/check-sdk-crate-deps.sh` (the crate's dependency tree)
keep them off the hosted service's code, and CI runs both.

## The distribution manifest

```json
{
  "name": "public",
  "plugins": []
}
```

That is `distribution.json` at the repository root: the open build. A build
reads it unless `DROPPEN_DISTRIBUTION` names another file, which is how a
private build is made **without anything private entering this repository**:

```json
{
  "name": "my-private",
  "plugins": [
    { "tarball": "../release/droppen-plugin-example-0.1.0.tgz" }
  ]
}
```

Each entry gives exactly one of:

- `"tarball"` — a `pnpm pack` / `npm pack` file; unpacked under
  `web/node_modules/.droppen-plugins/<hash>/`;
- `"path"` — a built package directory (one with `package.json` and its
  `dist/`), e.g. a plugin checkout during development;
- `"package"` — a package installed in `web/node_modules`.

Relative paths are resolved against the manifest's own directory. An entry may
add `"defaultEnabled": true` to override the package's own default (normally
off).

The build (`droppenPlugins()` in `web/vite.config.ts`) reads each package's
`package.json` → `droppen` manifest, **fails** on a bad id, a repeated id, a bad
alias or an `engines.droppen` range the tree's SDK does not satisfy, and then:

- generates `virtual:droppen/bundled-plugins` — every plugin's manifest and a
  `load()` that dynamically imports its entry. A plugin's code is a lazy chunk;
  the build also fails if any plugin module ends up statically reachable from
  the entry (the `vendor` chunk excludes `@droppen/plugin-*` and unpacked
  tarballs);
- writes `web/dist/plugins/manifest.json`, which the server reads from its
  embedded assets to learn what it ships.

The build log names the distribution:
`[droppen-plugins] distribution "my-private" (…): example@0.1.0`.

## Writing a plugin

A plugin is an ESM package whose `package.json` carries the manifest and whose
entry default-exports `definePlugin(...)`:

```json
{
  "name": "@droppen/plugin-example",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "peerDependencies": { "react": "^19", "@droppen/plugin-sdk": "^0.1.0" },
  "droppen": {
    "id": "example",
    "name": { "en": "Example", "zh-CN": "示例" },
    "engines": { "droppen": "^0.1.0" },
    "permissions": ["storage"],
    "aliases": []
  }
}
```

`engines.droppen` is read with Cargo's rules, by the build and by the server
alike: comparators joined by commas (`>=0.1.0, <0.3.0`), and a bare version
means `^` (`0.1.0` is `^0.1.0`). npm-only syntax (space-separated comparators,
`||`) fails the build. Aliases may not take a path the shell already answers
(`/settings`, `/sessions`, …).

Build it in library mode with `react`, `react/jsx-runtime`, `react-dom` and
`@droppen/plugin-sdk` external, keep views behind `React.lazy`, and do all I/O
through `host.*` (see the SDK README for the rules). Pages appear at
`/p/<id>/<path>`, panes in the split-pane picker, settings blocks under
Settings › Plugins.

## A private distribution build

A private distribution is the open core plus plugins that live elsewhere. Keep
its manifest and the plugin packages outside this repository (next to the
plugins, say) and point the build at it:

```sh
# The plugin, built and packed in its own repository.
cd /path/to/my-plugin && pnpm install && pnpm test && pnpm build && pnpm pack --pack-destination release

# The core, composed with it.
cd /path/to/droppen
pnpm install --frozen-lockfile
DROPPEN_DISTRIBUTION=/path/to/my-private.json pnpm --filter @remote-hand/web build
grep '"id"' web/dist/plugins/manifest.json                    # the plugins it bundles
DROPPEN_BUILD_REV=$(git rev-parse --short HEAD) cargo build --release --locked --manifest-path server-rs/Cargo.toml
grep -ac '"distribution": "my-private"' server-rs/target/release/remote-hand-server   # ≥ 1
```

`web/dist` is embedded when the server is compiled, so build the web app with
the manifest you mean immediately before the server. A build **without**
`DROPPEN_DISTRIBUTION` is the public distribution: no plugin chunk, no nav
entry, `/api/plugins/<id>/*` answers 404 and no `store.db` is created. A
public build deployed where a plugin was in use hides it, and keeps its data
(`plugins/<id>/store.db`) for the next build that bundles it again — so check
the `grep` before every deploy.

`droppen.app` serves the public distribution, so it shows no plugins for now;
serving a machine's own plugins to the browser over the end-to-end channel is
a later design, not built yet.

A plugin that took over a built-in feature may carry its own migration and
rollback steps; they belong in that plugin's documentation, with the rest of
its release runbook.
