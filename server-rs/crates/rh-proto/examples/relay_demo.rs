//! M0 acceptance demo: two local processes complete an end-to-end handshake and
//! talk through a dumb relay that only forwards opaque frames — and a canary the
//! device sends never appears in the bytes the relay handled.
//!
//! ```text
//! cargo run -p rh-proto --example relay_demo
//! # the device side in TypeScript on WebCrypto instead of Rust:
//! cargo run -p rh-proto --example relay_demo -- --initiator-cmd "npx tsx web/scripts/e2e-relay-initiator.ts"
//! ```
//!
//! The orchestrator (no arguments) mints an account key, a device and a machine
//! identity, signs a device chain (genesis + add-machine), writes them and a
//! random canary to a 0600 file in a temporary directory, starts the relay on a
//! loopback port and spawns two children of itself: `responder` (the agent) and
//! `initiator` (the device; or `--initiator-cmd`, which is run with the relay
//! address and the key file appended). The relay pairs the first two
//! connections and copies whole hub frames between them, keeping a copy of every
//! byte. Both children verify the chain; the agent authorises the device's
//! handshake against it; the device sends the canary on a `term` stream and an
//! rpc request, the agent echoes them, and the device checks the echo. Then the
//! orchestrator searches everything the relay saw for the canary.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ed25519_dalek::SigningKey;
use rand_core::{OsRng, RngCore};
use rh_proto::chain::{genesis_draft, Action, Attestation, ChainClock, ChainState, DeviceInfo, Entry, Signer};
use rh_proto::channel::Session;
use rh_proto::frame::{Frame, FrameDecoder};
use rh_proto::handshake::{self, Accepted, AgentSide};
use rh_proto::identity::{fingerprint, MachineIdentity};
use rh_proto::keys::DhKeypair;
use rh_proto::mux::{MuxEvent, Role, StreamClass};
use rh_proto::noise::{RekeyPolicy, ReplayGuard};
use serde_json::{json, Value};

const ACCOUNT: &str = "acct-demo";
const DEVICE: &str = "dev-demo";
const MACHINE: &str = "m-demo";
const TIMEOUT: Duration = Duration::from_secs(60);

type Result<T> = std::result::Result<T, String>;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("responder") => responder(&args[1], &args[2]),
        Some("initiator") => initiator(&args[1], &args[2]),
        _ => orchestrate(&args),
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("relay_demo: {error}");
            ExitCode::FAILURE
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn arr32(v: &Value) -> Result<[u8; 32]> {
    unhex(v.as_str().ok_or("expected a hex string")?)?
        .try_into()
        .map_err(|_| "expected 32 bytes".to_string())
}

fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b
}

// ---------------------------------------------------------------- orchestrator

