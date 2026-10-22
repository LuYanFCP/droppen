//! The built-in Tasks feature's Excel ledger, on its way out. **Temporary.**
//!
//! Tasks used to be a server feature that kept its whole state in
//! `<instance>/tasks/待办记录.xlsx`. It is now the `tasks` plugin, which keeps
//! the same state as documents in its store and runs its logic in the browser.
//! Everything here exists to move one into the other without losing anything,
//! and to keep a rollback possible for a release or two. None of it runs
//! unless the bundled manifest has a plugin with the id [`ID`]: the public
//! build bundles no plugins, and so never reads a ledger.
//!
//! # The documents (a contract with the plugin)
//!
//! * `state` — `{"schemaVersion": 1, "nextId", "groups", "tasks", "savedAt"}`,
//!   at the **ledger's revision**, so a page still holding the old ledger gets
//!   an ordinary conflict.
//! * `events/<YYYY-MM>` — `{"schemaVersion": 1, "events": [...]}`. Events are
//!   walked in ledger order and each lands in `max(previous month, its own
//!   month)` (its own being the first seven characters of `at`, or the previous
//!   month — `1970-01` at first — when `at` does not start `YYYY-MM`), so the
//!   month documents sorted by name concatenate back to the exact original
//!   order.
//! * `reports/<YYYY-MM-DD>` — the saved weekly report, as it was.
//!
//! Reassembled, those are the ledger's `TaskState` with `revision` taken from
//! the `state` document.
//!
//! # What happens when
//!
//! * **First boot** of an instance that never decided about `tasks`, has a
//!   ledger that reads, and has at least one task in it: the documents,
//!   `meta.imported_from` and [`LEDGER_SYNC`] / [`LEDGER_BASE`] are written in
//!   one transaction, read back, reassembled and deep-compared with the ledger
//!   before it commits; then the plugin is switched on (`reason: "migrated"`).
//!   A ledger that will not read switches nothing on and makes no store. The
//!   ledger itself is only ever read.
//! * **Every write** to the `tasks` store is written back to the ledger before
//!   it is acknowledged ([`write_back_covering`]), so a binary rolled back to
//!   `.prev` reads current data. A failure is logged at error level, kept as a
//!   notice in the instance database, pushed to open clients and shown on the
//!   Tasks page; the write stands.
//! * **The ledger is overwritten only while it is the file the store last
//!   wrote or took in** (its sha256 is [`LEDGER_SYNC`]'s). A ledger that is
//!   anything else — an older binary kept working after a rollback, a backup put
//!   back by hand, equal revisions with different contents — is copied aside
//!   as `待办记录.xlsx.diverged-<revision>-<time>` (once per distinct file).
//!   A file *newer* than the one the store last wrote is three-way merged into
//!   the store from [`LEDGER_BASE`] — field by field, notes by lines ([`merge`]:
//!   what only one side changed is taken, where both changed the same field
//!   the store's version is kept and named, task numbers are never reused,
//!   families are made consistent and the history made to agree with the
//!   result the way the weekly report reads it). A file *not newer* (a stale
//!   copy saved over it, an old backup put back) did not grow out of it, so
//!   only what is new in it is taken ([`take_additions`]) — it can never delete
//!   or revert. Either way the result is committed by compare-and-set (a write
//!   that lands meanwhile makes it merge again), written back, and announced in
//!   a notice that stays until it is dismissed. Nothing is overwritten or
//!   dropped silently.
//! * **Writing the ledger** records the new file's digest and contents
//!   *before* the rename that puts it in place, as not yet landed, beside the
//!   file it replaces; a crash in between is recognised, not mistaken for an
//!   outside edit.
//! * **At boot, and whenever the plugin is switched on** ([`reconcile`]), the
//!   same check runs, so edits made while the plugin was off are taken in
//!   before its first write.
//!
//! Remove with P5, together with `crate::tasks`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use droppen_plugin_sdk::{valid_doc_name, Doc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{lock, store, Decision, DecisionReason, NewNotice, NoticeKind, Plugins, Store, StoreError};
use crate::tasks::{workbook, TaskEvent, TaskGroup, TaskState, WorkTask};

/// The plugin that inherits the ledger.
pub const ID: &str = "tasks";
/// The ledger's file name, under `<instance>/tasks/`.
pub const LEDGER_FILE: &str = "待办记录.xlsx";
/// The documents' own format version.
pub const SCHEMA_VERSION: u64 = 1;
/// Whether every write is copied back into the ledger. On for the release
/// that ships the plugin and the one after it; P5 turns it off.
const WRITE_BACK: bool = true;
/// `meta` key: where the documents were imported from.
pub const IMPORTED_FROM: &str = "imported_from";
/// `meta` key: the ledger file this store last wrote or took in —
/// `{sha256, revision, at}`. The ledger is overwritten only while it is still
/// that file.
const LEDGER_SYNC: &str = "ledger_sync";
/// `meta` key: that ledger's contents (`TaskState` JSON), which a three-way
/// merge starts from when the ledger turns out to have moved.
const LEDGER_BASE: &str = "ledger_base";
/// `meta` key: the contents of the file before that one, still the base while
/// the newest write has not landed.
const LEDGER_BASE_PREVIOUS: &str = "ledger_base_previous";

/// `<instance>/tasks/待办记录.xlsx`.
pub fn ledger_path(instance_dir: &Path) -> PathBuf {
    instance_dir.join("tasks").join(LEDGER_FILE)
}

/// `at`'s month, when `at` starts `YYYY-MM`.
fn month_of(at: &str) -> Option<&str> {
    let head = at.get(..7)?;
    let bytes = head.as_bytes();
    (bytes[..4].iter().all(u8::is_ascii_digit) && bytes[4] == b'-' && bytes[5..].iter().all(u8::is_ascii_digit)).then_some(head)
}

/// The ledger, as the plugin's documents (name and value), `state` first.
pub fn split(state: &TaskState) -> Result<Vec<(String, Value)>, String> {
    let mut docs = vec![(
        "state".to_string(),
        json!({
            "schemaVersion": SCHEMA_VERSION,
            "nextId": state.next_id,
            "groups": state.groups,
            "tasks": state.tasks,
            "savedAt": state.saved_at,
        }),
    )];
    let mut months: Vec<(String, Vec<Value>)> = Vec::new();
    for event in &state.events {
        let previous = months.last().map(|(month, _)| month.as_str());
        let month = match (month_of(&event.at), previous) {
            (Some(own), Some(previous)) if previous > own => previous.to_string(),
            (Some(own), _) => own.to_string(),
            (None, Some(previous)) => previous.to_string(),
            (None, None) => "1970-01".to_string(),
        };
        let event = serde_json::to_value(event).map_err(|error| error.to_string())?;
        match months.last_mut() {
            Some((last, events)) if *last == month => events.push(event),
            _ => months.push((month, vec![event])),
        }
    }
    for (month, events) in months {
        docs.push((format!("events/{month}"), json!({ "schemaVersion": SCHEMA_VERSION, "events": events })));
    }
    let mut weeks: Vec<_> = state.reports.iter().collect();
    weeks.sort_by(|a, b| a.0.cmp(b.0));
    for (week, report) in weeks {
        docs.push((
            format!("reports/{week}"),
            serde_json::to_value(report).map_err(|error| error.to_string())?,
        ));
    }
    if let Some((name, _)) = docs.iter().find(|(name, _)| !valid_doc_name(name)) {
        return Err(format!("the ledger holds something that cannot be a document name: {name:?}"));
    }
    Ok(docs)
}

/// The documents put back together as the ledger's `TaskState`, as JSON.
///
/// The store has no delete, so the plugin writes `null` over a document it
/// means to be gone — its restore from an Excel backup does, for every week
/// and month the backup lacks. A `null` `reports/<week>` is no report for that
/// week, and a `null` `events/<month>` no events; both are skipped.
pub fn assemble(docs: &[Doc]) -> Result<Value, String> {
    let state = docs.iter().find(|doc| doc.name == "state").ok_or("there is no `state` document")?;
    let version = state.value.get("schemaVersion").and_then(Value::as_u64);
    if version != Some(SCHEMA_VERSION) {
        return Err(format!("`state` has schemaVersion {version:?}; this server reads {SCHEMA_VERSION}"));
    }
    let mut months: Vec<&Doc> = docs
        .iter()
        .filter(|doc| doc.name.starts_with("events/") && !doc.value.is_null())
        .collect();
    months.sort_by(|a, b| a.name.cmp(&b.name));
    let mut events = Vec::new();
    for month in months {
        let list = month
            .value
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("`{}` has no events list", month.name))?;
        events.extend(list.iter().cloned());
    }
    let reports: serde_json::Map<String, Value> = docs
        .iter()
        .filter(|doc| !doc.value.is_null())
        .filter_map(|doc| Some((doc.name.strip_prefix("reports/")?.to_string(), doc.value.clone())))
        .collect();
    let field = |key: &str| state.value.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "revision": state.revision,
        "nextId": field("nextId"),
        "groups": field("groups"),
        "tasks": field("tasks"),
        "events": events,
        "reports": reports,
        "savedAt": field("savedAt"),
    }))
}

/// Where two JSON values first differ, as a path (`$.events[12].snapshot.note`).
/// Never the values: they are somebody's work.
pub fn first_difference(expected: &Value, actual: &Value) -> Option<String> {
    fn walk(a: &Value, b: &Value, path: &mut String) -> bool {
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
                keys.sort();
                keys.dedup();
                for key in keys {
                    let len = path.len();
                    path.push('.');
                    path.push_str(key);
                    match (a.get(key), b.get(key)) {
                        (Some(x), Some(y)) if !walk(x, y, path) => return false,
                        (Some(_), Some(_)) => {}
                        _ => return false,
                    }
                    path.truncate(len);
                }
                true
            }
            (Value::Array(a), Value::Array(b)) => {
                for (index, (x, y)) in a.iter().zip(b).enumerate() {
                    let len = path.len();
                    path.push_str(&format!("[{index}]"));
                    if !walk(x, y, path) {
                        return false;
                    }
                    path.truncate(len);
                }
                if a.len() != b.len() {
                    path.push_str(&format!("[{}] (lengths {} and {})", a.len().min(b.len()), a.len(), b.len()));
                    return false;
                }
                true
            }
            _ => a == b,
        }
    }
    let mut path = "$".to_string();
    (!walk(expected, actual, &mut path)).then_some(path)
}

/// How much of a ledger there is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    /// Tasks.
    pub tasks: usize,
    /// Groups (projects).
    pub groups: usize,
    /// History events.
    pub events: usize,
    /// Saved weekly reports.
    pub reports: usize,
    /// The ledger's revision.
    pub revision: u64,
}

impl Counts {
    fn of(state: &Value) -> Self {
        let len = |key: &str| state.get(key).and_then(Value::as_array).map_or(0, Vec::len);
        Self {
            tasks: len("tasks"),
            groups: len("groups"),
            events: len("events"),
            reports: state.get("reports").and_then(Value::as_object).map_or(0, serde_json::Map::len),
            revision: state.get("revision").and_then(Value::as_u64).unwrap_or_default(),
        }
    }
}

impl std::fmt::Display for Counts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} tasks, {} groups, {} events, {} reports, revision {}",
            self.tasks, self.groups, self.events, self.reports, self.revision
        )
    }
}

/// What an import wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Imported {
    /// The ledger's contents.
    pub counts: Counts,
    /// How many documents that came to.
    pub docs: usize,
}

/// The ledger file this store last wrote or took in: [`LEDGER_SYNC`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Synced {
    /// That file's sha256.
    sha256: String,
    /// The revision it holds.
    revision: u64,
    at: String,
    /// The file before it, still ours while this one has not `landed`.
    #[serde(default)]
    previous: Option<String>,
    /// Whether this file is known to have reached the disk. Recorded `false`
    /// before the rename that writes it and `true` after, so a crash between
    /// the two is told apart from somebody else's edit.
    #[serde(default = "landed_by_default")]
    landed: bool,
}

fn landed_by_default() -> bool {
    true
}

/// A ledger, read, with its digest and what `meta.imported_from` says about it.
struct Ledger {
    state: TaskState,
    origin: Value,
    sha256: String,
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_ledger(path: &Path) -> Result<Ledger, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let state = workbook::read(path).map_err(|error| error.body()["error"].as_str().unwrap_or("unreadable").to_string())?;
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(crate::sessions::iso8601)
        .ok();
    let digest = sha256(&bytes);
    Ok(Ledger {
        origin: json!({
            "path": path.display().to_string(),
            "sha256": digest,
            "size": bytes.len(),
            "mtime": modified,
            "revision": state.revision,
        }),
        sha256: digest,
        state,
    })
}

/// Whether `name` is one of the documents the ledger is split into — the only
/// ones an import or a merge may replace or drop.
pub fn is_ledger_doc(name: &str) -> bool {
    name == "state" || name.starts_with("events/") || name.starts_with("reports/")
}

/// The ledger the store holds, as a merge reads it.
struct Ours {
    /// Read the way a write-back reads it (through `TaskState`, so a value the
    /// ledger cannot carry is normalised away).
    state: TaskState,
    /// The revision of every ledger document, by name: what a merge expects to
    /// find unchanged when it commits.
    revisions: Vec<(String, u64)>,
    /// Weeks whose report the store deleted (a `null` document).
    deleted_reports: BTreeSet<String>,
}

/// [`Ours`], or `None` before anything was stored.
fn read_ours(store: &Store) -> Result<Option<Ours>, String> {
    let docs = store.all().map_err(|error| error.to_string())?;
    if !docs.iter().any(|doc| doc.name == "state") {
        return Ok(None);
    }
    let revisions = docs
        .iter()
        .filter(|doc| is_ledger_doc(&doc.name))
        .map(|doc| (doc.name.clone(), doc.revision))
        .collect();
    let deleted_reports = docs
        .iter()
        .filter(|doc| doc.value.is_null())
        .filter_map(|doc| doc.name.strip_prefix("reports/").map(str::to_string))
        .collect();
    let state = serde_json::from_value(assemble(&docs)?).map_err(|error| format!("the documents are not a ledger: {error}"))?;
    Ok(Some(Ours {
        state,
        revisions,
        deleted_reports,
    }))
}

