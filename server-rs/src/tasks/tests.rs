//! The workbook format: what an older binary reads back, and what it never does.

use calamine::{Data, Reader, Xlsx};

use super::workbook;
use super::*;

fn ledger_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("tasks").join("待办记录.xlsx")
}

fn task(id: u32, name: &str) -> WorkTask {
    WorkTask {
        id,
        parent_id: None.into(),
        name: name.into(),
        assigner: "林一".into(),
        group_id: "inbox".into(),
        note: "跨行\n中文备注 🙂".into(),
        report_topic: "蓝湾接口平台".into(),
        due_at: Some("2026-09-24T08:30:00.000Z".to_string()).into(),
        created_at: "2026-09-21T01:02:03.000Z".into(),
        updated_at: "2026-09-21T01:02:03.000Z".into(),
        completed_at: None.into(),
        status: "pending".into(),
    }
}

#[test]
fn a_missing_ledger_reads_as_the_empty_state_and_is_not_created() {
    let dir = tempfile::tempdir().unwrap();
    let path = ledger_path(dir.path());
    assert_eq!(workbook::read(&path).unwrap(), TaskState::default());
    assert!(!path.exists());
    assert!(workbook::encode(&TaskState::default()).unwrap().starts_with(b"PK"));
}

#[test]
fn a_real_xlsx_round_trips_without_formula_execution() {
    let dir = tempfile::tempdir().unwrap();
    let path = ledger_path(dir.path());
    let mut state = TaskState {
        revision: 3,
        next_id: 3,
        saved_at: "2026-09-21T01:02:03.000Z".into(),
        ..TaskState::default()
    };
    state.tasks.push(task(1, "=HYPERLINK(\"https://example.com\",\"x\")"));
    let mut child = task(2, "星河数据平台 接口联调");
    child.parent_id = Some(1).into();
    child.status = "done".into();
    child.completed_at = Some("2026-09-22T00:00:00.000Z".to_string()).into();
    state.tasks.push(child);
    state.events.push(TaskEvent {
        task_id: 1,
        action: "created".into(),
        at: "2026-09-21T01:02:03.000Z".into(),
        snapshot: state.tasks[0].clone(),
    });
    workbook::save(&path, &state).unwrap();
    assert_eq!(workbook::read(&path).unwrap(), state);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    let mut book: Xlsx<_> = calamine::open_workbook(&path).unwrap();
    let rows = book.worksheet_range("待办台账").unwrap();
    assert_eq!(rows.get((1, 1)), Some(&Data::String(state.tasks[0].name.clone())), "user text stays text");
    assert_eq!(rows.get((0, 13)), Some(&Data::String("计划完成时间".into())));
    assert!(book
        .worksheet_formula("待办台账")
        .unwrap()
        .used_cells()
        .all(|(_, _, formula)| formula.is_empty()));
    assert!(matches!(rows.get((1, 4)), Some(Data::DateTime(_))));
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "the temporary file is renamed, not left behind");
}

#[test]
fn reports_and_large_unicode_snapshots_survive_a_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = ledger_path(dir.path());
    let mut state = TaskState {
        revision: 2,
        next_id: 2,
        ..TaskState::default()
    };
    let mut big = task(1, "星河数据平台");
    // Far past one 8000-character cell of the hidden snapshot sheet.
    big.note = "中文🙂".repeat(6000);
    state.tasks.push(big);
    state.reports.insert(
        "2026-09-21".into(),
        TaskReport {
            schema_version: 2,
            projects: vec![TaskReportProject {
                id: "inbox".into(),
                name: "蓝湾接口平台".into(),
                included: true,
                progress: "手工修改的总结".into(),
                plans: "下一步".into(),
                risks: "风险".into(),
                source_ids: vec![1],
            }],
            pending_projects: "星河数据平台（等待立项）".into(),
            source_revision: 2,
            saved_at: "2026-09-21T01:02:03.000Z".into(),
        },
    );
    workbook::save(&path, &state).unwrap();
    assert_eq!(workbook::read(&path).unwrap(), state);
}

#[test]
fn a_corrupt_workbook_is_an_error_and_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = ledger_path(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"damaged excel").unwrap();
    assert!(workbook::read(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"damaged excel");

    // A real workbook whose snapshot breaks the ledger's own rules is refused too.
    let mut state = TaskState::default();
    state.tasks.push(task(5, "星河数据平台"));
    workbook::save(&path, &state).unwrap();
    assert!(workbook::read(&path).is_err(), "a task id at or past nextId");
}

/// The cross-check the rollback depends on: a workbook the tasks plugin wrote
/// in the browser (its "导出台账" / backup, `fixtures/plugin-export.xlsx`, made
/// from fake data by the plugin's own golden test) is read by this crate's
/// reader — the one the previous binary uses — into exactly the ledger it was
/// made from. Kept until the Excel reader is retired.
#[test]
fn a_workbook_the_tasks_plugin_writes_is_read_back_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tasks/fixtures");
    let read = workbook::read(&dir.join("plugin-export.xlsx")).expect("the plugin's workbook reads");
    let expected: TaskState = serde_json::from_slice(&std::fs::read(dir.join("plugin-export.json")).unwrap()).unwrap();
    assert_eq!(read, expected);
    assert!(!read.tasks.is_empty() && !read.events.is_empty() && !read.reports.is_empty());
}
