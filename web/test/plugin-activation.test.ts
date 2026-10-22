// A plugin is activated once per machine and plugin (`plugins/activation.ts`):
// its host's storage is the machine's (`httpStorage(id, machine)`), and on
// droppen.app the home — the machine the plugin runs for — moves when the
// person switches machines. An activation kept by plugin alone went on reading
// and writing the first machine's documents after a switch.
import assert from "node:assert/strict";
import test from "node:test";

/**
 * The typed client builds a `Request` from a root-relative URL, which Node's
 * own `Request` refuses; it reads `Request` when first imported, so the stub
 * goes in before the dynamic imports below (as in plugin-host.test.ts).
 */
class StubRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  constructor(url: string, init: RequestInit = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.headers = new Headers(init.headers ?? {});
  }
  clone() {
    return this;
  }
}
globalThis.Request = StubRequest as unknown as typeof Request;

const { openMachine } = await import("../src/lib/machines/registry.js");
const { activatePlugin } = await import("../src/plugins/activation.js");

function recording(name: string, log: string[]) {
  return {
    fetch: async (request: Request) => {
      log.push(`${name} ${request.method} ${request.url}`);
      return new Response(JSON.stringify({ error: "doc_not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    },
    socketUrl: async (path: string) => path,
    openSocket: () => {
      throw new Error("no sockets here");
    },
  };
}

test("a plugin is activated once per machine, and each machine's host reads and writes that machine's documents", async () => {
  const log: string[] = [];
  openMachine("m-a", recording("a", log));
  openMachine("m-b", recording("b", log));
  const hosts: unknown[] = [];
  let loads = 0;
  const bundled = {
    id: "demo",
    manifest: { id: "demo", version: "1.0.0", name: "Demo", engines: { droppen: "*" }, permissions: [], aliases: [], defaultEnabled: true, package: "demo" },
    load: async () => {
      loads++;
      return {
        default: {
          manifest: { id: "demo" },
          activate: (host: unknown) => {
            hosts.push(host);
            return {};
          },
        },
      };
    },
  } as never;
  const navigate = () => undefined;

  const a = await activatePlugin(bundled, navigate, "m-a");
  assert.equal(await activatePlugin(bundled, navigate, "m-a"), a, "the same machine: the same activation, whatever remounts");
  const b = await activatePlugin(bundled, navigate, "m-b");
  assert.ok(a.ok && b.ok);
  assert.equal(hosts.length, 2, "another machine: a host of its own");
  assert.notEqual(a.host, b.host);
  assert.equal(loads, 2);

  assert.equal(await a.host.storage.get("state"), null);
  assert.equal(await b.host.storage.get("state"), null);
  assert.deepEqual(log, ["a GET /api/plugins/demo/docs/state", "b GET /api/plugins/demo/docs/state"]);
});

test("a machine closed on the page takes its plugin activations with it", async () => {
  const { closeMachine } = await import("../src/lib/machines/registry.js");
  const log: string[] = [];
  openMachine("m-c", recording("c", log));
  let loads = 0;
  const bundled = {
    id: "demo",
    manifest: { id: "demo" },
    load: async () => {
      loads++;
      return { default: { manifest: { id: "demo" }, activate: () => ({}) } };
    },
  } as never;
  const first = await activatePlugin(bundled, () => undefined, "m-c");
  closeMachine("m-c");
  openMachine("m-c", recording("c", log));
  const again = await activatePlugin(bundled, () => undefined, "m-c");
  assert.notEqual(again, first, "a fresh activation for the machine opened again");
  assert.equal(loads, 2);
});