fn stored_ledger(store: &Store) -> Result<Option<TaskState>, String> {
    Ok(read_ours(store)?.map(|ours| ours.state))
}

/// What this store last wrote or took in, if it knows: [`LEDGER_SYNC`], or —
/// for a store made before that was kept — the digest `imported_from` recorded.
fn synced(store: &Store) -> Option<Synced> {
    if let Some(raw) = store.meta(LEDGER_SYNC).ok().flatten() {
        if let Ok(synced) = serde_json::from_str(&raw) {
            return Some(synced);
        }
    }
    let origin: Value = serde_json::from_str(&store.meta(IMPORTED_FROM).ok().flatten()?).ok()?;
    Some(Synced {
        sha256: origin["sha256"].as_str()?.to_string(),
        revision: origin["revision"].as_u64()?,
        at: String::new(),
        previous: None,
        landed: true,
    })
}

fn meta_ledger(store: &Store, key: &str) -> Option<TaskState> {
    serde_json::from_str(&store.meta(key).ok().flatten()?).ok()
}

/// The contents of the ledger file the store is in step with: where a
/// three-way merge starts. While the newest write has not landed, that is the
/// file before it.
fn synced_base(store: &Store) -> Option<TaskState> {
    match synced(store) {
        Some(synced) if !synced.landed => meta_ledger(store, LEDGER_BASE_PREVIOUS),
        _ => meta_ledger(store, LEDGER_BASE),
    }
}

fn ledger_json(state: &TaskState) -> String {
    serde_json::to_string(state).expect("a ledger serialises")
}

/// The bookkeeping for a ledger file the store now holds — one it took in, or
/// one it wrote and saw land.
fn synced_meta(sha256: &str, state: &TaskState) -> Vec<(&'static str, String)> {
    let synced = Synced {
        sha256: sha256.to_string(),
        revision: state.revision,
        at: store::now(),
        previous: None,
        landed: true,
    };
    vec![
        (LEDGER_SYNC, serde_json::to_string(&synced).expect("a sync record serialises")),
        (LEDGER_BASE, ledger_json(state)),
    ]
}

/// Make the store's ledger documents hold `state` — and only those documents:
/// anything else the plugin keeps is left alone — verified before it commits.
/// With `expect`, only if the ledger documents are still at exactly those
/// revisions (a [`StoreError::Conflict`](super::StoreError) otherwise). `meta`
/// is written in the same transaction.
fn store_ledger(store: &Store, state: &TaskState, meta: &[(&str, String)], expect: Option<&[(String, u64)]>) -> Result<Vec<Doc>, StoreError> {
    let at = store::now();
    let docs: Vec<Doc> = split(state)
        .map_err(StoreError::Invalid)?
        .into_iter()
        .map(|(name, value)| Doc {
            revision: if name == "state" { state.revision } else { 1 },
            name,
            updated_at: at.clone(),
            value,
        })
        .collect();
    let expected = serde_json::to_value(state).map_err(|error| StoreError::Invalid(error.to_string()))?;
    store
        .replace_all(
            docs,
            super::store::ImportScope {
                replace: true,
                owned: &is_ledger_doc,
                expect,
            },
            None,
            meta,
            |stored| {
                let assembled = assemble(stored)?;
                let mut expected = expected.clone();
                // Replacing a store that was already ahead moves the revision on
                // rather than back; everything else must be exactly the ledger.
                if let Some(revision) = assembled["revision"].as_u64().filter(|r| *r > state.revision) {
                    expected["revision"] = json!(revision);
                }
                match first_difference(&expected, &assembled) {
                    None => Ok(()),
                    Some(path) => Err(format!("the store does not read back as the ledger (first difference at {path})")),
                }
            },
        )
        .map(|stored| stored.into_iter().filter(|doc| is_ledger_doc(&doc.name)).collect())
}

/// Write `ledger` into the store as documents, verified before it commits,
/// remembering it as the ledger the store is in step with.
fn import_ledger(plugins: &Plugins, ledger: &Ledger, replace: bool) -> Result<Imported, String> {
    let store = plugins.open_store(ID);
    if !replace {
        let held = store
            .list("")
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|doc| is_ledger_doc(&doc.name))
            .count();
        if held > 0 {
            return Err(format!("the store already holds {held} documents"));
        }
    }
    let mut meta = synced_meta(&ledger.sha256, &ledger.state);
    meta.push((IMPORTED_FROM, ledger.origin.to_string()));
    let docs = store_ledger(&store, &ledger.state, &meta, None).map_err(|error| error.to_string())?;
    plugins.published(ID, &docs);
    Ok(Imported {
        counts: Counts::of(&serde_json::to_value(&ledger.state).map_err(|error| error.to_string())?),
        docs: docs.len(),
    })
}

/// Import the ledger at its usual place: `plugin import tasks`. Refuses over
/// documents already there unless `replace` (which keeps the replaced values in
/// their history). Switches the plugin on, as the first boot would have, only
/// when the instance never decided about it.
pub fn import(plugins: &Plugins, replace: bool) -> Result<Imported, String> {
    let _gate = lock(&plugins.write_back);
    let path = ledger_path(plugins.instance_dir());
    if !path.exists() {
        return Err(format!("there is no ledger at {}", path.display()));
    }
    let ledger = read_ledger(&path)?;
    let imported = import_ledger(plugins, &ledger, replace)?;
    if plugins.decision(ID).is_none() {
        migrated(plugins);
    }
    plugins.set_notice(ID, NoticeKind::Import, None);
    Ok(imported)
}

fn migrated(plugins: &Plugins) {
    plugins.record(
        ID,
        &Decision {
            enabled: true,
            by: None,
            at: store::now(),
            reason: DecisionReason::Migrated,
        },
    );
    plugins.announce_status();
}

fn refuse_loudly(plugins: &Plugins, path: &Path, error: &str) {
    tracing::error!(
        ledger = %path.display(),
        %error,
        "THE TASK LEDGER WAS NOT IMPORTED; the tasks plugin stays off here. Fix the file, then run `remote-hand-server plugin import tasks`"
    );
    plugins.set_notice(ID, NoticeKind::Import, Some(format!("Excel 台账未能导入：{error}")));
}

/// The boot step: import a ledger nothing has taken in yet, or reconcile one
/// that moved under another binary. Only for the owner of the instance.
pub fn boot(plugins: &Plugins) {
    let Some(status) = plugins.status_of(ID) else { return };
    let decision = plugins.decision(ID);
    // Pinned off, incompatible, or turned off by somebody: leave everything —
    // ledger and store — exactly as it is. Turning it on runs [`reconcile`].
    if !status.compatible || (status.forced && !status.enabled) || decision.as_ref().is_some_and(|d| !d.enabled) {
        return;
    }
    reconcile(plugins);
}

/// Bring the store and the ledger into step: the first import of a ledger
/// nothing has taken in, or — for a store that already holds it — whatever
/// [`sync_ledger`] finds. At boot, and whenever the plugin is switched on.
pub fn reconcile(plugins: &Plugins) {
    let _gate = lock(&plugins.write_back);
    let path = ledger_path(plugins.instance_dir());
    let existing = plugins.existing_store(ID).map(|store| stored_ledger(&store).map(|state| (store, state)));
    match existing {
        Some(Err(error)) => {
            tracing::error!(%error, "cannot read the tasks plugin's store; leaving the ledger alone");
        }
        Some(Ok((store, Some(ours)))) => {
            // An import that committed and then lost its decision to a crash.
            if plugins.decision(ID).is_none() && store.meta(IMPORTED_FROM).ok().flatten().is_some() {
                migrated(plugins);
            }
            sync_ledger(plugins, &store, &ours);
        }
        _ => {
            // Nothing imported yet.
            if !path.exists() {
                return;
            }
            let ledger = match read_ledger(&path) {
                Ok(ledger) => ledger,
                Err(error) => return refuse_loudly(plugins, &path, &error),
            };
            if ledger.state.tasks.is_empty() {
                tracing::info!(ledger = %path.display(), "the task ledger has no tasks; nothing to import");
                return;
            }
            match import_ledger(plugins, &ledger, true) {
                Ok(imported) => {
                    tracing::info!(ledger = %path.display(), counts = %imported.counts, docs = imported.docs, "imported the task ledger into the tasks plugin");
                    plugins.set_notice(ID, NoticeKind::Import, None);
                    if plugins.decision(ID).is_none() {
                        migrated(plugins);
                    }
                }
                Err(error) => refuse_loudly(plugins, &path, &error),
            }
        }
    }
}

/// After a committed write to the `tasks` store: copy the store back into the
/// ledger, so a binary from before the plugin reads current data.
///
/// Synchronous — the write is acknowledged only once the ledger has it (or the
/// failure is noticed) — but never piled up: writes are numbered as they
/// commit, and a write that a write-back started after it already covered
/// returns at once. A burst of writes costs one write-back per turn of the
/// gate, not one each.
pub fn write_back_covering(plugins: &Plugins, write: u64) {
    if !WRITE_BACK {
        return;
    }
    let _gate = lock(&plugins.write_back);
    if plugins.write_covered(write) {
        return;
    }
    let upto = plugins.writes_committed();
    if let Some(store) = plugins.existing_store(ID) {
        match stored_ledger(&store) {
            Ok(Some(ours)) => sync_ledger(plugins, &store, &ours),
            Ok(None) => {}
            Err(error) => plugins.set_notice(ID, NoticeKind::WriteBack, Some(format!("Excel 回写失败：{error}"))),
        }
    }
    plugins.cover_writes(upto);
}

/// [`write_back_covering`] for whatever has committed so far: the CLI's.
pub fn write_back(plugins: &Plugins) {
    let _gate = lock(&plugins.write_back);
    if let Some(store) = plugins.existing_store(ID) {
        if let Ok(Some(ours)) = stored_ledger(&store) {
            sync_ledger(plugins, &store, &ours);
        }
    }
}

/// The heart of the rollback guarantee. Called with the gate held.
///
/// The ledger on disk is overwritten only when it is the very file this store
/// last wrote or took in (its sha256 matches [`LEDGER_SYNC`]) — or the one
/// before it, when the newest write never landed. Anything else — an older
/// binary kept working after a rollback, somebody put a backup back, a file
/// that will not read — is [`diverged`]: kept aside, merged, said so.
fn sync_ledger(plugins: &Plugins, store: &Store, ours: &TaskState) {
    let path = ledger_path(plugins.instance_dir());
    let on_disk = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return plugins.set_notice(
                ID,
                NoticeKind::WriteBack,
                Some(format!("Excel 回写失败：无法读取 {}：{error}", path.display())),
            );
        }
    };
    let Some(bytes) = on_disk else {
        // No ledger at all: nothing to lose by writing one.
        write_ledger(plugins, store, ours);
        return;
    };
    let digest = sha256(&bytes);
    match synced(store) {
        Some(synced) if synced.sha256 == digest => {
            if !synced.landed {
                // It did land; the crash came before the bookkeeping did.
                mark_landed(store, &synced);
            }
            // Ours to overwrite. By contents, not only by revision: a write
            // that left `state` alone (a report on its own) changes the ledger too.
            if synced.revision != ours.revision || meta_ledger(store, LEDGER_BASE).as_ref() != Some(ours) {
                write_ledger(plugins, store, ours);
            }
        }
        // The newest write never reached the disk: the file there is still
        // the one before it, ours, and simply out of date.
        Some(synced) if !synced.landed && synced.previous.as_deref() == Some(digest.as_str()) => {
            write_ledger(plugins, store, ours);
        }
        synced => diverged(plugins, store, &path, &digest, synced.as_ref()),
    }
}

fn mark_landed(store: &Store, synced: &Synced) {
    let landed = Synced {
        landed: true,
        previous: None,
        ..synced.clone()
    };
    if let Err(error) = store.set_metas(&[(LEDGER_SYNC, serde_json::to_string(&landed).expect("a sync record serialises"))]) {
        tracing::warn!(%error, "cannot record that the ledger was written");
    }
}

/// Write `state` to the ledger, keeping the bookkeeping one step ahead of the
/// disk: the new file's digest and contents are recorded *before* the rename
/// that puts it there (as not yet landed, beside the file it replaces), and
/// marked landed after. However a crash falls, the file on disk is one the
/// store can name.
fn write_ledger(plugins: &Plugins, store: &Store, state: &TaskState) -> bool {
    let path = ledger_path(plugins.instance_dir());
    let attempt = || -> Result<(), String> {
        let bytes = workbook::encode(state).map_err(|error| format!("生成台账失败：{error}"))?;
        let digest = sha256(&bytes);
        // The file that is on disk now, if it is ours: it stays recognisable
        // until the new one has landed.
        let (previous, previous_base) = match synced(store) {
            Some(synced) if synced.landed => (Some(synced.sha256), store.meta(LEDGER_BASE).ok().flatten()),
            Some(synced) => (synced.previous, store.meta(LEDGER_BASE_PREVIOUS).ok().flatten()),
            None => (None, None),
        };
        let pending = Synced {
            sha256: digest.clone(),
            revision: state.revision,
            at: store::now(),
            previous,
            landed: false,
        };
        let mut meta = vec![
            (LEDGER_SYNC, serde_json::to_string(&pending).expect("a sync record serialises")),
            (LEDGER_BASE, ledger_json(state)),
        ];
        if let Some(previous_base) = previous_base {
            meta.push((LEDGER_BASE_PREVIOUS, previous_base));
        }
        store.set_metas(&meta).map_err(|error| error.to_string())?;
        #[cfg(test)]
        if tests::crash_before_rename() {
            return Err("simulated crash".into());
        }
        workbook::save_bytes(&path, &bytes).map_err(|error| error.body()["error"].as_str().unwrap_or("cannot save").to_string())?;
        mark_landed(store, &pending);
        Ok(())
    };
    match attempt() {
        Ok(()) => {
            plugins.set_notice(ID, NoticeKind::WriteBack, None);
            true
        }
        Err(error) => {
            plugins.set_notice(
                ID,
                NoticeKind::WriteBack,
                Some(format!("Excel 回写失败，待办的数据不受影响，但回滚到旧版本时会看不到最近的修改：{error}")),
            );
            false
        }
    }
}

