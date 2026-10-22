#!/usr/bin/env node
/**
 * The plugin SDK and the plugin host are part of the open core: neither may
 * reach into the hosted service's code (docs/plugins/distribution.md).
 *
 * - `packages/plugin-sdk/src` may import `react` and its own files, nothing
 *   else — a relative import that climbs out of `packages/plugin-sdk` counts
 *   as anything else.
 * - `web/src/plugins` (the host) may not import the hub/e2e/transport layers or
 *   the cloud and landing features, by alias or by relative path; it talks to
 *   the server through `@/api/client`.
 * - Nothing in `web/src` imports a plugin package directly: plugins arrive only
 *   through `virtual:droppen/bundled-plugins`, so the open build cannot depend
 *   on a private plugin by accident.
 *
 * The Rust half (`droppen-plugin-sdk`'s dependency tree) is
 * `scripts/check-sdk-crate-deps.sh`; plugin code importing the core is refused
 * by the build itself (`web/build/droppen-plugins.ts`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `import … from`, `export … from`, `import("…")`, `import "…"` and
// `require("…")` (with `require.resolve`), in that order of capture groups.
const IMPORT =
  /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*["']([^"']+)["']|(?:^|[\s;(=,!])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;])import\s*["']([^"']+)["']|(?:^|[^\w$.])require(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gm;

function files(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

function imports(file) {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

/** Every violation under `root` (a checkout of the core), as readable lines. */
export function checkBoundary(root) {
  const problems = [];
  const rule = (dir, check) => {
    for (const file of files(join(root, dir))) {
      for (const spec of imports(file)) {
        const target = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
        const why = check(spec, target, file);
        if (why) problems.push(`${relative(root, file)}: imports "${spec}" — ${why}`);
      }
    }
  };

  const sdk = join(root, "packages/plugin-sdk");
  rule("packages/plugin-sdk/src", (spec, target) => {
    if (spec === "react") return null;
    if (target) return inside(target, sdk) ? null : "a relative import that leaves packages/plugin-sdk";
    return "the SDK may import only react";
  });

  const src = join(root, "web/src");
  const hosted = ["lib/hub", "lib/e2e", "lib/transport", "features/cloud", "features/landing"];
  const HUB = hosted.map((dir) => new RegExp(`^@/${dir}(/|$)`));
  rule("web/src/plugins", (spec, target) => {
    const reason = "the plugin host is open-core and may not use the hosted service's internals";
    if (HUB.some((re) => re.test(spec))) return reason;
    if (target && hosted.some((dir) => inside(target, join(src, dir)))) return reason;
    return null;
  });

  rule("web/src", (spec) =>
    /^@droppen\/plugin-(?!sdk(\/|$))/.test(spec) ? "plugins are composed by the distribution build, never imported by the core" : null,
  );
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkBoundary(root);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} plugin boundary violation(s).`);
    process.exit(1);
  }
  console.log("plugin boundary: ok");
}
