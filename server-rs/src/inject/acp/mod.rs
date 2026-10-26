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
//! * `session/cancel` to stop a turn.
//!
//! What the agent says is written down as it arrives, in the transcript
//! [`crate::sessions::acp_transcript`] keeps; that file is what the session
//! view reads.
//!
//! Everything here is the same for every ACP agent. What differs — how the
//! agent is started, what it is called, what to tell a user who has not
//! installed it — is an [`AcpAgent`], and adding an agent is adding one of
//! those (plus its [`Source`] and its icon).
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
use crate::sessions::acp_transcript::{has_conversation, record, transcript_path, Translator};
use client::Client;
use conn::Conn;
pub(super) use driver::Handle;
use driver::{Cmd, Driver, Message, State, StderrTail};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

/// How long an agent may take to start and open a session.
///
/// Generous: `initialize` may import a whole framework and its plugins (Bub
/// is Python), and `session/load` reads and replays the whole history.
const START_TIMEOUT: Duration = Duration::from_secs(120);

/// One agent this server drives over ACP.
pub struct AcpAgent {
    /// The session source its sessions are listed under.
    pub source: Source,
    /// What the user calls it, in every message about it.
    pub name: &'static str,
    /// What to do when it cannot be started, said after the reason.
    pub install_hint: &'static str,
    /// How to start it on this machine, read at each start so a settings
    /// change applies to the next process.
    pub launch: fn(&Paths) -> Launch,
}

/// The command line and environment an agent is started with.
#[derive(Debug, Clone)]
pub struct Launch {
    /// The executable, absolute or looked up on the `PATH` in `env`.
    pub program: PathBuf,
    /// Its arguments: whatever puts it into ACP mode over stdio.
    pub args: Vec<String>,
    /// Its whole environment; nothing is inherited past this.
    pub env: Env,
}

/// The ACP agent behind a session source, if it is one.
pub fn agent(source: Source) -> Option<&'static AcpAgent> {
    match source {
        Source::Bub => Some(&crate::bub::AGENT),
        Source::Claude | Source::Codex => None,
    }
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
    Message {
        id: options.message_id.clone().unwrap_or_else(new_uuid),
        text: text.to_string(),
        prompt: prompt_text(text, &options.images, &options.files),
        images: options.images.clone(),
        files: options.files.clone(),
    }
}

/// Refuse what an ACP session cannot do differently per message.
///
/// An ACP agent's model and reasoning effort come from its own configuration,
/// and it has no accounts here and no permission modes; a request that names
/// any of them is refused rather than quietly run on something else.
fn check_options(agent: &AcpAgent, options: &SendOptions) -> Result<(), InjectError> {
    let name = agent.name;
    if options.account.named().is_some() || matches!(options.account, AccountChoice::Rule(_)) {
        return Err(InjectError::message(format!(
            "{name} sessions run on {name}'s own configuration; there is no account to choose"
        )));
    }
    let named = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.trim().is_empty());
    if named(&options.model) || named(&options.effort) {
        return Err(InjectError::message(format!(
            "{name} takes its model and reasoning effort from its own configuration"
        )));
    }
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

impl InjectionRegistry {
    pub(super) fn acp_handle(&self, source: Source, id: &str) -> Option<Handle> {
        self.acp_servers.lock().unwrap().get(&self.key_of(source, id)).cloned()
    }

    /// Hand a message to an ACP session, starting its agent if needed.
    ///
    /// `id` is `None` for a new session; the id the agent gives it is returned.
    pub(super) async fn acp_deliver(
        self: &Arc<Self>,
        agent: &'static AcpAgent,
        id: Option<&str>,
        cwd: Option<&str>,
        text: &str,
        options: &SendOptions,
    ) -> Result<(String, Sent), InjectError> {
        check_options(agent, options)?;
        let message = message(text, options);
        let _gate = self.spawn_gate.lock().await;
        let running = id.and_then(|id| {
            self.acp_handle(agent.source, id)
                .filter(Handle::alive)
                .map(|handle| (id.to_string(), handle))
        });
        let (id, handle) = match running {
            Some(running) => running,
            None => self.acp_spawn(agent, id, cwd).await?,
        };
        let gone = || InjectError::message(format!("{} exited before it took the message", agent.name));
        let (reply, rx) = oneshot::channel();
        handle.tx.send(Cmd::Deliver(message, reply)).map_err(|_| gone())?;
        let sent = rx.await.map_err(|_| gone())?;
        Ok((id, sent))
    }

    pub(super) async fn acp_queue_action(&self, source: Source, id: &str, qid: &str, steer: bool) -> QueueOutcome {
        match self.acp_handle(source, id).filter(Handle::alive) {
            Some(handle) => handle.queue_action(qid, steer).await,
            None => QueueOutcome::NoResident,
        }
    }

