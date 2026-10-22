//! Human-readable sheets plus a versioned, lossless snapshot in the same XLSX.
//! The ledger the built-in Tasks feature kept; now read once for the `tasks`
//! plugin's import and written back for a release (`plugins::legacy_tasks`).
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use calamine::{open_workbook, Data, Reader, Xlsx};
use chrono::{DateTime, Local};
use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};

use super::TaskState;
use crate::api::error::ApiError;

/// Read a ledger. A missing file is the empty state; anything unreadable is an
/// error, never an empty state.
pub(crate) fn read(path: &Path) -> Result<TaskState, ApiError> {
    // Missing is the only condition that creates an empty state. A permission
    // failure, truncated ZIP, or damaged snapshot must never silently reset it.
    match fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TaskState::default()),
        Err(e) => return Err(ApiError::internal(format!("无法读取台账：{e}"))),
        Ok(_) => {}
    }
    let load = || -> Result<TaskState, String> {
        let mut book: Xlsx<_> = open_workbook(path).map_err(|e: calamine::XlsxError| e.to_string())?;
        let range = book.worksheet_range("系统数据").map_err(|e| e.to_string())?;
        let mut rows = range.rows();
        if rows.next().and_then(|r| r.first()) != Some(&Data::String("remote-hand.tasks.v1".into())) {
            return Err("不支持的台账格式".into());
        }
        let mut json = String::new();
        for row in rows {
            match row.first() {
                Some(Data::String(chunk)) => json.push_str(chunk),
                _ => return Err("台账快照不完整".into()),
            }
        }
        let state: TaskState = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if !state.groups.iter().any(|g| g.id == "inbox") || state.tasks.iter().any(|t| t.id >= state.next_id) {
            return Err("台账序号或分组损坏".into());
        }
        Ok(state)
    };
    load().map_err(|e| ApiError::internal(format!("Excel 台账无法读取，原文件已保留：{e}")))
}

fn sheet<'a>(book: &'a mut Workbook, name: &str, headers: &[&str]) -> Result<&'a mut Worksheet, XlsxError> {
    let ws = book.add_worksheet();
    ws.set_name(name)?;
    let header = Format::new().set_bold().set_background_color("#176b59").set_font_color("#FFFFFF");
    for (i, title) in headers.iter().enumerate() {
        ws.write_string_with_format(0, i as u16, *title, &header)?;
    }
    ws.set_freeze_panes(1, 0)?;
    ws.set_column_range_width(0, headers.len() as u16 - 1, 20)?;
    Ok(ws)
}

fn date(ws: &mut Worksheet, row: u32, col: u16, value: &str, minute: bool) -> Result<(), XlsxError> {
    if let Ok(d) = DateTime::parse_from_rfc3339(value) {
        let format = Format::new().set_num_format(if minute { "yyyy-mm-dd hh:mm" } else { "yyyy-mm-dd hh:mm:ss" });
        ws.write_datetime_with_format(row, col, d.with_timezone(&Local).naive_local(), &format)?;
    }
    Ok(())
}

