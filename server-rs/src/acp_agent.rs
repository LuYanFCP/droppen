//! The ACP agents this machine runs sessions on: a registry keyed by id.
//!
//! Any program that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
//! over stdio can run Droppen sessions ([`crate::inject::acp`]). An agent is a
//! description — an id, the name it goes by, the command line that starts it in
//! ACP mode — plus the environment the user gives it. What it can do is not part
//! of the description: that is what it answers to `initialize` and publishes as
//! its sessions' configuration options.
//!
//! * **Built-in** descriptions are `acp-agents.json`, embedded in the build:
//!   the agents Droppen knows how to start ([`presets`]). They are offered when
//!   an agent is added and never run on their own. An agent is often installed
//!   into an environment of its own that the server's `PATH` knows nothing
//!   about, and its model settings often come from variables a shell profile or
//!   a project `.env` sets, so only the user can say how it runs here.
//! * **Configured** agents are rows in the machine-wide state database under
//!   [`scope::ACP_AGENTS`], one per id, holding `name`, `command`, `args` and
//!   `env` as JSON. One with a built-in's id is that agent as the user set it
//!   up (a name left empty is the built-in's); any other id is the user's own.
//!   These are the agents sessions run on ([`agents`], [`agent`]).
//!
//! The id is a short slug ([`valid_id`]): it names the directory an agent's
//! transcripts are kept in ([`crate::sessions::acp_transcript`]) and is
//! recorded on every session, so a session is reopened by the agent it ran on
//! and no other. Removing an agent leaves its sessions alone: they stay listed
//! and readable, and cannot be continued until an agent with that id is
//! configured again.
//!
//! `env` is read through [`parse_env_block`], so an agent's block refuses what
//! an account's block refuses: `PATH`, the loader variables, and everything
//! else that would move where a child's state lives. The values are what an
//! API key looks like, so they are handled the way [`crate::chats::provider`]
//! handles its key: a client is told the names, never the values, and a write
//! replaces the whole block or leaves it alone.

use std::path::PathBuf;
use std::sync::LazyLock;

use gotcha::{api, Json, Schematic, State};
use serde::{Deserialize, Serialize};

use crate::accounts::store::{parse_env_block, EnvVar};
use crate::api::error::ApiError;
use crate::api::extract::{ApiJson, ApiPath};
use crate::api::{ApiRouter, AppState, SendResult};
use crate::db::scope;
use crate::openapi_ext::{ExtraResponses, Optional};
use crate::process_env::Env;
use crate::sessions::{Paths, SessionSummary, Source};

/// The longest agent id.
const MAX_ID: usize = 64;
/// The longest name a person needs.
const MAX_NAME: usize = 64;
/// The longest executable path a person can mean.
const MAX_COMMAND: usize = 4096;
/// The most arguments, and the longest one.
const MAX_ARGS: usize = 64;
const MAX_ARG: usize = 4096;
/// The most agents one machine configures.
const MAX_AGENTS: usize = 64;

/// Whether `id` can name an agent: ASCII lowercase letters, digits and `-`,
/// starting with a letter or digit. It is a directory name and a key, so
/// nothing else is let near either.
pub fn valid_id(id: &str) -> bool {
    id.len() <= MAX_ID
        && id.bytes().next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// One built-in agent description: how a known agent is started in ACP mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentPreset {
    /// Its id, which a configured agent made from it keeps.
    pub id: String,
    /// What the agent is called.
    pub name: String,
    /// The executable, as found on the `PATH`.
    pub command: String,
    /// The arguments that put it into ACP mode over stdio.
    pub args: Vec<String>,
    /// Where its ACP setup is documented.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub homepage: Optional<String>,
    /// What it needs before it can run.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub note: Optional<String>,
}

static PRESETS: LazyLock<Vec<AcpAgentPreset>> =
    LazyLock::new(|| serde_json::from_str(include_str!("acp-agents.json")).expect("acp-agents.json is a list of agent descriptions"));

/// Every built-in description, in the order they are offered.
pub fn presets() -> &'static [AcpAgentPreset] {
    &PRESETS
}

fn preset(id: &str) -> Option<&'static AcpAgentPreset> {
    presets().iter().find(|preset| preset.id == id)
}

