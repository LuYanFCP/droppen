//! `remote-hand-server plugin list|enable|disable|export|import|verify|purge`.
//!
//! Safe while a server runs, for the reason `user` is: the switches live in
//! the instance's `state.db` and each store is its own SQLite file, so SQLite
//! arbitrates between this process and the server, and no instance lock is
//! taken. A running server reads the switch on every request, so `enable` and
//! `disable` take effect at once; it is not told about documents this writes
//! until a client next reads them.
//!
//! The instance is chosen exactly as `user` chooses it — `--instance`, else
//! `$APP_INSTANCE`, else `default`, and a defaulted instance that does not
//! exist is a refusal — and named in every line of output.

use std::path::Path;

use droppen_plugin_sdk::{valid_id, PluginId, StoreExport, EXPORT_FORMAT};
use serde_json::json;

use super::{embedded_manifest, legacy_tasks, store, DecisionReason, PluginError, Plugins, StoreError};
use crate::sessions::Paths;

/// What to print when the subcommand does not parse.
pub const USAGE: &str = "\
USAGE:
    remote-hand-server plugin list                              [--instance <name>]
    remote-hand-server plugin enable  <id>                      [--instance <name>]
    remote-hand-server plugin disable <id>                      [--instance <name>]
    remote-hand-server plugin export  <id> [--out <file>]       [--instance <name>]
    remote-hand-server plugin import  <id> [<file>] [--replace] [--instance <name>]
    remote-hand-server plugin verify  <id>                      [--instance <name>]
    remote-hand-server plugin purge   <id> --yes                [--instance <name>]

`list` shows the plugins this binary bundles and whether each is on for the
instance. `enable`/`disable` switch one for the instance (the configuration's
[plugins] enable/disable, or APP_PLUGINS__ENABLE/DISABLE, win over both).
`export` writes the plugin's documents as JSON (to stdout without --out);
`import` restores such a file, refusing over existing documents unless
--replace, which keeps the replaced values in their history. `import tasks`
without a file imports the instance's old Excel task ledger again, and
`verify tasks` compares the plugin's store with that ledger. `purge` moves a
plugin's data aside to plugins/<id>.purged-<time>/; the plugin must be off.

Safe while the server runs.";

#[derive(Debug, PartialEq, Eq)]
enum Action {
    List,
    Enable(String),
    Disable(String),
    Export { id: String, out: Option<String> },
    Import { id: String, file: Option<String>, replace: bool },
    Verify(String),
    Purge(String),
}

fn parse(args: &[String]) -> Result<Action, String> {
    let usage = || USAGE.to_string();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let id = |word: Option<&&str>| -> Result<String, String> {
        let id = word.ok_or_else(usage)?;
        if valid_id(id) {
            Ok(id.to_string())
        } else {
            Err(format!(
                "{id:?} is not a plugin id: 2-32 characters of a-z, 0-9 or '-', starting with a letter"
            ))
        }
    };
    match words.as_slice() {
        ["list"] => Ok(Action::List),
        ["enable", _] => Ok(Action::Enable(id(words.get(1))?)),
        ["disable", _] => Ok(Action::Disable(id(words.get(1))?)),
        ["export", _] => Ok(Action::Export {
            id: id(words.get(1))?,
            out: None,
        }),
        ["export", _, "--out", out] => Ok(Action::Export {
            id: id(words.get(1))?,
            out: Some(out.to_string()),
        }),
        ["import", _, rest @ ..] => {
            let replace = rest.contains(&"--replace");
            let files: Vec<&&str> = rest.iter().filter(|word| **word != "--replace").collect();
            if files.len() > 1 || files.iter().any(|word| word.starts_with("--")) {
                return Err(usage());
            }
            Ok(Action::Import {
                id: id(words.get(1))?,
                file: files.first().map(|file| file.to_string()),
                replace,
            })
        }
        ["verify", _] => Ok(Action::Verify(id(words.get(1))?)),
        ["purge", _, "--yes"] => Ok(Action::Purge(id(words.get(1))?)),
        ["purge", _] => Err("purge moves the plugin's data aside; say --yes to mean it".to_string()),
        _ => Err(usage()),
    }
}

