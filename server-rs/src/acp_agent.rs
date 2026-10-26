//! How this machine starts its ACP agent: the name it goes by, the command
//! line, and the environment it runs in.
//!
//! Any program that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
//! over stdio can run Droppen sessions ([`crate::inject::acp`] and [`AGENT`]).
//! Nothing about a particular agent is built in: the user says which program
//! it is, because there is no answer this server could find on its own. An
//! agent is often installed into an environment of its own that the server's
//! `PATH` knows nothing about, and its model settings often come from
//! variables a shell profile or a project `.env` sets.
//!
//! Rows in the machine-wide state database under [`scope::ACP_AGENT`]:
//!
//! * `name` — what the user calls the agent, in the session picker. Empty is
//!   the generic "ACP agent".
//! * `command` — the executable, absolute or looked up on the `PATH`. Empty
//!   means no agent is configured, and nothing is started.
//! * `args` — its arguments, as a JSON array: whatever puts it into ACP mode
//!   over stdio.
//! * `env` — extra `KEY=VALUE` pairs, as JSON. Read through
//!   [`parse_env_block`], so the agent's block refuses what an account's block
//!   refuses: `PATH`, the loader variables, and everything else that would move
//!   where a child's state lives.
//!
//! The values are what an API key looks like, so they are handled the way
//! [`crate::chats::provider`] handles its key: a client is told the names, never
//! the values, and a write replaces the whole block or leaves it alone.

use std::path::PathBuf;

use gotcha::{api, Json, Schematic, State};
use serde::{Deserialize, Serialize};

use crate::accounts::store::{parse_env_block, EnvVar};
use crate::api::error::ApiError;
use crate::api::extract::ApiJson;
use crate::api::{ApiRouter, AppState};
use crate::db::scope;
use crate::inject::acp::{AcpAgent, Launch};
use crate::openapi_ext::{ExtraResponses, Optional};
use crate::process_env::{clean_env_bare, Env};
use crate::sessions::{Paths, Source};

/// The configured agent, as the ACP driver knows it: the configured command
/// line, over stdio, with the configured variables laid over the server's
/// clean environment.
pub static AGENT: AcpAgent = AcpAgent {
    source: Source::Acp,
    name: "the ACP agent",
    install_hint: "Set its executable and arguments in Settings",
    launch,
};

fn launch(paths: &Paths) -> Launch {
    let stored = read(paths);
    Launch {
        program: stored.program(),
        args: stored.args.clone(),
        env: stored.environment(clean_env_bare()),
    }
}

/// The stored configuration, values included. Never serialized to a client.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredAcpAgent {
    /// What the user calls it; empty for the generic name.
    pub name: String,
    /// The executable as typed; empty when no agent is configured.
    pub command: String,
    /// Its arguments, in order.
    pub args: Vec<String>,
    /// Extra environment, in the order it was typed.
    pub env: Vec<EnvVar>,
}

impl StoredAcpAgent {
    /// The executable to run; empty when none is configured.
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
    pub fn info(&self) -> AcpAgentSettings {
        AcpAgentSettings {
            name: self.name.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env_names: self.env.iter().map(|var| var.key.clone()).collect(),
        }
    }
}

/// How the ACP agent is started, as a client sees it: the variables' names,
/// not their values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentSettings {
    /// What the user calls the agent, or `""` for the generic name.
    pub name: String,
    /// The configured executable, or `""` when no agent is configured.
    pub command: String,
    /// Its arguments, in order.
    pub args: Vec<String>,
    /// The names of the extra environment variables, in order.
    pub env_names: Vec<String>,
}

/// The body of `PUT /api/acp/settings`; every field is a patch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentSettingsUpdate {
    /// The name; `""` goes back to the generic one, absent leaves it alone.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub name: Optional<String>,
    /// The executable; `""` removes the agent, absent leaves it alone.
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

/// The longest name a person needs.
const MAX_NAME: usize = 64;
/// The longest executable path a person can mean.
const MAX_COMMAND: usize = 4096;
/// The most arguments, and the longest one.
const MAX_ARGS: usize = 64;
const MAX_ARG: usize = 4096;

/// The stored configuration; an empty store is no agent.
pub fn read(paths: &Paths) -> StoredAcpAgent {
    let rows = crate::db::at(paths.config_db()).kv_scope(scope::ACP_AGENT);
    StoredAcpAgent {
        name: rows.get("name").cloned().unwrap_or_default(),
        command: rows.get("command").cloned().unwrap_or_default(),
        // A row this build cannot read is nothing rather than no settings: the
        // settings panel has to stay usable so it can be typed again.
        args: rows.get("args").and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default(),
        env: rows.get("env").and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default(),
    }
}