/// Copy the ledger aside as `待办记录.xlsx.diverged-<revision>-<time>`,
/// never over an existing file — and only once per distinct file: a copy of
/// these very bytes already there is reused. The copy, not a move: until the
/// merge is in the store, the original stays where an older binary would look.
fn keep_aside(path: &Path, revision: &str, digest: &str) -> Result<PathBuf, String> {
    let dir = path.parent().ok_or("the ledger has no directory")?;
    let prefix = format!("{LEDGER_FILE}.diverged-");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let copy = entry.path();
            if entry.file_name().to_string_lossy().starts_with(&prefix) && std::fs::read(&copy).is_ok_and(|bytes| sha256(&bytes) == digest) {
                return Ok(copy);
            }
        }
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let aside = path.with_file_name(format!("{prefix}{revision}-{stamp}"));
    let mut source = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut target = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&aside)
        .map_err(|error| format!("cannot keep a copy at {}: {error}", aside.display()))?;
    std::io::copy(&mut source, &mut target).map_err(|error| error.to_string())?;
    target.sync_all().map_err(|error| error.to_string())?;
    Ok(aside)
}

/// How often a merge is worked out again because the store moved under it.
const MERGE_ATTEMPTS: usize = 8;

/// A failure notice about the ledger file with this digest: repeats of it are
/// counted in one notice, not added as more.
fn failure(text: String, kind: &str, digest: &str) -> NewNotice {
    NewNotice {
        text,
        key: Some(format!("{kind}:{digest}")),
        important: false,
    }
}

/// The ledger on disk is not the one this store last wrote. Keep it, take its
/// changes in, write the result, and say so — never overwrite it blind.
///
/// * A file **newer** than the one the store last wrote (an older binary kept
///   working after a rollback) is three-way merged from that file ([`merge`]).
/// * A file **not newer** — a stale copy saved or copied over it, an old
///   backup put back — did not grow out of it, and merging from it would read
///   everything added since as deleted. From such a file only what is new is
///   taken ([`take_additions`]): nothing is deleted or reverted.
///
/// Either way the result is committed by compare-and-set on the store: it
/// goes in only if every ledger document is still at the revision it was
/// worked out from. A write that lands meanwhile (another tab's, already
/// answered) makes it start again from the store as it now is, so no
/// acknowledged edit is replaced.
fn diverged(plugins: &Plugins, store: &Store, path: &Path, digest: &str, synced: Option<&Synced>) {
    let theirs = match workbook::read(path) {
        Ok(theirs) => theirs,
        Err(error) => {
            let why = error.body()["error"].as_str().unwrap_or("unreadable").to_string();
            match keep_aside(path, "unreadable", digest) {
                Ok(aside) => {
                    plugins.add_notice(
                        ID,
                        failure(
                            format!(
                                "Excel 台账无法读取（{why}），原文件已另存为 {}；待办里的数据不变，Excel 已按待办重新写出。",
                                file_name(&aside)
                            ),
                            "unreadable",
                            digest,
                        ),
                    );
                    if let Ok(Some(ours)) = stored_ledger(store) {
                        write_ledger(plugins, store, &ours);
                    }
                }
                Err(copy) => plugins.set_notice(
                    ID,
                    NoticeKind::WriteBack,
                    Some(format!(
                        "Excel 台账无法读取（{why}），也无法另存（{copy}），所以没有回写；请检查 {}",
                        path.display()
                    )),
                ),
            }
            return;
        }
    };
    let base = synced_base(store);
    // Grown out of the file the store last wrote, or something older put back.
    let stale = base.as_ref().is_some_and(|base| theirs.revision <= base.revision);
    let mut aside: Option<PathBuf> = None;
    for attempt in 0..MERGE_ATTEMPTS {
        let ours = match read_ours(store) {
            Ok(Some(ours)) => ours,
            Ok(None) => return,
            Err(error) => return plugins.set_notice(ID, NoticeKind::WriteBack, Some(format!("Excel 回写失败：{error}"))),
        };
        if same_content(&theirs, &ours.state) {
            if theirs.revision == ours.state.revision {
                // The same ledger in a different file (a re-save): adopt it.
                if let Err(error) = store.set_metas(&synced_meta(digest, &ours.state)) {
                    tracing::warn!(%error, "cannot record the ledger as in step");
                }
            } else {
                // The same contents at another revision: nothing to take in.
                write_ledger(plugins, store, &ours.state);
            }
            return;
        }
        if base.as_ref().is_some_and(|base| same_content(base, &theirs)) {
            // Rewritten, but saying nothing new since the store last had it.
            write_ledger(plugins, store, &ours.state);
            return;
        }
        let kept = match &aside {
            Some(kept) => kept.clone(),
            None => match keep_aside(path, &theirs.revision.to_string(), digest) {
                Ok(kept) => {
                    aside = Some(kept.clone());
                    kept
                }
                Err(error) => {
                    // Without a copy there is no evidence to point at: touch nothing.
                    plugins.add_notice(
                        ID,
                        failure(
                            format!(
                                "Excel 台账在 Droppen 之外被改过（第 {} 版），但无法另存原文件（{error}），所以既没有合并也没有覆盖它。请检查 {}",
                                theirs.revision,
                                path.display()
                            ),
                            "no-copy",
                            digest,
                        ),
                    );
                    return;
                }
            },
        };
        let at = store::now();
        let (merged, report) = match &base {
            Some(base) if !stale => merge(base, &ours.state, &theirs, &at),
            Some(_) => take_additions(&ours.state, &theirs, &ours.deleted_reports, &at),
            None => keep_ours(&ours.state, &theirs, &at),
        };
        #[cfg(test)]
        tests::between_merge_and_commit(attempt);
        // The disk's ledger is the base from here: a crash before the
        // write-back below finds it in step and simply writes the merge out.
        match store_ledger(store, &merged, &synced_meta(digest, &theirs), Some(&ours.revisions)) {
            Ok(docs) => {
                plugins.published(ID, &docs);
                tracing::error!(
                    ledger = theirs.revision,
                    store = ours.state.revision,
                    merged = merged.revision,
                    stale,
                    last_written = ?synced.map(|s| s.revision),
                    aside = %kept.display(),
                    ?report,
                    "THE TASK LEDGER CHANGED OUTSIDE THIS SERVER; its edits were merged into the tasks plugin and the original kept aside"
                );
                write_ledger(plugins, store, &merged);
                let mode = match (&base, stale) {
                    (None, _) => Mode::NoBase,
                    (Some(base), true) => Mode::Stale { last_written: base.revision },
                    (Some(_), false) => Mode::Merged,
                };
                plugins.add_notice(
                    ID,
                    NewNotice {
                        text: report.describe(theirs.revision, &file_name(&kept), mode),
                        key: Some(format!("merged:{digest}")),
                        important: true,
                    },
                );
                return;
            }
            Err(StoreError::Conflict { doc, .. }) => {
                tracing::info!(attempt, %doc, "the store moved during a ledger merge; merging again");
                continue;
            }
            Err(error) => {
                plugins.add_notice(
                    ID,
                    failure(
                        format!(
                            "Excel 台账在 Droppen 之外被改过（第 {} 版），合并失败（{error}）；原文件已另存为 {}，待办和 Excel 都没有改动。",
                            theirs.revision,
                            file_name(&kept)
                        ),
                        "merge-failed",
                        digest,
                    ),
                );
                return;
            }
        }
    }
    plugins.add_notice(
        ID,
        failure(
            "Excel 台账在 Droppen 之外被改过，但合并时待办一直在变化，没能完成；下次保存时会再试。".to_string(),
            "busy",
            digest,
        ),
    );
}

/// The same ledger, whatever revision each says it is at.
fn same_content(a: &TaskState, b: &TaskState) -> bool {
    a.next_id == b.next_id && a.groups == b.groups && a.tasks == b.tasks && a.events == b.events && a.reports == b.reports && a.saved_at == b.saved_at
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}

/// What a merge did, for the notice and the log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeReport {
    /// Tasks the ledger added.
    pub added: usize,
    /// Tasks the merge changed (from the ledger, or to keep a family consistent).
    pub changed: usize,
    /// Tasks the ledger deleted.
    pub removed: usize,
    /// Of the added tasks, how many got new numbers because the store had used theirs.
    pub renumbered: usize,
    /// Groups and reports the ledger added, changed or deleted.
    pub other: usize,
    /// Where both sides changed the same field and the store's version was
    /// kept — the ledger's is in the copy kept aside.
    pub kept_ours: Vec<String>,
    /// What the merge did to keep the result consistent.
    pub fixed: Vec<String>,
    /// From a stale file: differences that were not taken (they would have
    /// deleted or reverted newer work).
    pub skipped: usize,
}

/// How a merge's notice reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// A file newer than the one the store last wrote, merged from it.
    Merged,
    /// A file not newer than that one: only what was new in it was taken.
    Stale { last_written: u64 },
    /// No record of what the store last wrote.
    NoBase,
}

impl MergeReport {
    fn describe(&self, revision: u64, aside: &str, mode: Mode) -> String {
        let mut text = match mode {
            Mode::Merged => format!(
                "Excel 台账在 Droppen 之外被改过（第 {revision} 版），这些修改已并入待办：新增 {} 项、修改 {} 项、删除 {} 项任务",
                self.added, self.changed, self.removed
            ),
            Mode::Stale { last_written } => format!(
                "台账文件被换成了一份不比待办上次写出的（第 {last_written} 版）更新的 Excel（第 {revision} 版）——可能是一份打开着的旧副本被保存回来，或放回了旧备份。为避免回退，只并入了其中新增的内容：{} 项任务",
                self.added
            ),
            Mode::NoBase => format!("Excel 台账在 Droppen 之外被改过（第 {revision} 版）。没有可比对的基准，这些修改没有自动并入"),
        };
        if self.other > 0 {
            text.push_str(&format!("，分组或周报 {} 处", self.other));
        }
        if self.skipped > 0 {
            text.push_str(&format!("；另有 {} 处不同没有并入（并入会删掉或回退待办里更新的内容）", self.skipped));
        }
        if self.renumbered > 0 {
            text.push_str(&format!("；{} 项新任务的序号已被占用，改用了新序号", self.renumbered));
        }
        if !self.kept_ours.is_empty() {
            text.push_str(&format!(
                "；{} 处两边都改过，保留了待办里的版本（{}），Excel 里的版本在另存的文件中",
                self.kept_ours.len(),
                self.kept_ours.join("、")
            ));
        }
        if !self.fixed.is_empty() {
            text.push_str(&format!("；为保持一致还调整了：{}", self.fixed.join("、")));
        }
        text.push_str(&format!("。原文件已另存为 {aside}。"));
        text
    }
}

/// With no record of what the store last wrote, nothing can say which side
/// changed what: keep the store, keep the ledger's numbers out of reuse, and
/// leave its edits in the copy kept aside.
fn keep_ours(ours: &TaskState, theirs: &TaskState, at: &str) -> (TaskState, MergeReport) {
    let mut merged = ours.clone();
    merged.next_id = ours.next_id.max(theirs.next_id);
    merged.revision = ours.revision.max(theirs.revision) + 1;
    merged.saved_at = at.to_string();
    (merged, MergeReport::default())
}

/// Three-way pick of one value: whichever side changed it, or — when both did,
/// differently — ours, with `conflict` told.
fn pick<T: Clone + PartialEq>(base: &T, ours: &T, theirs: &T, mut conflict: impl FnMut()) -> T {
    if ours == base || ours == theirs {
        theirs.clone()
    } else if theirs == base {
        ours.clone()
    } else {
        conflict();
        ours.clone()
    }
}

/// The lines each side added around the base's lines, if all it did was add:
/// `gaps[i]` holds the lines before base line `i` (`gaps[base.len()]` the
/// ones after the last).
fn insertions<'a>(base: &[&str], side: &[&'a str]) -> Option<Vec<Vec<&'a str>>> {
    let mut gaps = vec![Vec::new(); base.len() + 1];
    let mut next = 0;
    for line in side {
        if next < base.len() && *line == base[next] {
            next += 1;
        } else {
            gaps[next].push(*line);
        }
    }
    (next == base.len()).then_some(gaps)
}

/// A note (备注) changed on both sides, merged by lines: the base's lines,
/// with both sides' new lines in order and none twice. `None` when the two
/// changed the same lines differently (a real conflict).
fn merge_note(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == base || ours == theirs {
        return Some(theirs.to_string());
    }
    if theirs == base {
        return Some(ours.to_string());
    }
    let (b, o, t): (Vec<&str>, Vec<&str>, Vec<&str>) = (base.lines().collect(), ours.lines().collect(), theirs.lines().collect());
    fn with<'a>(mut lines: Vec<&'a str>, extra: &[&'a str]) -> String {
        for line in extra {
            if !lines.contains(line) {
                lines.push(line);
            }
        }
        lines.join("\n")
    }
    if let (Some(og), Some(tg)) = (insertions(&b, &o), insertions(&b, &t)) {
        let mut lines: Vec<&str> = Vec::new();
        for (i, (mine, other)) in og.iter().zip(&tg).enumerate() {
            lines.extend(mine);
            lines.extend(other.iter().filter(|line| !mine.contains(line)));
            if let Some(line) = b.get(i) {
                lines.push(line);
            }
        }
        return Some(lines.join("\n"));
    }
    // One side only added lines at the end: those go after the other's.
    if t.len() >= b.len() && t[..b.len()] == b[..] {
        return Some(with(o, &t[b.len()..]));
    }
    if o.len() >= b.len() && o[..b.len()] == b[..] {
        return Some(with(t, &o[b.len()..]));
    }
    None
}