/// Run a `plugin` subcommand. `args` is everything after `plugin`.
pub async fn run(args: &[String]) -> Result<(), String> {
    let (args, instance) = crate::auth::cli::take_instance(args)?;
    let action = parse(&args)?;
    let paths = crate::auth::cli::home_paths(instance.as_deref())?;
    let config = crate::config::load(std::env::var("GOTCHA_ACTIVE_PROFILE").ok()).map_err(|error| error.to_string())?;
    let plugins = Plugins::new(paths.instance_dir(), paths.instance_db(), embedded_manifest(), &config.app.plugins, None);
    tokio::task::spawn_blocking(move || execute(&plugins, &paths, action))
        .await
        .map_err(|error| error.to_string())?
}

fn refusal(error: PluginError) -> String {
    match error {
        PluginError::Store(StoreError::NotEmpty(count)) => {
            format!("the store already holds {count} documents; add --replace to replace them (the replaced values are kept in their history)")
        }
        other => other.to_string(),
    }
}

fn execute(plugins: &Plugins, paths: &Paths, action: Action) -> Result<(), String> {
    let instance = paths.instance();
    match action {
        Action::List => {
            let statuses = plugins.status();
            if statuses.is_empty() {
                println!("this build bundles no plugins (instance {instance})");
                return Ok(());
            }
            println!("instance {instance}:");
            for status in statuses {
                let state = if status.enabled { "on" } else { "off" };
                let pinned = if status.forced { ", pinned by the configuration" } else { "" };
                let stored = match plugins.existing_store(status.id.as_str()) {
                    Some(store) => format!(", {} documents", store.count().map_err(|e| e.to_string())?),
                    None => String::new(),
                };
                println!("  {} {} — {state}{pinned}{stored}", status.id, status.version);
                if let Some(reason) = status.reason {
                    println!("      {reason}");
                }
                if let Some(notice) = status.notice {
                    println!("      ! {notice}");
                }
            }
            Ok(())
        }
        Action::Enable(id) | Action::Disable(id) if plugins.manifest(&id).is_none() => {
            Err(format!("this build bundles no plugin {id:?} (instance {instance})"))
        }
        Action::Enable(id) => {
            let status = plugins.set_enabled(&id, true, None, DecisionReason::Cli).map_err(refusal)?;
            println!("{id} is {} on instance {instance}", if status.enabled { "on" } else { "still off" });
            if let Some(reason) = status.reason {
                println!("  {reason}");
            }
            // Switching tasks on takes in its Excel ledger (or what changed in
            // it while the plugin was off) before anything can overwrite it.
            if let Some(notice) = plugins.status_of(&id).and_then(|status| status.notice) {
                println!("  ! {notice}");
            }
            Ok(())
        }
        Action::Disable(id) => {
            plugins.set_enabled(&id, false, None, DecisionReason::Cli).map_err(refusal)?;
            println!("{id} is off on instance {instance}; its data is kept ({})", plugins.dir(&id).display());
            Ok(())
        }
        Action::Export { id, out } => {
            let store = plugins
                .existing_store(&id)
                .ok_or_else(|| format!("plugin {id} has no store on instance {instance} ({})", plugins.store_path(&id).display()))?;
            let export = store
                .export(&PluginId::new(id.clone()).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())? + "\n";
            match out {
                Some(out) => {
                    write_private(Path::new(&out), json.as_bytes())?;
                    println!("exported {} documents of {id} on instance {instance} to {out}", export.docs.len());
                }
                None => {
                    print!("{json}");
                    eprintln!("exported {} documents of {id} on instance {instance}", export.docs.len());
                }
            }
            Ok(())
        }
        Action::Import { id, .. } if plugins.manifest(&id).is_none() => Err(format!("this build bundles no plugin {id:?} (instance {instance})")),
        Action::Import { id, file: None, replace } => {
            if id != legacy_tasks::ID {
                return Err("import without a file only means the old Excel task ledger: plugin import tasks".to_string());
            }
            let imported = legacy_tasks::import(plugins, replace).map_err(|error| {
                if error.contains("already holds") {
                    format!("{error}; add --replace to replace them (the replaced values are kept in their history)")
                } else {
                    error
                }
            })?;
            println!(
                "imported the Excel task ledger into {id} on instance {instance}: {} in {} documents; the ledger was not changed",
                imported.counts, imported.docs
            );
            Ok(())
        }
        Action::Import {
            id,
            file: Some(file),
            replace,
        } => {
            let text = std::fs::read_to_string(&file).map_err(|error| format!("cannot read {file}: {error}"))?;
            let export: StoreExport = serde_json::from_str(&text).map_err(|error| format!("{file} is not a plugin export: {error}"))?;
            if export.format != EXPORT_FORMAT {
                return Err(format!("{file} is in format {:?}; this binary reads {EXPORT_FORMAT}", export.format));
            }
            if export.plugin.as_str() != id {
                return Err(format!("{file} holds the documents of {}, not {id}", export.plugin));
            }
            let expected: Vec<(String, serde_json::Value)> = export.docs.iter().map(|doc| (doc.name.clone(), doc.value.clone())).collect();
            let origin = json!({ "path": file, "exportedAt": export.exported_at, "at": store::now() }).to_string();
            let stored = plugins
                .open_store(&id)
                .replace_all(
                    export.docs,
                    super::store::ImportScope::all(replace),
                    None,
                    &[("restored_from", origin)],
                    |stored| {
                        let mut got: Vec<(String, serde_json::Value)> = stored.iter().map(|doc| (doc.name.clone(), doc.value.clone())).collect();
                        let mut want = expected.clone();
                        got.sort_by(|a, b| a.0.cmp(&b.0));
                        want.sort_by(|a, b| a.0.cmp(&b.0));
                        if got == want {
                            Ok(())
                        } else {
                            Err("the store does not read back as the export".to_string())
                        }
                    },
                )
                .map_err(|error| refusal(error.into()))?;
            println!("imported {} documents into {id} on instance {instance} from {file}", stored.len());
            if id == legacy_tasks::ID {
                legacy_tasks::write_back(plugins);
                if let Some(notice) = plugins.status_of(&id).and_then(|status| status.notice) {
                    println!("  ! {notice}");
                }
            }
            if !plugins.is_enabled(&id) {
                let hint = format!("  {id} is off on this instance; turn it on with: remote-hand-server plugin enable {id} --instance {instance}");
                println!("{}", crate::program::Name::invoked().rewrite(&hint));
            }
            Ok(())
        }
        Action::Verify(id) if id == legacy_tasks::ID => {
            let verified = legacy_tasks::verify(plugins)?;
            println!("instance {instance}, plugin {id}:");
            println!(
                "  store:  {} ({} event documents, {} report documents)",
                verified.store, verified.event_docs, verified.report_docs
            );
            println!("  ledger: {}", verified.ledger);
            println!(
                "  the ledger on disk is {}",
                if verified.in_step {
                    "the file the plugin last wrote"
                } else {
                    "NOT the file the plugin last wrote: the next write-back keeps a copy and merges it"
                }
            );
            match verified.difference {
                None => {
                    println!("  identical");
                    Ok(())
                }
                Some(path) => Err(format!("the store and the ledger differ, first at {path}")),
            }
        }
        Action::Verify(id) => {
            let store = plugins
                .existing_store(&id)
                .ok_or_else(|| format!("plugin {id} has no store on instance {instance}"))?;
            let integrity = store.integrity().map_err(|e| e.to_string())?;
            let count = store.count().map_err(|e| e.to_string())?;
            let bytes = store.bytes().map_err(|e| e.to_string())?;
            store.all().map_err(|e| e.to_string())?;
            println!("instance {instance}, plugin {id}: {count} documents, {bytes} bytes of JSON, integrity {integrity}");
            if integrity == "ok" {
                Ok(())
            } else {
                Err(format!("the store's integrity check failed: {integrity}"))
            }
        }
        Action::Purge(id) => {
            if plugins.is_enabled(&id) {
                return Err(format!(
                    "{id} is on for instance {instance}; turn it off first (remote-hand-server plugin disable {id}), or take it out of [plugins] enable"
                ));
            }
            let dir = plugins.dir(&id);
            if !dir.exists() {
                println!("{id} has no data on instance {instance}; nothing to purge");
                return Ok(());
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_secs())
                .unwrap_or_default();
            let aside = plugins.instance_dir().join("plugins").join(format!("{id}.purged-{stamp}"));
            std::fs::rename(&dir, &aside).map_err(|error| format!("cannot move {} aside: {error}", dir.display()))?;
            crate::db::forget(&plugins.store_path(&id));
            println!("moved {id}'s data on instance {instance} to {}", aside.display());
            Ok(())
        }
    }
}

