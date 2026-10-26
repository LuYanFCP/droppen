//! One ACP session's driver: its queue, its turns, its transcript, and the
//! agent process behind them.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use super::client::Client;
use super::conn::{Conn, Event};
use super::AcpAgent;
use crate::acp::{category, option_for, ConfigOption, SessionUpdate};
use crate::inject::{InjectError, InjectionRegistry, Phase, QueueOutcome, ResidentState, Sent};
use crate::sessions::acp_transcript::{record, Translator};
use crate::sessions::{iso8601, Injection, InjectionRunState};

/// How long an agent process with nothing to do is kept.
pub(super) const IDLE_EXIT: Duration = Duration::from_secs(30 * 60);
/// How much of the agent's stderr is kept for the message a failure is
/// reported with.
const STDERR_TAIL: usize = 4 * 1024;

/// The driver's state, readable without awaiting it.
#[derive(Clone, Debug, Default)]
pub(super) struct State {
    /// A `session/prompt` is in flight.
    active: bool,
    /// When it was sent.
    turn_started_at: Option<String>,
    /// Messages waiting for the turn in flight to end, in order.
    queue: VecDeque<Message>,
    /// The last turn this driver ran, as the session row reports it.
    injection: Option<Injection>,
    /// The session's configuration options as they stand: what its model and
    /// effort are, and may be set to.
    options: Vec<ConfigOption>,
}

impl State {
    pub(super) fn with_options(options: Vec<ConfigOption>) -> Self {
        Self { options, ..Self::default() }
    }
}

/// One message on its way to the agent.
#[derive(Clone, Debug)]
pub(super) struct Message {
    pub(super) id: String,
    /// What the user typed, as the transcript shows it.
    pub(super) text: String,
    /// What the agent is sent: the text and where its attachments are.
    pub(super) prompt: String,
    pub(super) images: Vec<String>,
    pub(super) files: Vec<String>,
    /// The model the turn is to run on, when the user picked one.
    pub(super) model: Option<String>,
    /// The effort it is to run at, when the user picked one.
    pub(super) effort: Option<String>,
}

/// What the send path and the routes hold on to.
#[derive(Clone)]
pub(in crate::inject) struct Handle {
    pub(super) tx: mpsc::UnboundedSender<Cmd>,
    shared: Arc<Mutex<State>>,
}

impl Handle {
    pub(super) fn new(tx: mpsc::UnboundedSender<Cmd>) -> Self {
        Self { tx, shared: Arc::default() }
    }

    pub(super) fn shared(&self) -> Arc<Mutex<State>> {
        self.shared.clone()
    }

    /// The session's configuration options as they stand.
    pub(super) fn options(&self) -> Vec<ConfigOption> {
        self.shared.lock().unwrap().options.clone()
    }

    pub(in crate::inject) fn alive(&self) -> bool {
        !self.tx.is_closed()
    }

    /// Whether the session row should report this driver at all.
    pub(in crate::inject) fn visible(&self) -> bool {
        self.alive()
    }

    pub(in crate::inject) fn injection(&self) -> Option<Injection> {
        self.shared.lock().unwrap().injection.clone()
    }

    pub(in crate::inject) fn state(&self) -> ResidentState {
        let state = self.shared.lock().unwrap();
        ResidentState {
            phase: if state.active { Phase::Working } else { Phase::Idle },
            stalled: false,
            queued: state.queue.len(),
            queued_messages: state
                .queue
                .iter()
                .map(|message| crate::sessions::QueuedMessage {
                    id: message.id.clone(),
                    text: message.text.chars().take(200).collect(),
                    steered: false,
                })
                .collect(),
            background: 0,
            tasks: vec![],
            awaiting_background: false,
            turn_started_at: state.turn_started_at.clone(),
            // Every permission request the agent makes is answered by the client.
            question: None,
        }
    }

    pub(in crate::inject) fn info(&self) -> crate::sessions::ResidentInfo {
        self.state().into()
    }

    pub(in crate::inject) fn interrupt(&self) -> bool {
        self.shared.lock().unwrap().active && self.tx.send(Cmd::Interrupt).is_ok()
    }

    pub(super) async fn queue_action(&self, id: &str, steer: bool) -> QueueOutcome {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::Queue { id: id.into(), steer, reply }).is_err() {
            return QueueOutcome::Unreachable;
        }
        rx.await.unwrap_or(QueueOutcome::Unreachable)
    }

    pub(super) async fn stop(&self) -> bool {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Cmd::Stop(reply)).is_ok() && rx.await.unwrap_or(false)
    }
}

