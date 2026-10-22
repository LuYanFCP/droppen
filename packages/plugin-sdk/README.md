# @droppen/plugin-sdk

The contract between [Droppen](../../README.md) and its plugins.

- **Types** for the manifest (`package.json` → `droppen`), contributions (navigation,
  routes under `/p/<id>/`, split-pane content, settings blocks, strings) and the
  `PluginHost` a plugin is given.
- **`definePlugin`**, **`usePluginHost`**, **`isStorageError`** and **`satisfies`**
  (the engine-range check).
- **`@droppen/plugin-sdk/testing`**: `createTestHost()`, an in-memory host with real
  compare-and-set storage that records every file, print, copy, question and
  navigation — for a plugin's own unit tests.

A plugin depends on React and this package only (both as peer dependencies), and
does every bit of I/O through `host.*`: no `fetch` of host URLs, no
`window.confirm` / `window.print` / `<a download>`, no service worker, no host CSS
utility classes (use the host's design variables, `--color-*`, `--font-*`,
`--tracking-label`, and prefix your own classes). That is what lets one plugin
build run in a local browser tab, on droppen.app and in the desktop shell.

`engines.droppen` ranges follow Cargo's rules (the host's server reads them
with the `semver` crate): comparators joined by commas, a bare version meaning
`^`. `satisfies` and `validRange` implement exactly that, checked against the
same vectors as the Rust side (`test/engine-vectors.json`).

A plugin may import React and this package; the build refuses a plugin that
imports the host's own code (`@/…` or anything under `web/src`).

The document store's HTTP protocol is in
[`docs/plugins/storage-protocol.md`](../../docs/plugins/storage-protocol.md).

## Licence

MIT OR Apache-2.0, at your option — independently of the licence of the application
that hosts plugins.
