//! The part of the [Agent Client Protocol](https://agentclientprotocol.com)
//! this server speaks, as Rust types.
//!
//! Defined here rather than taken from the official schema crate on purpose:
//! that crate turns on `serde_json`'s `preserve_order`, and Cargo features
//! apply to the whole build, so depending on it would change the key order of
//! every JSON document this server writes — the API contract and every
//! fingerprint taken over a re-serialized `Value` included.
//!
//! Only what [`crate::inject::acp`] sends or reads is here, and reading is
//! lenient the way ACP asks clients to be: an update kind, content block,
//! tool kind or stop reason this build does not know is kept as `Other`
//! rather than failing the message, and unknown fields are ignored.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Map, Value};

/// The protocol version this client speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// `session/update`: something an agent says about a session.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotification {
    /// The session it is about.
    pub session_id: String,
    /// What it says.
    pub update: SessionUpdate,
}

/// The kinds of `session/update` this server records.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    /// A piece of the user's message: only ever replayed by `session/load`,
    /// unless the agent echoes what it was sent.
    UserMessageChunk(ContentChunk),
    /// A piece of the agent's answer.
    AgentMessageChunk(ContentChunk),
    /// A piece of the agent's reasoning.
    AgentThoughtChunk(ContentChunk),
    /// A tool call starting.
    ToolCall(ToolCall),
    /// A tool call progressing, or ending.
    ToolCallUpdate(ToolCallUpdate),
    /// How full the context window is.
    UsageUpdate(UsageUpdate),
    /// Anything else: plans, mode and command lists, session info.
    #[serde(other)]
    Other,
}

/// One streamed piece of a message.
#[derive(Debug, Clone, Deserialize)]
pub struct ContentChunk {
    /// The piece itself.
    pub content: ContentBlock,
}

/// A piece of content, as far as this server shows it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Text.
    Text {
        /// The text.
        text: String,
    },
    /// An image, which a transcript names rather than draws.
    Image {},
    /// A link to a resource the agent can read.
    ResourceLink {
        /// The resource's name.
        name: String,
    },
    /// Audio, an embedded resource, or a kind this build does not know.
    #[serde(other)]
    Other,
}

/// What a tool call is for: how the session view labels it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    /// Reading files or data.
    Read,
    /// Changing files.
    Edit,
    /// Removing files.
    Delete,
    /// Moving or renaming files.
    Move,
    /// Searching.
    Search,
    /// Running a command.
    Execute,
    /// Thinking out loud.
    Think,
    /// Fetching from the network.
    Fetch,
    /// Anything else.
    #[default]
    #[serde(other)]
    Other,
}

/// Where a tool call is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    /// Not started yet.
    Pending,
    /// Running.
    InProgress,
    /// Finished.
    Completed,
    /// Finished, and failed.
    Failed,
    /// A status this build does not know.
    #[serde(other)]
    Other,
}

/// A tool call starting.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// The call's id, which its updates name.
    pub tool_call_id: String,
    /// What the agent calls it: a command line, a file name.
    #[serde(default)]
    pub title: String,
    /// What it is for.
    #[serde(default)]
    pub kind: ToolKind,
    /// The tool's input, as the agent gave it.
    #[serde(default)]
    pub raw_input: Option<Value>,
    /// Extension data: Bub marks a context hand-off here.
    #[serde(default, rename = "_meta")]
    pub meta: Option<Map<String, Value>>,
}

/// A tool call progressing, or ending. Every field but the id is optional:
/// an update carries only what changed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallUpdate {
    /// The call it updates.
    pub tool_call_id: String,
    /// Where it is now.
    #[serde(default)]
    pub status: Option<ToolCallStatus>,
    /// What it produced, for the user to read.
    #[serde(default)]
    pub content: Option<Vec<ToolCallContent>>,
    /// What it returned to the agent.
    #[serde(default)]
    pub raw_output: Option<Value>,
    /// Extension data: Bub marks a context hand-off here.
    #[serde(default, rename = "_meta")]
    pub meta: Option<Map<String, Value>>,
}