/// One task changed on both sides, merged field by field: the text fields
/// each on their own (the note by lines), the completion (status and
/// completion time) as one, the group (with its report topic) as one. Where
/// both sides changed the same field, ours is kept and the field named.
fn merge_task(base: &WorkTask, ours: &WorkTask, theirs: &WorkTask, kept: &mut Vec<String>) -> WorkTask {
    let mut merged = ours.clone();
    let label = format!("#{:03}", ours.id);
    let mut field = |name: &str| kept.push(format!("{label} {name}"));
    merged.name = pick(&base.name, &ours.name, &theirs.name, || field("名称"));
    merged.assigner = pick(&base.assigner, &ours.assigner, &theirs.assigner, || field("交代人"));
    merged.note = merge_note(&base.note, &ours.note, &theirs.note).unwrap_or_else(|| {
        field("备注");
        ours.note.clone()
    });
    merged.due_at = pick(&base.due_at, &ours.due_at, &theirs.due_at, || field("计划完成时间"));
    let (group_id, report_topic) = pick(
        &(base.group_id.clone(), base.report_topic.clone()),
        &(ours.group_id.clone(), ours.report_topic.clone()),
        &(theirs.group_id.clone(), theirs.report_topic.clone()),
        || field("分组"),
    );
    merged.group_id = group_id;
    merged.report_topic = report_topic;
    let (status, completed_at) = pick(
        &(base.status.clone(), base.completed_at.clone()),
        &(ours.status.clone(), ours.completed_at.clone()),
        &(theirs.status.clone(), theirs.completed_at.clone()),
        || field("完成状态"),
    );
    merged.status = status;
    merged.completed_at = completed_at;
    merged.updated_at = ours.updated_at.clone().max(theirs.updated_at.clone());
    merged
}

fn label(id: u32) -> String {
    format!("#{id:03}")
}

/// Make task families consistent again: a sub-task whose main task is gone
/// gets it back (from whichever side still has it), a sub-task has its main
/// task's group and report topic, and a main task with an open sub-task is open.
fn settle_families(tasks: &mut Vec<WorkTask>, sources: &[&[WorkTask]], report: &mut MergeReport) {
    use std::collections::{HashMap, HashSet};
    let present: HashSet<u32> = tasks.iter().map(|t| t.id).collect();
    let missing: BTreeSet<u32> = tasks.iter().filter_map(|t| t.parent_id.0).filter(|p| !present.contains(p)).collect();
    for parent in missing {
        if let Some(found) = sources.iter().find_map(|tasks| tasks.iter().find(|t| t.id == parent)) {
            report.fixed.push(format!("{}（主任务已恢复）", label(parent)));
            tasks.push(found.clone());
        } else {
            for orphan in tasks.iter_mut().filter(|t| t.parent_id.0 == Some(parent)) {
                orphan.parent_id = None.into();
                report.fixed.push(format!("{}（主任务已不在，改为主任务）", label(orphan.id)));
            }
        }
    }
    let parents: HashMap<u32, (String, String)> = tasks
        .iter()
        .filter(|t| t.parent_id.0.is_none())
        .map(|t| (t.id, (t.group_id.clone(), t.report_topic.clone())))
        .collect();
    for task in tasks.iter_mut() {
        if let Some((group, topic)) = task.parent_id.0.and_then(|p| parents.get(&p)) {
            if task.group_id != *group || task.report_topic != *topic {
                task.group_id.clone_from(group);
                task.report_topic.clone_from(topic);
                report.fixed.push(format!("{}（随主任务的分组）", label(task.id)));
            }
        }
    }
    let open_children: HashSet<u32> = tasks.iter().filter(|t| t.status != "done").filter_map(|t| t.parent_id.0).collect();
    for task in tasks.iter_mut() {
        if task.parent_id.0.is_none() && task.status == "done" && open_children.contains(&task.id) {
            task.status = "pending".into();
            task.completed_at = None.into();
            report.fixed.push(format!("{}（有未完成的子任务，已重新打开）", label(task.id)));
        }
    }
}

/// Two groups may not share a name (the ledger's own checks refuse it).
fn settle_group_names(groups: &mut [TaskGroup], report: &mut MergeReport) {
    let mut names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for group in groups {
        if !names.insert(group.name.clone()) {
            let original = group.name.clone();
            let mut n = 2;
            loop {
                let suffix = format!("·{n}");
                let stem: String = original.chars().take(24 - suffix.chars().count()).collect();
                let candidate = format!("{stem}{suffix}");
                if names.insert(candidate.clone()) {
                    group.name = candidate;
                    break;
                }
                n += 1;
            }
            report.fixed.push(format!("分组「{original}」重名，改为「{}」", group.name));
        }
    }
}

/// Make the history agree with the merged tasks, the way the weekly report
/// reads it (its events in time order, the last `completed`/`reopened`
/// deciding the status, a last `deleted` hiding the task):
///
/// * a task the merge brought back from a deletion gets a `restored` event;
/// * a changed task whose status the history already implies gets an
///   `edited` event — never a status event, so no completion is re-dated;
/// * a changed task whose status the history does not imply gets the status
///   event, a completion dated at its completion time, not the merge's;
/// * a task the merge removed gets a `deleted` event, unless its history ends in one.
///
/// `changed` is every task whose merged value is not what the store had.
fn settle_history(tasks: &mut [WorkTask], events: &mut Vec<TaskEvent>, changed: &std::collections::HashSet<u32>, gone: Vec<WorkTask>, at: &str) {
    let timeline = |events: &[TaskEvent], id: u32| {
        let mut history: Vec<TaskEvent> = events.iter().filter(|e| e.task_id == id).cloned().collect();
        history.sort_by(|a, b| a.at.cmp(&b.at));
        history
    };
    let event = |task: &WorkTask, action: &str, when: &str| TaskEvent {
        task_id: task.id,
        action: action.into(),
        at: when.to_string(),
        snapshot: task.clone(),
    };
    for task in tasks.iter_mut() {
        let history = timeline(events, task.id);
        let Some(last) = history.last() else {
            if changed.contains(&task.id) {
                task.updated_at = at.to_string();
                events.push(event(task, "edited", at));
            }
            continue;
        };
        if last.action == "deleted" {
            task.updated_at = at.to_string();
            events.push(event(task, "restored", at));
            continue;
        }
        if !changed.contains(&task.id) || last.snapshot == *task {
            continue;
        }
        let mut implied = last.snapshot.status.clone();
        for e in &history {
            match e.action.as_str() {
                "completed" => implied = "done".into(),
                "reopened" => implied = "pending".into(),
                _ => {}
            }
        }
        if implied == task.status {
            task.updated_at = at.to_string();
            events.push(event(task, "edited", at));
        } else if task.status == "done" {
            let when = task.completed_at.0.clone().unwrap_or_else(|| at.to_string());
            events.push(event(task, "completed", &when));
        } else {
            task.updated_at = at.to_string();
            events.push(event(task, "reopened", at));
        }
    }
    for task in gone {
        if timeline(events, task.id).last().is_none_or(|last| last.action != "deleted") {
            let mut snapshot = task;
            snapshot.updated_at = at.to_string();
            events.push(event(&snapshot, "deleted", at));
        }
    }
}

/// A three-way merge of the ledger (`theirs`) into the store (`ours`), from
/// the ledger both last agreed on (`base`), stamped `at`.
///
/// * Tasks, groups and reports present on both sides are merged field by
///   field ([`merge_task`]; notes by lines); what only one side changed is
///   taken, and where both changed the same field the store's version is kept
///   and named.
/// * A deletion on one side stands unless the other side changed the thing
///   deleted, which then comes back (and is named).
/// * Task numbers the ledger handed out that the store also used are moved
///   past the store's — unless it is the very same task on both sides, which
///   is kept once. No number is ever reused.
/// * Families are made consistent again ([`settle_families`]), group names
///   unique, and the history made to agree with the result ([`settle_history`]).
pub fn merge(base: &TaskState, ours: &TaskState, theirs: &TaskState, at: &str) -> (TaskState, MergeReport) {
    use std::collections::{HashMap, HashSet};
    let mut report = MergeReport::default();

    // Numbers: the store and the ledger each handed out numbers from
    // `base.next_id` on. Where both used one for different tasks, the
    // ledger's moves past every number either side has used.
    let ours_by: HashMap<u32, &WorkTask> = ours.tasks.iter().map(|t| (t.id, t)).collect();
    let theirs_ids: BTreeSet<u32> = theirs
        .tasks
        .iter()
        .map(|t| t.id)
        .chain(theirs.events.iter().map(|e| e.task_id))
        .filter(|id| *id >= base.next_id)
        .collect();
    let theirs_by: HashMap<u32, &WorkTask> = theirs.tasks.iter().map(|t| (t.id, t)).collect();
    let mut fresh = ours.next_id.max(theirs.next_id);
    let mut numbers: HashMap<u32, u32> = HashMap::new();
    for id in theirs_ids {
        let same_task = matches!((ours_by.get(&id), theirs_by.get(&id)), (Some(o), Some(t)) if o == t);
        if id < ours.next_id && !same_task {
            numbers.insert(id, fresh);
            fresh += 1;
        }
    }
    let theirs = renumbered(theirs, &|id| numbers.get(&id).copied().unwrap_or(id));
    report.renumbered = theirs.tasks.iter().filter(|t| numbers.values().any(|n| *n == t.id)).count();

    // Tasks.
    let by_id = |tasks: &[WorkTask]| tasks.iter().map(|t| (t.id, t.clone())).collect::<HashMap<u32, WorkTask>>();
    let (b, t) = (by_id(&base.tasks), by_id(&theirs.tasks));
    let mine: HashSet<u32> = ours.tasks.iter().map(|t| t.id).collect();
    let mut tasks = Vec::new();
    for task in &ours.tasks {
        match (b.get(&task.id), t.get(&task.id)) {
            (None, _) => tasks.push(task.clone()),
            (Some(was), Some(now)) => {
                let merged = merge_task(was, task, now, &mut report.kept_ours);
                if merged != *task {
                    report.changed += 1;
                }
                tasks.push(merged);
            }
            (Some(was), None) => {
                if task == was {
                    report.removed += 1;
                } else {
                    report.kept_ours.push(format!("{}（Excel 里删除了，待办里改过，已保留）", label(task.id)));
                    tasks.push(task.clone());
                }
            }
        }
    }
    for was in &base.tasks {
        if !mine.contains(&was.id) {
            if let Some(now) = t.get(&was.id).filter(|now| *now != was) {
                report.changed += 1;
                report.kept_ours.push(format!("{}（待办里删除了，Excel 里改过，已恢复）", label(was.id)));
                tasks.push(now.clone());
            }
        }
    }
    for task in &theirs.tasks {
        if !b.contains_key(&task.id) && !mine.contains(&task.id) {
            report.added += 1;
            tasks.push(task.clone());
        }
    }
    settle_families(&mut tasks, &[&ours.tasks, &theirs.tasks, &base.tasks], &mut report);

    // Groups, field by field (their ids are uuids: nothing to renumber).
    let groups_by = |groups: &[TaskGroup]| groups.iter().map(|g| (g.id.clone(), g.clone())).collect::<HashMap<String, TaskGroup>>();
    let (bg, tg, og) = (groups_by(&base.groups), groups_by(&theirs.groups), groups_by(&ours.groups));
    let used: HashSet<String> = tasks.iter().map(|t| t.group_id.clone()).collect();
    let mut groups = Vec::new();
    for group in &ours.groups {
        match (bg.get(&group.id), tg.get(&group.id)) {
            (Some(was), Some(now)) => {
                let mut merged = group.clone();
                let mut conflict = |what: &str| report.kept_ours.push(format!("分组「{}」{what}", group.name));
                merged.name = pick(&was.name, &group.name, &now.name, || conflict("名称"));
                merged.color = pick(&was.color, &group.color, &now.color, || conflict("颜色"));
                let (stage, reason) = pick(
                    &(was.stage.clone(), was.pending_reason.clone()),
                    &(group.stage.clone(), group.pending_reason.clone()),
                    &(now.stage.clone(), now.pending_reason.clone()),
                    || conflict("项目状态"),
                );
                merged.stage = stage;
                merged.pending_reason = reason;
                if merged != *group {
                    report.other += 1;
                }
                groups.push(merged);
            }
            (Some(was), None) if group == was && !used.contains(&group.id) && group.id != "inbox" => report.other += 1,
            _ => groups.push(group.clone()),
        }
    }
    for group in &theirs.groups {
        if !bg.contains_key(&group.id) && !og.contains_key(&group.id) {
            report.other += 1;
            groups.push(group.clone());
        }
    }
    let have: HashSet<String> = groups.iter().map(|g| g.id.clone()).collect();
    for needed in used.iter().collect::<BTreeSet<_>>() {
        if !have.contains(needed) {
            if let Some(found) = og.get(needed).or_else(|| tg.get(needed)).or_else(|| bg.get(needed)) {
                groups.push(found.clone());
            }
        }
    }
    if !groups.iter().any(|g| g.id == "inbox") {
        groups.insert(0, TaskState::default().groups.remove(0));
    }
    settle_group_names(&mut groups, &mut report);

    // Events only ever grow: the ledger's new ones follow the store's, once.
    let mut events = ours.events.clone();
    let start = base.events.len();
    let fresh_events: Vec<&TaskEvent> = if theirs.events.len() >= start && theirs.events[..start] == base.events[..] {
        theirs.events[start..].iter().collect()
    } else {
        theirs.events.iter().collect()
    };
    for event in fresh_events {
        if !events.contains(event) {
            events.push(event.clone());
        }
    }

    // Reports, by week; a deletion stands unless the other side changed it.
    let mut reports = HashMap::new();
    let weeks: BTreeSet<&String> = base.reports.keys().chain(ours.reports.keys()).chain(theirs.reports.keys()).collect();
    for week in weeks {
        let (was, mine, now) = (base.reports.get(week), ours.reports.get(week), theirs.reports.get(week));
        let kept = match (was, mine, now) {
            (Some(was), Some(mine), Some(now)) => Some(pick(was, mine, now, || report.kept_ours.push(format!("周报 {week}")))),
            (Some(was), None, Some(now)) if now != was => {
                report.kept_ours.push(format!("周报 {week}（待办里删除了，Excel 里改过，已恢复）"));
                Some(now.clone())
            }
            (Some(_), None, _) => None,
            (Some(was), Some(mine), None) => (mine != was).then(|| mine.clone()),
            (None, Some(mine), Some(now)) => {
                if mine != now {
                    report.kept_ours.push(format!("周报 {week}"));
                }
                Some(mine.clone())
            }
            (None, None, Some(now)) => Some(now.clone()),
            (None, Some(mine), None) => Some(mine.clone()),
            (None, None, None) => None,
        };
        if kept.as_ref() != mine {
            report.other += 1;
        }
        if let Some(kept) = kept {
            reports.insert(week.clone(), kept);
        }
    }

    let changed: HashSet<u32> = tasks
        .iter()
        .filter(|t| ours_by.get(&t.id).is_none_or(|o| *o != *t))
        .map(|t| t.id)
        .collect();
    let kept_ids: HashSet<u32> = tasks.iter().map(|t| t.id).collect();
    let mut gone: Vec<WorkTask> = ours
        .tasks
        .iter()
        .chain(&theirs.tasks)
        .filter(|t| !kept_ids.contains(&t.id))
        .cloned()
        .collect();
    gone.sort_by_key(|t| t.id);
    gone.dedup_by_key(|t| t.id);
    settle_history(&mut tasks, &mut events, &changed, gone, at);

    let highest = tasks.iter().map(|t| t.id).chain(events.iter().map(|e| e.task_id)).max().unwrap_or(0);
    let next_id = ours.next_id.max(theirs.next_id).max(fresh).max(highest.saturating_add(1));
    let merged = TaskState {
        revision: ours.revision.max(theirs.revision) + 1,
        next_id,
        groups,
        tasks,
        events,
        reports,
        saved_at: at.to_string(),
    };
    (merged, report)
}

