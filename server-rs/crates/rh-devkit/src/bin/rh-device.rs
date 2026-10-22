//! A headless device driven one command per line on stdin, for trying the
//! browser's pairing, recovery and removal flows against a second device by
//! hand (or from a script): it signs in to an existing account as a new
//! device and then does what it is told.
//!
//!   rh-device --hub http://127.0.0.1:<port> --email <e> --password-file <f> [--sign-up <invite>]
//!
//! With `--sign-up`, it makes the account first (with an invite from the
//! hub's operator: `cloud-dev.sh invite` for a local one) and becomes its
//! first device, creating the chain:
//! a full device that can enroll machines, with no browser anywhere. That
//! chain is v2, as accounts were made before chain v3 (the web app makes
//! every new one on v3): the commands below write v2's entries.
//!
//! Commands (one per line; each prints `ok ...` or `error ...`):
//!
//!   offer                 print this device's QR offer text and wait for the pairing delivery
//!   code                  show a fresh 8-digit code (new-device side) and wait for a run and the delivery
//!   accept <RHP1-...>     add the device behind a pasted offer and deliver the user keys (existing device)
//!   enter <device> <code> run CPace for the code a new device shows, add it and deliver (existing device)
//!   approve <device>      approve a pending recovered device
//!   enroll                issue a machine enrollment code (prints `CODE RH1-...`), then wait for
//!                         the machine's proof and add it, as the web app's "add a computer" does
//!   remove <device>       remove a device, rotate the user and machine keys, give each agent its new key in a channel (re-encrypt)
//!   keys                  take mailed user keys; list user key and machine key epochs
//!   read <machine>        read the machine's status stream with the keys held; print its name and size
//!   channel <machine>     attest, open a channel and GET /rh/info
//!   status                this device's standing in the chain
//!   forge-chain           print a hub-forged chain around the real recovery key (for a test proxy)
//!
//! The account password is read from a file so it never appears in a process
//! listing. Nothing is stored: the device lives as long as the process.

use std::sync::Arc;
use std::time::Duration;

use rh_devkit::{rpc, Device, HubUrl, Link};
use rh_proto::pairing::Offer;
use rh_proto::stream::status_stream;
use serde_json::json;

type Result<T> = std::result::Result<T, String>;

struct Session {
    device: Device,
    link: Option<Arc<Link>>,
}

impl Session {
    async fn link(&mut self) -> Result<Arc<Link>> {
        if let Some(link) = &self.link {
            return Ok(link.clone());
        }
        self.device.sync_chain().await?;
        let link = Arc::new(self.device.connect().await?);
        if let Ok(att) = self.device.attestation() {
            let _ = link.attest(&att);
        }
        self.link = Some(link.clone());
        Ok(link)
    }

    fn reset_link(&mut self) {
        self.link = None;
    }

    async fn machine_sign_key(&mut self, machine: &str) -> Result<[u8; 32]> {
        self.device.sync_chain().await?;
        let chain = self.device.chain().ok_or("no chain")?;
        Ok(chain.machine(machine).ok_or("no such machine in the chain")?.info.sign_key)
    }

