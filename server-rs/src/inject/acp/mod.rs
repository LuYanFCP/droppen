//! Agents driven over the Agent Client Protocol: one agent process per
//! session, spoken to over stdio.
//!
//! [ACP](https://agentclientprotocol.com) is JSON-RPC 2.0, one message per
//! line. This server is its client half ([`conn`] for the wire, [`crate::acp`]
//! for the messages), and uses the part of the protocol that holds a
//! conversation:
//!
//! * `initialize`, advertising the file and terminal methods: an agent may run
//!   its shell and file tools through the client, and [`client`] is that
//!   client;
//! * `session/new` for a new session, `session/load` to reopen one — which
//!   replays the session's history as `session/update` notifications;
//! * `session/prompt` per message, answered with a stop reason when the turn
//!   ends, with the turn itself streamed as `session/update` notifications in
//!   between;
//! * `session/set_config_option` before a turn whose message picked another
//!   model or effort than the session has: the agent publishes both as
//!   configuration options (categories `model` and `thought_level`), and
//!   [`InjectionRegistry::acp_options`] reads them for the composer before any
//!   session exists, by opening one in a scratch directory and closing it;
//! * `session/cancel` to stop a turn.
//!
//! What the agent says is written down as it arrives, in the transcript
//! [`crate::sessions::acp_transcript`] keeps; that file is what the session
//! view reads.
//!
//! Everything here is the same for every ACP agent. Which agents there are is
//! the user's to configure ([`crate::acp_agent`]); each session records the one
//! it runs on, and is started, reopened and resumed with that agent and no
//! other. Its id is this server's own and the agent's id is kept beside it
//! ([`crate::sessions::acp_transcript`]): two agents may give two sessions the
//! same id, and both still have to be told apart here.
//!
//! One message runs at a time. A message sent mid-turn waits in the driver's
//! queue and goes in when the turn ends: ACP takes a second `session/prompt`
//! only behind the first, so holding it here is the same thing with a queue
//! the user can see and take a message back out of.
//!
//! Unlike the Claude and Codex residents, an ACP agent is not started through
//! the session shim and is not journalled: it is this server's child, and it
//! ends with this server. A turn in flight when the server stops is cut short
//! (what it said so far is in the transcript), and the next message reopens the
//! session with `session/load`. A process left alone for [`driver::IDLE_EXIT`]
//! is closed, for the same reason: the agent keeps the conversation, and an idle
//! process per session is not worth keeping for it.

mod client;
mod conn;
mod driver;

use std::path::{Path, PathBuf};
use std::process::Stdio;

use super::*;
use crate::acp::{category, option_for, ConfigOption, InitializeResponse};
use crate::acp_agent::{AcpAgent, AcpCheck, AcpCheckState};
use crate::sessions::acp_transcript::{agent_dir, has_conversation, locate, read_header, record, Translator};
use client::Client;
use conn::Conn;
pub(super) use driver::Handle;
use driver::{Cmd, Driver, Message, Process, State, StderrTail};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

/// How long an agent may take to start and open a session.
///
/// Generous: `initialize` may import a whole framework and its plugins (an
/// agent may be a Python program), and `session/load` reads and replays the
/// whole history.
const START_TIMEOUT: Duration = Duration::from_secs(120);

/// What to do when an agent cannot be started, said after the reason.
const INSTALL_HINT: &str = "Check its executable and arguments in Settings";

/// How long a check waits for `initialize` to be answered.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The configured agent `id`, or why a new session cannot run on it.
fn configured(paths: &Paths, id: &str) -> Result<AcpAgent, InjectError> {
    crate::acp_agent::agent(paths, id)
        .ok_or_else(|| InjectError::message(format!("no ACP agent \"{id}\" is configured; add it in Settings")))
}

/// A session this server already has a transcript for.
struct Recorded {
    /// This server's id for it.
    id: String,
    /// Its transcript.
    file: PathBuf,
    /// The id the agent gave it.
    agent_session: String,
    /// Where it ran.
    cwd: Option<String>,
}

/// The prompt an agent is sent: the text, and where each attachment is on disk.
///
/// Paths rather than inline content, images included: an ACP agent reads
/// files with its own tools, and an image block would fail outright on a
/// model without vision.
fn prompt_text(text: &str, images: &[String], files: &[String]) -> String {
    let attached: Vec<&String> = images.iter().chain(files).collect();
    if attached.is_empty() {
        return text.to_string();
    }
    let list = attached.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n");
    format!("{text}\n\n[{} attached file(s):]\n{list}", attached.len())
}