/// From a file that is not newer than the one the store last wrote (a stale
/// copy saved over it, an old backup put back), take only what is new in it:
/// tasks the store has never had (by number and creation time, in its tasks
/// or its history), groups it has never had, and reports for weeks it has no
/// report for and never deleted. Nothing is deleted or reverted; every other
/// difference is counted as skipped, and stays in the copy kept aside.
pub fn take_additions(ours: &TaskState, theirs: &TaskState, deleted_reports: &BTreeSet<String>, at: &str) -> (TaskState, MergeReport) {
    use std::collections::{HashMap, HashSet};
    let mut report = MergeReport::default();
    let known: HashSet<(u32, &str)> = ours
        .tasks
        .iter()
        .chain(ours.events.iter().map(|e| &e.snapshot))
        .map(|t| (t.id, t.created_at.as_str()))
        .collect();
    let used: HashSet<u32> = ours.tasks.iter().map(|t| t.id).chain(ours.events.iter().map(|e| e.task_id)).collect();
    let ours_by: HashMap<u32, &WorkTask> = ours.tasks.iter().map(|t| (t.id, t)).collect();
    let mut fresh = ours.next_id.max(theirs.next_id);
    let mut numbers: HashMap<u32, u32> = HashMap::new();
    let mut new_ids = Vec::new();
    for task in &theirs.tasks {
        if known.contains(&(task.id, task.created_at.as_str())) {
            if ours_by.get(&task.id).is_none_or(|mine| *mine != task) {
                report.skipped += 1;
            }
            continue;
        }
        if used.contains(&task.id) || task.id < ours.next_id {
            numbers.insert(task.id, fresh);
            fresh += 1;
        }
        new_ids.push(task.id);
    }
    report.renumbered = numbers.len();
    let theirs = renumbered(theirs, &|id| {
        if new_ids.contains(&id) {
            numbers.get(&id).copied().unwrap_or(id)
        } else {
            id
        }
    });
    let added: HashSet<u32> = new_ids.iter().map(|id| numbers.get(id).copied().unwrap_or(*id)).collect();
    report.added = added.len();

    let mut tasks = ours.tasks.clone();
    tasks.extend(theirs.tasks.iter().filter(|t| added.contains(&t.id)).cloned());
    settle_families(&mut tasks, &[&ours.tasks], &mut report);

    let mut groups = ours.groups.clone();
    let have: HashSet<String> = groups.iter().map(|g| g.id.clone()).collect();
    for group in &theirs.groups {
        if !have.contains(&group.id) {
            report.other += 1;
            groups.push(group.clone());
        } else if ours.groups.iter().any(|g| g.id == group.id && g != group) {
            report.skipped += 1;
        }
    }
    settle_group_names(&mut groups, &mut report);

    let mut reports = ours.reports.clone();
    for (week, now) in &theirs.reports {
        match ours.reports.get(week) {
            None if !deleted_reports.contains(week) => {
                report.other += 1;
                reports.insert(week.clone(), now.clone());
            }
            Some(mine) if mine == now => {}
            _ => report.skipped += 1,
        }
    }

    let mut events = ours.events.clone();
    for event in theirs.events.iter().filter(|e| added.contains(&e.task_id)) {
        if !events.contains(event) {
            events.push(event.clone());
        }
    }
    let changed: HashSet<u32> = tasks
        .iter()
        .filter(|t| ours_by.get(&t.id).is_none_or(|o| *o != *t))
        .map(|t| t.id)
        .collect();
    settle_history(&mut tasks, &mut events, &changed, Vec::new(), at);

    let highest = tasks.iter().map(|t| t.id).chain(events.iter().map(|e| e.task_id)).max().unwrap_or(0);
    let merged = TaskState {
        revision: ours.revision.max(theirs.revision) + 1,
        next_id: ours.next_id.max(theirs.next_id).max(fresh).max(highest.saturating_add(1)),
        groups,
        tasks,
        events,
        reports,
        saved_at: at.to_string(),
    };
    (merged, report)
}

/// `state` with every task number `renumber` moves moved — in tasks,
/// sub-task links, history snapshots and report sources.
fn renumbered(state: &TaskState, renumber: &impl Fn(u32) -> u32) -> TaskState {
    let mut state = state.clone();
    let task = |task: &mut WorkTask| {
        task.id = renumber(task.id);
        task.parent_id = task.parent_id.0.map(renumber).into();
    };
    state.tasks.iter_mut().for_each(task);
    for event in &mut state.events {
        event.task_id = renumber(event.task_id);
        task(&mut event.snapshot);
    }
    for report in state.reports.values_mut() {
        for project in &mut report.projects {
            project.source_ids.iter_mut().for_each(|id| *id = renumber(*id));
        }
    }
    state
}

/// What `plugin verify tasks` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    /// The store, reassembled.
    pub store: Counts,
    /// The ledger.
    pub ledger: Counts,
    /// How many `events/*` and `reports/*` documents there are, tombstones
    /// (`null`) aside.
    pub event_docs: usize,
    /// See [`Self::event_docs`].
    pub report_docs: usize,
    /// Where the two first differ; `None` when they are identical.
    pub difference: Option<String>,
    /// Whether the ledger on disk is the file the store last wrote or took in.
    pub in_step: bool,
}