pub(in crate::inject) enum Cmd {
    Deliver(Message, oneshot::Sender<Sent>),
    Interrupt,
    Queue {
        id: String,
        steer: bool,
        reply: oneshot::Sender<QueueOutcome>,
    },
    /// End the process if nothing is in flight; `false` when something is.
    Stop(oneshot::Sender<bool>),
}

/// The last [`STDERR_TAIL`] bytes the agent wrote to stderr.
#[derive(Clone, Default)]
pub(super) struct StderrTail(Arc<Mutex<VecDeque<u8>>>);

impl StderrTail {
    pub(super) fn follow(mut stderr: tokio::process::ChildStderr) -> Self {
        let tail = Self::default();
        let kept = tail.0.clone();
        tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut buffer).await {
                if read == 0 {
                    return;
                }
                let mut kept = kept.lock().unwrap();
                kept.extend(&buffer[..read]);
                let excess = kept.len().saturating_sub(STDERR_TAIL);
                kept.drain(..excess);
            }
        });
        tail
    }

    /// The last few non-empty lines.
    pub(super) fn text(&self) -> String {
        let bytes: Vec<u8> = self.0.lock().unwrap().iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
        lines[lines.len().saturating_sub(8)..].join("\n")
    }
}

/// The transcript file, opened for appending.
pub(super) struct Transcript {
    file: tokio::fs::File,
}

impl Transcript {
    pub(super) async fn open(path: &Path) -> std::io::Result<Self> {
        let file = tokio::fs::OpenOptions::new().create(true).append(true).open(path).await?;
        Ok(Self { file })
    }

    /// Append records. A failed write is logged and the turn goes on: losing a
    /// line of the view is better than stopping the work it describes.
    pub(super) async fn append(&mut self, records: &[Value]) {
        if records.is_empty() {
            return;
        }
        let mut text = String::new();
        for record in records {
            text.push_str(&record.to_string());
            text.push('\n');
        }
        if let Err(error) = self.file.write_all(text.as_bytes()).await {
            tracing::warn!(%error, "cannot write an ACP transcript");
        }
    }
}

pub(super) struct Driver {
    pub(super) registry: Arc<InjectionRegistry>,
    pub(super) agent: &'static AcpAgent,
    pub(super) id: String,
    pub(super) child: Child,
    pub(super) conn: Conn,
    pub(super) client: Arc<Client>,
    pub(super) stderr: StderrTail,
    pub(super) transcript: Transcript,
    pub(super) translator: Translator,
    pub(super) state: State,
    pub(super) shared: Arc<Mutex<State>>,
    pub(super) rx: mpsc::UnboundedReceiver<Cmd>,
    /// A cancel was sent for the turn in flight.
    pub(super) interrupted: bool,
    /// The model and effort the transcript last recorded the session running
    /// on, so a `config` record is written only when they change.
    pub(super) recorded_choice: Option<(Option<String>, Option<String>)>,
}

impl Driver {
    fn publish(&mut self) {
        *self.shared.lock().unwrap() = self.state.clone();
        self.registry.poke_feed(self.agent.source, &self.id);
    }

    pub(super) async fn run(mut self) {
        let mut idle_since = Instant::now();
        loop {
            if !self.state.active {
                if let Some(message) = self.state.queue.pop_front() {
                    if let Err(error) = self.submit(message).await {
                        self.died(&error.to_string()).await;
                        return;
                    }
                }
            }
            let idle_deadline = idle_since + IDLE_EXIT;
            tokio::select! {
                event = self.conn.events.recv() => match event {
                    Some(Event::Update(notification)) => {
                        if notification.session_id == self.id {
                            if let SessionUpdate::ConfigOptionUpdate(update) = &notification.update {
                                self.options_changed(update.options());
                                self.publish();
                            }
                            let records = self.translator.update(&notification.update);
                            if !records.is_empty() {
                                self.transcript.append(&records).await;
                                self.registry.poke_feed(self.agent.source, &self.id);
                            }
                        }
                    }
                    Some(Event::Prompted(result)) => self.prompted(result).await,
                    Some(Event::Closed) | None => {
                        self.died(&format!("{} exited", self.agent.name)).await;
                        return;
                    }
                },
                cmd = self.rx.recv() => match cmd {
                    Some(Cmd::Stop(reply)) => {
                        let idle = !self.state.active && self.state.queue.is_empty();
                        if idle {
                            self.exit().await;
                        }
                        let _ = reply.send(idle);
                        if idle {
                            return;
                        }
                    }
                    Some(cmd) => {
                        if let Err(error) = self.command(cmd).await {
                            self.died(&error.to_string()).await;
                            return;
                        }
                    }
                    None => {
                        self.exit().await;
                        return;
                    }
                },
                _ = tokio::time::sleep_until(idle_deadline.into()), if !self.state.active && self.state.queue.is_empty() => {
                    // Gone from the map first, so the next message starts a new
                    // process instead of finding this one on its way out.
                    let key = self.registry.key_of(self.agent.source, &self.id);
                    self.registry.acp_servers.lock().unwrap().remove(&key);
                    self.exit().await;
                    return;
                }
            }
            idle_since = Instant::now();
        }
    }