/// Something a tool call produced.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolCallContent {
    /// Ordinary content.
    Content {
        /// The content itself.
        content: ContentBlock,
    },
    /// A file the call changed.
    Diff {
        /// The file.
        path: PathBuf,
    },
    /// A terminal, or a kind this build does not know.
    #[serde(other)]
    Other,
}

/// How full the context window is.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageUpdate {
    /// Tokens in use.
    pub used: u64,
    /// The window's size.
    pub size: u64,
}

/// The answer to `session/prompt`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    /// Why the turn ended.
    pub stop_reason: StopReason,
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The agent finished.
    EndTurn,
    /// The model's output limit was reached.
    MaxTokens,
    /// Too many model requests in one turn.
    MaxTurnRequests,
    /// The agent refused to continue.
    Refusal,
    /// The client cancelled the turn.
    Cancelled,
    /// A reason this build does not know.
    #[serde(other)]
    Other,
}

impl StopReason {
    /// ACP's name for it, as a transcript records it.
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::EndTurn => "end_turn",
            StopReason::MaxTokens => "max_tokens",
            StopReason::MaxTurnRequests => "max_turn_requests",
            StopReason::Refusal => "refusal",
            StopReason::Cancelled => "cancelled",
            StopReason::Other => "other",
        }
    }
}

/// `fs/read_text_file`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReadTextFileParams {
    /// The file, absolute.
    pub path: PathBuf,
    /// The first line to read, 1-based.
    #[serde(default)]
    pub line: Option<u32>,
    /// How many lines to read.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `fs/write_text_file`.
#[derive(Debug, Clone, Deserialize)]
pub struct WriteTextFileParams {
    /// The file, absolute.
    pub path: PathBuf,
    /// Its whole new content.
    pub content: String,
}

/// One environment variable a terminal is given.
#[derive(Debug, Clone, Deserialize)]
pub struct EnvVariable {
    /// Its name.
    pub name: String,
    /// Its value.
    pub value: String,
}

/// `terminal/create`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalParams {
    /// The executable.
    pub command: String,
    /// Its arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Variables on top of the client's environment.
    #[serde(default)]
    pub env: Vec<EnvVariable>,
    /// Where it runs; the session's directory when absent.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// How much output to keep.
    #[serde(default)]
    pub output_byte_limit: Option<u64>,
}

/// `terminal/output`, `terminal/wait_for_exit`, `terminal/kill` and
/// `terminal/release`: which terminal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalParams {
    /// The terminal `terminal/create` answered with.
    pub terminal_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn what_this_build_does_not_know_is_kept_as_other() {
        let plan: SessionNotification =
            serde_json::from_value(json!({"sessionId": "s", "update": {"sessionUpdate": "plan", "entries": []}})).unwrap();
        assert!(matches!(plan.update, SessionUpdate::Other));
        let audio: ContentBlock = serde_json::from_value(json!({"type": "audio", "data": "", "mimeType": "audio/wav"})).unwrap();
        assert!(matches!(audio, ContentBlock::Other));
        let call: ToolCall = serde_json::from_value(json!({"toolCallId": "t", "kind": "switch_mode"})).unwrap();
        assert_eq!(call.kind, ToolKind::Other);
        let stop: PromptResponse = serde_json::from_value(json!({"stopReason": "something_new", "usage": {}})).unwrap();
        assert_eq!(stop.stop_reason, StopReason::Other);
    }

    #[test]
    fn a_tool_call_update_carries_only_what_changed() {
        let update: SessionUpdate = serde_json::from_value(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}, {"type": "terminal", "terminalId": "x"}],
        }))
        .unwrap();
        let SessionUpdate::ToolCallUpdate(update) = update else {
            panic!("a tool call update")
        };
        assert_eq!(update.status, Some(ToolCallStatus::Completed));
        assert!(matches!(
            update.content.as_deref(),
            Some([ToolCallContent::Content { .. }, ToolCallContent::Other])
        ));
        assert!(update.raw_output.is_none());
    }
}