/// Write `0600`, through a temporary file renamed into place.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let temp = dir.join(format!(".plugin-export-{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    };
    write().map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("cannot write {}: {error}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PluginSettings;
    use crate::plugins::tests::{host, manifest};

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn the_subcommands_parse_and_anything_else_is_the_usage() {
        assert_eq!(parse(&args("list")), Ok(Action::List));
        assert_eq!(parse(&args("enable tasks")), Ok(Action::Enable("tasks".into())));
        assert_eq!(
            parse(&args("export tasks --out /tmp/x.json")),
            Ok(Action::Export {
                id: "tasks".into(),
                out: Some("/tmp/x.json".into())
            })
        );
        assert_eq!(
            parse(&args("import tasks --replace")),
            Ok(Action::Import {
                id: "tasks".into(),
                file: None,
                replace: true
            })
        );
        assert_eq!(
            parse(&args("import tasks backup.json --replace")),
            Ok(Action::Import {
                id: "tasks".into(),
                file: Some("backup.json".into()),
                replace: true
            })
        );
        assert_eq!(parse(&args("purge tasks --yes")), Ok(Action::Purge("tasks".into())));
        assert!(parse(&args("purge tasks")).unwrap_err().contains("--yes"));
        assert!(parse(&args("enable ../x")).unwrap_err().contains("not a plugin id"));
        for bad in [
            "",
            "list extra",
            "enable",
            "import tasks a b",
            "import tasks --force",
            "export tasks --out",
        ] {
            assert_eq!(parse(&args(bad)), Err(USAGE.to_string()), "{bad:?}");
        }
    }

    #[test]
    fn purge_wants_the_plugin_off_and_moves_its_data_aside() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = host(dir.path(), vec![manifest("notes", true)], PluginSettings::default(), None);
        let paths = Paths::new(dir.path().to_path_buf());
        plugins
            .put(
                "notes",
                "a",
                droppen_plugin_sdk::PutDoc {
                    expected_revision: None,
                    value: json!(1),
                },
                None,
            )
            .unwrap();
        assert!(execute(&plugins, &paths, Action::Purge("notes".into()))
            .unwrap_err()
            .contains("turn it off"));
        execute(&plugins, &paths, Action::Disable("notes".into())).unwrap();
        execute(&plugins, &paths, Action::Purge("notes".into())).unwrap();
        assert!(!plugins.dir("notes").exists());
        let moved: Vec<String> = std::fs::read_dir(plugins.instance_dir().join("plugins"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(moved.len() == 1 && moved[0].starts_with("notes.purged-"), "{moved:?}");
        execute(&plugins, &paths, Action::Purge("notes".into())).expect("nothing left to purge is not an error");
    }

    #[test]
    fn an_export_imports_back_and_refuses_to_overwrite_without_replace() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = host(dir.path(), vec![manifest("notes", true)], PluginSettings::default(), None);
        let paths = Paths::new(dir.path().to_path_buf());
        for name in ["state", "events/2026-10"] {
            plugins
                .put(
                    "notes",
                    name,
                    droppen_plugin_sdk::PutDoc {
                        expected_revision: None,
                        value: json!({ "name": name }),
                    },
                    None,
                )
                .unwrap();
        }
        let file = dir.path().join("notes.json");
        execute(
            &plugins,
            &paths,
            Action::Export {
                id: "notes".into(),
                out: Some(file.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        let import = |replace| Action::Import {
            id: "notes".into(),
            file: Some(file.to_string_lossy().into_owned()),
            replace,
        };
        assert!(execute(&plugins, &paths, import(false)).unwrap_err().contains("--replace"));
        execute(&plugins, &paths, import(true)).unwrap();
        let state = plugins.get("notes", "state").unwrap();
        assert_eq!(state.revision, 2, "a replaced document moves forward");
        assert_eq!(plugins.history("notes", "state", 0, None).unwrap().versions.len(), 1);

        let other_dir = tempfile::tempdir().unwrap();
        let other = host(other_dir.path(), vec![manifest("notes", true)], PluginSettings::default(), None);
        execute(&other, &paths, import(false)).unwrap();
        assert_eq!(
            other.get("notes", "events/2026-10").unwrap().revision,
            1,
            "an empty store takes the export as it is"
        );
    }
}