    async fn command(&mut self, cmd: Cmd) -> Result<(), InjectError> {
        match cmd {
            Cmd::Deliver(message, reply) => {
                let queued = self.state.active || !self.state.queue.is_empty();
                self.state.queue.push_back(message);
                self.publish();
                let _ = reply.send(Sent { queued });
            }
            Cmd::Interrupt => {
                if self.state.active && !self.interrupted {
                    self.interrupted = true;
                    self.conn.cancel(&self.id).await?;
                }
            }
            Cmd::Queue { id, steer, reply } => {
                let Some(index) = self.state.queue.iter().position(|message| message.id == id) else {
                    let _ = reply.send(QueueOutcome::Unknown);
                    return Ok(());
                };
                if steer {
                    let _ = reply.send(QueueOutcome::Refused {
                        reason: format!("{} takes the next message when the turn in flight ends", self.agent.name),
                    });
                    return Ok(());
                }
                let dropped = self.state.queue.remove(index).expect("an index the queue just gave");
                self.publish();
                self.registry
                    .note_receipt(self.agent.source, &self.id, &dropped.id, crate::inject::receipts::ReceiptStatus::Failed);
                let _ = reply.send(QueueOutcome::Done);
            }
            Cmd::Stop(_) => unreachable!("handled by the loop"),
        }
        Ok(())
    }

    async fn submit(&mut self, message: Message) -> Result<(), InjectError> {
        self.transcript
            .append(&[record(
                "user",
                json!({"text": message.text, "images": message.images, "files": message.files}),
            )])
            .await;
        if let Err(reason) = self.configure(&message).await {
            // The turn never starts: the session would have run on a model or
            // at an effort nobody asked for.
            self.registry
                .note_receipt(self.agent.source, &self.id, &message.id, crate::inject::receipts::ReceiptStatus::Failed);
            let message = self.registry.redact(&reason);
            self.transcript.append(&[record("error", json!({ "message": message }))]).await;
            self.start_turn();
            self.end_turn(Some(message), false);
            return Ok(());
        }
        self.record_choice().await;
        self.conn.prompt(&self.id, message.prompt).await?;
        self.registry
            .note_receipt(self.agent.source, &self.id, &message.id, crate::inject::receipts::ReceiptStatus::Sent);
        self.start_turn();
        Ok(())
    }

    /// Mark a turn as started, on the row and in the mirror.
    fn start_turn(&mut self) {
        let now = iso8601(SystemTime::now());
        self.interrupted = false;
        self.state.active = true;
        self.state.turn_started_at = Some(now.clone());
        self.state.injection = Some(Injection {
            state: InjectionRunState::Running,
            error: crate::openapi_ext::Nullable(None),
            interrupted: false,
            started_at: now,
            finished_at: crate::openapi_ext::Nullable(None),
        });
        self.publish();
    }

    /// Set the session's model and effort to what the message picked, where
    /// they differ: one `session/set_config_option` each.
    async fn configure(&mut self, message: &Message) -> Result<(), String> {
        let name = self.agent.name;
        let picks = [
            (category::MODEL, "model", message.model.as_deref()),
            (category::THOUGHT_LEVEL, "effort", message.effort.as_deref()),
        ];
        for (category, what, wanted) in picks {
            let Some(wanted) = wanted else { continue };
            let Some(option) = option_for(&self.state.options, category).cloned() else {
                return Err(format!("{name} offers no {what} to choose"));
            };
            if option.current_value.as_deref() == Some(wanted) {
                continue;
            }
            if !option.accepts(wanted) {
                return Err(format!("{name} has no {what} \"{wanted}\""));
            }
            let options = self
                .conn
                .set_config_option(&self.id, &option.id, wanted)
                .await
                .map_err(|error| format!("{name} did not switch its {what} to {wanted}: {error}"))?;
            if options.is_empty() {
                // An agent that answers without the list: the value it took.
                if let Some(changed) = self.state.options.iter_mut().find(|candidate| candidate.id == option.id) {
                    changed.current_value = Some(wanted.to_string());
                }
            } else {
                self.options_changed(options);
            }
        }
        self.publish();
        Ok(())
    }

