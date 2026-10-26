//! How this machine starts Bub: the executable, and the environment it runs in.
//!
//! [Bub](https://bub.build/) is driven over its ACP server (`bub acp`, see
//! [`crate::inject::acp`] and [`AGENT`]), and both halves of how that process is launched are the
//! user's to say, because neither has an answer this server could find on its
//! own. Bub is a Python program, usually installed into a virtual environment
//! of its own that the server's `PATH` knows nothing about; and its model
//! settings often come from variables a shell profile or a project `.env` sets.
//!
//! Two rows in the machine-wide state database under [`scope::BUB`]:
//!
//! * `command` — the executable, absolute or looked up on the `PATH`. Empty
//!   means `bub`.
//! * `env` — extra `KEY=VALUE` pairs, as JSON. Read through
//!   [`parse_env_block`], so a Bub block refuses what an account's block
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

/// The executable when nobody has named one.
pub const DEFAULT_COMMAND: &str = "bub";

/// Bub, as the ACP driver knows it: `<executable> acp`, over stdio, with the
/// configured variables laid over the server's clean environment.
pub static AGENT: AcpAgent = AcpAgent {
    source: Source::Bub,
    name: "Bub",
    install_hint: "Install its ACP server with `bub install bub-acp-server@main`, or set the Bub executable in Settings",
    launch,
};

fn launch(paths: &Paths) -> Launch {
    let stored = read(paths);
    Launch {
        program: stored.program(),
        args: vec!["acp".to_string()],
        env: stored.environment(clean_env_bare()),
    }
}

/// The stored configuration, values included. Never serialized to a client.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredBub {
    /// The executable as typed; empty for [`DEFAULT_COMMAND`].
    pub command: String,
    /// Extra environment, in the order it was typed.
    pub env: Vec<EnvVar>,
}

impl StoredBub {
    /// The executable to run.
    pub fn program(&self) -> PathBuf {
        PathBuf::from(match self.command.trim() {
            "" => DEFAULT_COMMAND,
            command => command,
        })
    }

    /// `base` with the configured variables laid over it.
    pub fn environment(&self, mut base: Env) -> Env {
        for var in &self.env {
            base.insert(var.key.clone(), var.value.clone());
        }
        base
    }

    /// What a client may learn.
    pub fn info(&self) -> BubSettings {
        BubSettings {
            command: self.command.clone(),
            default_command: DEFAULT_COMMAND.to_string(),
            env_names: self.env.iter().map(|var| var.key.clone()).collect(),
        }
    }
}

/// How Bub is started, as a client sees it: the variables' names, not their values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct BubSettings {
    /// The configured executable, or `""` for the default.
    pub command: String,
    /// What an empty `command` runs.
    pub default_command: String,
    /// The names of the extra environment variables, in order.
    pub env_names: Vec<String>,
}

/// The body of `PUT /api/bub/settings`; every field is a patch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct BubSettingsUpdate {
    /// The executable; `""` goes back to the default, absent leaves it alone.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub command: Optional<String>,
    /// A `KEY=VALUE`-per-line block that replaces every stored variable; `""`
    /// clears them, absent leaves them alone.
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub env: Optional<String>,
}

/// The longest executable path a person can mean.
const MAX_COMMAND: usize = 4096;

/// The stored configuration; an empty store is the default executable and no
/// extra variables.
pub fn read(paths: &Paths) -> StoredBub {
    let rows = crate::db::at(paths.config_db()).kv_scope(scope::BUB);
    StoredBub {
        command: rows.get("command").cloned().unwrap_or_default(),
        // A row this build cannot read is no variables rather than no Bub: the
        // settings panel has to stay usable so the block can be typed again.
        env: rows.get("env").and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default(),
    }
}

/// Apply a patch and persist it, or say why it was refused.
pub fn update(paths: &Paths, patch: &BubSettingsUpdate) -> Result<StoredBub, String> {
    let mut next = read(paths);
    if let Some(command) = patch.command.as_deref() {
        let command = command.trim();
        if command.len() > MAX_COMMAND || command.contains(['\n', '\r', '\0']) {
            return Err("the Bub executable must be a single path or command name".into());
        }
        next.command = command.to_string();
    }
    if let Some(block) = patch.env.as_deref() {
        next.env = parse_block(block)?;
    }
    let env = serde_json::to_string(&next.env).map_err(|error| error.to_string())?;
    crate::db::at(paths.config_db()).kv_replace_scope(scope::BUB, [("command", next.command.as_str()), ("env", env.as_str())]);
    Ok(next)
}

