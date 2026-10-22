//! Opt-in capture of this relay's control link to the Hub (`/v1/relay`), for
//! the contract check in `docs/hub-api/` (`node docs/hub-api/check.mjs
//! --traffic <file>`).
//!
//! Off unless `DROPPEN_HUB_API_TRAFFIC=<path>` is set. Then every JSON message on
//! the link is appended to that file as one line, `{"src": "relay", "kind":
//! "ws", "socket": "/v1/relay", "dir": "in"|"out", "body"}`. What is written
//! already crosses the wire to the Hub (a registration token among it), so
//! the file is created `0600`; delete it after.

use std::io::Write;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

fn file() -> Option<&'static Mutex<std::fs::File>> {
    static FILE: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = crate::config::env("DROPPEN_HUB_API_TRAFFIC")?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(path).ok().map(Mutex::new)
    })
    .as_ref()
}

fn record(dir: &str, text: &str) {
    let Some(file) = file() else { return };
    let Ok(body) = serde_json::from_str::<Value>(text) else { return };
    let mut line = json!({"src": "relay", "kind": "ws", "socket": "/v1/relay", "dir": dir, "body": body}).to_string();
    line.push('\n');
    if let Ok(mut file) = file.lock() {
        let _ = file.write_all(line.as_bytes());
    }
}

/// A message to the Hub, as sent.
pub fn sent(text: String) -> String {
    record("out", &text);
    text
}

/// A message from the Hub, as received.
pub fn got(text: &str) -> &str {
    record("in", text);
    text
}