    /// The session's options as the agent now reports them.
    fn options_changed(&mut self, options: Vec<ConfigOption>) {
        self.state.options = options;
    }

    /// Write down which model and effort the session runs on, when that is
    /// news: what the composer shows for a session it reopens.
    async fn record_choice(&mut self) {
        let current = |category: &str| option_for(&self.state.options, category).and_then(|option| option.current_value.clone());
        let choice = (current(category::MODEL), current(category::THOUGHT_LEVEL));
        if choice == (None, None) || self.recorded_choice.as_ref() == Some(&choice) {
            return;
        }
        self.transcript
            .append(&[record("config", json!({"model": choice.0, "effort": choice.1}))])
            .await;
        self.recorded_choice = Some(choice);
    }

    /// The turn in flight ended: say how, in the transcript and on the row.
    async fn prompted(&mut self, result: Result<crate::acp::PromptResponse, String>) {
        if !self.state.active {
            return;
        }
        let mut records = self.translator.flush();
        let (error, cancelled) = match result {
            Ok(response) => {
                let stop = response.stop_reason.as_str();
                records.push(record("turn_end", json!({ "stopReason": stop })));
                (None, stop == "cancelled")
            }
            Err(error) => {
                let message = self.registry.redact(&error);
                records.push(record("error", json!({ "message": message })));
                (Some(message), false)
            }
        };
        self.transcript.append(&records).await;
        let interrupted = cancelled || (self.interrupted && error.is_some());
        self.end_turn(error, interrupted);
    }

    fn end_turn(&mut self, error: Option<String>, interrupted: bool) {
        self.interrupted = false;
        self.state.active = false;
        self.state.turn_started_at = None;
        let started_at = self
            .state
            .injection
            .as_ref()
            .map(|injection| injection.started_at.clone())
            .unwrap_or_else(|| iso8601(SystemTime::now()));
        let outcome = if error.is_some() || interrupted {
            InjectionRunState::Failed
        } else {
            InjectionRunState::Ok
        };
        self.state.injection = Some(Injection {
            state: outcome,
            error: crate::openapi_ext::Nullable(error.clone()),
            interrupted,
            started_at,
            finished_at: crate::openapi_ext::Nullable(Some(iso8601(SystemTime::now()))),
        });
        self.publish();
        crate::push::notify_turn(
            self.registry.paths.clone(),
            self.agent.source,
            self.id.clone(),
            outcome,
            error,
            self.registry.driver_states(),
        );
    }

    /// The process went away, or stopped answering: say so, and fail what
    /// was waiting for it.
    async fn died(&mut self, reason: &str) {
        self.client.kill_all();
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        let tail = self.stderr.text();
        let message = self.registry.redact(&if tail.is_empty() {
            reason.to_string()
        } else {
            format!("{reason}\n{tail}")
        });
        tracing::warn!(session = %self.id, agent = self.agent.name, error = %message, "the agent process for this session is gone");
        let mut records = self.translator.flush();
        if self.state.active || !self.state.queue.is_empty() {
            records.push(record("error", json!({ "message": message })));
        }
        self.transcript.append(&records).await;
        for dropped in std::mem::take(&mut self.state.queue) {
            self.registry
                .note_receipt(self.agent.source, &self.id, &dropped.id, crate::inject::receipts::ReceiptStatus::Failed);
        }
        if self.state.active {
            let interrupted = self.interrupted;
            self.end_turn(Some(message), interrupted);
        } else {
            self.publish();
        }
        // The handle stays in the map with its sender closed, so the session
        // row still says how the last turn ended; the next message replaces it.
        self.rx.close();
    }

    /// End the process politely: an ACP agent over stdio exits when its input
    /// closes.
    async fn exit(&mut self) {
        self.rx.close();
        self.client.kill_all();
        self.conn.close().await;
        if tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await.is_err() {
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }
    }
}