fn message(text: &str, options: &SendOptions) -> Message {
    let picked = |value: &Option<String>| value.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    Message {
        id: options.message_id.clone().unwrap_or_else(new_uuid),
        text: text.to_string(),
        prompt: prompt_text(text, &options.images, &options.files),
        images: options.images.clone(),
        files: options.files.clone(),
        model: picked(&options.model),
        effort: picked(&options.effort),
    }
}

/// Refuse what an ACP session cannot do differently per message.
///
/// An ACP agent has no accounts here and no permission modes; a request that
/// names either is refused rather than quietly run on something else. Its
/// model and effort are its own configuration options, checked against what
/// it publishes ([`check_choice`]).
fn check_options(agent: &AcpAgent, options: &SendOptions) -> Result<(), InjectError> {
    let name = &agent.name;
    if options.account.named().is_some() || matches!(options.account, AccountChoice::Rule(_)) {
        return Err(InjectError::message(format!(
            "{name} runs on its own configuration; there is no account to choose"
        )));
    }
    let named = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.trim().is_empty());
    if named(&options.permission) {
        return Err(InjectError::message(format!("{name} has no permission modes to choose between")));
    }
    if options.chat {
        return Err(InjectError::message(format!(
            "instant chats run on Claude Code, Codex or an API provider, not {name}"
        )));
    }
    Ok(())
}