fn orchestrate(args: &[String]) -> Result<()> {
    let initiator_cmd = match args {
        [] => None,
        [flag, cmd] if flag == "--initiator-cmd" => Some(cmd.clone()),
        _ => return Err("usage: relay_demo [--initiator-cmd \"<command>\"]".into()),
    };
    let dir = std::env::temp_dir().join(format!("rh-relay-demo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let keys_path = dir.join("keys.json");

    // Keys and a chain: AK signs genesis with the device; the device adds the machine.
    let ak = SigningKey::from_bytes(&random32());
    let device_sign = SigningKey::from_bytes(&random32());
    let device_dh = random32();
    let machine_seed = random32();
    let machine = MachineIdentity::from_seed(&machine_seed);
    let device = DeviceInfo {
        id: DEVICE.into(),
        sign_key: device_sign.verifying_key().to_bytes(),
        dh_key: DhKeypair::from_secret(device_dh).public(),
        full: true,
    };
    let genesis = genesis_draft(ACCOUNT, ak.verifying_key().to_bytes(), device, None, now_ms()).sign(&ak);
    let mut state = ChainState::verify(std::slice::from_ref(&genesis), None, &mut ChainClock::history()).map_err(|e| e.to_string())?;
    let add_machine = state
        .draft(Signer::Device(DEVICE.into()), Action::AddMachine(machine.info(MACHINE)), now_ms())
        .sign(&device_sign);
    state.apply(&add_machine, &mut ChainClock::history()).map_err(|e| e.to_string())?;
    // The device vouches for the head it sees; the agent opens no channel
    // without a recent attestation (a hub relays it as an ATTEST frame).
    let attestation = Attestation::create(&state, DEVICE, &device_sign, now_ms());
    let canary = format!("RH-CANARY-{}", hex(&random32()[..12]));
    let keys = json!({
        "account": ACCOUNT, "deviceId": DEVICE, "machineId": MACHINE,
        "deviceDhSecret": hex(&device_dh),
        "machineSeed": hex(&machine_seed),
        "accountFingerprint": hex(&fingerprint(&ak.verifying_key().to_bytes())),
        "chain": [hex(&genesis.encode()), hex(&add_machine.encode())],
        "attestation": hex(&attestation.encode()),
        "canary": canary,
    });
    write_private(&keys_path, &serde_json::to_vec_pretty(&keys).map_err(|e| e.to_string())?)?;

    // The relay.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?.to_string();
    let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
    let frames = Arc::new(Mutex::new(0usize));
    let relay = {
        let captured = captured.clone();
        let frames = frames.clone();
        std::thread::spawn(move || run_relay(listener, captured, frames))
    };
    println!("relay listening on {addr}");

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let keys_arg = keys_path.to_string_lossy().to_string();
    let mut agent = Command::new(&exe)
        .args(["responder", &addr, &keys_arg])
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    // The agent connects first, as a real one would be online before a device dials it.
    std::thread::sleep(Duration::from_millis(200));
    let mut device = match &initiator_cmd {
        None => Command::new(&exe).args(["initiator", &addr, &keys_arg]).stdin(Stdio::null()).spawn(),
        Some(cmd) => Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{cmd} {addr} {keys_arg}"))
            .stdin(Stdio::null())
            .spawn(),
    }
    .map_err(|e| e.to_string())?;

    let device_ok = wait(&mut device, "initiator");
    let agent_ok = wait(&mut agent, "responder");
    let relay_result = relay.join().map_err(|_| "the relay thread panicked".to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    device_ok?;
    agent_ok?;
    relay_result?;

    let seen = captured.lock().map_err(|_| "poisoned")?.clone();
    let leaked = seen.windows(canary.len()).any(|w| w == canary.as_bytes());
    println!(
        "relay forwarded {} frames, {} bytes; canary {} the relayed bytes",
        frames.lock().map(|f| *f).unwrap_or(0),
        seen.len(),
        if leaked { "FOUND IN" } else { "absent from" }
    );
    if leaked {
        return Err("the canary appeared in relayed bytes".into());
    }
    println!("ok: end-to-end handshake and exchange through a relay that never saw plaintext");
    Ok(())
}

fn write_private(path: &std::path::Path, data: &[u8]) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(path)
        .and_then(|mut f| f.write_all(data))
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn wait(child: &mut Child, name: &str) -> Result<()> {
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("{name} exited with {status}")),
            None if start.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// Pair the first two connections and copy whole frames between them until
/// either side closes. Parses envelopes (to count and bound frames) and
/// nothing else.
fn run_relay(listener: TcpListener, captured: Arc<Mutex<Vec<u8>>>, frames: Arc<Mutex<usize>>) -> Result<()> {
    let (a, _) = listener.accept().map_err(|e| e.to_string())?;
    let (b, _) = listener.accept().map_err(|e| e.to_string())?;
    let pump = |mut from: TcpStream, mut to: TcpStream, captured: Arc<Mutex<Vec<u8>>>, frames: Arc<Mutex<usize>>| {
        std::thread::spawn(move || -> Result<()> {
            from.set_read_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
            let mut decoder = FrameDecoder::new();
            let mut buf = [0u8; 16 * 1024];
            loop {
                let n = match from.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                captured.lock().map_err(|_| "poisoned")?.extend_from_slice(&buf[..n]);
                decoder.push(&buf[..n]);
                while let Some(raw) = decoder.next_frame().map_err(|e| e.to_string())? {
                    *frames.lock().map_err(|_| "poisoned")? += 1;
                    to.write_all(&raw.encode().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                }
            }
            let _ = to.shutdown(std::net::Shutdown::Write);
            Ok(())
        })
    };
    let one = pump(
        a.try_clone().map_err(|e| e.to_string())?,
        b.try_clone().map_err(|e| e.to_string())?,
        captured.clone(),
        frames.clone(),
    );
    let two = pump(b, a, captured, frames);
    one.join().map_err(|_| "relay pump panicked")??;
    two.join().map_err(|_| "relay pump panicked")??;
    Ok(())
}

// ---------------------------------------------------------------- shared

struct Keys {
    v: Value,
    chain: ChainState,
}

fn load(keys_path: &str, pin: bool) -> Result<Keys> {
    let v: Value = serde_json::from_slice(&std::fs::read(keys_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let entries: Vec<Entry> = v["chain"]
        .as_array()
        .ok_or("no chain")?
        .iter()
        .map(|e| Entry::decode(&unhex(e.as_str().unwrap_or_default())?).map_err(|e| e.to_string()))
        .collect::<Result<_>>()?;
    let fp: [u8; 16] = unhex(v["accountFingerprint"].as_str().ok_or("no fingerprint")?)?
        .try_into()
        .map_err(|_| "bad fingerprint")?;
    let chain = ChainState::verify(&entries, pin.then_some(&fp), &mut ChainClock::history()).map_err(|e| format!("chain: {e}"))?;
    Ok(Keys { v, chain })
}

struct Conn {
    stream: TcpStream,
    decoder: FrameDecoder,
}

impl Conn {
    fn connect(addr: &str) -> Result<Self> {
        let stream = TcpStream::connect(addr).map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
        Ok(Self {
            stream,
            decoder: FrameDecoder::new(),
        })
    }

    fn send(&mut self, frames: &[Frame]) -> Result<()> {
        for f in frames {
            self.stream
                .write_all(&f.encode().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn recv(&mut self) -> Result<Option<Frame>> {
        let mut buf = [0u8; 16 * 1024];
        loop {
            if let Some(raw) = self.decoder.next_frame().map_err(|e| e.to_string())? {
                return Frame::from_raw(raw).map(Some).map_err(|e| e.to_string());
            }
            match self.stream.read(&mut buf) {
                Ok(0) => return Ok(None),
                Ok(n) => self.decoder.push(&buf[..n]),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

// ---------------------------------------------------------------- the agent

fn responder(addr: &str, keys_path: &str) -> Result<()> {
    let Keys { v, mut chain } = load(keys_path, true)?;
    let identity = MachineIdentity::from_seed(&arr32(&v["machineSeed"])?);
    let machine_id = v["machineId"].as_str().ok_or("no machine id")?;
    if chain.machine(machine_id).map(|m| m.info.dh_key) != Some(identity.dh_public()) {
        return Err("this machine is not in the chain under its own key".into());
    }
    let mut conn = Conn::connect(addr)?;
    // A process with no saved replay state refuses first messages stamped
    // before it could know what an earlier process accepted (a minute).
    // The demo's device is spawned after the agent, so allow it from now.
    let mut guard = ReplayGuard::new(10 * 60 * 1000, 60 * 1000, 256, now_ms().saturating_sub(1));
    let mut session: Option<Session> = None;
    let mut device: Option<String> = None;
    // The agent's own live clock: it gates recovery by when *it* saw a join.
    let mut clock = ChainClock::live(now_ms(), chain.seq() + 1);
    let attestations = [Attestation::decode(&unhex(v["attestation"].as_str().ok_or("no attestation")?)?).map_err(|e| e.to_string())?];
    while let Some(frame) = conn.recv()? {
        match frame {
            // A hub puts the sender's device id here; this relay forwards the device's own claim.
            Frame::Open { peer, .. } => device = Some(peer),
            Frame::Data { ch, payload } if session.is_none() => {
                let device = device.as_deref().ok_or("DATA before OPEN")?;
                let side = AgentSide {
                    chain: &mut chain,
                    clock: &mut clock,
                    attestations: &attestations,
                    freshness_max_age_ms: handshake::FRESHNESS_MAX_AGE_MS,
                    guard: &mut guard,
                    key: identity.dh(),
                    machine: machine_id,
                    policy: RekeyPolicy::default(),
                    server_info: b"{\"features\":[\"term\",\"rpc\"]}",
                };
                let Accepted::Open { reply, transport, hello, .. } =
                    handshake::accept(side, device, &payload, now_ms()).map_err(|e| format!("handshake: {e}"))?
                else {
                    return Err("the device's chain view is ahead of the agent's".into());
                };
                println!("agent: handshake from {device} accepted (its chain view: seq {})", hello.chain_seq);
                conn.send(&[Frame::Data { ch, payload: reply }])?;
                session = Some(Session::new(ch, *transport, Role::Responder));
            }
            Frame::Data { payload, .. } => {
                let s = session.as_mut().ok_or("no session")?;
                match s.receive(&payload, now_ms()).map_err(|e| e.to_string())?.into_iter().next() {
                    Some(MuxEvent::Opened { sid, class, meta }) => println!("agent: stream {sid} opened ({class:?}, {} byte meta)", meta.len()),
                    Some(MuxEvent::Data { sid, data }) => {
                        s.mux().consumed(sid, data.len());
                        let mut echo = b"echo:".to_vec();
                        echo.extend_from_slice(&data);
                        s.mux().send(sid, &echo).map_err(|e| e.to_string())?;
                    }
                    _ => {}
                }
                let out = s.flush(now_ms()).map_err(|e| e.to_string())?;
                conn.send(&out)?;
            }
            Frame::Close { .. } => break,
            other => return Err(format!("unexpected frame {other:?}")),
        }
    }
    println!("agent: done");
    Ok(())
}

// ---------------------------------------------------------------- the device

fn initiator(addr: &str, keys_path: &str) -> Result<()> {
    let Keys { v, chain } = load(keys_path, false)?;
    let device_id = v["deviceId"].as_str().ok_or("no device id")?;
    let machine_id = v["machineId"].as_str().ok_or("no machine id")?;
    let canary = v["canary"].as_str().ok_or("no canary")?.as_bytes().to_vec();
    let device = DhKeypair::from_secret(arr32(&v["deviceDhSecret"])?);
    let mut conn = Conn::connect(addr)?;

    let (initiator, hello) = handshake::start(&chain, &device, device_id, machine_id, now_ms(), b"relay-demo/rust").map_err(|e| e.to_string())?;
    conn.send(&[
        Frame::Open {
            ch: 1,
            peer: device_id.into(),
        },
        Frame::Data { ch: 1, payload: hello },
    ])?;
    let Some(Frame::Data { payload, .. }) = conn.recv()? else {
        return Err("no handshake reply".into());
    };
    let (transport, reply) = handshake::finish(
        initiator,
        &mut chain.clone(),
        &mut ChainClock::live(now_ms(), chain.seq() + 1),
        &payload,
        RekeyPolicy::default(),
        now_ms(),
    )
    .map_err(|e| e.to_string())?;
    println!("device: handshake complete, agent says {}", String::from_utf8_lossy(&reply.server));
    let mut s = Session::new(1, transport, Role::Initiator);

    let term = s.mux().open(StreamClass::Term, b"t-1").map_err(|e| e.to_string())?;
    s.mux().send(term, &canary).map_err(|e| e.to_string())?;
    let rpc = s.mux().open(StreamClass::Rpc, b"GET /api/version").map_err(|e| e.to_string())?;
    s.mux().send(rpc, b"{}").map_err(|e| e.to_string())?;
    let out = s.flush(now_ms()).map_err(|e| e.to_string())?;
    conn.send(&out)?;

    let mut echoed_term = Vec::new();
    let mut echoed_rpc = Vec::new();
    let want_term = [b"echo:".as_slice(), &canary].concat();
    while echoed_term != want_term || echoed_rpc != b"echo:{}" {
        let Some(Frame::Data { payload, .. }) = conn.recv()? else {
            return Err("the agent went away".into());
        };
        if let Some(MuxEvent::Data { sid, data }) = s.receive(&payload, now_ms()).map_err(|e| e.to_string())?.into_iter().next() {
            if sid == term {
                echoed_term.extend_from_slice(&data);
            } else {
                echoed_rpc.extend_from_slice(&data);
            }
        }
    }
    println!("device: the agent echoed the canary over the term stream and answered the rpc stream");
    conn.send(&[Frame::Close {
        ch: 1,
        code: 1000,
        reason: "done".into(),
    }])?;
    Ok(())
}
