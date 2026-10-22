//! Opt-in capture of the hub-API traffic the headless device and the echo
//! agent exchange, for the contract check in `docs/hub-api/` (`node
//! docs/hub-api/check.mjs --traffic <file>`).
//!
//! Off unless `DROPPEN_HUB_API_TRAFFIC=<path>` is set. Then every JSON body this
//! crate sends to or gets from the hub's HTTP routes itself, and every JSON
//! control message on the echo agent's `/v1/agent` and `/v1/connect`, is
//! appended to that file as one line (what goes through `rh-client` — its
//! HTTP helpers, `/v1/client`, a device's `/v1/connect` — `rh_client::tap`
//! writes to the same file, as `"src": "client"`): `{"src": "devkit", "kind": "http"|"ws",
//! "socket"?, "dir": "in"|"out", "method"?, "path"?, "status"?, "body"}`.
//! Binary frames and binary bodies never are. What is written already
//! crosses the wire to the hub or a relay (test passwords, tokens and tickets
//! among it), so the file is created `0600`; delete it after.

use std::io::Write;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};

fn file() -> Option<&'static Mutex<std::fs::File>> {
    static FILE: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = rh_client::tap::traffic_path()?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(path).ok().map(Mutex::new)
    })
    .as_ref()
}

fn write(record: Map<String, Value>) {
    let Some(file) = file() else { return };
    let mut line = Value::Object(record).to_string();
    line.push('\n');
    if let Ok(mut file) = file.lock() {
        let _ = file.write_all(line.as_bytes());
    }
}

fn ws(socket: &str, dir: &str, text: &str) {
    if file().is_none() {
        return;
    }
    if let Ok(body) = serde_json::from_str::<Value>(text) {
        let record = json!({"src": "devkit", "kind": "ws", "socket": socket, "dir": dir, "body": body});
        write(record.as_object().cloned().unwrap_or_default());
    }
}

/// A control message sent on `socket` (`/v1/client`, `/v1/agent`, `/v1/connect`).
pub fn sent(socket: &str, text: String) -> String {
    ws(socket, "out", &text);
    text
}

/// A control message received on `socket`.
pub fn got<'a>(socket: &str, text: &'a str) -> &'a str {
    ws(socket, "in", text);
    text
}

fn http(dir: &str, method: &str, url: &str, status: Option<u16>, body: &Value) {
    if file().is_none() {
        return;
    }
    // `scheme://authority/path?query` → the path and the query.
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let target = after_scheme.find('/').map_or("/", |i| &after_scheme[i..]);
    let (path, query) = target.split_once('?').map_or((target, None), |(p, q)| (p, Some(q)));
    let mut record = Map::new();
    for (k, v) in [
        ("src", json!("devkit")),
        ("kind", json!("http")),
        ("dir", json!(dir)),
        ("method", json!(method)),
        ("path", json!(path)),
    ] {
        record.insert(k.into(), v);
    }
    if let Some(query) = query {
        record.insert("query".into(), json!(query));
    }
    if let Some(status) = status {
        record.insert("status".into(), json!(status));
    }
    record.insert("body".into(), body.clone());
    write(record);
}

/// A JSON request body, before it is sent to `url`.
pub fn http_out(method: &str, url: &str, body: &Value) {
    http("out", method, url, None, body);
}

/// A response from `url` (`body`: its JSON, or `null` when it had none).
pub fn http_in(method: &str, url: &str, status: u16, body: &Value) {
    http("in", method, url, Some(status), body);
}