/// Refuse a model or effort the agent does not offer, when what it offers is
/// known; with nothing known yet, the agent itself answers when it is set.
fn check_choice(agent: &AcpAgent, offered: &[ConfigOption], model: Option<&str>, effort: Option<&str>) -> Result<(), InjectError> {
    if offered.is_empty() {
        return Ok(());
    }
    for (category, what, wanted) in [(category::MODEL, "model", model), (category::THOUGHT_LEVEL, "effort", effort)] {
        let Some(wanted) = wanted else { continue };
        match option_for(offered, category) {
            None => return Err(InjectError::message(format!("{} offers no {what} to choose", agent.name))),
            Some(option) if !option.accepts(wanted) => {
                return Err(InjectError::message(format!("{} has no {what} \"{wanted}\"", agent.name)));
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// An agent process, started and connected, before any session is open.
struct Started {
    process: Process,
    stderr: StderrTail,
    client: Arc<Client>,
    conn: Conn,
}

/// Start `agent` in `workdir` and connect to it: its command line, over stdio,
/// with its variables laid over the server's clean environment, in a process
/// group of its own ([`Process`]).
async fn start(agent: &AcpAgent, workdir: &Path) -> Result<Started, InjectError> {
    let program = agent.program();
    if program.as_os_str().is_empty() {
        return Err(InjectError::message(format!("{} has no executable. {INSTALL_HINT}", agent.name)));
    }
    let env = agent.environment(clean_env_bare());
    let mut child = tokio::process::Command::new(&program)
        .args(&agent.args)
        .current_dir(workdir)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            InjectError::message(format!(
                "cannot start {} ({}): {error}. {INSTALL_HINT}",
                agent.name,
                program.display(),
            ))
        })?;
    let stderr = StderrTail::follow(child.stderr.take().expect("piped stderr"));
    let client = Client::new(workdir.to_path_buf(), env);
    let conn = Conn::start(
        child.stdin.take().expect("piped stdin"),
        child.stdout.take().expect("piped stdout"),
        client.clone(),
    )
    .await?;
    Ok(Started {
        process: Process::new(child),
        stderr,
        client,
        conn,
    })
}

impl Started {
    /// End a process that did not get as far as a driver, and say why.
    async fn fail(mut self, registry: &InjectionRegistry, agent: &AcpAgent, reason: String) -> InjectError {
        self.client.kill_all();
        self.process.kill().await;
        let tail = self.stderr.settled().await;
        let said = if tail.is_empty() { reason } else { format!("{reason}\n{tail}") };
        InjectError::message(registry.redact_acp(agent, &format!("cannot start {}: {said}", agent.name)))
    }
}

/// A scratch directory for an agent that is only asked something: removed
/// when it is dropped, a cancelled request's included.
fn scratch(kind: &str) -> std::io::Result<tempfile::TempDir> {
    tempfile::Builder::new().prefix(&format!("droppen-acp-{kind}-")).tempdir()
}

impl InjectionRegistry {
    /// The configuration options `agent` offers, for the composer: the model
    /// list and the effort ladder.
    ///
    /// Remembered per agent id once read — from a probe, or from a session the
    /// agent created since — and forgotten when its settings change. Only a
    /// fresh session's options are remembered: their current values are the
    /// agent's defaults, which a switched session's are not. With
    /// nothing remembered, a probe opens a session in a scratch directory,
    /// reads its options and closes it, so it leaves no conversation behind.
    pub async fn acp_options(self: &Arc<Self>, agent: &AcpAgent) -> Result<Vec<ConfigOption>, InjectError> {
        if let Some(options) = self.acp_options.lock().unwrap().get(&agent.id) {
            return Ok(options.clone());
        }
        // One probe per agent at a time: a page that asks twice gets the first
        // answer, and a slow agent does not hold up another's list.
        let gate = self.acp_probes.lock().unwrap().entry(agent.id.clone()).or_default().clone();
        let _probing = gate.lock().await;
        if let Some(options) = self.acp_options.lock().unwrap().get(&agent.id) {
            return Ok(options.clone());
        }
        let scratch = scratch("probe").map_err(|error| InjectError::Internal(error.to_string()))?;
        let options = self.probe(agent, scratch.path()).await?;
        self.remember_acp_options(&agent.id, &options);
        Ok(options)
    }

    async fn probe(&self, agent: &AcpAgent, scratch: &Path) -> Result<Vec<ConfigOption>, InjectError> {
        let mut started = start(agent, scratch).await?;
        // Only answers are read: what else the agent says is dropped as it
        // arrives rather than kept.
        started.conn.events.close();
        let opened = tokio::time::timeout(START_TIMEOUT, started.conn.open(None, scratch)).await;
        let opened = match opened {
            Ok(Ok(opened)) => opened,
            failed => {
                let reason = match failed {
                    Ok(Err(error)) => error.to_string(),
                    _ => format!("{} did not open a session in time", agent.name),
                };
                return Err(started.fail(self, agent, reason).await);
            }
        };
        started.conn.close_session(&opened.id).await;
        started.conn.close().await;
        started.process.end(Duration::from_secs(10)).await;
        Ok(opened.options)
    }

    /// What the agent `agent` offers, as a fresh session reports it.
    pub(super) fn remember_acp_options(&self, agent: &str, options: &[ConfigOption]) {
        if !options.is_empty() {
            self.acp_options.lock().unwrap().insert(agent.to_string(), options.to_vec());
        }
    }

    /// Forget what the agent `agent` offers: its settings changed, so the next
    /// start may run a different configuration.
    pub fn forget_acp_options(&self, agent: &str) {
        self.acp_options.lock().unwrap().remove(agent);
    }

    /// What `agent` said, fit to be stored and shown: [`InjectionRegistry::redact`],
    /// after its own variables' values are taken out — they are what an API
    /// key looks like.
    pub(super) fn redact_acp(&self, agent: &AcpAgent, text: &str) -> String {
        self.redact(&agent.without_values(text))
    }

    /// Whether a turn of the agent `agent` is running, in any of its sessions,
    /// or a message is waiting for one.
    fn acp_agent_busy(&self, agent: &str) -> bool {
        self.acp_servers.lock().unwrap().values().any(|handle| handle.runs_on(agent) && handle.busy())
    }

    /// Remove the configured agent `agent` unless a turn of it is running or a
    /// message is waiting for one, which is the `Err`; `Ok(false)` when it was
    /// gone already. Its sessions stay.
    ///
    /// Under the spawn gate, which a start or a send holds from reading its
    /// agent until its message is handed over: no turn starts between the
    /// look and the removal, and none starts on the agent after it.
    pub async fn remove_acp_agent(&self, agent: &AcpAgent) -> Result<bool, String> {
        let _gate = self.spawn_gate.lock().await;
        if self.acp_agent_busy(&agent.id) {
            return Err(format!(
                "{} is running a turn or has a message waiting; stop it, or let it finish, then remove the agent",
                agent.name
            ));
        }
        let removed = crate::acp_agent::remove(&self.paths, &agent.id);
        // Whatever it offered, an agent configured again under this id may not.
        self.forget_acp_options(&agent.id);
        Ok(removed)
    }

    /// Check `agent`: find its executable on its own `PATH`, start it in a
    /// scratch directory, send `initialize`, read the answer, and stop it.
    /// Nothing reaches a model, and no session is opened.
    ///
    /// Bounded: `initialize` gets [`CHECK_TIMEOUT`], what the agent wrote to
    /// stderr is its last few lines, and the error is cut to a few KB. What it
    /// says is redacted ([`InjectionRegistry::redact_acp`]).
    pub async fn check_acp_agent(&self, agent: &AcpAgent) -> AcpCheck {
        self.check_acp_agent_within(agent, CHECK_TIMEOUT).await
    }

    /// [`InjectionRegistry::check_acp_agent`], waiting `patience` for the answer.
    async fn check_acp_agent_within(&self, agent: &AcpAgent, patience: Duration) -> AcpCheck {
        let env = agent.environment(clean_env_bare());
        let searched = format!("PATH={}", env.get("PATH").map(String::as_str).unwrap_or(""));
        let redact = |text: &str| self.redact_acp(agent, text);
        let Some(resolved) = crate::process_env::resolve_on_path(agent.command.trim(), &env) else {
            let error = format!("{}: no such executable\n{searched}", agent.command.trim());
            return AcpCheck::ended(AcpCheckState::NotFound, Some(redact(&error)));
        };
        let scratch = match scratch("check") {
            Ok(scratch) => scratch,
            Err(error) => {
                return AcpCheck::ended(AcpCheckState::Failed, Some(redact(&format!("cannot make a scratch directory: {error}"))));
            }
        };
        let mut started = match start(agent, scratch.path()).await {
            Ok(started) => started,
            Err(error) => return AcpCheck::ended(AcpCheckState::Failed, Some(redact(&format!("{error}\n{searched}")))),
        };
        // Only the answer is read: what else the agent says is dropped as it
        // arrives rather than kept.
        started.conn.events.close();
        let answered = tokio::time::timeout(patience, started.conn.initialize()).await;
        started.client.kill_all();
        started.conn.close().await;
        started.process.end(Duration::from_secs(5)).await;
        match answered {
            Ok(Ok(answer)) => AcpCheck::ready(resolved, &InitializeResponse::read(&answer), redact),
            failed => {
                let reason = match failed {
                    Ok(Err(error)) => error.to_string(),
                    _ => format!("{} did not answer initialize within {}s", agent.name, patience.as_secs()),
                };
                let tail = started.stderr.settled().await;
                let said = if tail.is_empty() { reason } else { format!("{reason}\n{tail}") };
                AcpCheck::ended(AcpCheckState::Failed, Some(redact(&said)))
            }
        }
    }

    pub(super) fn acp_handle(&self, id: &str) -> Option<Handle> {
        self.acp_servers.lock().unwrap().get(&self.key_of(Source::Acp, id)).cloned()
    }

    /// Start a new session on the configured agent `agent` in `cwd`, with its
    /// first message; this server's id for it is returned.
    pub(super) async fn acp_start(self: &Arc<Self>, agent: &str, cwd: &str, text: &str, options: &SendOptions) -> Result<String, InjectError> {
        // The agent is read under the gate, which its removal holds too
        // ([`InjectionRegistry::remove_acp_agent`]).
        let _gate = self.spawn_gate.lock().await;
        let agent = configured(&self.paths, agent)?;
        check_options(&agent, options)?;
        let message = message(text, options);
        // Checked before anything starts, against what the agent last offered:
        // a refused pick must not leave a new, empty session behind.
        let offered = self.acp_options.lock().unwrap().get(&agent.id).cloned().unwrap_or_default();
        check_choice(&agent, &offered, message.model.as_deref(), message.effort.as_deref())?;
        let name = agent.name.clone();
        let (id, handle) = self.acp_spawn(agent, None, Some(cwd)).await?;
        Self::acp_hand_over(&handle, &name, message).await?;
        Ok(id)
    }

    /// Hand a message to the session `id`, starting its own agent if needed:
    /// the one its transcript is kept under, whatever else is configured now.
    pub(super) async fn acp_send(self: &Arc<Self>, id: &str, text: &str, options: &SendOptions) -> Result<Sent, InjectError> {
        let (agent_id, file) = locate(&self.paths, id)
            .await
            .ok_or_else(|| InjectError::message("ACP session not found"))?;
        // Under the gate, as in `acp_start`.
        let _gate = self.spawn_gate.lock().await;
        let agent = crate::acp_agent::agent(&self.paths, &agent_id)
            .ok_or_else(|| InjectError::message(crate::acp_agent::removed(&agent_id)))?;
        check_options(&agent, options)?;
        let message = message(text, options);
        let running = self.acp_handle(id).filter(Handle::alive);
        // Checked before anything starts, against the session's own options
        // when it is running and what the agent last offered otherwise.
        let offered = match &running {
            Some(handle) => handle.options(),
            None => self.acp_options.lock().unwrap().get(&agent.id).cloned().unwrap_or_default(),
        };
        check_choice(&agent, &offered, message.model.as_deref(), message.effort.as_deref())?;
        let name = agent.name.clone();
        let handle = match running {
            Some(handle) => handle,
            None => {
                // Written by this server when the session was created; a header
                // without the agent's id is from before this server minted its
                // own, when the two were the same.
                let header = read_header(&file).await.unwrap_or_default();
                let recorded = Recorded {
                    id: id.to_string(),
                    file,
                    agent_session: header.agent_session_id.unwrap_or_else(|| id.to_string()),
                    cwd: header.cwd,
                };
                self.acp_spawn(agent, Some(recorded), None).await?.1
            }
        };
        Self::acp_hand_over(&handle, &name, message).await
    }

    /// Give a running session's driver its next message.
    async fn acp_hand_over(handle: &Handle, name: &str, message: Message) -> Result<Sent, InjectError> {
        let gone = || InjectError::message(format!("{name} exited before it took the message"));
        let (reply, rx) = oneshot::channel();
        handle.tx.send(Cmd::Deliver(message, reply)).map_err(|_| gone())?;
        rx.await.map_err(|_| gone())
    }

    pub(super) async fn acp_queue_action(&self, id: &str, qid: &str, steer: bool) -> QueueOutcome {
        match self.acp_handle(id).filter(Handle::alive) {
            Some(handle) => handle.queue_action(qid, steer).await,
            None => QueueOutcome::NoResident,
        }
    }

    /// Put an ACP session away: its transcript leaves the list, and the
    /// agent's own record of it is left alone. A session of an agent that was
    /// removed can be put away too.
    ///
    /// Refused while a turn is running or a message is waiting, as the other
    /// archives are: the user is told rather than the work being dropped.
    pub async fn archive_acp(&self, id: &str) -> Result<(), crate::drive::archive::ArchiveError> {
        use crate::drive::archive::ArchiveError;
        let (agent_id, from) = locate(&self.paths, id)
            .await
            .ok_or_else(|| ArchiveError("cannot archive the ACP session: it is gone".to_string()))?;
        let name = crate::acp_agent::agent(&self.paths, &agent_id).map_or(agent_id.clone(), |agent| agent.name);
        let _gate = self.spawn_gate.lock().await;
        if let Some(handle) = self.acp_handle(id).filter(Handle::alive) {
            if !handle.stop().await {
                return Err(ArchiveError(format!(
                    "{name} is running or has queued messages; stop it and clear the queue before archiving"
                )));
            }
        }
        self.acp_servers.lock().unwrap().remove(&self.key_of(Source::Acp, id));
        let archived = from.with_file_name("archived");
        tokio::fs::create_dir_all(&archived)
            .await
            .and(tokio::fs::rename(&from, archived.join(format!("{id}.jsonl"))).await)
            .map_err(|error| ArchiveError(format!("cannot archive the ACP session: {error}")))
    }

    /// Start `agent` for a session and open it: a new one in `cwd`, or the
    /// `recorded` one, reopened where it ran with `session/load`.
    async fn acp_spawn(self: &Arc<Self>, agent: AcpAgent, recorded: Option<Recorded>, cwd: Option<&str>) -> Result<(String, Handle), InjectError> {
        // A session that exists ran somewhere; that is where it is reopened,
        // whatever directory the request names.
        let workdir = claude_workdir(&self.paths, recorded.as_ref().and_then(|recorded| recorded.cwd.as_deref()).or(cwd));
        let mut started = start(&agent, &workdir).await?;
        let reopen = recorded.as_ref().map(|recorded| recorded.agent_session.as_str());
        let opened = match tokio::time::timeout(START_TIMEOUT, started.conn.open(reopen, &workdir)).await {
            Ok(Ok(opened)) => opened,
            failed => {
                let reason = match failed {
                    Ok(Err(error)) => error.to_string(),
                    _ => format!("{} did not open the session in time", agent.name),
                };
                return Err(started.fail(self, &agent, reason).await);
            }
        };
        let (id, file) = match recorded {
            Some(recorded) => (recorded.id, recorded.file),
            None => {
                // A new session's options say what a fresh one starts on — the
                // defaults the composer offers. A reopened one's say what *it*
                // was switched to, which is nobody else's default.
                self.remember_acp_options(&agent.id, &opened.options);
                let dir = agent_dir(&self.paths, &agent.id).ok_or_else(|| InjectError::Internal(format!("unusable agent id {}", agent.id)))?;
                tokio::fs::create_dir_all(&dir)
                    .await
                    .map_err(|error| InjectError::Internal(error.to_string()))?;
                let id = new_uuid();
                let file = dir.join(format!("{id}.jsonl"));
                (id, file)
            }
        };

        let fresh = tokio::fs::metadata(&file).await.map(|metadata| metadata.len() == 0).unwrap_or(true);
        let mut transcript = driver::Transcript::open(&file)
            .await
            .map_err(|error| InjectError::Internal(error.to_string()))?;
        if fresh {
            transcript
                .append(&[record(
                    "session",
                    json!({"id": id, "agent": agent.id, "agentSessionId": opened.id, "cwd": workdir.to_string_lossy()}),
                )])
                .await;
        }
        // The agent's own history, for a transcript this server does not have:
        // the session is one the agent kept and this server lost, or never
        // wrote down.
        if !has_conversation(&file).await {
            let mut translator = Translator::default();
            let mut records: Vec<Value> = opened.replay.iter().flat_map(|update| translator.replayed(update)).collect();
            records.extend(translator.flush());
            transcript.append(&records).await;
        }

        let (tx, rx) = mpsc::unbounded_channel();
        let handle = Handle::new(tx, &agent.id);
        self.acp_servers.lock().unwrap().insert(self.key_of(Source::Acp, &id), handle.clone());
        let Started { process, stderr, client, conn } = started;
        let driver = Driver {
            registry: self.clone(),
            agent,
            id: id.clone(),
            agent_session: opened.id,
            process,
            conn,
            client,
            stderr,
            transcript,
            translator: Translator::default(),
            state: State::with_options(opened.options),
            shared: handle.shared(),
            rx,
            interrupted: false,
            recorded_choice: None,
        };
        tokio::spawn(driver.run());
        Ok((id, handle))
    }
}

/// The working directory as ACP wants it: absolute.
fn absolute(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// What a session's replay is made of, for the caller to translate.
pub(super) type Replay = Vec<crate::acp::SessionUpdate>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_reach_the_agent_as_paths() {
        assert_eq!(prompt_text("hi", &[], &[]), "hi");
        let prompt = prompt_text("look", &["/u/a.png".into()], &["/u/b.txt".into()]);
        assert_eq!(prompt, "look\n\n[2 attached file(s):]\n- /u/a.png\n- /u/b.txt");
    }

    fn agent() -> AcpAgent {
        AcpAgent {
            id: "fake".into(),
            name: "Fake agent".into(),
            command: "/x/fake".into(),
            args: vec![],
            env: vec![],
            last_check: None,
        }
    }

    #[test]
    fn options_an_acp_agent_cannot_honour_are_refused() {
        let agent = &agent();
        assert!(check_options(agent, &SendOptions::default()).is_ok());
        assert!(check_options(
            agent,
            &SendOptions {
                account: AccountChoice::Local,
                ..SendOptions::default()
            }
        )
        .is_ok());
        for refused in [
            SendOptions {
                account: AccountChoice::Account("a".into()),
                ..SendOptions::default()
            },
            SendOptions {
                permission: Some("auto".into()),
                ..SendOptions::default()
            },
            SendOptions {
                chat: true,
                ..SendOptions::default()
            },
        ] {
            let error = check_options(agent, &refused).expect_err("refused");
            assert!(error.to_string().contains("Fake agent"), "the refusal names the agent: {error}");
        }
    }

    #[test]
    fn a_model_or_effort_is_checked_against_what_the_agent_offers() {
        let agent = &agent();
        let offered = crate::acp::config_options(&json!({"configOptions": [
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "a:x",
             "options": [{"value": "a:x", "name": "X"}, {"value": "a:y", "name": "Y"}]},
            {"id": "reasoning_effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": "auto",
             "options": [{"value": "auto", "name": "Auto"}, {"value": "high", "name": "High"}]},
        ]}));
        assert!(check_choice(agent, &offered, Some("a:y"), Some("high")).is_ok());
        assert!(check_choice(agent, &offered, None, None).is_ok());
        assert!(check_choice(agent, &offered, Some("a:z"), None).is_err());
        assert!(check_choice(agent, &offered, None, Some("ultra")).is_err());
        assert!(
            check_choice(agent, &[], Some("anything"), Some("goes")).is_ok(),
            "unknown yet: the agent answers"
        );
        let model_only = &offered[..1];
        let refused = check_choice(agent, model_only, None, Some("high")).expect_err("no effort to choose");
        assert!(refused.to_string().contains("offers no effort"), "{refused}");
    }

    /// A stand-in that never answers and is deaf to its input: it writes down
    /// where it runs and the pid of a helper it forks into `record`, then
    /// sleeps.
    fn deaf_agent(record: &Path) -> AcpAgent {
        use std::os::unix::fs::PermissionsExt;
        let program = record.join("deaf-agent");
        std::fs::write(
            &program,
            "#!/bin/sh\npwd > \"$RECORD/cwd\"\nsleep 300 &\necho $! > \"$RECORD/helper\"\nexec sleep 300\n",
        )
        .expect("agent");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        AcpAgent {
            command: program.to_string_lossy().into_owned(),
            env: vec![crate::accounts::store::EnvVar {
                key: "RECORD".into(),
                value: record.to_string_lossy().into_owned(),
            }],
            ..agent()
        }
    }

    /// Where the stand-in ran, and its helper's pid.
    fn recorded(record: &Path) -> (PathBuf, u32) {
        let read = |name: &str| std::fs::read_to_string(record.join(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
        (PathBuf::from(read("cwd").trim()), read("helper").trim().parse().expect("a pid"))
    }

    /// Wait for `pid` to be gone: killed, and reaped by whoever it was left to.
    async fn gone(pid: u32) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while crate::procs::alive(pid) {
            assert!(std::time::Instant::now() < deadline, "the helper {pid} is still running");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn a_check_that_gets_no_answer_leaves_nothing_running_and_no_scratch_directory() {
        let home = tempfile::tempdir().expect("tempdir");
        let state = crate::api::test_support::state(home.path()).await;
        let record = tempfile::tempdir().expect("tempdir");
        let agent = deaf_agent(record.path());
        let check = state.drive.injections.check_acp_agent_within(&agent, Duration::from_secs(2)).await;
        assert_eq!(check.state, AcpCheckState::Failed);
        assert!(
            check.error.0.as_deref().is_some_and(|error| error.contains("did not answer initialize")),
            "{check:?}"
        );
        let (scratch, helper) = recorded(record.path());
        assert!(
            scratch.file_name().is_some_and(|name| name.to_string_lossy().starts_with("droppen-acp-check-")),
            "{}",
            scratch.display()
        );
        assert!(!scratch.exists(), "{} is left behind", scratch.display());
        gone(helper).await;
    }

    #[tokio::test]
    async fn a_check_whose_request_is_cancelled_leaves_nothing_running_and_no_scratch_directory() {
        let home = tempfile::tempdir().expect("tempdir");
        let state = crate::api::test_support::state(home.path()).await;
        let record = tempfile::tempdir().expect("tempdir");
        let agent = deaf_agent(record.path());
        let cancelled = tokio::time::timeout(Duration::from_secs(2), state.drive.injections.check_acp_agent(&agent)).await;
        assert!(cancelled.is_err(), "still waiting for initialize when dropped");
        let (scratch, helper) = recorded(record.path());
        assert!(!scratch.exists(), "{} is left behind", scratch.display());
        gone(helper).await;
    }
}
