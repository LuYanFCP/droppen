// The distribution build: which plugins a build contains comes from a manifest
// outside the code (the repository's `distribution.json`, which lists none, or
// the file `DROPPEN_DISTRIBUTION` names), and every plugin is checked before a
// byte of it is bundled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { relative } from "node:path";
import { build } from "vite";
import { coreImport, distributionPath, droppenPlugins, inCore, isPluginModule, RESERVED_PATHS, resolveDistribution } from "../build/droppen-plugins.js";

const webRoot = resolve(import.meta.dirname, "..");

function fakePlugin(dir: string, droppen: Record<string, unknown>, version = "0.1.0") {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "export default {};\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `@droppen/plugin-${droppen.id}`, version, type: "module", exports: { ".": "./dist/index.js" }, droppen }),
  );
}

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: { en: id, "zh-CN": id },
  engines: { droppen: "^0.1.0" },
  permissions: ["storage"],
  ...extra,
});

test("the open build's distribution lists no plugins", () => {
  const file = distributionPath(webRoot, "");
  assert.equal(file, resolve(webRoot, "..", "distribution.json"));
  const dist = resolveDistribution(webRoot, file, "0.1.0");
  assert.deepEqual(dist, { name: "public", plugins: [] });
  assert.equal(distributionPath(webRoot, "/elsewhere/private.json"), "/elsewhere/private.json");
});

test("a private manifest names plugins by path or by packed tarball, relative to itself", () => {
  const root = mkdtempSync(join(tmpdir(), "droppen-dist-"));
  fakePlugin(join(root, "checkout"), manifest("tasks", { aliases: ["/tasks"] }));
  // `pnpm pack` puts everything under `package/`.
  fakePlugin(join(root, "pack", "package"), manifest("notes"), "1.2.3");
  mkdirSync(join(root, "release"));
  execFileSync("tar", ["-czf", join(root, "release", "notes.tgz"), "-C", join(root, "pack"), "package"]);
  const file = join(root, "private.json");
  writeFileSync(
    file,
    JSON.stringify({ name: "mine", plugins: [{ path: "checkout", defaultEnabled: true }, { tarball: "release/notes.tgz" }] }),
  );
  const dist = resolveDistribution(webRoot, file, "0.1.0");
  assert.equal(dist.name, "mine");
  assert.deepEqual(
    dist.plugins.map((p) => [p.id, p.manifest.version, p.manifest.defaultEnabled, p.manifest.aliases]),
    [
      ["tasks", "0.1.0", true, ["/tasks"]],
      ["notes", "1.2.3", false, []],
    ],
  );
  assert.ok(dist.plugins[1]!.dir.includes(join("node_modules", ".droppen-plugins")), "a tarball is unpacked under web/node_modules");
  assert.equal(readFileSync(dist.plugins[1]!.entry, "utf8"), "export default {};\n");
  assert.ok(isPluginModule(join(dist.plugins[0]!.dir, "dist", "index.js")), "a path plugin's files are plugin modules");
  assert.ok(isPluginModule("/x/web/node_modules/.droppen-plugins/abc/package/dist/index.js"));
  assert.ok(isPluginModule("/x/node_modules/@droppen/plugin-tasks/dist/index.js"));
  assert.ok(!isPluginModule("/x/node_modules/@droppen/plugin-sdk/src/index.ts"), "the SDK is shared, not a plugin");
  assert.ok(!isPluginModule("/x/node_modules/react/index.js"));
});

test("a plugin built for another SDK, a bad id, a repeated id or a bad alias fails the build", () => {
  const root = mkdtempSync(join(tmpdir(), "droppen-dist-"));
  const cases: [string, Record<string, unknown>[], RegExp][] = [
    ["engines", [manifest("tasks", { engines: { droppen: "^0.2.0" } })], /needs SDK \^0\.2\.0/],
    ["id", [manifest("Tasks")], /not a plugin id/],
    ["dupe", [manifest("tasks"), manifest("tasks")], /appears twice/],
    ["alias", [manifest("tasks", { aliases: ["tasks"] })], /aliases/],
    ["shadow", [manifest("tasks", { aliases: ["/settings"] })], /would shadow/],
    ["plugin-root", [manifest("tasks", { aliases: ["/p"] })], /would shadow/],
    ["npm-range", [manifest("tasks", { engines: { droppen: ">=0.1.0 <0.2.0" } })], /not a range the host reads/],
    ["npm-or", [manifest("tasks", { engines: { droppen: "^0.1.0 || ^0.2.0" } })], /not a range the host reads/],
    ["permission", [manifest("tasks", { permissions: ["storage", "everything"] })], /permissions/],
    ["name", [manifest("tasks", { name: { "zh-CN": "待办" } })], /name must be/],
    ["default", [manifest("tasks", { defaultEnabled: "yes" })], /defaultEnabled/],
  ];
  for (const [name, manifests, error] of cases) {
    const entries = manifests.map((m, i) => {
      fakePlugin(join(root, name, String(i)), m);
      return { path: `${name}/${i}` };
    });
    const file = join(root, `${name}.json`);
    writeFileSync(file, JSON.stringify({ plugins: entries }));
    assert.throws(() => resolveDistribution(webRoot, file, "0.1.0"), error, name);
  }
  fakePlugin(join(root, "badversion"), manifest("tasks"), "1.0");
  writeFileSync(join(root, "badversion.json"), JSON.stringify({ plugins: [{ path: "badversion" }] }));
  assert.throws(() => resolveDistribution(webRoot, join(root, "badversion.json"), "0.1.0"), /not a semver version/);
  // A bare version means ^, as the server (Cargo's rules) reads it.
  fakePlugin(join(root, "bare"), manifest("tasks", { engines: { droppen: "0.1.0" } }));
  writeFileSync(join(root, "bare.json"), JSON.stringify({ plugins: [{ path: "bare" }] }));
  assert.equal(resolveDistribution(webRoot, join(root, "bare.json"), "0.1.4").plugins.length, 1);
  const file = join(root, "both.json");
  writeFileSync(file, JSON.stringify({ plugins: [{ path: "a", tarball: "b" }] }));
  assert.throws(() => resolveDistribution(webRoot, file, "0.1.0"), /exactly one/);
  assert.throws(() => resolveDistribution(webRoot, join(root, "missing.json"), "0.1.0"), /not found/);
});