/// Apply a patch and persist it, or say why it was refused.
pub fn update(paths: &Paths, patch: &AcpAgentSettingsUpdate) -> Result<StoredAcpAgent, String> {
    let mut next = read(paths);
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
    let args = serde_json::to_string(&next.args).map_err(|error| error.to_string())?;
    let env = serde_json::to_string(&next.env).map_err(|error| error.to_string())?;
    crate::db::at(paths.config_db()).kv_replace_scope(
        scope::ACP_AGENT,
        [
            ("name", next.name.as_str()),
            ("command", next.command.as_str()),
            ("args", args.as_str()),
            ("env", env.as_str()),
        ],
    );
    Ok(next)
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

/// How the ACP agent is started on this machine.
#[api(id = "acp_settings", group = "acp", summary = "ACP agent settings")]
pub async fn acp_settings(State(state): State<AppState>) -> Json<AcpAgentSettings> {
    Json(read(&state.paths).info())
}

/// Change how the ACP agent is started. Applies to the next agent process; one
/// already running keeps what it was started with.
#[api(id = "update_acp_settings", group = "acp", summary = "Update the ACP agent settings")]
pub async fn update_acp_settings(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<AcpAgentSettingsUpdate>,
) -> Result<Json<AcpAgentSettings>, ApiError> {
    let stored = update(&state.paths, &body).map_err(ApiError::bad_request)?;
    // Another executable or environment may offer other models.
    state.drive.injections.forget_acp_options(Source::Acp);
    Ok(Json(stored.info()))
}

/// Register this module's routes.
pub fn routes(router: ApiRouter) -> ApiRouter {
    router
        .get("/api/acp/settings", acp_settings)
        .put("/api/acp/settings", update_acp_settings)
}

/// Everything gotcha cannot express about those routes.
pub fn describe(reg: &mut ExtraResponses) {
    reg.describe(
        "GET",
        "/api/acp/settings",
        200,
        "The ACP agent's name, command line and the names of its extra variables",
    )
    .describe("PUT", "/api/acp/settings", 200, "Updated ACP agent settings")
    .error(
        "PUT",
        "/api/acp/settings",
        400,
        "An unusable name, executable, argument or environment block",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let home = tempfile::tempdir().expect("tempdir");
        let paths = Paths::new(home.path().to_path_buf());
        (home, paths)
    }

    fn patch(command: Option<&str>, args: Option<&[&str]>, env: Option<&str>) -> AcpAgentSettingsUpdate {
        AcpAgentSettingsUpdate {
            name: None.into(),
            command: command.map(str::to_owned).into(),
            args: args.map(|args| args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>()).into(),
            env: env.map(str::to_owned).into(),
        }
    }

    #[test]
    fn nothing_stored_is_no_agent() {
        let (_home, paths) = paths();
        let stored = read(&paths);
        assert_eq!(stored.program(), PathBuf::new());
        assert!(stored.args.is_empty() && stored.env.is_empty());
        assert_eq!(stored.info().command, "");
    }

    #[test]
    fn values_are_kept_and_never_reported() {
        let (_home, paths) = paths();
        update(
            &paths,
            &AcpAgentSettingsUpdate {
                name: Some(" My agent ".to_string()).into(),
                ..patch(
                    Some(" /opt/agent/bin/agent "),
                    Some(&["acp", "--stdio"]),
                    Some("AGENT_MODEL=openai:gpt-5\nexport AGENT_API_KEY=\"sk-secret\""),
                )
            },
        )
        .expect("saved");
        let stored = read(&paths);
        assert_eq!(stored.name, "My agent");
        assert_eq!(stored.program(), PathBuf::from("/opt/agent/bin/agent"));
        assert_eq!(launch(&paths).args, vec!["acp", "--stdio"]);
        let info = serde_json::to_string(&stored.info()).unwrap();
        assert!(info.contains("AGENT_API_KEY"), "{info}");
        assert!(!info.contains("sk-secret"), "a value never reaches a client: {info}");
        let env = stored.environment(Env::from([("HOME".to_string(), "/h".to_string())]));
        assert_eq!(env.get("AGENT_API_KEY").map(String::as_str), Some("sk-secret"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/h"));
    }

    #[test]
    fn an_absent_field_is_left_alone_and_an_empty_one_clears() {
        let (_home, paths) = paths();
        update(&paths, &patch(Some("/x/agent"), Some(&["acp"]), Some("A=1"))).expect("saved");
        update(&paths, &patch(None, None, None)).expect("saved");
        assert_eq!(read(&paths).info().env_names, vec!["A"]);
        assert_eq!(read(&paths).command, "/x/agent");
        assert_eq!(read(&paths).args, vec!["acp"]);
        update(&paths, &patch(Some(""), Some(&[]), Some("  \n# nothing\n"))).expect("saved");
        assert_eq!(read(&paths), StoredAcpAgent::default());
    }

    #[test]
    fn a_block_that_moves_the_child_is_refused() {
        let (_home, paths) = paths();
        assert!(update(&paths, &patch(None, None, Some("PATH=/tmp"))).is_err());
        assert!(update(&paths, &patch(None, None, Some("not a pair"))).is_err());
        assert!(update(&paths, &patch(Some("agent\nrm -rf /"), None, None)).is_err());
        assert!(update(&paths, &patch(None, Some(&["a\nb"]), None)).is_err());
        assert_eq!(read(&paths), StoredAcpAgent::default(), "a refusal stores nothing");
    }
}
