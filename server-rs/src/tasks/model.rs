//! Persisted task and weekly report contracts.
use std::collections::HashMap;

use gotcha::Schematic;
use serde::{Deserialize, Serialize};

use crate::openapi_ext::Nullable;

/// One task, or a single-level child of another task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    /// Monotonic ledger sequence number.
    pub id: u32,
    /// Parent sequence, null for main tasks.
    pub parent_id: Nullable<u32>,
    /// Task title.
    pub name: String,
    /// Person assigning the work.
    pub assigner: String,
    /// Project group identifier.
    pub group_id: String,
    /// Editable daily notes, plans and risk evidence.
    pub note: String,
    /// Optional shared topic for weekly merging within a project.
    pub report_topic: String,
    /// Planned deadline, ISO-8601, minute precision; initially null.
    pub due_at: Nullable<String>,
    /// Actual creation time, ISO-8601.
    pub created_at: String,
    /// Most recent change, ISO-8601.
    pub updated_at: String,
    /// Actual completion time, cleared upon reopening.
    pub completed_at: Nullable<String>,
    /// `pending` or `done`.
    pub status: String,
}

/// A project grouping for tasks and weekly reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    /// Stable identifier; `inbox` is the default group.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Six-digit RGB color.
    pub color: String,
    /// `active` or `pending` (deferred project).
    pub stage: String,
    /// Explanation shown under deferred projects in reports.
    pub pending_reason: String,
}

/// An immutable snapshot for reconstructing historical weeks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    /// Sequence number of the changed task.
    pub task_id: u32,
    /// `created`, `edited`, `completed`, `reopened`, or `deleted`.
    pub action: String,
    /// Server timestamp.
    pub at: String,
    /// Task contents after the change, or the final snapshot before deletion.
    pub snapshot: WorkTask,
}

/// Editable report section for one project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct TaskReportProject {
    /// Source project id.
    pub id: String,
    /// Project name captured when the report was generated.
    pub name: String,
    /// Whether to include this project in exports.
    pub included: bool,
    /// One progress entry per line.
    pub progress: String,
    /// One plan per line.
    pub plans: String,
    /// One risk per line.
    pub risks: String,
    /// Source task sequences for traceability.
    pub source_ids: Vec<u32>,
}

/// A manually editable, saved report for one calendar week.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct TaskReport {
    /// Report format version, currently 2.
    pub schema_version: u32,
    /// Included project sections in display order.
    pub projects: Vec<TaskReportProject>,
    /// One deferred project per line.
    pub pending_projects: String,
    /// Ledger revision from which this draft was compiled.
    pub source_revision: u64,
    /// Server timestamp of the last explicit save.
    #[serde(default)]
    pub saved_at: String,
}

/// Complete instance-scoped workbook state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schematic)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    /// Optimistic concurrency token, incremented after every successful write.
    pub revision: u64,
    /// Next never-reused task sequence.
    pub next_id: u32,
    /// Projects, including the default inbox.
    pub groups: Vec<TaskGroup>,
    /// All non-deleted pending and completed tasks.
    pub tasks: Vec<WorkTask>,
    /// Complete change history.
    pub events: Vec<TaskEvent>,
    /// Saved drafts keyed by local Monday (`YYYY-MM-DD`).
    pub reports: HashMap<String, TaskReport>,
    /// Last durable workbook save, empty before the first change.
    pub saved_at: String,
}

impl Default for TaskState {
    fn default() -> Self {
        Self {
            revision: 0,
            next_id: 1,
            groups: vec![TaskGroup {
                id: "inbox".into(),
                name: "未分组".into(),
                color: "#a5afa0".into(),
                stage: "active".into(),
                pending_reason: String::new(),
            }],
            tasks: vec![],
            events: vec![],
            reports: HashMap::new(),
            saved_at: String::new(),
        }
    }
}