/// One configured agent, values included. Never serialized to a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpAgent {
    /// Its id ([`valid_id`]).
    pub id: String,
    /// What the user calls it, in every message about it.
    pub name: String,
    /// The executable, absolute or looked up on the `PATH` in its environment.
    pub command: String,
    /// Its arguments: whatever puts it into ACP mode over stdio.
    pub args: Vec<String>,
    /// Extra environment, in the order it was typed.
    pub env: Vec<EnvVar>,
}

impl AcpAgent {
    /// The executable to run.
    pub fn program(&self) -> PathBuf {
        PathBuf::from(self.command.trim())
    }

    /// `base` with the configured variables laid over it.
    pub fn environment(&self, mut base: Env) -> Env {
        for var in &self.env {
            base.insert(var.key.clone(), var.value.clone());
        }
        base
    }

    /// What a client may learn.
    pub fn info(&self) -> AcpAgentInfo {
        let preset = preset(&self.id);
        AcpAgentInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env_names: self.env.iter().map(|var| var.key.clone()).collect(),
            homepage: preset.and_then(|preset| preset.homepage.0.clone()).into(),
            note: preset.and_then(|preset| preset.note.0.clone()).into(),
        }
    }
}

/// A row of [`scope::ACP_AGENTS`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    name: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvVar>,
}

impl Stored {
    /// What a new agent with this id starts from: its built-in's description, if
    /// it has one.
    fn fresh(id: &str) -> Self {
        preset(id).map_or_else(Stored::default, |preset| Stored {
            name: preset.name.clone(),
            command: preset.command.clone(),
            args: preset.args.clone(),
            env: Vec::new(),
        })
    }

    fn agent(self, id: &str) -> AcpAgent {
        let name = match self.name.trim() {
            "" => preset(id).map_or_else(|| id.to_string(), |preset| preset.name.clone()),
            name => name.to_string(),
        };
        AcpAgent {
            id: id.to_string(),
            name,
            command: self.command,
            args: self.args,
            env: self.env,
        }
    }
}

/// A stored row, or `None` for one this build cannot read or that names no
/// executable: an agent that cannot be started is no agent.
fn parse(id: &str, raw: &str) -> Option<AcpAgent> {
    let stored: Stored = serde_json::from_str(raw).ok()?;
    (!stored.command.trim().is_empty()).then(|| stored.agent(id))
}

/// Every configured agent, in id order.
pub fn agents(paths: &Paths) -> Vec<AcpAgent> {
    crate::db::at(paths.config_db())
        .kv_scope(scope::ACP_AGENTS)
        .into_iter()
        .filter(|(id, _)| valid_id(id))
        .filter_map(|(id, raw)| parse(&id, &raw))
        .collect()
}

/// The configured agent `id`, or `None` when there is none.
pub fn agent(paths: &Paths, id: &str) -> Option<AcpAgent> {
    if !valid_id(id) {
        return None;
    }
    let raw = crate::db::at(paths.config_db()).kv_get(scope::ACP_AGENTS, id)?;
    parse(id, &raw)
}

/// What a message to a session of the removed agent `id` is told.
pub fn removed(id: &str) -> String {
    format!("the ACP agent \"{id}\" is no longer configured; add it again in Settings to continue this session")
}

/// Why no message can go to this session, when the reason is its agent: an ACP
/// session whose agent is no longer configured. `None` for every other
/// session.
///
/// The session itself stays as it was — listed, readable, archivable — and an
/// agent configured again under the same id picks it up where it stopped.
pub fn send_block(paths: &Paths, summary: &SessionSummary) -> Option<String> {
    if summary.source != Source::Acp {
        return None;
    }
    match summary.acp_agent.as_deref() {
        Some(id) if agent(paths, id).is_some() => None,
        Some(id) => Some(removed(id)),
        None => Some("this ACP session does not say which agent it ran on".into()),
    }
}