test("no alias may take a path the shell's router already answers", () => {
  const router = readFileSync(join(webRoot, "src/app/router.tsx"), "utf8");
  const tops = [...router.matchAll(/getParentRoute: \(\) => rootRoute,\s*path: "([^"/$]+)/g)].map((m) => m[1]!);
  assert.ok(tops.length >= 8, `found the router's top-level routes: ${tops}`);
  for (const top of tops) assert.ok(RESERVED_PATHS.has(top), `/${top} is reserved`);
});

test("a plugin module may not import the core's own code", () => {
  const importer = "/somewhere/node_modules/.droppen-plugins/abc/package/dist/index.js";
  assert.match(coreImport("@/api/client", importer, webRoot) ?? "", /plugin-sdk/);
  assert.match(coreImport("/src/main.tsx", importer, webRoot) ?? "", /plugin-sdk/);
  assert.match(coreImport(join(webRoot, "src/lib/cn.ts"), importer, webRoot) ?? "", /plugin-sdk/);
  const sneaky = relative(dirname(importer), join(webRoot, "src/api/client.ts"));
  assert.match(coreImport(sneaky, importer, webRoot) ?? "", /plugin-sdk/, sneaky);
  assert.equal(coreImport("react", importer, webRoot), null);
  assert.equal(coreImport("./chunk.js", importer, webRoot), null);
  assert.equal(coreImport("@droppen/plugin-sdk", importer, webRoot), null);
});

test("a distribution whose plugin imports the core does not build", async () => {
  for (const [label, specifier] of [
    ["alias", "@/api/client"],
    ["relative path", "RELATIVE"],
    ["symlink inside the plugin", "./core/lib/cn.ts"],
    ["absolute path through a symlink", "ABSOLUTE-SYMLINK"],
  ] as const) {
    // Not the real path on purpose: on macOS the temp directory is behind a
    // symlink (/var → /private/var), as a plugin's own path may be.
    const loose = mkdtempSync(join(tmpdir(), "droppen-licence-"));
    const root = realpathSync(loose);
    const dir = join(root, "plugin");
    fakePlugin(dir, manifest("leaky"));
    symlinkSync(join(webRoot, "src"), join(dir, "dist", "core"));
    symlinkSync(join(webRoot, "src"), join(root, "websrc"));
    const target =
      specifier === "RELATIVE"
        ? relative(join(dir, "dist"), join(webRoot, "src/lib/cn.ts"))
        : specifier === "ABSOLUTE-SYMLINK"
          ? join(loose, "websrc", "lib", "cn.ts")
          : specifier;
    writeFileSync(
      join(dir, "dist", "index.js"),
      `import { api } from ${JSON.stringify(target)};\nexport default { manifest: { id: "leaky" }, activate: () => ({ api }) };\n`,
    );
    const distribution = join(root, "private.json");
    writeFileSync(distribution, JSON.stringify({ name: "leaky", plugins: [{ path: "plugin" }] }));
    writeFileSync(join(root, "entry.js"), 'import { bundledPlugins } from "virtual:droppen/bundled-plugins";\nconsole.log(bundledPlugins.map((p) => p.load));\n');
    await assert.rejects(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [droppenPlugins({ webRoot, distribution })],
        build: { write: false, rollupOptions: { input: join(root, "entry.js") } },
      }),
      (error: Error) => /imports .*plugins use the host only through @droppen\/plugin-sdk/.test(error.message),
      label,
    );
  }
});

test("a module is the core's by its real path", () => {
  const loose = mkdtempSync(join(tmpdir(), "droppen-real-"));
  symlinkSync(join(webRoot, "src"), join(loose, "websrc"));
  assert.ok(inCore(join(loose, "websrc", "lib", "cn.ts"), webRoot), "through a symlink");
  assert.ok(inCore(join(webRoot, "src/lib/cn.ts?import"), webRoot));
  assert.ok(!inCore(join(webRoot, "build/droppen-plugins.ts"), webRoot));
  assert.ok(!inCore("\0virtual:droppen/bundled-plugins", webRoot));
});