/// Reassemble the store and deep-compare it with the ledger — both read the
/// way a write-back reads them, so a value the ledger cannot carry (a report
/// with no `savedAt`, a field it does not know) is not a difference.
pub fn verify(plugins: &Plugins) -> Result<Verified, String> {
    let store = plugins
        .existing_store(ID)
        .ok_or_else(|| format!("there is no store at {}", plugins.store_path(ID).display()))?;
    let docs = store.all().map_err(|error| error.to_string())?;
    let ours = stored_ledger(&store)?.ok_or("the store holds no ledger")?;
    let assembled = serde_json::to_value(&ours).map_err(|error| error.to_string())?;
    let path = ledger_path(plugins.instance_dir());
    let ledger = read_ledger(&path)?;
    let expected = serde_json::to_value(&ledger.state).map_err(|error| error.to_string())?;
    Ok(Verified {
        store: Counts::of(&assembled),
        ledger: Counts::of(&expected),
        event_docs: docs.iter().filter(|doc| doc.name.starts_with("events/") && !doc.value.is_null()).count(),
        report_docs: docs.iter().filter(|doc| doc.name.starts_with("reports/") && !doc.value.is_null()).count(),
        difference: first_difference(&expected, &assembled),
        in_step: synced(&store).is_some_and(|synced| synced.sha256 == ledger.sha256),
    })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    type Hook = Box<dyn FnMut(usize)>;

    thread_local! {
        static CRASH_BEFORE_RENAME: Cell<bool> = const { Cell::new(false) };
        static BETWEEN: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    /// Test hook: make the next ledger write stop after its bookkeeping and
    /// before its rename, as a crash would.
    pub(crate) fn crash_before_rename() -> bool {
        CRASH_BEFORE_RENAME.with(Cell::get)
    }

    /// Test hook: run between a merge being worked out and its commit.
    pub(crate) fn between_merge_and_commit(attempt: usize) {
        BETWEEN.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook(attempt);
            }
        });
    }

    fn dismiss_all(plugins: &Plugins) {
        for notice in plugins.status_of(ID).unwrap().notices {
            if notice.dismissible {
                plugins.dismiss_notice(ID, &notice.id).unwrap();
            }
        }
    }
    use crate::config::PluginSettings;
    use crate::plugins::tests::{host, manifest};
    use crate::tasks::{TaskEvent, TaskReport, TaskReportProject};
    use droppen_plugin_sdk::PutDoc;

    fn task(id: u32, at: &str) -> WorkTask {
        WorkTask {
            id,
            parent_id: None.into(),
            name: format!("星河数据平台 任务 {id}"),
            assigner: "林一".into(),
            group_id: "inbox".into(),
            note: "跨行\n备注 🙂 =SUM(A1)".into(),
            report_topic: "蓝湾接口平台".into(),
            due_at: None.into(),
            created_at: at.into(),
            updated_at: at.into(),
            completed_at: None.into(),
            status: "pending".into(),
        }
    }

    fn event(id: u32, at: &str) -> TaskEvent {
        TaskEvent {
            task_id: id,
            action: "edited".into(),
            at: at.into(),
            snapshot: task(id, at),
        }
    }

    /// A ledger with events across months — one stamped out of order, one not
    /// stamped at all — and two reports.
    fn ledger() -> TaskState {
        let mut state = TaskState {
            revision: 42,
            next_id: 4,
            saved_at: "2026-10-16T09:00:00.000Z".into(),
            ..TaskState::default()
        };
        state.groups.push(TaskGroup {
            id: "g1".into(),
            name: "蓝湾接口平台".into(),
            color: "#123456".into(),
            stage: "pending".into(),
            pending_reason: "等待排期".into(),
        });
        state.tasks = vec![task(1, "2026-09-01T00:00:00.000Z"), task(3, "2026-10-02T00:00:00.000Z")];
        state.events = vec![
            event(2, "not a date"),
            event(1, "2026-09-01T00:00:00.000Z"),
            event(2, "2026-10-01T00:00:00.000Z"),
            event(2, "2026-09-30T23:59:59.000Z"),
            event(3, "2026-10-02T00:00:00.000Z"),
            event(3, "garbage"),
            event(3, "2026-11-01T00:00:00.000Z"),
        ];
        for week in ["2026-09-28", "2026-10-05"] {
            state.reports.insert(
                week.into(),
                TaskReport {
                    schema_version: 2,
                    projects: vec![TaskReportProject {
                        id: "g1".into(),
                        name: "蓝湾接口平台".into(),
                        included: true,
                        progress: "完成联调".into(),
                        plans: "上线".into(),
                        risks: String::new(),
                        source_ids: vec![1, 3],
                    }],
                    pending_projects: String::new(),
                    source_revision: 40,
                    saved_at: "2026-10-05T00:00:00.000Z".into(),
                },
            );
        }
        state
    }

    fn as_docs(split: Vec<(String, Value)>, revision: u64) -> Vec<Doc> {
        split
            .into_iter()
            .map(|(name, value)| Doc {
                revision: if name == "state" { revision } else { 1 },
                name,
                updated_at: String::new(),
                value,
            })
            .collect()
    }

    #[test]
    fn the_ledger_splits_by_month_and_reassembles_exactly() {
        let state = ledger();
        let docs = split(&state).unwrap();
        let names: Vec<&str> = docs.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "state",
                "events/1970-01",
                "events/2026-09",
                "events/2026-10",
                "events/2026-11",
                "reports/2026-09-28",
                "reports/2026-10-05"
            ]
        );
        let october = &docs[3].1["events"];
        assert_eq!(
            october.as_array().unwrap().len(),
            4,
            "the late-stamped September event and the unstamped one stay in October"
        );
        assert_eq!(docs[0].1["schemaVersion"], json!(1));
        assert!(docs[0].1.get("events").is_none() && docs[0].1.get("revision").is_none());

        // Shuffled, as a store hands documents back by name and a client by whim.
        let mut stored = as_docs(docs, state.revision);
        stored.reverse();
        let assembled = assemble(&stored).unwrap();
        assert_eq!(first_difference(&serde_json::to_value(&state).unwrap(), &assembled), None);
        let back: TaskState = serde_json::from_value(assembled).unwrap();
        assert_eq!(back, state);
    }

    /// The plugin's restore writes `null` over every week and month the backup
    /// lacks; reassembling, writing back and verifying all read those as absent.
    #[test]
    fn a_null_report_or_events_document_is_a_tombstone() {
        let state = ledger();
        let mut docs = as_docs(split(&state).unwrap(), state.revision);
        let mut expected = state.clone();
        expected.reports.remove("2026-09-28");
        // October's document alone: the late-stamped September event and the
        // unstamped one live in it.
        expected.events = state.events[2..6].to_vec();
        for doc in &mut docs {
            if doc.name == "reports/2026-09-28" || doc.name == "events/1970-01" || doc.name == "events/2026-09" || doc.name == "events/2026-11" {
                doc.value = Value::Null;
                doc.revision += 1;
            }
        }
        let assembled = assemble(&docs).unwrap();
        assert_eq!(first_difference(&serde_json::to_value(&expected).unwrap(), &assembled), None);
        assert_eq!(Counts::of(&assembled).reports, 1);

        // And through the store: write-back and verify agree with it.
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &state).unwrap();
        plugins.boot();
        let current = plugins.get(ID, "reports/2026-09-28").unwrap();
        let writes = vec![
            droppen_plugin_sdk::DocWrite {
                name: "reports/2026-09-28".into(),
                expected_revision: Some(current.revision),
                value: Value::Null,
            },
            droppen_plugin_sdk::DocWrite {
                name: "state".into(),
                expected_revision: Some(state.revision),
                value: docs[0].value.clone(),
            },
        ];
        plugins.batch(ID, writes, None).unwrap();
        let written = workbook::read(&path).unwrap();
        assert_eq!(
            written.reports.keys().collect::<Vec<_>>(),
            ["2026-10-05"],
            "the tombstoned week is not in the ledger"
        );
        let verified = verify(&plugins).unwrap();
        assert_eq!(verified.difference, None);
        assert_eq!(verified.report_docs, 1);
    }

    #[test]
    fn a_difference_is_named_by_path_not_by_value() {
        let a = json!({"events": [{"note": "secret"}], "x": 1});
        let b = json!({"events": [{"note": "other"}], "x": 1});
        assert_eq!(first_difference(&a, &b).as_deref(), Some("$.events[0].note"));
        assert_eq!(first_difference(&a, &a), None);
        let c = json!({"events": [{"note": "secret"}, {}], "x": 1});
        assert!(first_difference(&a, &c).unwrap().starts_with("$.events[1]"));
        assert_eq!(first_difference(&json!({"a": 1}), &json!({"b": 1})).as_deref(), Some("$.a"));
    }

    fn tasks_host(dir: &Path) -> Plugins {
        host(dir, vec![manifest(ID, false)], PluginSettings::default(), None)
    }

    #[test]
    fn the_first_boot_imports_a_ledger_with_tasks_and_switches_the_plugin_on() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(!plugins.is_enabled(ID));

        plugins.boot();
        let decision = plugins.decision(ID).expect("a decision");
        assert!(decision.enabled);
        assert_eq!(decision.reason, DecisionReason::Migrated);
        assert!(plugins.is_enabled(ID));
        assert_eq!(std::fs::read(&path).unwrap(), before, "the import only ever reads the ledger");

        let state = plugins.get(ID, "state").unwrap();
        assert_eq!(state.revision, 42, "the ledger's revision");
        assert_eq!(plugins.get(ID, "events/2026-09").unwrap().revision, 1);
        let origin: Value = serde_json::from_str(&plugins.open_store(ID).meta(IMPORTED_FROM).unwrap().unwrap()).unwrap();
        assert_eq!(origin["revision"], json!(42));
        assert_eq!(origin["size"], json!(before.len()));
        let verified = verify(&plugins).unwrap();
        assert_eq!(verified.difference, None);
        assert_eq!((verified.store.tasks, verified.store.events, verified.store.reports), (2, 7, 2));
        assert_eq!((verified.event_docs, verified.report_docs), (4, 2));

        // A second boot finds everything in step and does nothing.
        plugins.boot();
        assert_eq!(plugins.get(ID, "state").unwrap().revision, 42);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn no_tasks_an_unreadable_ledger_or_a_decision_to_stay_off_import_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &TaskState::default()).unwrap();
        plugins.boot();
        assert_eq!(plugins.decision(ID), None, "an empty ledger is not a reason to switch anything on");
        assert!(!plugins.dir(ID).exists());

        std::fs::write(&path, b"damaged excel").unwrap();
        plugins.boot();
        assert_eq!(plugins.decision(ID), None);
        assert!(!plugins.dir(ID).exists(), "a ledger that will not read makes no store");
        assert!(plugins.status_of(ID).unwrap().notice.unwrap().contains("Excel"));
        assert_eq!(std::fs::read(&path).unwrap(), b"damaged excel");
        assert!(import(&plugins, false).is_err());

        workbook::save(&path, &ledger()).unwrap();
        plugins.set_enabled(ID, false, Some("ada"), DecisionReason::Settings).unwrap();
        plugins.boot();
        assert!(!plugins.dir(ID).exists(), "an instance that said no is left alone");
    }

    fn put_state(plugins: &Plugins, expected: u64, state: &TaskState) {
        let value = split(state).unwrap().remove(0).1;
        plugins
            .put(
                ID,
                "state",
                PutDoc {
                    expected_revision: Some(expected),
                    value,
                },
                Some("ada"),
            )
            .unwrap();
    }

    fn stored(plugins: &Plugins) -> TaskState {
        stored_ledger(&plugins.open_store(ID)).unwrap().unwrap()
    }

    fn diverged_copies(plugins: &Plugins) -> Vec<PathBuf> {
        let dir = ledger_path(plugins.instance_dir()).parent().unwrap().to_path_buf();
        let mut copies: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.file_name().unwrap().to_string_lossy().contains(".diverged-"))
            .collect();
        copies.sort();
        copies
    }

    fn notice(plugins: &Plugins) -> String {
        plugins.status_of(ID).unwrap().notice.unwrap_or_default()
    }

    #[test]
    fn every_write_reaches_the_ledger_and_a_rolled_back_binary_is_reconciled() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();

        let mut next = stored(&plugins);
        next.next_id = 5;
        next.tasks.push(task(4, "2026-10-17T00:00:00.000Z"));
        put_state(&plugins, 42, &next);
        let written = workbook::read(&path).unwrap();
        assert_eq!((written.revision, written.tasks.len()), (43, 3), "the write is in the ledger");
        assert_eq!(plugins.status_of(ID).unwrap().notice, None);
        assert!(verify(&plugins).unwrap().in_step);

        // An older binary takes over and keeps working: it deletes task 4.
        let mut older = written.clone();
        older.revision = 45;
        older.tasks.pop();
        workbook::save(&path, &older).unwrap();
        plugins.boot();
        let state = plugins.get(ID, "state").unwrap();
        assert_eq!(state.revision, 46, "moved past both");
        assert_eq!(state.value["tasks"].as_array().unwrap().len(), 2, "the ledger's work is taken in");
        let history = plugins.history(ID, "state", 0, None).unwrap().versions;
        assert_eq!(history[0].revision, 43, "and the store's last version is kept");
        assert_eq!(verify(&plugins).unwrap().difference, None);
        assert_eq!(diverged_copies(&plugins).len(), 1, "the older binary's file is kept");
        assert_eq!(workbook::read(&diverged_copies(&plugins)[0]).unwrap(), older);
        assert!(notice(&plugins).contains("删除 1 项"), "{}", notice(&plugins));

        // The same ledger at an older revision says nothing new: it is simply
        // written again, with no copy and no notice.
        dismiss_all(&plugins);
        let mut behind = workbook::read(&path).unwrap();
        behind.revision = 44;
        workbook::save(&path, &behind).unwrap();
        plugins.boot();
        assert_eq!(workbook::read(&path).unwrap().revision, 46);
        assert_eq!(diverged_copies(&plugins).len(), 1);
        assert_eq!(plugins.status_of(ID).unwrap().notice, None);
    }

    /// (a) The write-back fails while the plugin takes two edits; the server is
    /// rolled back, an older binary adds a task to the (stale) ledger, and the
    /// server is upgraded again. Neither side's tasks may be lost, and no task
    /// number may be used twice.
    #[test]
    fn a_failed_write_back_then_a_rollback_loses_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        let tasks_dir = path.parent().unwrap().to_path_buf();

        std::fs::set_permissions(&tasks_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let mut ours = stored(&plugins);
        for (id, expected) in [(4u32, 42u64), (5, 43)] {
            ours.next_id = id + 1;
            ours.tasks.push(task(id, "2026-10-17T00:00:00.000Z"));
            put_state(&plugins, expected, &ours);
        }
        assert!(notice(&plugins).contains("回写失败"), "{}", notice(&plugins));
        assert_eq!(workbook::read(&path).unwrap().revision, 42, "the ledger stayed behind");
        std::fs::set_permissions(&tasks_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        // The older binary, on the stale ledger: one new task, numbered 4.
        let mut theirs = workbook::read(&path).unwrap();
        let mut made = task(4, "2026-10-18T00:00:00.000Z");
        made.name = "旧版本里新建的任务".into();
        theirs.tasks.push(made.clone());
        theirs.next_id = 5;
        theirs.revision = 43;
        theirs.events.push(TaskEvent {
            task_id: 4,
            action: "created".into(),
            at: "2026-10-18T00:00:00.000Z".into(),
            snapshot: made,
        });
        workbook::save(&path, &theirs).unwrap();

        // Upgraded again.
        let plugins = tasks_host(dir.path());
        plugins.boot();
        let merged = stored(&plugins);
        let ids: Vec<u32> = merged.tasks.iter().map(|t| t.id).collect();
        assert_eq!(ids, [1, 3, 4, 5, 6], "the store's 4 and 5 stay, the older binary's 4 becomes 6");
        let moved = merged.tasks.iter().find(|t| t.id == 6).unwrap();
        assert_eq!(moved.name, "旧版本里新建的任务");
        assert_eq!(merged.next_id, 7);
        let created = merged.events.iter().find(|e| e.snapshot.name == "旧版本里新建的任务").unwrap();
        assert_eq!((created.task_id, created.snapshot.id), (6, 6), "its history moved with it");
        assert_eq!(workbook::read(&path).unwrap(), merged, "and the ledger is the merge");
        assert!(verify(&plugins).unwrap().in_step);
        let copies = diverged_copies(&plugins);
        assert_eq!(copies.len(), 1);
        assert_eq!(workbook::read(&copies[0]).unwrap(), theirs, "the older binary's file is kept as it was");
        let text = notice(&plugins);
        assert!(text.contains("新增 1 项") && text.contains("新序号"), "{text}");
        assert!(!text.contains("回写失败"), "the write-back works again: {text}");
    }

    /// (b) The plugin is switched off, the server rolled back, the ledger
    /// edited, the server upgraded again, and the plugin switched back on in
    /// Settings. Its first write may not overwrite those edits.
    #[test]
    fn switching_back_on_takes_in_what_changed_while_off() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        plugins.set_enabled(ID, false, Some("ada"), DecisionReason::Settings).unwrap();

        let mut theirs = workbook::read(&path).unwrap();
        let mut made = task(4, "2026-10-18T00:00:00.000Z");
        made.name = "关着插件时新建的任务".into();
        theirs.tasks.push(made);
        theirs.next_id = 5;
        theirs.revision = 43;
        workbook::save(&path, &theirs).unwrap();
        plugins.boot();
        assert_eq!(stored(&plugins).revision, 42, "a plugin that is off is left alone at boot");

        plugins.set_enabled(ID, true, Some("ada"), DecisionReason::Settings).unwrap();
        let taken = stored(&plugins);
        assert_eq!(
            taken.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            [1, 3, 4],
            "taken in when switched on"
        );
        assert!(diverged_copies(&plugins).len() == 1 && notice(&plugins).contains("新增 1 项"));

        let mut next = taken.clone();
        next.tasks[0].name = "之后的修改".into();
        put_state(&plugins, taken.revision, &next);
        let ledger = workbook::read(&path).unwrap();
        assert!(ledger.tasks.iter().any(|t| t.name == "关着插件时新建的任务"));
        assert!(ledger.tasks.iter().any(|t| t.name == "之后的修改"));
    }

    /// Equal revisions, different contents: the digest tells them apart.
    #[test]
    fn a_ledger_at_the_same_revision_with_other_contents_is_kept_and_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        let mut theirs = workbook::read(&path).unwrap();
        theirs.tasks[0].name = "在 Excel 里改的名字".into();
        assert_eq!(theirs.revision, 42);
        workbook::save(&path, &theirs).unwrap();

        let mut ours = stored(&plugins);
        ours.tasks[1].note = "在待办里改的备注".into();
        put_state(&plugins, 42, &ours);
        // Not newer than the file the store last wrote: it did not grow out of
        // it (an older binary always moves the revision on), so nothing in it
        // may overwrite the store — it is kept aside and said so.
        let merged = stored(&plugins);
        assert_eq!(merged.tasks[0].name, ledger().tasks[0].name);
        assert_eq!(merged.tasks[1].note, "在待办里改的备注");
        assert_eq!(workbook::read(&path).unwrap(), merged);
        assert_eq!(diverged_copies(&plugins).len(), 1);
        assert!(notice(&plugins).contains("没有并入"), "{}", notice(&plugins));
    }

    /// Q3: a stale copy (one open in Excel, an old backup) saved over the
    /// ledger. Merging from the last written file would read everything added
    /// since as deleted; only what is new in the stale file may be taken.
    #[test]
    fn a_stale_copy_saved_over_the_ledger_neither_deletes_nor_reverts() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        let stale = std::fs::read(&path).unwrap();

        // Work in the plugin since then: a new task, a completion, a note, a report.
        let mut ours = stored(&plugins);
        ours.next_id = 5;
        let mut made = task(4, "2026-10-12T00:00:00.000Z");
        made.name = "之后新建的任务".into();
        ours.tasks.push(made);
        ours.tasks[0].status = "done".into();
        ours.tasks[0].completed_at = Some("2026-10-12T01:00:00.000Z".to_string()).into();
        ours.tasks[1].note.push_str("\n之后加的备注");
        put_state(&plugins, 42, &ours);
        let week = "2026-10-12";
        let mut report = ledger().reports["2026-10-05"].clone();
        report.pending_projects = "之后保存的周报".into();
        plugins
            .put(
                ID,
                &format!("reports/{week}"),
                PutDoc {
                    expected_revision: None,
                    value: serde_json::to_value(&report).unwrap(),
                },
                None,
            )
            .unwrap();
        let before = stored(&plugins);

        // The stale file comes back — once as it was, once with a task an
        // older binary added on top of it.
        std::fs::write(&path, &stale).unwrap();
        write_back(&plugins);
        let after = stored(&plugins);
        assert_eq!(after.tasks, before.tasks, "nothing deleted, nothing reverted");
        assert_eq!(after.reports, before.reports);
        assert_eq!(diverged_copies(&plugins).len(), 1, "the old copy is kept");
        assert!(notice(&plugins).contains("不比待办上次写出的"), "{}", notice(&plugins));
        assert_eq!(workbook::read(&path).unwrap(), after, "and the ledger is the store again");

        std::fs::write(&path, &stale).unwrap();
        let mut theirs = workbook::read(&path).unwrap();
        let mut extra = task(4, "2026-10-13T00:00:00.000Z");
        extra.name = "旧副本里新建的任务".into();
        theirs.tasks.push(extra);
        theirs.next_id = 5;
        theirs.revision = 43;
        workbook::save(&path, &theirs).unwrap();
        write_back(&plugins);
        let after = stored(&plugins);
        assert!(after.tasks.iter().any(|t| t.name == "之后新建的任务" && t.id == 4));
        let taken = after
            .tasks
            .iter()
            .find(|t| t.name == "旧副本里新建的任务")
            .expect("the new task is taken");
        assert_ne!(taken.id, 4, "under a number nobody used");
        assert_eq!(after.tasks[0].status, "done");
        assert!(after.tasks[1].note.ends_with("之后加的备注"));
        assert_eq!(after.reports, before.reports);
        assert_eq!(diverged_copies(&plugins).len(), 2);
        assert!(notice(&plugins).contains("新增的内容：1 项任务"), "{}", notice(&plugins));
    }

    #[test]
    fn a_ledger_that_will_not_read_is_kept_aside_before_the_store_writes_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        plugins.set_enabled(ID, true, None, DecisionReason::Settings).unwrap();
        let state = |next: u32| json!({"schemaVersion": 1, "nextId": next, "groups": TaskState::default().groups, "tasks": [], "savedAt": ""});
        let put = |expected, value| PutDoc {
            expected_revision: expected,
            value,
        };
        // No ledger at all: the write-back makes one, and keeps it after.
        plugins.put(ID, "state", put(None, state(1)), None).unwrap();
        let path = ledger_path(plugins.instance_dir());
        assert_eq!(workbook::read(&path).unwrap().revision, 1);
        plugins.put(ID, "state", put(Some(1), state(2)), None).unwrap();
        assert_eq!(workbook::read(&path).unwrap().next_id, 2);

        // A ledger that appeared from elsewhere and will not read.
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"damaged excel").unwrap();
        plugins.set_enabled(ID, true, None, DecisionReason::Settings).unwrap();
        assert!(notice(&plugins).contains("未能导入"));
        plugins.put(ID, "state", put(None, state(1)), None).unwrap();
        let copies = diverged_copies(&plugins);
        assert_eq!(copies.len(), 1);
        assert!(copies[0].to_string_lossy().contains("diverged-unreadable"));
        assert_eq!(std::fs::read(&copies[0]).unwrap(), b"damaged excel", "kept, not deleted");
        assert_eq!(workbook::read(&path).unwrap().revision, 1);
        assert!(notice(&plugins).contains("无法读取"));
    }

    #[test]
    fn the_merge_takes_one_sided_changes_and_keeps_the_stores_where_both_changed() {
        let base = ledger();
        let mut ours = base.clone();
        let mut theirs = base.clone();
        ours.tasks[0].note = "ours".into();
        theirs.tasks[0].note = "theirs".into();
        theirs.tasks.retain(|t| t.id != 3);
        let group = TaskGroup {
            id: "g-new".into(),
            name: "星河数据平台".into(),
            color: "#654321".into(),
            stage: "active".into(),
            pending_reason: String::new(),
        };
        theirs.groups.push(group.clone());
        let mut report = base.reports["2026-10-05"].clone();
        report.projects[0].progress = "Excel 里改的进展".into();
        theirs.reports.insert("2026-10-05".into(), report.clone());
        theirs.revision = 50;
        let (merged, summary) = merge(&base, &ours, &theirs, AT);
        assert_eq!(merged.tasks.iter().map(|t| t.id).collect::<Vec<_>>(), [1], "task 3 deleted there");
        assert_eq!(merged.tasks[0].note, "ours", "both changed task 1's note: the store's is kept");
        assert_eq!(summary.kept_ours, ["#001 备注"]);
        assert_eq!(summary.removed, 1);
        assert!(merged.groups.contains(&group));
        assert_eq!(merged.reports["2026-10-05"], report);
        assert_eq!(merged.revision, 51);
        assert_eq!(merged.next_id, base.next_id);

        // A main task deleted on one side keeps a sub-task the other side added.
        let mut ours = base.clone();
        let mut child = task(4, "2026-10-17T00:00:00.000Z");
        child.parent_id = Some(1).into();
        ours.tasks.push(child);
        ours.next_id = 5;
        let mut theirs = base.clone();
        theirs.tasks.retain(|t| t.id != 1);
        let (merged, summary) = merge(&base, &ours, &theirs, AT);
        assert!(merged.tasks.iter().any(|t| t.id == 1) && merged.tasks.iter().any(|t| t.id == 4));
        assert!(summary.fixed.iter().any(|k| k.contains("主任务已恢复")));
    }

    #[test]
    fn a_write_that_a_later_write_back_covered_does_not_write_again() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        let mut next = stored(&plugins);
        next.tasks[0].name = "covered".into();
        put_state(&plugins, 42, &next);
        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        // Pretend a write-back started after write number 1 already ran.
        plugins.cover_writes(1);
        write_back_covering(&plugins, 1);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), written, "nothing to do");
        assert_eq!(workbook::read(&path).unwrap().tasks[0].name, "covered");
    }

    #[test]
    fn verify_reads_both_sides_as_the_write_back_does_and_a_re_import_keeps_other_documents() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        // A report as a restore may leave it: no savedAt, and a field the
        // ledger does not carry.
        let current = plugins.get(ID, "reports/2026-10-05").unwrap();
        let mut value = current.value.clone();
        value.as_object_mut().unwrap().remove("savedAt");
        value["extra"] = json!("not in the ledger");
        let other = plugins
            .batch(
                ID,
                vec![
                    droppen_plugin_sdk::DocWrite {
                        name: "reports/2026-10-05".into(),
                        expected_revision: Some(current.revision),
                        value,
                    },
                    droppen_plugin_sdk::DocWrite {
                        name: "notes/keep".into(),
                        expected_revision: None,
                        value: json!("a document that is not the ledger's"),
                    },
                ],
                None,
            )
            .unwrap();
        assert_eq!(other.len(), 2);
        let verified = verify(&plugins).unwrap();
        assert_eq!(verified.difference, None, "normalised the same way on both sides");
        assert!(verified.in_step);

        // A re-import replaces the ledger's documents, and only those.
        import(&plugins, true).unwrap();
        assert_eq!(plugins.get(ID, "notes/keep").unwrap().value, json!("a document that is not the ledger's"));
    }

    const AT: &str = "2026-10-20T00:00:00.000Z";

    #[test]
    fn notices_add_up_outlive_a_restart_and_only_events_are_dismissed() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let note = |text: &str| NewNotice {
            text: text.into(),
            ..NewNotice::default()
        };
        plugins.add_notice(ID, note("第一次合并，提到了 #002"));
        plugins.add_notice(ID, note("第二次合并"));
        plugins.set_notice(ID, NoticeKind::WriteBack, Some("回写失败".into()));
        let restarted = tasks_host(dir.path());
        let notices = restarted.status_of(ID).unwrap().notices;
        assert_eq!(notices.len(), 3, "a second merge's notice does not replace the first");
        assert!(notices[0].text.contains("#002"));
        let failing = notices.iter().find(|n| n.kind == "writeBack").unwrap();
        assert!(!failing.dismissible);
        assert!(
            restarted.dismiss_notice(ID, &failing.id).is_err(),
            "a failure still there cannot be dismissed"
        );
        restarted.dismiss_notice(ID, &notices[0].id).unwrap();
        let left: Vec<String> = restarted.status_of(ID).unwrap().notices.into_iter().map(|n| n.text).collect();
        assert_eq!(left, ["第二次合并", "回写失败"], "one by one");
        restarted.set_notice(ID, NoticeKind::WriteBack, None);
        dismiss_all(&restarted);
        assert_eq!(restarted.status_of(ID).unwrap().notice, None);
        // An unread conflict is never pushed out by newer notices.
        restarted.add_notice(
            ID,
            NewNotice {
                text: "两边都改过 #002 备注".into(),
                key: None,
                important: true,
            },
        );
        for n in 0..30 {
            restarted.add_notice(ID, note(&format!("合并 {n}")));
        }
        let notices = restarted.status_of(ID).unwrap().notices;
        assert_eq!(notices.len(), NOTICES_KEPT_FOR_TESTS);
        assert_eq!(notices[0].text, "两边都改过 #002 备注");
        assert_eq!(notices.last().unwrap().text, "合并 29");
        // The same failure again is counted, not added.
        dismiss_all(&restarted);
        for _ in 0..3 {
            restarted.add_notice(
                ID,
                NewNotice {
                    text: "合并失败".into(),
                    key: Some("merge-failed:abc".into()),
                    important: false,
                },
            );
        }
        let notices = restarted.status_of(ID).unwrap().notices;
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].text, "合并失败（共 3 次）");
    }

    #[test]
    fn a_file_that_keeps_failing_is_kept_aside_once() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        for _ in 0..3 {
            std::fs::write(&path, b"damaged excel").unwrap();
            write_back(&plugins);
        }
        assert_eq!(diverged_copies(&plugins).len(), 1, "one copy per distinct file");
        let notices = plugins.status_of(ID).unwrap().notices;
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(notices[0].text.contains("共 3 次"), "{}", notices[0].text);
    }

    #[test]
    fn notes_both_sides_added_lines_to_keep_both() {
        let base = "10.01 第一行\n10.02 第二行";
        let ours = "10.01 第一行\n10.02 第二行\n10.05 待办里加的";
        let theirs = "10.01 第一行\n10.03 Excel 里插的\n10.02 第二行\n10.06 Excel 里加的\n10.05 待办里加的";
        assert_eq!(
            merge_note(base, ours, theirs).unwrap(),
            "10.01 第一行\n10.03 Excel 里插的\n10.02 第二行\n10.05 待办里加的\n10.06 Excel 里加的"
        );
        // One side rewrote a line, the other only appended: both stand.
        assert_eq!(
            merge_note(base, "10.01 改过的第一行\n10.02 第二行", "10.01 第一行\n10.02 第二行\n10.07 新的一行").unwrap(),
            "10.01 改过的第一行\n10.02 第二行\n10.07 新的一行"
        );
        // Both rewrote the same line: a real conflict.
        assert_eq!(merge_note(base, "10.01 甲\n10.02 第二行", "10.01 乙\n10.02 第二行"), None);
        let mut kept = Vec::new();
        let mut b = task(1, "2026-10-01T00:00:00.000Z");
        b.note = base.into();
        let mut o = b.clone();
        o.note = ours.into();
        let mut t = b.clone();
        t.note = "10.01 第一行\n10.02 第二行\n10.06 Excel 里加的".into();
        let merged = merge_task(&b, &o, &t, &mut kept);
        assert!(kept.is_empty());
        assert_eq!(merged.note, "10.01 第一行\n10.02 第二行\n10.05 待办里加的\n10.06 Excel 里加的");
    }

    /// The scenarios the weekly report reads back, as JSON for the plugin's own
    /// report tests (`droppen-todo-plugin/test/fixtures/merge-*.json`, copied
    /// from `server-rs/src/tasks/fixtures/`). `DROPPEN_UPDATE_GOLDEN=1` rewrites them.
    fn golden(name: &str, state: &TaskState) {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tasks/fixtures").join(name);
        let text = serde_json::to_string_pretty(state).unwrap() + "\n";
        if std::env::var("DROPPEN_UPDATE_GOLDEN").is_ok() {
            std::fs::write(&file, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text, "{name} is out of date: DROPPEN_UPDATE_GOLDEN=1");
    }

    fn week_base() -> TaskState {
        let mut state = TaskState {
            revision: 10,
            next_id: 4,
            saved_at: "2026-10-01T00:00:00.000Z".into(),
            ..TaskState::default()
        };
        for id in 1..=3 {
            let mut t = task(id, "2026-10-01T00:00:00.000Z");
            t.name = format!("任务 {id}");
            t.note = String::new();
            t.report_topic = String::new();
            state.events.push(TaskEvent {
                task_id: id,
                action: "created".into(),
                at: t.created_at.clone(),
                snapshot: t.clone(),
            });
            state.tasks.push(t);
        }
        state
    }

    /// The plugin completed #003 on 10-06; an older binary, from a ledger that
    /// had not heard, edited its note on 10-07; the merge ran on 10-14. #003
    /// was completed in the week of 10-05, and only in that week.
    #[test]
    fn a_merge_does_not_re_date_a_completion() {
        let base = week_base();
        let mut ours = base.clone();
        ours.revision = 11;
        ours.tasks[2].status = "done".into();
        ours.tasks[2].completed_at = Some("2026-10-06T02:00:00.000Z".to_string()).into();
        ours.tasks[2].updated_at = "2026-10-06T02:00:00.000Z".into();
        ours.events.push(TaskEvent {
            task_id: 3,
            action: "completed".into(),
            at: "2026-10-06T02:00:00.000Z".into(),
            snapshot: ours.tasks[2].clone(),
        });
        let mut theirs = base.clone();
        theirs.revision = 11;
        theirs.tasks[2].note = "10.07 旧版本里加的备注".into();
        theirs.tasks[2].updated_at = "2026-10-07T02:00:00.000Z".into();
        theirs.events.push(TaskEvent {
            task_id: 3,
            action: "edited".into(),
            at: "2026-10-07T02:00:00.000Z".into(),
            snapshot: theirs.tasks[2].clone(),
        });
        let (merged, _) = merge(&base, &ours, &theirs, "2026-10-14T03:00:00.000Z");
        let three = merged.tasks.iter().find(|t| t.id == 3).unwrap();
        assert_eq!((three.status.as_str(), three.note.as_str()), ("done", "10.07 旧版本里加的备注"));
        let completions: Vec<&str> = merged
            .events
            .iter()
            .filter(|e| e.task_id == 3 && e.action == "completed")
            .map(|e| e.at.as_str())
            .collect();
        assert_eq!(completions, ["2026-10-06T02:00:00.000Z"], "never re-dated to the merge");
        assert!(merged.events.iter().all(|e| e.action != "reopened"));
        golden("merge-completion.json", &merged);
    }

    /// Q7: the plugin deleted main task #1 on 10-08; an older binary, from a
    /// ledger before that, added a sub-task to it on 10-09; the merge on 10-14
    /// brings #1 back, and its history says so.
    #[test]
    fn a_task_the_merge_brings_back_is_recorded() {
        let base = week_base();
        let mut ours = base.clone();
        ours.revision = 11;
        let gone = ours.tasks.remove(0);
        ours.events.push(TaskEvent {
            task_id: 1,
            action: "deleted".into(),
            at: "2026-10-08T02:00:00.000Z".into(),
            snapshot: gone,
        });
        let mut theirs = base.clone();
        theirs.revision = 11;
        let mut child = task(4, "2026-10-09T02:00:00.000Z");
        child.name = "旧版本里加的子任务".into();
        child.parent_id = Some(1).into();
        child.note = String::new();
        child.report_topic = String::new();
        theirs.tasks.push(child.clone());
        theirs.next_id = 5;
        theirs.events.push(TaskEvent {
            task_id: 4,
            action: "created".into(),
            at: child.created_at.clone(),
            snapshot: child,
        });
        let (merged, report) = merge(&base, &ours, &theirs, "2026-10-14T03:00:00.000Z");
        assert!(merged.tasks.iter().any(|t| t.id == 1) && merged.tasks.iter().any(|t| t.id == 4));
        assert!(report.fixed.iter().any(|f| f.contains("主任务已恢复")));
        let last = merged.events.iter().filter(|e| e.task_id == 1).max_by(|a, b| a.at.cmp(&b.at)).unwrap();
        assert_eq!((last.action.as_str(), last.at.as_str()), ("restored", "2026-10-14T03:00:00.000Z"));
        golden("merge-restored.json", &merged);
    }

    const NOTICES_KEPT_FOR_TESTS: usize = 20;

    /// The merge reads the store, works the merge out, and commits — and a
    /// write that lands in between (another tab's, already answered 200) must
    /// not be replaced by the merge. It is merged again, with that write in.
    #[test]
    fn a_write_that_lands_during_a_merge_is_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        // The ledger changes while the server runs.
        let mut theirs = workbook::read(&path).unwrap();
        theirs.tasks[0].name = "Excel 里改的名字".into();
        theirs.revision = 43;
        workbook::save(&path, &theirs).unwrap();

        // Tab B's write commits after the merge read the store, before it commits.
        let store = plugins.open_store(ID);
        let b_state = {
            let mut state = stored(&plugins);
            state.next_id = 5;
            state.tasks.push(task(4, "2026-10-19T00:00:00.000Z"));
            state.tasks[2].name = "B 标签页新建的任务".into();
            state
        };
        BETWEEN.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |attempt| {
                if attempt == 0 {
                    let value = split(&b_state).unwrap().remove(0).1;
                    store.put("state", Some(42), value, Some("tab-b")).unwrap();
                }
            }));
        });
        // Tab A's write-back finds the changed ledger and merges.
        write_back(&plugins);
        BETWEEN.with(|hook| *hook.borrow_mut() = None);

        let merged = stored(&plugins);
        assert!(
            merged.tasks.iter().any(|t| t.name == "B 标签页新建的任务"),
            "B's acknowledged task survives the merge"
        );
        assert_eq!(merged.tasks[0].name, "Excel 里改的名字", "and the ledger's edit is in");
        assert!(merged.revision > 43);
        assert_eq!(workbook::read(&path).unwrap(), merged);
        assert_eq!(verify(&plugins).unwrap().difference, None);
    }

    /// One side completes a task, the other adds a line to its note: both stand.
    #[test]
    fn edits_to_different_fields_of_one_task_both_survive() {
        let base = ledger();
        let mut ours = base.clone();
        ours.tasks[0].note.push_str("\n10.20 新加的一行");
        let mut theirs = base.clone();
        theirs.tasks[0].status = "done".into();
        theirs.tasks[0].completed_at = Some("2026-10-19T08:00:00.000Z".to_string()).into();
        let (merged, report) = merge(&base, &ours, &theirs, AT);
        let task = &merged.tasks[0];
        assert_eq!(task.status, "done");
        assert!(task.note.ends_with("新加的一行"));
        assert!(report.kept_ours.is_empty(), "{report:?}");
        let last = merged.events.iter().rev().find(|e| e.task_id == task.id).unwrap();
        assert_eq!(last.snapshot, *task, "the history records what the merge made of it");
    }

    /// R4: the older binary moves a main task to another group and completes
    /// it; the plugin meanwhile reopened one of its sub-tasks and edited its
    /// note. The result is one consistent family.
    #[test]
    fn families_are_consistent_after_a_merge() {
        let mut base = ledger();
        let mut child = task(5, "2026-10-01T00:00:00.000Z");
        child.parent_id = Some(1).into();
        child.status = "done".into();
        child.completed_at = Some("2026-10-02T00:00:00.000Z".to_string()).into();
        base.tasks.push(child);
        base.next_id = 6;
        let mut theirs = base.clone();
        for t in &mut theirs.tasks {
            if t.id == 1 || t.parent_id.0 == Some(1) {
                t.group_id = "g1".into();
            }
            if t.id == 1 {
                t.status = "done".into();
                t.completed_at = Some("2026-10-19T00:00:00.000Z".to_string()).into();
            }
        }
        let mut ours = base.clone();
        let c = ours.tasks.iter_mut().find(|t| t.id == 5).unwrap();
        c.status = "pending".into();
        c.completed_at = None.into();
        c.note = "插件里改的备注".into();
        let (merged, report) = merge(&base, &ours, &theirs, AT);
        let parent = merged.tasks.iter().find(|t| t.id == 1).unwrap();
        let child = merged.tasks.iter().find(|t| t.id == 5).unwrap();
        assert_eq!(
            (parent.group_id.as_str(), child.group_id.as_str()),
            ("g1", "g1"),
            "the child follows its parent's group"
        );
        assert_eq!(child.status, "pending");
        assert_eq!(child.note, "插件里改的备注");
        assert_eq!(parent.status, "pending", "a main task with an open sub-task is open");
        assert!(parent.completed_at.0.is_none());
        assert!(report.fixed.iter().any(|f| f.contains("重新打开")), "{report:?}");
        for t in merged.tasks.iter().filter(|t| [1, 5].contains(&t.id)) {
            let last = merged.events.iter().rev().find(|e| e.task_id == t.id).unwrap();
            assert_eq!(last.snapshot, *t, "#{} is what its history says", t.id);
            assert_ne!(last.action, "reopened", "nothing was reopened at the merge for #{}", t.id);
        }
    }

    #[test]
    fn numbers_both_sides_used_move_but_the_same_task_is_kept_once() {
        let base = ledger();
        let made = |id: u32, name: &str| {
            let mut t = task(id, "2026-10-19T00:00:00.000Z");
            t.name = name.into();
            t
        };
        let mut ours = base.clone();
        ours.tasks.extend([made(4, "两边都有的任务"), made(5, "只在待办里")]);
        ours.next_id = 6;
        let mut theirs = base.clone();
        theirs.tasks.extend([made(4, "两边都有的任务"), made(5, "只在 Excel 里")]);
        theirs.next_id = 6;
        let (merged, report) = merge(&base, &ours, &theirs, AT);
        let names: Vec<(u32, &str)> = merged.tasks.iter().map(|t| (t.id, t.name.as_str())).collect();
        assert_eq!(names[2..], [(4, "两边都有的任务"), (5, "只在待办里"), (6, "只在 Excel 里")]);
        assert_eq!(report.renumbered, 1);
        assert_eq!(merged.next_id, 7);
    }

    #[test]
    fn a_report_the_store_deleted_stays_deleted_and_group_names_stay_unique() {
        let base = ledger();
        let mut ours = base.clone();
        ours.reports.remove("2026-09-28");
        let mut theirs = base.clone();
        theirs.tasks[0].note = "无关的修改".into();
        theirs.groups.push(TaskGroup {
            id: "g-new".into(),
            name: "蓝湾接口平台".into(),
            color: "#000000".into(),
            stage: "active".into(),
            pending_reason: String::new(),
        });
        let (merged, report) = merge(&base, &ours, &theirs, AT);
        assert!(!merged.reports.contains_key("2026-09-28"), "a deletion stands");
        assert!(merged.reports.contains_key("2026-10-05"));
        let names: Vec<&str> = merged.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names.iter().filter(|n| n.starts_with("蓝湾接口平台")).count(), 2);
        assert!(names.contains(&"蓝湾接口平台·2"), "{names:?}");
        assert!(report.fixed.iter().any(|f| f.contains("重名")));
        // But a report the ledger changed comes back, said so.
        let mut theirs = base.clone();
        theirs.reports.get_mut("2026-09-28").unwrap().pending_projects = "Excel 里补的".into();
        let (merged, report) = merge(&base, &ours, &theirs, AT);
        assert_eq!(merged.reports["2026-09-28"].pending_projects, "Excel 里补的");
        assert!(report.kept_ours.iter().any(|k| k.contains("已恢复")));
    }

    /// A write-back that crashed between its bookkeeping and its rename, then
    /// a rollback: the file on disk is the one before, the merge starts from
    /// what that file held, and nothing is duplicated.
    #[test]
    fn a_crash_between_the_bookkeeping_and_the_rename_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = tasks_host(dir.path());
        let path = ledger_path(plugins.instance_dir());
        workbook::save(&path, &ledger()).unwrap();
        plugins.boot();
        let before = std::fs::read(&path).unwrap();

        let mut ours = stored(&plugins);
        ours.next_id = 5;
        let mut made = task(4, "2026-10-19T00:00:00.000Z");
        made.name = "崩溃前的修改".into();
        ours.tasks.push(made);
        CRASH_BEFORE_RENAME.with(|c| c.set(true));
        put_state(&plugins, 42, &ours);
        CRASH_BEFORE_RENAME.with(|c| c.set(false));
        assert_eq!(std::fs::read(&path).unwrap(), before, "the rename never happened");

        // Restarted: the file is the one before the crash — ours, out of date.
        let plugins = tasks_host(dir.path());
        plugins.boot();
        assert!(diverged_copies(&plugins).is_empty(), "not mistaken for somebody else's edit");
        assert_eq!(workbook::read(&path).unwrap().tasks.len(), 3);

        // Again, but this time an older binary edits the stale file first.
        let mut next = stored(&plugins);
        next.tasks[0].note = "又一次修改".into();
        CRASH_BEFORE_RENAME.with(|c| c.set(true));
        put_state(&plugins, next.revision, &next);
        CRASH_BEFORE_RENAME.with(|c| c.set(false));
        let mut theirs = workbook::read(&path).unwrap();
        theirs.tasks[1].name = "旧版本里改的".into();
        theirs.revision += 1;
        workbook::save(&path, &theirs).unwrap();
        let plugins = tasks_host(dir.path());
        plugins.boot();
        let merged = stored(&plugins);
        assert_eq!(merged.tasks.iter().filter(|t| t.name == "崩溃前的修改").count(), 1, "kept once");
        assert!(merged.tasks.iter().any(|t| t.name == "旧版本里改的"));
        assert_eq!(merged.tasks[0].note, "又一次修改");
        assert_eq!(workbook::read(&path).unwrap(), merged);
    }

    /// The real ledgers, read from copies: `DROPPEN_LEDGER_COPY=<xlsx>[:<xlsx>…]
    /// cargo test --lib plugins::legacy_tasks::tests::a_real_ledger -- --ignored --nocapture`.
    /// Prints counts only.
    #[test]
    #[ignore = "reads ledger copies named by DROPPEN_LEDGER_COPY"]
    fn a_real_ledger_imports_verifies_and_survives_an_export_round_trip() {
        let copies = std::env::var("DROPPEN_LEDGER_COPY").expect("DROPPEN_LEDGER_COPY");
        for copy in copies.split(':').filter(|s| !s.is_empty()) {
            let dir = tempfile::tempdir().unwrap();
            let plugins = tasks_host(dir.path());
            let path = ledger_path(plugins.instance_dir());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::copy(copy, &path).unwrap();
            let source = workbook::read(&path).expect("the copy reads");
            let started = std::time::Instant::now();
            plugins.boot();
            let took = started.elapsed();
            let enabled = plugins.is_enabled(ID);
            if source.tasks.is_empty() {
                println!(
                    "{copy}: ledger {}; auto-enable {enabled} (no tasks); store made: {}; decision: {:?}",
                    Counts::of(&serde_json::to_value(&source).unwrap()),
                    plugins.store_path(ID).exists(),
                    plugins.decision(ID),
                );
                assert!(!enabled && !plugins.dir(ID).exists() && plugins.decision(ID).is_none());
                continue;
            }
            let verified = verify(&plugins).expect("verify");
            let store = plugins.open_store(ID);
            println!(
                "{copy}: ledger {}; auto-enable {} ({} tasks); import {:?}; store {} ({} event docs, {} report docs, {} docs, {} bytes); deep compare: {}",
                verified.ledger,
                enabled,
                source.tasks.len(),
                took,
                verified.store,
                verified.event_docs,
                verified.report_docs,
                store.count().unwrap(),
                store.bytes().unwrap(),
                verified.difference.as_deref().unwrap_or("identical"),
            );
            assert_eq!(verified.difference, None);
            assert_eq!(enabled, !source.tasks.is_empty());

            let export = store.export(&droppen_plugin_sdk::PluginId::new(ID).unwrap()).unwrap();
            let json = serde_json::to_string(&export).unwrap();
            let again: droppen_plugin_sdk::StoreExport = serde_json::from_str(&json).unwrap();
            let other_dir = tempfile::tempdir().unwrap();
            let other = tasks_host(other_dir.path());
            let restored = other
                .open_store(ID)
                .replace_all(again.docs, super::super::store::ImportScope::all(false), None, &[], |_| Ok(()))
                .unwrap();
            let difference = first_difference(&serde_json::to_value(&source).unwrap(), &assemble(&restored).unwrap());
            println!(
                "{copy}: export {} docs, {} bytes of JSON; re-import compare: {}",
                export.docs.len(),
                json.len(),
                difference.as_deref().unwrap_or("identical")
            );
            assert_eq!(difference, None);

            let started = std::time::Instant::now();
            write_back(&plugins);
            println!("{copy}: one write-back {:?}", started.elapsed());
            assert_eq!(plugins.status_of(ID).unwrap().notice, None);
            assert_eq!(workbook::read(&path).unwrap(), source, "the write-back reads as the ledger it came from");
        }
    }
}