/// One write at a time: an update reads the row it replaces.
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Apply a patch to the agent `id`, adding it when there is none, and persist
/// it; or say why it was refused. A new agent with a built-in's id starts from
/// that description.
pub fn update(paths: &Paths, id: &str, patch: &AcpAgentUpdate) -> Result<AcpAgent, String> {
    if !valid_id(id) {
        return Err(format!(
            "an agent id is at most {MAX_ID} lowercase letters, digits and dashes, starting with a letter or digit"
        ));
    }
    let _writing = WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let db = crate::db::at(paths.config_db());
    let rows = db.kv_scope(scope::ACP_AGENTS);
    let mut next = match rows.get(id).and_then(|raw| serde_json::from_str::<Stored>(raw).ok()) {
        Some(stored) => stored,
        None if rows.len() >= MAX_AGENTS => return Err(format!("at most {MAX_AGENTS} ACP agents can be configured")),
        None => Stored::fresh(id),
    };
    if let Some(name) = patch.name.as_deref() {
        let name = name.trim();
        if name.len() > MAX_NAME || name.chars().any(char::is_control) {
            return Err(format!("the agent's name must be a single line of at most {MAX_NAME} bytes"));
        }
        next.name = name.to_string();
    }
    if let Some(command) = patch.command.as_deref() {
        let command = command.trim();
        if command.len() > MAX_COMMAND || command.contains(['\n', '\r', '\0']) {
            return Err("the agent's executable must be a single path or command name".into());
        }
        next.command = command.to_string();
    }
    if let Some(args) = patch.args.0.as_deref() {
        if args.len() > MAX_ARGS || args.iter().any(|arg| arg.len() > MAX_ARG || arg.contains(['\n', '\r', '\0'])) {
            return Err(format!("the agent's arguments must be at most {MAX_ARGS} single-line words"));
        }
        next.args = args.to_vec();
    }
    if let Some(block) = patch.env.as_deref() {
        next.env = parse_block(block)?;
    }
    if next.command.is_empty() {
        return Err("an agent needs an executable".into());
    }
    let raw = serde_json::to_string(&next).map_err(|error| error.to_string())?;
    db.kv_set(scope::ACP_AGENTS, id, &raw);
    Ok(next.agent(id))
}

/// Forget the agent `id`; `false` when there was none. Its sessions stay.
pub fn remove(paths: &Paths, id: &str) -> bool {
    if !valid_id(id) {
        return false;
    }
    let _writing = WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let db = crate::db::at(paths.config_db());
    if db.kv_get(scope::ACP_AGENTS, id).is_none() {
        return false;
    }
    db.kv_remove(scope::ACP_AGENTS, id);
    true
}

/// [`parse_env_block`], except that a block with nothing in it clears the
/// variables rather than being refused: an account needs a credential, an
/// agent may not.
fn parse_block(block: &str) -> Result<Vec<EnvVar>, String> {
    let empty = block
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .all(|line| line.is_empty() || line.starts_with('#'));
    if empty {
        return Ok(Vec::new());
    }
    parse_env_block(block).map_err(|error| error.to_string())
}

/// One configured agent, as a client sees it: the variables' names, not their
/// values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentInfo {
    /// Its id: what sessions record, and what `presets/icons/<id>.svg` draws.
    pub id: String,
    /// What the user calls it.
    pub name: String,
    /// The configured executable.
    pub command: String,
    /// Its arguments, in order.
    pub args: Vec<String>,
    /// The names of the extra environment variables, in order.
    pub env_names: Vec<String>,
    /// Where its ACP setup is documented, for a built-in agent.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub homepage: Optional<String>,
    /// What a built-in agent needs before it can run.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub note: Optional<String>,
}

/// `GET /api/acp/agents`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Schematic)]
pub struct AcpAgentList {
    /// The agents sessions can run on, in id order.
    pub agents: Vec<AcpAgentInfo>,
    /// The built-in descriptions, to offer when an agent is added.
    pub presets: Vec<AcpAgentPreset>,
}

/// The body of `PUT /api/acp/agents/{id}`; every field is a patch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentUpdate {
    /// The name; `""` goes back to the built-in's or the id, absent leaves it alone.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub name: Optional<String>,
    /// The executable; required unless the agent exists or is a built-in.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub command: Optional<String>,
    /// The arguments; absent leaves them alone.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub args: Optional<Vec<String>>,
    /// A `KEY=VALUE`-per-line block that replaces every stored variable; `""`
    /// clears them, absent leaves them alone.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub env: Optional<String>,
}

/// The ACP agents configured on this machine, and the built-in descriptions.
#[api(id = "acp_agents", group = "acp", summary = "ACP agents")]
pub async fn acp_agents(State(state): State<AppState>) -> Json<AcpAgentList> {
    Json(AcpAgentList {
        agents: agents(&state.paths).iter().map(AcpAgent::info).collect(),
        presets: presets().to_vec(),
    })
}

