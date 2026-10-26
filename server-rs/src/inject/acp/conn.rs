//! The JSON-RPC connection to one agent process: one message per line, both
//! ways, over the agent's stdio.
//!
//! One task reads everything the agent writes, in order, and turns it into an
//! [`Event`] on one channel — so a turn's last `session/update` is always read
//! before the answer that ends the turn:
//!
//! * `session/update` notifications become [`Event::Update`];
//! * the answer to `session/prompt` becomes [`Event::Prompted`];
//! * the answers to the other requests go to whoever is awaiting them;
//! * requests the agent makes of this client go to [`super::client`], each on
//!   a task of its own, because `terminal/wait_for_exit` is answered only when
//!   the command ends;
//! * the end of the agent's output becomes [`Event::Closed`].
//!
//! Anything on stdout that is not a JSON object is skipped: it is a plugin
//! printing to the wrong stream, not the protocol.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};

use super::client::Client;
use super::{absolute, InjectError, Replay};
use crate::acp::{PromptResponse, SessionNotification, PROTOCOL_VERSION};

/// How long a write to the agent's stdin may block.
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Something the agent said, in the order it said it.
pub(super) enum Event {
    /// A `session/update`.
    Update(SessionNotification),
    /// The answer to the `session/prompt` in flight: how the turn ended, or the
    /// agent's error.
    Prompted(Result<PromptResponse, String>),
    /// The agent's output ended: it exited, or closed it.
    Closed,
}

/// The agent's stdin, shared by the driver and the tasks answering its
/// requests; `None` once closed, which is how an agent is told to exit.
#[derive(Clone)]
struct Writer(Arc<tokio::sync::Mutex<Option<ChildStdin>>>);

impl Writer {
    /// Write one message. `false` when the input is closed or the write failed.
    async fn send(&self, value: &Value) -> bool {
        let mut line = value.to_string();
        line.push('\n');
        let mut stdin = self.0.lock().await;
        let Some(pipe) = stdin.as_mut() else { return false };
        let written = tokio::time::timeout(WRITE_TIMEOUT, async { pipe.write_all(line.as_bytes()).await.and(pipe.flush().await) }).await;
        matches!(written, Ok(Ok(())))
    }

    async fn close(&self) {
        drop(self.0.lock().await.take());
    }
}

/// Requests awaiting an answer, by id, and the one `session/prompt` whose
/// answer is an [`Event`] rather than a reply.
#[derive(Default)]
struct Pending {
    replies: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    prompt: Option<String>,
}

/// One agent's connection.
pub(super) struct Conn {
    writer: Writer,
    pending: Arc<Mutex<Pending>>,
    next: AtomicU64,
    /// What the agent says; see [`Event`].
    pub(super) events: mpsc::UnboundedReceiver<Event>,
}

/// A line the agent wrote that is a JSON-RPC message.
fn parse(line: &str) -> Option<Map<String, Value>> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    serde_json::from_str(line).ok()
}

/// The message an error answer carries.
fn error_text(error: &Value) -> String {
    error["message"].as_str().map(str::to_owned).unwrap_or_else(|| error.to_string())
}

impl Conn {
    /// Connect to the agent behind these pipes.
    pub(super) async fn start(stdin: ChildStdin, stdout: ChildStdout, client: Arc<Client>) -> Result<Conn, InjectError> {
        let writer = Writer(Arc::new(tokio::sync::Mutex::new(Some(stdin))));
        let pending = Arc::new(Mutex::new(Pending::default()));
        let (events_tx, events) = mpsc::unbounded_channel();
        tokio::spawn(read(stdout, writer.clone(), pending.clone(), events_tx, client));
        Ok(Conn {
            writer,
            pending,
            next: AtomicU64::new(0),
            events,
        })
    }

    fn next_id(&self) -> String {
        format!("droppen-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// Send a request and wait for its answer.
    async fn call(&self, method: &str, params: Value) -> Result<Value, InjectError> {
        let id = self.next_id();
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap().replies.insert(id.clone(), reply);
        if !self
            .writer
            .send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().unwrap().replies.remove(&id);
            return Err(InjectError::message("the agent closed its input"));
        }
        match answer.await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(InjectError::message(format!("{method} failed: {error}"))),
            Err(_) => Err(InjectError::message("the agent exited")),
        }
    }

