/*
 * The device side of the M0 relay demo, in TypeScript on node's WebCrypto: the
 * same `web/src/lib/e2e` a browser would run, against the Rust agent through
 * the Rust demo's dumb relay. Run by the demo, which appends the relay address
 * and its key file:
 *
 *   cargo run --manifest-path server-rs/Cargo.toml -p rh-proto --example relay_demo -- \
 *     --initiator-cmd "web/node_modules/.bin/tsx web/scripts/e2e-relay-initiator.ts"
 *
 * It verifies the device chain, handshakes with the machine key the chain
 * lists, sends the canary on a `term` stream and an rpc request, and exits 0
 * once the agent has echoed both.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import {
  ChainClock,
  ChainState,
  DEFAULT_REKEY,
  decodeEntry,
  encodeFrame,
  equal,
  type Frame,
  FrameDecoder,
  fromHex,
  fromRaw,
  fromUtf8,
  finishHandshake,
  startHandshake,
  keyPairFromSecret,
  Session,
  utf8,
  concat,
} from "../src/lib/e2e/index";

const [addr, keysPath] = process.argv.slice(2);
if (!addr || !keysPath) throw new Error("usage: e2e-relay-initiator.ts <host:port> <keys.json>");
const keys = JSON.parse(readFileSync(keysPath, "utf8"));
const chain = await ChainState.verify(keys.chain.map((e: string) => decodeEntry(fromHex(e))), undefined, ChainClock.history());
const device = await keyPairFromSecret(fromHex(keys.deviceDhSecret));

const [host, port] = addr.split(":");
const socket = connect({ host, port: Number(port), noDelay: true });
const decoder = new FrameDecoder();
const waiting: ((f: Frame | null) => void)[] = [];
const ready: (Frame | null)[] = [];
const deliver = (f: Frame | null) => {
  const w = waiting.shift();
  if (w) w(f);
  else ready.push(f);
};
socket.on("data", (chunk: Buffer) => {
  decoder.push(new Uint8Array(chunk));
  for (let raw = decoder.next(); raw; raw = decoder.next()) deliver(fromRaw(raw));
});
socket.on("close", () => deliver(null));
const next = () => new Promise<Frame | null>((resolve) => (ready.length ? resolve(ready.shift()!) : waiting.push(resolve)));
const send = (frames: Frame[]) => socket.write(concat(...frames.map(encodeFrame)));
await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));

const { initiator, message } = await startHandshake(chain, device, keys.deviceId, keys.machineId, Date.now(), utf8("relay-demo/ts"));
send([
  { type: "open", ch: 1, peer: keys.deviceId },
  { type: "data", ch: 1, payload: message },
]);
const reply = await next();
if (reply?.type !== "data") throw new Error("no handshake reply");
const { transport, reply: body } = await finishHandshake(initiator, chain, ChainClock.live(Date.now(), chain.seq + 1), reply.payload, DEFAULT_REKEY, Date.now());
console.log(`device (TypeScript/WebCrypto): handshake complete, agent says ${fromUtf8(body.server)}`);

const session = new Session(1, transport, "initiator");
const term = session.mux.open("term", utf8("t-1"));
session.mux.send(term, utf8(keys.canary));
const rpc = session.mux.open("rpc", utf8("GET /api/version"));
session.mux.send(rpc, utf8("{}"));
send(await session.flush(Date.now()));

const wantTerm = utf8(`echo:${keys.canary}`);
let echoedTerm = new Uint8Array(0);
let echoedRpc = "";
while (!equal(echoedTerm, wantTerm) || echoedRpc !== "echo:{}") {
  const f = await next();
  if (f?.type !== "data") throw new Error("the agent went away");
  const event = await session.receive(f.payload);
  if (event?.type === "data") {
    if (event.sid === term) echoedTerm = concat(echoedTerm, event.data);
    else echoedRpc += fromUtf8(event.data);
  }
}
console.log("device (TypeScript/WebCrypto): the agent echoed the canary over the term stream and answered the rpc stream");
send([{ type: "close", ch: 1, code: 1000, reason: "done" }]);
socket.end();