/// Add an ACP agent or change how it is started. Applies to the next agent
/// process; one already running keeps what it was started with.
#[api(id = "put_acp_agent", group = "acp", summary = "Add or update an ACP agent")]
pub async fn put_acp_agent(
    State(state): State<AppState>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<AcpAgentUpdate>,
) -> Result<Json<AcpAgentInfo>, ApiError> {
    let agent = update(&state.paths, &id, &body).map_err(ApiError::bad_request)?;
    // Another executable or environment may offer other models.
    state.drive.injections.forget_acp_options(&id);
    Ok(Json(agent.info()))
}

/// Remove an ACP agent. Its sessions stay listed and readable; they cannot be
/// continued until an agent with this id is configured again.
#[api(id = "delete_acp_agent", group = "acp", summary = "Remove an ACP agent")]
pub async fn delete_acp_agent(State(state): State<AppState>, ApiPath(id): ApiPath<String>) -> Result<Json<SendResult>, ApiError> {
    if !remove(&state.paths, &id) {
        return Err(ApiError::not_found("no such ACP agent"));
    }
    state.drive.injections.forget_acp_options(&id);
    Ok(Json(SendResult { accepted: true }))
}

/// Register this module's routes.
pub fn routes(router: ApiRouter) -> ApiRouter {
    router
        .get("/api/acp/agents", acp_agents)
        .put("/api/acp/agents/{id}", put_acp_agent)
        .delete("/api/acp/agents/{id}", delete_acp_agent)
}