    /// Put an ACP session away: its transcript leaves the list, and the
    /// agent's own record of it is left alone.
    ///
    /// Refused while a turn is running or a message is waiting, as the other
    /// archives are: the user is told rather than the work being dropped.
    pub async fn archive_acp(&self, source: Source, id: &str) -> Result<(), crate::drive::archive::ArchiveError> {
        use crate::drive::archive::ArchiveError;
        let name = agent(source).map_or("the agent", |agent| agent.name);
        let _gate = self.spawn_gate.lock().await;
        if let Some(handle) = self.acp_handle(source, id).filter(Handle::alive) {
            if !handle.stop().await {
                return Err(ArchiveError(format!(
                    "{name} is running or has queued messages; stop it and clear the queue before archiving"
                )));
            }
        }
        self.acp_servers.lock().unwrap().remove(&self.key_of(source, id));
        let from = transcript_path(&self.paths, source, id);
        let archived = self.paths.acp_sessions(source).join("archived");
        tokio::fs::create_dir_all(&archived)
            .await
            .and(tokio::fs::rename(&from, archived.join(format!("{id}.jsonl"))).await)
            .map_err(|error| ArchiveError(format!("cannot archive the {name} session: {error}")))
    }

    async fn acp_spawn(self: &Arc<Self>, agent: &'static AcpAgent, id: Option<&str>, cwd: Option<&str>) -> Result<(String, Handle), InjectError> {
        let name = agent.name;
        // A session that exists ran somewhere; that is where it is reopened,
        // whatever directory the request names.
        let recorded = match id {
            Some(id) => Some(
                crate::sessions::acp_transcript::find_session(&self.paths, agent.source, id)
                    .await
                    .ok_or_else(|| InjectError::message(format!("{name} session not found")))?
                    .cwd
                    .0,
            ),
            None => None,
        };
        let workdir = claude_workdir(&self.paths, recorded.flatten().as_deref().or(cwd));
        let launch = (agent.launch)(&self.paths);
        let mut child = tokio::process::Command::new(&launch.program)
            .args(&launch.args)
            .current_dir(&workdir)
            .env_clear()
            .envs(&launch.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                InjectError::message(format!(
                    "cannot start {name} ({}): {error}. {}",
                    launch.program.display(),
                    agent.install_hint
                ))
            })?;
        let stderr = StderrTail::follow(child.stderr.take().expect("piped stderr"));
        let client = Client::new(workdir.clone(), launch.env.clone());
        let started = Conn::start(
            child.stdin.take().expect("piped stdin"),
            child.stdout.take().expect("piped stdout"),
            client.clone(),
        );

        let opened = tokio::time::timeout(START_TIMEOUT, async {
            let mut conn = started.await?;
            let opened = conn.open(id, &workdir).await?;
            Ok::<_, InjectError>((conn, opened))
        })
        .await;
        let (conn, (id, replayed)) = match opened {
            Ok(Ok(opened)) => opened,
            failed => {
                let reason = match failed {
                    Ok(Err(error)) => error.to_string(),
                    _ => format!("{name} did not open the session in time"),
                };
                client.kill_all();
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                let tail = stderr.text();
                let said = if tail.is_empty() { reason } else { format!("{reason}\n{tail}") };
                return Err(InjectError::message(self.redact(&format!("cannot start {name}: {said}"))));
            }
        };

        let file = transcript_path(&self.paths, agent.source, &id);
        tokio::fs::create_dir_all(self.paths.acp_sessions(agent.source))
            .await
            .map_err(|error| InjectError::Internal(error.to_string()))?;
        let fresh = tokio::fs::metadata(&file).await.map(|metadata| metadata.len() == 0).unwrap_or(true);
        let mut transcript = driver::Transcript::open(&file)
            .await
            .map_err(|error| InjectError::Internal(error.to_string()))?;
        if fresh {
            transcript
                .append(&[record("session", json!({"id": id, "cwd": workdir.to_string_lossy()}))])
                .await;
        }
        // The agent's own history, for a transcript this server does not have:
        // the session is one the agent kept and this server lost, or never
        // wrote down.
        if !has_conversation(&file).await {
            let mut translator = Translator::default();
            let mut records: Vec<Value> = replayed.iter().flat_map(|update| translator.replayed(update)).collect();
            records.extend(translator.flush());
            transcript.append(&records).await;
        }

        let (tx, rx) = mpsc::unbounded_channel();
        let handle = Handle::new(tx);
        self.acp_servers.lock().unwrap().insert(self.key_of(agent.source, &id), handle.clone());
        let driver = Driver {
            registry: self.clone(),
            agent,
            id: id.clone(),
            child,
            conn,
            client,
            stderr,
            transcript,
            translator: Translator::default(),
            state: State::default(),
            shared: handle.shared(),
            rx,
            interrupted: false,
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

    #[test]
    fn options_an_acp_agent_cannot_honour_are_refused() {
        let agent = &crate::bub::AGENT;
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
                model: Some("gpt-5".into()),
                ..SendOptions::default()
            },
            SendOptions {
                chat: true,
                ..SendOptions::default()
            },
        ] {
            let error = check_options(agent, &refused).expect_err("refused");
            assert!(error.to_string().contains("Bub"), "the refusal names the agent: {error}");
        }
    }

    #[test]
    fn only_the_acp_sources_have_an_agent() {
        assert_eq!(agent(Source::Bub).map(|agent| agent.source), Some(Source::Bub));
        assert!(agent(Source::Claude).is_none());
        assert!(agent(Source::Codex).is_none());
    }
}