    async fn run(&mut self, line: &str) -> Result<String> {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["offer"] => {
                let offer = self.device.offer();
                println!("OFFER {}", offer.to_text());
                let n = self.device.await_delivery(&offer.secret, Duration::from_secs(600)).await?;
                self.reset_link();
                Ok(format!("paired by offer: {n} user key epoch(s); device {}", self.device.id))
            }
            ["code"] => {
                let code = format!(
                    "{:08}",
                    u32::from_le_bytes(rh_devkit::random_key()[..4].try_into().expect("4")) % 100_000_000
                );
                println!("CODE {code} DEVICE {}", self.device.id);
                let n = self.device.pair_by_code(&code, Duration::from_secs(600)).await?;
                self.reset_link();
                Ok(format!("paired by code: {n} user key epoch(s); device {}", self.device.id))
            }
            ["accept", text] => {
                let offer = Offer::from_text(text).map_err(|e| format!("offer: {e}"))?;
                if offer.account != self.device_account() {
                    return Err("the offer is for another account".into());
                }
                self.device
                    .add_and_deliver(&offer.device, offer.sign_key, offer.dh_key, &offer.secret)
                    .await?;
                self.attest_now().await?;
                Ok(format!("added {} and delivered the user keys", offer.device))
            }
            ["enter", device, code] => {
                self.device.pair_with_code(device, code, Duration::from_secs(120)).await?;
                self.attest_now().await?;
                Ok(format!("added {device} by code and delivered the user keys"))
            }
            ["enroll"] => {
                let code = self.device.new_enrollment().await?;
                println!("CODE {code}");
                let machine = self.device.complete_enrollment(&code, Duration::from_secs(600)).await?;
                self.reset_link();
                Ok(format!("enrolled machine {}", machine.id))
            }
            ["approve", device] => {
                let seq = self.device.approve(device).await?;
                self.attest_now().await?;
                Ok(format!("approved {device} at seq {seq}"))
            }
            ["remove", device] => {
                let (uk, rotated) = self.device.remove_and_rotate(device).await?;
                self.attest_now().await?;
                let mut delivered = Vec::new();
                for (machine, epoch, mk) in rotated {
                    let link = self.link().await?;
                    match self.device.open_channel(&link, &machine).await {
                        Ok(channel) => {
                            let r = rpc(
                                &channel,
                                "POST",
                                "/rh/machine-key",
                                Some(&json!({"epoch": epoch, "key": rh_devkit::hex(&mk), "reencrypt": true})),
                            )
                            .await?;
                            delivered.push(format!("{machine}: MK epoch {epoch} in a channel ({})", r.status));
                        }
                        Err(e) => {
                            self.device.mail_machine_key(&machine, epoch, &mk).await?;
                            delivered.push(format!("{machine}: MK epoch {epoch} by mail (channel: {e})"));
                        }
                    }
                }
                Ok(format!("removed {device}; user key epoch {uk}; {}", delivered.join("; ")))
            }
            ["keys"] => {
                let got = self.device.take_user_key_mail().await?;
                let mut out = format!(
                    "{got} new user key epoch(s) from mail; user key epochs {:?}",
                    self.device.user_keys.keys().collect::<Vec<_>>()
                );
                let machines: Vec<String> = self
                    .device
                    .chain()
                    .map(|c| c.hosts().filter(|m| m.is_current_host()).map(|m| m.info.id.clone()).collect())
                    .unwrap_or_default();
                for m in machines {
                    let keys = self.device.machine_keys(&m).await?;
                    out.push_str(&format!("; {m}: MK epochs {:?}", keys.keys().collect::<Vec<_>>()));
                }
                Ok(out)
            }
            ["read", machine] => {
                let sign_key = self.machine_sign_key(machine).await?;
                let keys: Vec<(u32, [u8; 32])> = self.device.machine_keys(machine).await?.iter().map(|(e, k)| (*e, **k)).collect();
                let naming = keys.first().ok_or("no machine key")?.1;
                let link = self.link().await?;
                let copy = self
                    .device
                    .read_stream_keys(&link, sign_key, &keys, status_stream(&naming), Duration::from_secs(20))
                    .await?;
                let last = copy
                    .bodies
                    .last()
                    .map(|(_, b)| serde_json::from_slice::<serde_json::Value>(b).unwrap_or_default())
                    .unwrap_or_default();
                Ok(format!(
                    "status stream: {} record(s) confirmed, name {}, MK epochs used {:?}",
                    copy.confirmed,
                    last["displayName"],
                    keys.iter().map(|(e, _)| e).collect::<Vec<_>>()
                ))
            }
            ["channel", machine] => {
                self.reset_link();
                let link = self.link().await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
                let channel = self.device.open_channel(&link, machine).await?;
                let r = rpc(&channel, "GET", "/rh/info", None).await?;
                Ok(format!("channel open; /rh/info {} {}", r.status, String::from_utf8_lossy(&r.body)))
            }
            ["forge-chain"] => {
                // What a malicious hub would serve a recovering browser: its own
                // account key and device around the account's real (public)
                // recovery key, the real proof copied. Printed as the JSON
                // `GET /v1/chain` returns, for a test proxy to serve.
                self.device.sync_chain().await?;
                let chain = self.device.chain().ok_or("no chain")?;
                let rh_proto::chain::Action::Genesis { recovery_key, .. } = &chain.entries()[0].draft.action else {
                    return Err("no genesis".into());
                };
                let hub_ak = ed25519_dalek::SigningKey::from_bytes(&rh_devkit::random_key());
                let hub_device = rh_proto::chain::DeviceInfo {
                    id: "d-hubforged0000000".into(),
                    sign_key: ed25519_dalek::SigningKey::from_bytes(&rh_devkit::random_key()).verifying_key().to_bytes(),
                    dh_key: rh_proto::keys::DhKeypair::from_secret(rh_devkit::random_key()).public(),
                    full: true,
                };
                let genesis = rh_proto::chain::genesis_draft(
                    chain.account(),
                    hub_ak.verifying_key().to_bytes(),
                    hub_device,
                    *recovery_key,
                    rh_devkit::now_ms(),
                )
                .sign(&hub_ak);
                println!("FORGED {}", json!({"entries": [rh_devkit::hex(&genesis.encode())], "seq": 0}));
                Ok("a forged chain (it does not verify: the copied proof is over the real root)".into())
            }
            ["status"] => {
                self.device.sync_chain().await?;
                let chain = self.device.chain().ok_or("no chain")?;
                let me = chain
                    .device(&self.device.id)
                    .map(|d| format!("active, full={}, host={}", d.admin, d.host))
                    .unwrap_or_else(|| "not an active device".into());
                let pending: Vec<String> = chain.pending_recoveries().iter().map(|(d, s)| format!("{d}@{s}")).collect();
                Ok(format!(
                    "device {} is {me}; chain seq {}; pending recoveries {:?}",
                    self.device.id,
                    chain.seq(),
                    pending
                ))
            }
            [] => Ok(String::new()),
            _ => Err(format!("unknown command {line:?}")),
        }
    }

    fn device_account(&self) -> String {
        self.device.account.clone()
    }

    /// Sync the chain and, if this device is in it and the head moved, attest.
    async fn follow(&mut self, attested: &mut Option<u64>) {
        if self.device.sync_chain().await.is_err() {
            return;
        }
        let Some(chain) = self.device.chain() else { return };
        let seq = chain.seq();
        if chain.device(&self.device.id).is_none() || *attested == Some(seq) {
            return;
        }
        if self.attest_now().await.is_ok() {
            *attested = Some(seq);
        } else {
            self.reset_link();
        }
    }

    async fn attest_now(&mut self) -> Result<()> {
        self.device.sync_chain().await?;
        let att = self.device.attestation()?;
        self.link().await?.attest(&att)
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let (Some(hub), Some(email), Some(password_file)) = (arg("--hub"), arg("--email"), arg("--password-file")) else {
        eprintln!("usage: rh-device --hub <url> --email <email> --password-file <file> [--sign-up <invite>]");
        std::process::exit(2);
    };
    let password = match std::fs::read_to_string(&password_file) {
        Ok(p) => p.trim_end_matches(['\r', '\n']).to_string(),
        Err(e) => {
            eprintln!("cannot read the password file: {e}");
            std::process::exit(2);
        }
    };
    let hub = match HubUrl::parse(&hub) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("hub: {e}");
            std::process::exit(2);
        }
    };
    let device = match arg("--sign-up") {
        Some(invite) => {
            let made = async {
                let mut device = Device::sign_up(&hub, &invite, &email, &password).await?;
                device.create_genesis().await?;
                Ok::<_, String>(device)
            };
            match made.await {
                Ok(d) => {
                    println!("ok signed up; first device {} (the account's chain starts here)", d.id);
                    d
                }
                Err(e) => {
                    eprintln!("sign-up: {e}");
                    std::process::exit(1);
                }
            }
        }
        None => match Device::log_in(&hub, &email, &password).await {
            Ok(d) => {
                println!("ok signed in as new device {}", d.id);
                d
            }
            Err(e) => {
                eprintln!("sign-in: {e}");
                std::process::exit(1);
            }
        },
    };
    let mut session = Session { device, link: None };
    // stdin on a thread (tokio's io-std is not enabled for this crate).
    let (tx, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines().map_while(std::result::Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    // Like a browser: follow the chain and vouch for each new head once in it,
    // so the other devices' channels stay fresh.
    let mut tick = tokio::time::interval(Duration::from_secs(3));
    let mut attested: Option<u64> = None;
    loop {
        let line = tokio::select! {
            line = lines.recv() => match line {
                Some(line) => line,
                None => break,
            },
            _ = tick.tick() => {
                session.follow(&mut attested).await;
                continue;
            }
        };
        let line = line.trim().to_string();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let shown = if line.starts_with("accept ") {
            "accept <offer>".to_string()
        } else {
            line.clone()
        };
        println!("> {shown}");
        match session.run(&line).await {
            Ok(out) => println!("ok {out}"),
            Err(e) => println!("error {e}"),
        }
    }
}
