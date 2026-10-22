#!/usr/bin/env node
// Third-party notices for the npm packages the web app bundles: what actually
// reaches `web/dist` (and so the server binary, which embeds it), not
// everything `package.json` lists. Node >= 20, no dependencies of its own.
//
//   node scripts/notices/web-notices.mjs <web-dir> <out-file>
//
// The app is built once more, with its own configuration and the caller's
// environment (so the same distribution), into a scratch directory, with one
// extra plugin that records every module rollup rendered into a chunk, every
// stylesheet, every asset's source file and every `/*! name vX` banner in the
// CSS. Each is mapped to the npm package it came from (the package directory
// after the last `node_modules/`). First-party code — `web/src` and the
// workspace packages — is not listed.
//
// Exits 1 when a package's licence is missing or not on the allow-list below
// (AGPL-3.0-compatible permissive licences only), after listing them all.

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** SPDX ids the server binary may carry. Keep in step with `about.toml`. */
export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "CC0-1.0",
  "BSL-1.0",
  "Unlicense",
  "MPL-2.0",
  "CDLA-Permissive-2.0",
]);

/** Licences outside the everyday MIT / Apache / BSD / ISC set, to be named in the summary. */
const USUAL = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);

/** Whether an SPDX expression can be satisfied with allowed licences, and the ids it names. */
export function evaluate(expression) {
  const tokens = expression.replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/);
  let at = 0;
  const ids = [];
  const primary = () => {
    const token = tokens[at++];
    if (token === "(") {
      const value = or();
      if (tokens[at++] !== ")") throw new Error(`unbalanced: ${expression}`);
      return value;
    }
    if (!token || ["AND", "OR", "WITH", ")"].includes(token)) throw new Error(`unexpected ${token ?? "end"} in ${expression}`);
    let id = token.replace(/\+$/, "");
    if (tokens[at] === "WITH") {
      at++;
      id = `${id} WITH ${tokens[at++]}`;
    }
    ids.push(id);
    return ALLOWED.has(id) || id === "Apache-2.0 WITH LLVM-exception";
  };
  const and = () => {
    let value = primary();
    while (tokens[at] === "AND") {
      at++;
      value = primary() && value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[at] === "OR") {
      at++;
      value = and() || value;
    }
    return value;
  };
  const ok = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${expression}`);
  return { ok, ids };
}

/** The declared licence of a package.json, as one SPDX expression, or null. */
function declared(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  }
  return null;
}

/** `<...>/node_modules/[@scope/]name` for a file inside a package, or null. */
function packageDirOf(file) {
  const at = file.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const rest = file.slice(at + "/node_modules/".length).split("/");
  const parts = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return file.slice(0, at) + "/node_modules/" + parts.join("/");
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

async function main() {
  const [webArg, outArg] = process.argv.slice(2);
  if (!webArg || !outArg) {
    console.error("usage: node scripts/notices/web-notices.mjs <web-dir> <out-file>");
    process.exit(2);
  }
  // The real path: Vite resolves modules to real paths, and a root reached
  // through a symlink (macOS's /tmp is /private/tmp) would not contain them.
  const webDir = realpathSync(resolve(webArg));
  const require = createRequire(join(webDir, "package.json"));
  const viteDir = dirname(require.resolve("vite/package.json"));
  const viteManifest = JSON.parse(readFileSync(join(viteDir, "package.json"), "utf8"));
  const entry = viteManifest.exports["."].import;
  const vite = await import(pathToFileURL(join(viteDir, typeof entry === "string" ? entry : entry.default)).href);

  const files = new Set();
  const banners = new Set();
  const recorder = {
    name: "droppen-third-party-notices",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          for (const [id, info] of Object.entries(output.modules)) {
            // A stylesheet's JS proxy renders to nothing; its CSS still ships.
            if (info.renderedLength > 0 || /\.css($|\?)/.test(id)) files.add(id);
          }
        } else {
          for (const name of output.originalFileNames ?? []) files.add(name);
          if (output.fileName.endsWith(".css")) {
            const css = typeof output.source === "string" ? output.source : Buffer.from(output.source).toString("utf8");
            for (const m of css.matchAll(/\/\*!\s*(@?[a-z0-9][\w./-]*)\s+v\d[\w.+-]*\s*\|/gi)) banners.add(m[1]);
          }
        }
      }
    },
  };

  const outDir = mkdtempSync(join(tmpdir(), "droppen-notices-"));
  try {
    await vite.build({
      root: webDir,
      configFile: join(webDir, "vite.config.ts"),
      logLevel: "error",
      build: { outDir, emptyOutDir: true },
      plugins: [recorder],
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  const packages = new Map(); // dir -> {name, version, ...}
  const helpers = new Set();
  for (const raw of files) {
    // `\0` marks a virtual module: a CommonJS wrapper around a real file
    // (which still names it), a bundler helper, or one of the app's own.
    const virtual = raw.startsWith("\0");
    const id = (virtual ? raw.slice(1) : raw).split("?")[0];
    const dir = packageDirOf(resolve(webDir, id));
    if (dir) packages.set(dir, null);
    else if (virtual && /^(commonjsHelpers|vite\/)/.test(id)) helpers.add(id);
  }
  for (const name of banners) {
    try {
      packages.set(dirname(require.resolve(`${name}/package.json`)), null);
    } catch {
      let at = webDir;
      for (;;) {
        const candidate = join(at, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) {
          packages.set(candidate, null);
          break;
        }
        if (dirname(at) === at) throw new Error(`a CSS banner names ${name}, which is not installed`);
        at = dirname(at);
      }
    }
  }
  if (helpers.size) {
    // The helpers are vite's (it bundles rollup's commonjs plugin): attribute them to vite.
    packages.set(viteDir, null);
  }

  const failures = [];
  const unusual = [];
  const withoutText = [];
  const counts = new Map();
  const entries = [];
  for (const dir of packages.keys()) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const license = declared(pkg);
    const label = `${pkg.name}@${pkg.version}`;
    let verdict;
    try {
      verdict = license ? evaluate(license) : { ok: false, ids: [] };
    } catch (error) {
      verdict = { ok: false, ids: [String(error.message)] };
    }
    if (!license) failures.push(`${label}: no licence declared`);
    else if (!verdict.ok) failures.push(`${label}: ${license} is not on the allow-list`);
    if (license && verdict.ids.some((id) => !USUAL.has(id))) unusual.push(`${label}: ${license}`);
    counts.set(license ?? "(none)", (counts.get(license ?? "(none)") ?? 0) + 1);
    const texts = readdirSync(dir)
      .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").trimEnd() }));
    if (!texts.length) withoutText.push(`${label} (${license})`);
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    entries.push({ label, license, repository, homepage: pkg.homepage, texts });
  }
  entries.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const rule = "-".repeat(80);
  const lines = [
    `npm packages bundled into the web app (${entries.length})`,
    "",
    "The web app is embedded in the server binary. Every package below has code",
    "or styles in it; each licence follows in full as the package ships it.",
    helpers.size ? `Bundler runtime helpers (${[...helpers].sort().join(", ")}) are attributed to vite.` : "",
    "",
  ];
  for (const e of entries) {
    lines.push(rule, `${e.label}  ${e.license}`);
    if (e.repository || e.homepage) lines.push(String(e.repository ?? e.homepage).replace(/^git\+/, ""));
    lines.push("");
    if (e.texts.length) {
      for (const t of e.texts) lines.push(`[${t.name}]`, t.text, "");
    } else {
      lines.push(`(The package ships no licence file. Its package.json declares ${e.license}.)`, "");
    }
  }
  writeFileSync(outArg, lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n") + "\n");

  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n} ${l}`).join(", ");
  console.error(`web notices: ${entries.length} bundled npm packages (${summary})`);
  if (unusual.length) console.error(`  outside MIT/Apache/BSD/ISC: ${unusual.join("; ")}`);
  if (withoutText.length) console.error(`  no licence file shipped: ${withoutText.join("; ")}`);
  if (failures.length) {
    console.error(`web notices: ${failures.length} package(s) fail the licence check:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
}

await main();
