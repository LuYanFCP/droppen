// The browser's cloud client, run headless under node against a local stack
// from `server-rs/crates/rh-devkit/scripts/cloud-dev.sh up`:
//
//   npx tsx scripts/cloud-smoke.ts <hub http url> <invite> <path to cloud-dev.sh>
//
// Signs up, creates the genesis, enrolls the dev stack's throwaway agent
// (running `cloud-dev.sh enroll` with the code), mails its machine key,
// starts it, and lists sessions over an end-to-end channel through the hub —
// the same modules the page uses, with node's fetch, WebSocket and WebCrypto.
import { spawn } from "node:child_process";
import { MemoryKeyStore, formatEnrollCode } from "../src/lib/e2e/index.js";
import { CloudAccount } from "../src/lib/hub/account.js";
import { HubApi } from "../src/lib/hub/api.js";
import { HubLink } from "../src/lib/hub/link.js";
import { MachineChannel } from "../src/lib/hub/machine.js";
import { tunnelTransport } from "../src/lib/transport/tunnel.js";

const [hubUrl, invite, devScript] = process.argv.slice(2);
if (!hubUrl || !invite || !devScript) throw new Error("usage: cloud-smoke.ts <hub url> <invite> <cloud-dev.sh>");
const origin = hubUrl.replace(/^http/, "ws");

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(devScript!, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const api = new HubApi(hubUrl);
const session = await api.signUp(invite, `smoke-${Date.now()}@example.com`, "correct horse battery");
const store = new MemoryKeyStore();
const account = await CloudAccount.open(api, session, store);
console.log("account", account.account, "device", account.deviceId);
await account.createGenesis(true);
const code = await account.startEnrollment();
const enrolled = run(["enroll", formatEnrollCode(code)]);
const machine = await account.completeEnrollment(code, undefined, 300);
console.log("machine added", machine.id, "enroll exit", await enrolled);
await account.deliverMachineKey(machine.id, store);
await run(["agent"]);
const link = new HubLink({ url: `${origin}/v1/client`, origin, account: account.account, deviceId: account.deviceId, token: session.token, signKey: account.keys.sign.privateKey });
link.start();
await link.waitOpen();
await new Promise<void>((resolve) => {
  const check = () => link.presence.get(machine.id)?.state === "online" && resolve();
  link.onPresence(check);
  check();
});
console.log("machine online");
const channel = new MachineChannel(link, account, machine.id);
const transport = tunnelTransport(channel);
const t0 = performance.now();
const res = await transport.fetch(new Request("http://machine/api/sessions?scope=all"));
const body = (await res.json()) as { total: number; sessions: { id: string }[] };
console.log("handshake", channel.handshakeMs?.toFixed(1), "ms; first rpc", (performance.now() - t0).toFixed(1), "ms;", res.status, body.total, body.sessions.map((s) => s.id));
link.stop();
process.exit(res.status === 200 && body.total > 0 ? 0 : 1);