/// [`parse_env_block`], except that a block with nothing in it clears the
/// variables rather than being refused: an account needs a credential, Bub does
/// not.
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

/// How Bub is started on this machine.
#[api(id = "bub_settings", group = "bub", summary = "Bub settings")]
pub async fn bub_settings(State(state): State<AppState>) -> Json<BubSettings> {
    Json(read(&state.paths).info())
}

/// Change how Bub is started. Applies to the next Bub process; one already
/// running keeps what it was started with.
#[api(id = "update_bub_settings", group = "bub", summary = "Update the Bub settings")]
pub async fn update_bub_settings(State(state): State<AppState>, ApiJson(body): ApiJson<BubSettingsUpdate>) -> Result<Json<BubSettings>, ApiError> {
    let stored = update(&state.paths, &body).map_err(ApiError::bad_request)?;
    // Another executable or environment may offer other models.
    state.drive.injections.forget_acp_options(Source::Bub);
    Ok(Json(stored.info()))
}

/// Register this module's routes.
pub fn routes(router: ApiRouter) -> ApiRouter {
    router
        .get("/api/bub/settings", bub_settings)
        .put("/api/bub/settings", update_bub_settings)
}

/// Everything gotcha cannot express about those routes.
pub fn describe(reg: &mut ExtraResponses) {
    reg.describe("GET", "/api/bub/settings", 200, "The Bub executable and the names of its extra variables")
        .describe("PUT", "/api/bub/settings", 200, "Updated Bub settings")
        .error("PUT", "/api/bub/settings", 400, "An unusable executable or environment block");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let home = tempfile::tempdir().expect("tempdir");
        let paths = Paths::new(home.path().to_path_buf());
        (home, paths)
    }

    fn patch(command: Option<&str>, env: Option<&str>) -> BubSettingsUpdate {
        BubSettingsUpdate {
            command: command.map(str::to_owned).into(),
            env: env.map(str::to_owned).into(),
        }
    }

    #[test]
    fn nothing_stored_runs_bub_with_no_extra_variables() {
        let (_home, paths) = paths();
        let stored = read(&paths);
        assert_eq!(stored.program(), PathBuf::from("bub"));
        assert!(stored.env.is_empty());
        assert_eq!(stored.info().command, "");
    }

    #[test]
    fn values_are_kept_and_never_reported() {
        let (_home, paths) = paths();
        update(
            &paths,
            &patch(
                Some(" /opt/bub/bin/bub "),
                Some("BUB_MODEL=openai:gpt-5\nexport BUB_API_KEY=\"sk-secret\""),
            ),
        )
        .expect("saved");
        let stored = read(&paths);
        assert_eq!(stored.program(), PathBuf::from("/opt/bub/bin/bub"));
        let info = serde_json::to_string(&stored.info()).unwrap();
        assert!(info.contains("BUB_API_KEY"), "{info}");
        assert!(!info.contains("sk-secret"), "a value never reaches a client: {info}");
        let env = stored.environment(Env::from([("HOME".to_string(), "/h".to_string())]));
        assert_eq!(env.get("BUB_API_KEY").map(String::as_str), Some("sk-secret"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/h"));
    }

    #[test]
    fn an_absent_field_is_left_alone_and_an_empty_one_clears() {
        let (_home, paths) = paths();
        update(&paths, &patch(Some("/x/bub"), Some("A=1"))).expect("saved");
        update(&paths, &patch(None, None)).expect("saved");
        assert_eq!(read(&paths).info().env_names, vec!["A"]);
        assert_eq!(read(&paths).command, "/x/bub");
        update(&paths, &patch(Some(""), Some("  \n# nothing\n"))).expect("saved");
        assert_eq!(read(&paths), StoredBub::default());
    }

    #[test]
    fn a_block_that_moves_the_child_is_refused() {
        let (_home, paths) = paths();
        assert!(update(&paths, &patch(None, Some("PATH=/tmp"))).is_err());
        assert!(update(&paths, &patch(None, Some("not a pair"))).is_err());
        assert!(update(&paths, &patch(Some("bub\nrm -rf /"), None)).is_err());
        assert_eq!(read(&paths), StoredBub::default(), "a refusal stores nothing");
    }
}