    /// Initialize, then create or reopen the session: its id, and whatever
    /// history the agent replayed while reopening it.
    pub(super) async fn open(&mut self, id: Option<&str>, workdir: &Path) -> Result<(String, Replay), InjectError> {
        let init = self
            .call(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {"fs": {"readTextFile": true, "writeTextFile": true}, "terminal": true},
                    "clientInfo": {"name": "droppen", "title": "Droppen", "version": env!("CARGO_PKG_VERSION")},
                }),
            )
            .await?;
        let cwd = absolute(workdir);
        match id {
            None => {
                let created = self.call("session/new", json!({"cwd": cwd, "mcpServers": []})).await?;
                let id = created["sessionId"]
                    .as_str()
                    .filter(|id| crate::sessions::acp_transcript::valid_id(id))
                    .ok_or_else(|| InjectError::message("the agent returned no usable session id"))?;
                Ok((id.to_string(), Vec::new()))
            }
            Some(id) => {
                if init["agentCapabilities"]["loadSession"] != json!(true) {
                    return Err(InjectError::message("this agent cannot reopen a session"));
                }
                self.call("session/load", json!({"sessionId": id, "cwd": cwd, "mcpServers": []})).await?;
                // Every update the replay sent was read before the answer
                // that ended it, so it is already on the channel.
                let mut replayed = Vec::new();
                while let Ok(event) = self.events.try_recv() {
                    match event {
                        Event::Update(notification) if notification.session_id == id => replayed.push(notification.update),
                        Event::Closed => return Err(InjectError::message("the agent exited")),
                        _ => {}
                    }
                }
                Ok((id.to_string(), replayed))
            }
        }
    }

    /// Start a turn. Its end arrives as [`Event::Prompted`], after its updates.
    pub(super) async fn prompt(&self, id: &str, text: String) -> Result<(), InjectError> {
        let request = self.next_id();
        self.pending.lock().unwrap().prompt = Some(request.clone());
        let sent = self
            .writer
            .send(&json!({
                "jsonrpc": "2.0", "id": request, "method": "session/prompt",
                "params": {"sessionId": id, "prompt": [{"type": "text", "text": text}]},
            }))
            .await;
        if sent {
            Ok(())
        } else {
            Err(InjectError::message("the agent closed its input"))
        }
    }

    /// Ask the agent to end the turn in flight.
    pub(super) async fn cancel(&self, id: &str) -> Result<(), InjectError> {
        if self
            .writer
            .send(&json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": id}}))
            .await
        {
            Ok(())
        } else {
            Err(InjectError::message("the agent closed its input"))
        }
    }

    /// Close the agent's stdin: how an ACP agent over stdio is told to exit.
    pub(super) async fn close(&mut self) {
        self.writer.close().await;
    }
}

/// Read everything the agent writes; see the module note.
async fn read(stdout: ChildStdout, writer: Writer, pending: Arc<Mutex<Pending>>, events: mpsc::UnboundedSender<Event>, client: Arc<Client>) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(message) = parse(&line) else { continue };
        match (message.get("method").and_then(Value::as_str), message.get("id")) {
            // A request this client is to answer.
            (Some(method), Some(id)) => {
                let (method, id, params) = (method.to_string(), id.clone(), message.get("params").cloned().unwrap_or(Value::Null));
                let (client, writer) = (client.clone(), writer.clone());
                tokio::spawn(async move {
                    let reply = match client.handle(&method, params).await {
                        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": error.code, "message": error.message}}),
                    };
                    writer.send(&reply).await;
                });
            }
            (Some("session/update"), None) => match serde_json::from_value(message.get("params").cloned().unwrap_or(Value::Null)) {
                Ok(notification) => {
                    let _ = events.send(Event::Update(notification));
                }
                Err(error) => tracing::debug!(%error, "skipping a session/update this build cannot read"),
            },
            (Some(_), None) => {}
            // An answer to one of this client's requests.
            (None, Some(id)) => {
                let id = id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string());
                let outcome = match (message.get("error"), message.get("result")) {
                    (Some(error), _) => Err(error_text(error)),
                    (None, result) => Ok(result.cloned().unwrap_or(Value::Null)),
                };
                let mut pending = pending.lock().unwrap();
                if pending.prompt.as_deref() == Some(id.as_str()) {
                    pending.prompt = None;
                    let ended = outcome.and_then(|result| serde_json::from_value(result).map_err(|error| error.to_string()));
                    let _ = events.send(Event::Prompted(ended));
                } else if let Some(reply) = pending.replies.remove(&id) {
                    let _ = reply.send(outcome);
                }
            }
            (None, None) => {}
        }
    }
    // Whatever was still waiting will not be answered now.
    pending.lock().unwrap().replies.clear();
    let _ = events.send(Event::Closed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_objects_reach_the_protocol() {
        assert!(parse(r#"{"jsonrpc":"2.0","method":"x"}"#).is_some());
        assert!(parse(r#"  {"jsonrpc":"2.0","id":1,"result":{}}"#).is_some());
        assert!(parse("Loading plugins...").is_none());
        assert!(parse("[1, 2]").is_none());
        assert!(parse("{not json").is_none());
    }
}
