//! The built-in Tasks feature's Excel ledger: its data model and its workbook
//! format, kept only for the `tasks` plugin's migration (see
//! [`crate::plugins::legacy_tasks`]).
//!
//! The feature itself — the `/api/tasks/*` routes and the commands they applied
//! — moved into the `tasks` plugin, which runs in the browser and keeps its
//! state in the plugin document store. What is left here reads a ledger once to
//! import it, and writes it back after each change for one more release so a
//! rolled-back binary still reads current data. It goes in P5, with
//! `calamine` and `rust_xlsxwriter`.

mod model;
pub(crate) mod workbook;

pub use model::{TaskEvent, TaskGroup, TaskReport, TaskReportProject, TaskState, WorkTask};

#[cfg(test)]
mod tests;