/// Everything gotcha cannot express about those routes.
pub fn describe(reg: &mut ExtraResponses) {
    reg.describe(
        "GET",
        "/api/acp/agents",
        200,
        "The configured ACP agents, with the names of their extra variables, and the built-in descriptions",
    )
    .describe("PUT", "/api/acp/agents/{id}", 200, "The agent as now configured")
    .error(
        "PUT",
        "/api/acp/agents/{id}",
        400,
        "An unusable id, name, executable, argument or environment block",
    )
    .describe("DELETE", "/api/acp/agents/{id}", 200, "The agent is gone; its sessions stay")
    .error("DELETE", "/api/acp/agents/{id}", 404, "No such ACP agent");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let home = tempfile::tempdir().expect("tempdir");
        let paths = Paths::new(home.path().to_path_buf());
        (home, paths)
    }

    fn patch(command: Option<&str>, args: Option<&[&str]>, env: Option<&str>) -> AcpAgentUpdate {
        AcpAgentUpdate {
            name: None.into(),
            command: command.map(str::to_owned).into(),
            args: args.map(|args| args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>()).into(),
            env: env.map(str::to_owned).into(),
        }
    }

    #[test]
    fn the_built_in_descriptions_are_usable() {
        assert!(!presets().is_empty());
        let mut ids: Vec<&str> = presets().iter().map(|preset| preset.id.as_str()).collect();
        for preset in presets() {
            assert!(valid_id(&preset.id), "{}", preset.id);
            assert!(!preset.name.is_empty() && !preset.command.is_empty(), "{preset:?}");
        }
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), presets().len(), "ids are unique");
    }

    #[test]
    fn an_id_is_a_slug() {
        for good in ["bub", "open-code", "a1", "9", &"x".repeat(MAX_ID)] {
            assert!(valid_id(good), "{good}");
        }
        for bad in ["", "-x", "Bub", "a_b", "a.b", "../x", "a/b", "é", &"x".repeat(MAX_ID + 1)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn nothing_stored_is_no_agent() {
        let (_home, paths) = paths();
        assert!(agents(&paths).is_empty());
        assert!(agent(&paths, "bub").is_none(), "a built-in is offered, not run");
    }

    #[test]
    fn values_are_kept_and_never_reported() {
        let (_home, paths) = paths();
        update(
            &paths,
            "mine",
            &AcpAgentUpdate {
                name: Some(" My agent ".to_string()).into(),
                ..patch(
                    Some(" /opt/agent/bin/agent "),
                    Some(&["acp", "--stdio"]),
                    Some("AGENT_MODEL=openai:gpt-5\nexport AGENT_API_KEY=\"sk-secret\""),
                )
            },
        )
        .expect("saved");
        let stored = agent(&paths, "mine").expect("configured");
        assert_eq!(stored.name, "My agent");
        assert_eq!(stored.program(), PathBuf::from("/opt/agent/bin/agent"));
        assert_eq!(stored.args, vec!["acp", "--stdio"]);
        let info = serde_json::to_string(&stored.info()).unwrap();
        assert!(info.contains("AGENT_API_KEY"), "{info}");
        assert!(!info.contains("sk-secret"), "a value never reaches a client: {info}");
        let env = stored.environment(Env::from([("HOME".to_string(), "/h".to_string())]));
        assert_eq!(env.get("AGENT_API_KEY").map(String::as_str), Some("sk-secret"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/h"));
    }

    #[test]
    fn two_agents_are_kept_apart() {
        let (_home, paths) = paths();
        update(&paths, "one", &patch(Some("/x/one"), Some(&["acp"]), Some("A=1"))).expect("saved");
        update(&paths, "two", &patch(Some("/x/two"), None, Some("B=2"))).expect("saved");
        let listed: Vec<(String, String)> = agents(&paths).into_iter().map(|agent| (agent.id, agent.command)).collect();
        assert_eq!(listed, vec![("one".into(), "/x/one".into()), ("two".into(), "/x/two".into())]);
        assert_eq!(agent(&paths, "one").unwrap().info().env_names, vec!["A"]);
        assert_eq!(agent(&paths, "two").unwrap().info().env_names, vec!["B"]);
        assert_eq!(agent(&paths, "two").unwrap().name, "two", "a name left empty is the id");
        assert!(remove(&paths, "one"));
        assert!(!remove(&paths, "one"), "gone already");
        assert!(agent(&paths, "one").is_none());
        assert!(agent(&paths, "two").is_some(), "the other stays");
    }

    #[test]
    fn a_built_in_is_added_from_its_description() {
        let (_home, paths) = paths();
        let bub = presets().iter().find(|preset| preset.id == "bub").expect("bub is built in");
        let added = update(&paths, "bub", &patch(None, None, Some("BUB_MODEL=x"))).expect("saved");
        assert_eq!((added.name.as_str(), added.command.as_str()), (bub.name.as_str(), bub.command.as_str()));
        assert_eq!(added.args, bub.args);
        assert_eq!(added.info().homepage, bub.homepage);
        // Its own name and command line, once changed, are the user's.
        update(&paths, "bub", &patch(Some("/home/me/.venv/bin/bub"), None, None)).expect("saved");
        assert_eq!(agent(&paths, "bub").unwrap().command, "/home/me/.venv/bin/bub");
        assert_eq!(agent(&paths, "bub").unwrap().info().env_names, vec!["BUB_MODEL"]);
    }

    #[test]
    fn an_absent_field_is_left_alone_and_an_empty_one_clears() {
        let (_home, paths) = paths();
        update(&paths, "x", &patch(Some("/x/agent"), Some(&["acp"]), Some("A=1"))).expect("saved");
        update(&paths, "x", &patch(None, None, None)).expect("saved");
        let stored = agent(&paths, "x").unwrap();
        assert_eq!((stored.command.as_str(), stored.args.clone(), stored.info().env_names), ("/x/agent", vec!["acp".to_string()], vec!["A".to_string()]));
        update(&paths, "x", &patch(None, Some(&[]), Some("  \n# nothing\n"))).expect("saved");
        let stored = agent(&paths, "x").unwrap();
        assert!(stored.args.is_empty() && stored.env.is_empty());
    }

    #[test]
    fn what_cannot_run_or_would_move_the_child_is_refused() {
        let (_home, paths) = paths();
        assert!(update(&paths, "x", &patch(None, None, None)).is_err(), "a new agent needs an executable");
        assert!(update(&paths, "x", &patch(Some(" "), None, None)).is_err());
        assert!(update(&paths, "../x", &patch(Some("/x"), None, None)).is_err());
        assert!(update(&paths, "X", &patch(Some("/x"), None, None)).is_err());
        assert!(update(&paths, "x", &patch(Some("/x"), None, Some("PATH=/tmp"))).is_err());
        assert!(update(&paths, "x", &patch(Some("/x"), None, Some("not a pair"))).is_err());
        assert!(update(&paths, "x", &patch(Some("agent\nrm -rf /"), None, None)).is_err());
        assert!(update(&paths, "x", &patch(Some("/x"), Some(&["a\nb"]), None)).is_err());
        assert!(agents(&paths).is_empty(), "a refusal stores nothing");
        update(&paths, "x", &patch(Some("/x"), None, None)).expect("saved");
        assert!(update(&paths, "x", &patch(Some(""), None, None)).is_err(), "removing is a delete, not an empty executable");
        assert_eq!(agent(&paths, "x").unwrap().command, "/x");
    }
}