/// The whole workbook, as bytes.
pub(crate) fn encode(state: &TaskState) -> Result<Vec<u8>, XlsxError> {
    let mut book = Workbook::new();
    let ws = sheet(
        &mut book,
        "待办台账",
        &[
            "序号",
            "任务名称",
            "交代人",
            "备注",
            "创建时间",
            "完成时间",
            "分组",
            "状态",
            "更新时间",
            "分组ID",
            "周报主题",
            "父任务序号",
            "任务层级",
            "计划完成时间",
        ],
    )?;
    ws.set_column_width(1, 44)?.set_column_width(3, 65)?.set_column_hidden(9)?;
    let wrap = Format::new().set_text_wrap();
    ws.set_column_format(3, &wrap)?;
    for (i, t) in state.tasks.iter().enumerate() {
        let r = i as u32 + 1;
        ws.write_number(r, 0, t.id)?;
        // write_string is deliberate: user text beginning '=' must stay text.
        for (c, value) in [
            (1, t.name.as_str()),
            (2, &t.assigner),
            (3, &t.note),
            (
                6,
                state
                    .groups
                    .iter()
                    .find(|g| g.id == t.group_id)
                    .map(|g| g.name.as_str())
                    .unwrap_or("未分组"),
            ),
            (7, if t.status == "done" { "已完成" } else { "待办" }),
            (9, &t.group_id),
            (10, &t.report_topic),
            (12, if t.parent_id.0.is_some() { "子任务" } else { "主任务" }),
        ] {
            ws.write_string(r, c, value)?;
        }
        date(ws, r, 4, &t.created_at, false)?;
        date(ws, r, 8, &t.updated_at, false)?;
        if let Some(d) = &t.completed_at.0 {
            date(ws, r, 5, d, false)?;
        }
        if let Some(d) = &t.due_at.0 {
            date(ws, r, 13, d, true)?;
        }
        if let Some(id) = t.parent_id.0 {
            ws.write_number(r, 11, id)?;
        }
    }
    ws.autofilter(0, 0, state.tasks.len() as u32, 13)?;
    let ws = sheet(
        &mut book,
        "操作记录",
        &["任务序号", "操作", "操作时间", "任务名称", "交代人", "备注", "分组ID", "计划完成时间"],
    )?;
    for (i, e) in state.events.iter().enumerate() {
        let r = i as u32 + 1;
        ws.write_number(r, 0, e.task_id)?;
        ws.write_string(
            r,
            1,
            match e.action.as_str() {
                "created" => "创建",
                "edited" => "编辑",
                "completed" => "完成",
                "reopened" => "重新打开",
                "restored" => "恢复",
                "deleted" => "删除",
                other => other,
            },
        )?;
        date(ws, r, 2, &e.at, false)?;
        for (c, v) in [
            (3, &e.snapshot.name),
            (4, &e.snapshot.assigner),
            (5, &e.snapshot.note),
            (6, &e.snapshot.group_id),
        ] {
            ws.write_string(r, c, v)?;
        }
        if let Some(d) = &e.snapshot.due_at.0 {
            date(ws, r, 7, d, true)?;
        }
    }
    let ws = sheet(&mut book, "任务分组", &["分组ID", "项目名称", "颜色", "项目状态", "待定原因"])?;
    for (i, g) in state.groups.iter().enumerate() {
        for (c, v) in [&g.id, &g.name, &g.color, &g.stage, &g.pending_reason].iter().enumerate() {
            ws.write_string(i as u32 + 1, c as u16, v.as_str())?;
        }
    }
    let ws = sheet(
        &mut book,
        "项目周报",
        &["周开始日期", "项目名称", "本周进展", "下周计划", "风险点", "纳入周报", "保存时间"],
    )?;
    let mut r = 1;
    for (week, report) in &state.reports {
        for p in &report.projects {
            for (c, v) in [
                week.as_str(),
                &p.name,
                &p.progress,
                &p.plans,
                &p.risks,
                if p.included { "是" } else { "否" },
            ]
            .iter()
            .enumerate()
            {
                ws.write_string(r, c as u16, *v)?;
            }
            date(ws, r, 6, &report.saved_at, false)?;
            r += 1;
        }
        if !report.pending_projects.is_empty() {
            ws.write_string(r, 0, week)?
                .write_string(r, 1, "待定项目")?
                .write_string(r, 2, &report.pending_projects)?;
            r += 1;
        }
    }
    let ws = sheet(&mut book, "使用说明", &["项目", "说明"])?;
    ws.set_column_width(1, 100)?;
    for (i, (key, value)) in [
        (
            "保存方式",
            "待办的数据保存在 Droppen 的待办插件里；此文件是它自动写出的副本，供回滚到旧版本时使用。请在网页中编辑任务，不要在 Droppen 运行时打开或保存这个文件。如果它在 Droppen 之外被改过，Droppen 下次保存时会先把它另存为 待办记录.xlsx.diverged-…，再把其中的修改并入待办，并在待办页面提示。",
        ),
        (
            "时间",
            "计划完成时间精确到分钟；完成时间为实际完成时刻。Excel 日期按服务器本地时区展示，系统数据保留 UTC 时间。",
        ),
        (
            "备份恢复",
            "备份完整工作簿，包括隐藏的系统数据。恢复时在待办页面点「从 Excel 备份恢复」选择备份文件；不要把备份直接放回 tasks/待办记录.xlsx，那样会被当作外部修改合并，而不是整体恢复。",
        ),
        ("风险分析", "周报使用可追溯的备注规则生成风险建议，支持人工校对和编辑。"),
        (
            "删除任务",
            "删除主任务时一并删除其子任务。待办台账移除对应行，操作记录保留删除快照，已保存周报保持不变；任务序号不重复使用。",
        ),
    ]
    .iter()
    .enumerate()
    {
        ws.write_string(i as u32 + 1, 0, *key)?.write_string(i as u32 + 1, 1, *value)?;
    }
    let ws = book.add_worksheet();
    ws.set_name("系统数据")?.set_hidden(true);
    ws.write_string(0, 0, "remote-hand.tasks.v1")?;
    // Chunk on Unicode scalar boundaries, well below Excel's UTF-16 cell limit.
    let snapshot = serde_json::to_string(state).map_err(|e| XlsxError::ParameterError(e.to_string()))?;
    let chars: Vec<char> = snapshot.chars().collect();
    for (i, chunk) in chars.chunks(8000).enumerate() {
        ws.write_string(i as u32 + 1, 0, chunk.iter().collect::<String>())?;
    }
    book.save_to_buffer()
}

/// Write a ledger atomically: a `0600` temporary file, synced, renamed over.
#[cfg(test)]
pub(crate) fn save(path: &Path, state: &TaskState) -> Result<(), ApiError> {
    let bytes = encode(state).map_err(|e| ApiError::internal(format!("生成台账失败：{e}")))?;
    save_bytes(path, &bytes)
}

/// Write already-encoded ledger bytes atomically, as [`save`] does.
pub(crate) fn save_bytes(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    let parent = path.parent().ok_or_else(|| ApiError::internal("台账路径无效"))?;
    fs::create_dir_all(parent).map_err(|e| ApiError::internal(format!("创建台账目录失败：{e}")))?;
    let temp = parent.join(format!(".tasks-{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        // The rename is the commit point. Directory sync failures after it
        // cannot be reported as a rollback: the new revision already exists.
        if let Err(e) = fs::File::open(parent).and_then(|f| f.sync_all()) {
            tracing::warn!(%e, "task workbook directory sync failed after commit");
        }
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&temp);
        return Err(ApiError::internal(format!("台账保存失败，原数据未改动：{e}")));
    }
    Ok(())
}
