//! ACP sessions end to end, against a stand-in ACP agent.
//!
//! The stand-in (`support/fake_acp_agent.py`) speaks the ACP the driver uses and
//! writes down everything it is sent, in the session's working directory. It
//! is configured the way a user configures a real agent: through
//! `PUT /api/acp/settings`, with an absolute executable, its arguments and a
//! variable of its own — so these tests never touch `PATH`.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::TestServer;
use serde_json::{json, Value};

const FAKE_AGENT: &str = include_str!("support/fake_acp_agent.py");
const SESSION: &str = "f00dfeed0123456789abcdef01234567";

/// The stand-in, written into `home` and made executable.
fn install_fake(home: &Path) -> PathBuf {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).expect("bin dir");
    let path = bin.join("fake-agent");
    std::fs::write(&path, FAKE_AGENT).expect("fake agent");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

/// Point the server at the stand-in, with one variable of the user's own.
async fn configure(server: &TestServer, program: &Path) {
    let (status, body) = server
        .json(
            "PUT",
            "/api/acp/settings",
            &json!({
                "name": "Fake agent",
                "command": program.to_string_lossy(),
                "args": ["--acp", "--stdio"],
                "env": "FAKE_AGENT_MARK=from-settings",
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let settings: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(settings["envNames"], json!(["FAKE_AGENT_MARK"]));
    assert_eq!(settings["name"], "Fake agent");
    assert!(!body.contains("from-settings"), "a value is never sent back: {body}");
}

/// What the stand-in was sent, in order.
fn calls(workdir: &Path) -> Vec<Value> {
    std::fs::read_to_string(workdir.join("agent-calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).expect("call"))
        .collect()
}

/// Poll the session's detail until `done` says so.
async fn wait_for(server: &TestServer, id: &str, what: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let (status, body) = server.get(&format!("/api/sessions/acp/{id}")).await;
        if status == 200 {
            let detail: Value = serde_json::from_str(&body).expect("json");
            if done(&detail) {
                return detail;
            }
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}: {detail:#}");
        } else {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}: {status} {body}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn texts(detail: &Value) -> Vec<(String, String, String)> {
    detail["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| {
            (
                item["role"].as_str().unwrap_or_default().to_string(),
                item["kind"].as_str().unwrap_or_default().to_string(),
                item["text"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

fn finished(detail: &Value) -> bool {
    detail["injection"]["state"] != "running" && !detail["injection"].is_null()
}

fn item(role: &str, kind: &str, text: &str) -> (String, String, String) {
    (role.into(), kind.into(), text.into())
}

#[tokio::test]
async fn an_acp_session_is_created_streamed_interrupted_reopened_and_archived() {
    let home = tempfile::tempdir().expect("tempdir");
    let program = install_fake(home.path());
    let workdir = home.path().join("work");
    std::fs::create_dir_all(&workdir).expect("workdir");

    let server = TestServer::start_at(home.path(), None).await;
    configure(&server, &program).await;

    // A new session: the agent names it, and the first turn is on screen.
    let (status, body) = server
        .json("POST", "/api/sessions/new", &json!({"source": "acp", "cwd": workdir, "text": "hi there"}))
        .await;
    assert_eq!(status, 200, "{body}");
    let id = serde_json::from_str::<Value>(&body).expect("json")["id"]
        .as_str()
        .expect("id")
        .to_string();
    assert_eq!(id, SESSION);
    let detail = wait_for(&server, &id, "the first turn", finished).await;
    assert_eq!(detail["injection"]["state"], "ok", "{detail:#}");
    assert_eq!(
        texts(&detail),
        vec![
            item("user", "text", "hi there"),
            item("assistant", "thinking", "Thinking about hi there"),
            item("assistant", "tool_use", "echo hi"),
            item("user", "tool_result", "hi"),
            item("assistant", "text", "Hello from the agent"),
        ]
    );
    assert_eq!(detail["summary"]["scope"], "owned");
    assert_eq!(detail["summary"]["title"], "hi there");
    assert_eq!(detail["canSend"], true);
    assert_eq!(
        (detail["contextTokens"].as_u64(), detail["contextWindow"].as_u64()),
        (Some(4020), Some(128000)),
        "the agent's own usage reading"
    );

    let sent = calls(&workdir);
    let methods: Vec<&str> = sent.iter().map(|call| call["method"].as_str().unwrap_or_default()).collect();
    assert_eq!(methods, vec!["initialize", "session/new", "session/prompt"]);
    assert_eq!(
        sent[1]["params"]["cwd"],
        json!(workdir.canonicalize().unwrap()),
        "the agent runs where it was asked to"
    );
    assert!(
        sent.iter().all(|call| call["mark"] == "from-settings"),
        "the configured environment reaches the agent"
    );

    // It lists with the other sessions.
    let list = server.get_json("/api/sessions?source=acp").await;
    assert_eq!(list["sessions"][0]["id"], json!(SESSION), "{list:#}");

    // A second message goes to the same process.
    let (status, body) = server
        .json("POST", &format!("/api/sessions/acp/{id}/message"), &json!({"text": "again"}))
        .await;
    assert_eq!(status, 200, "{body}");
    let detail = wait_for(&server, &id, "the second turn", |detail| texts(detail).len() == 10 && finished(detail)).await;
    assert_eq!(texts(&detail)[5], item("user", "text", "again"));
    assert_eq!(
        calls(&workdir).iter().filter(|call| call["method"] == "initialize").count(),
        1,
        "one process"
    );

    // A turn that does not end on its own is stopped from here.
    server
        .json("POST", &format!("/api/sessions/acp/{id}/message"), &json!({"text": "wait for me"}))
        .await;
    wait_for(&server, &id, "the long turn to start", |detail| detail["injection"]["state"] == "running").await;
    wait_for(&server, &id, "the long turn to stream", |detail| {
        texts(detail).last().is_some_and(|last| last.2 == "Working on it")
    })
    .await;
    let (status, body) = server.json("POST", &format!("/api/sessions/acp/{id}/interrupt"), &json!({})).await;
    assert_eq!(status, 200, "{body}");
    let detail = wait_for(&server, &id, "the interruption", finished).await;
    assert_eq!(detail["injection"]["interrupted"], true, "{detail:#}");
    assert_eq!(texts(&detail).last(), Some(&item("system", "text", "Interrupted")));
    assert!(calls(&workdir).iter().any(|call| call["method"] == "session/cancel"));

    // A restart loses the process, not the session: the next message reopens
    // it, and the agent's replay is not written over the transcript that has it.
    server.stop().await;
    let server = TestServer::start_at(home.path(), None).await;
    let before = texts(&server.get_json(&format!("/api/sessions/acp/{id}")).await).len();
    let (status, body) = server
        .json("POST", &format!("/api/sessions/acp/{id}/message"), &json!({"text": "still there?"}))
        .await;
    assert_eq!(status, 200, "{body}");
    let detail = wait_for(&server, &id, "the reopened turn", |detail| {
        texts(detail).len() == before + 5 && finished(detail)
    })
    .await;
    assert!(
        !texts(&detail).iter().any(|item| item.2 == "an old answer"),
        "the replay is not duplicated"
    );
    let load = calls(&workdir)
        .into_iter()
        .find(|call| call["method"] == "session/load")
        .expect("reopened with session/load");
    assert_eq!(load["params"]["sessionId"], json!(SESSION));

    // Archived, it leaves the list.
    let (status, body) = server.json("POST", &format!("/api/sessions/acp/{id}/archive"), &json!({})).await;
    assert_eq!(status, 200, "{body}");
    let list = server.get_json("/api/sessions?source=acp").await;
    assert_eq!(list["sessions"], json!([]), "{list:#}");
    server.stop().await;
}

#[tokio::test]
async fn a_session_this_server_lost_is_given_the_agents_own_history() {
    let home = tempfile::tempdir().expect("tempdir");
    let program = install_fake(home.path());
    let workdir = home.path().join("work");
    std::fs::create_dir_all(&workdir).expect("workdir");
    let server = TestServer::start_at(home.path(), None).await;
    configure(&server, &program).await;

    // A transcript with nothing in it but where the session ran: what is left
    // when the conversation this server wrote down is gone.
    let dir = server.paths.acp_sessions(remote_hand_server::sessions::Source::Acp);
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(
        dir.join(format!("{SESSION}.jsonl")),
        format!(
            "{}\n",
            json!({"type": "session", "id": SESSION, "cwd": workdir, "timestamp": "2026-10-01T10:00:00.000Z"})
        ),
    )
    .expect("transcript");

    let (status, body) = server
        .json("POST", &format!("/api/sessions/acp/{SESSION}/message"), &json!({"text": "remember?"}))
        .await;
    assert_eq!(status, 200, "{body}");
    let detail = wait_for(&server, SESSION, "the turn", finished).await;
    let texts = texts(&detail);
    assert_eq!(texts[0], item("user", "text", "an old question"));
    assert_eq!(texts[1], item("assistant", "text", "an old answer"));
    assert_eq!(texts[2], item("user", "text", "remember?"));
    server.stop().await;
}

#[tokio::test]
async fn what_the_agent_cannot_do_is_refused_before_it_starts() {
    let home = tempfile::tempdir().expect("tempdir");
    let workdir = home.path().join("work");
    std::fs::create_dir_all(&workdir).expect("workdir");
    let server = TestServer::start_at(home.path(), None).await;

    // No agent configured is a refusal that says what to do.
    let (status, body) = server
        .json("POST", "/api/sessions/new", &json!({"source": "acp", "cwd": workdir, "text": "hi"}))
        .await;
    assert_ne!(status, 200, "{body}");
    assert!(body.contains("no ACP agent is configured"), "{body}");

    // So is an executable that is not there.
    let (status, _) = server
        .json(
            "PUT",
            "/api/acp/settings",
            &json!({"command": home.path().join("no-such-agent").to_string_lossy()}),
        )
        .await;
    assert_eq!(status, 200);
    let (status, body) = server
        .json("POST", "/api/sessions/new", &json!({"source": "acp", "cwd": workdir, "text": "hi"}))
        .await;
    assert_ne!(status, 200, "{body}");
    assert!(body.contains("ACP agent"), "{body}");

    // Settings the agent does not have are not silently dropped.
    let program = install_fake(home.path());
    configure(&server, &program).await;
    let (status, body) = server
        .json(
            "POST",
            "/api/sessions/new",
            &json!({"source": "acp", "cwd": workdir, "text": "hi", "permission": "auto"}),
        )
        .await;
    assert_ne!(status, 200, "{body}");
    assert!(calls(&workdir).is_empty(), "nothing was started");

    // And an environment block that would move the child is refused.
    let (status, _) = server.json("PUT", "/api/acp/settings", &json!({"env": "PATH=/tmp"})).await;
    assert_eq!(status, 400);
    server.stop().await;
}

#[tokio::test]
async fn models_and_efforts_come_from_the_agent_and_are_set_before_the_turn() {
    let home = tempfile::tempdir().expect("tempdir");
    let program = install_fake(home.path());
    let workdir = home.path().join("work");
    std::fs::create_dir_all(&workdir).expect("workdir");
    // A probe runs in a scratch directory that is gone afterwards, so the
    // stand-in logs where the test can read it.
    let log = home.path().join("probe-calls.jsonl");
    let server = TestServer::start_at(home.path(), None).await;
    let (status, body) = server
        .json(
            "PUT",
            "/api/acp/settings",
            &json!({
                "command": program.to_string_lossy(),
                "args": ["--acp", "--stdio"],
                "env": format!("FAKE_AGENT_LOG={}", log.display()),
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let log_calls = || -> Vec<String> {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .map(|line| {
                serde_json::from_str::<Value>(line).expect("call")["method"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    };

    // The list is the agent's own, read by a probe that leaves no session behind.
    let models = server.get_json("/api/models?source=acp").await;
    assert_eq!(models["source"], "cache", "{models:#}");
    let ids: Vec<&str> = models["models"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["fake:small", "openrouter:vendor/big"]);
    assert_eq!(models["models"][1]["label"], "Big");
    assert_eq!(models["models"][0]["efforts"], json!(["auto", "low", "high"]));
    assert_eq!(models["models"][0]["defaultEffort"], "auto");
    assert_eq!(
        log_calls(),
        vec!["initialize", "session/new", "session/close"],
        "the probe closes what it opened"
    );

    // Asked again, it is remembered rather than probed.
    server.get_json("/api/models?source=acp").await;
    assert_eq!(log_calls().iter().filter(|m| *m == "initialize").count(), 1);

    // A start that picks both sets both, before the turn.
    let (status, body) = server
        .json(
            "POST",
            "/api/sessions/new",
            &json!({"source": "acp", "cwd": workdir, "text": "hi", "model": "openrouter:vendor/big", "effort": "high"}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let id = serde_json::from_str::<Value>(&body).expect("json")["id"]
        .as_str()
        .expect("id")
        .to_string();
    let detail = wait_for(&server, &id, "the first turn", finished).await;
    assert_eq!(detail["injection"]["state"], "ok", "{detail:#}");
    assert_eq!(detail["cliChoice"]["model"], "openrouter:vendor/big");
    assert_eq!(detail["cliChoice"]["effort"], "high");
    let turn: Vec<(String, String)> = log_calls()
        .into_iter()
        .skip(3)
        .zip(
            std::fs::read_to_string(&log)
                .unwrap()
                .lines()
                .skip(3)
                .map(|line| {
                    let call: Value = serde_json::from_str(line).unwrap();
                    call["params"]["configId"].as_str().unwrap_or_default().to_string()
                })
                .collect::<Vec<_>>(),
        )
        .collect();
    let methods: Vec<&str> = turn.iter().map(|(method, _)| method.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "initialize",
            "session/new",
            "session/set_config_option",
            "session/set_config_option",
            "session/prompt"
        ]
    );
    assert_eq!((turn[2].1.as_str(), turn[3].1.as_str()), ("model", "reasoning_effort"));

    // Only what changed is set again.
    let before = log_calls().len();
    server
        .json(
            "POST",
            &format!("/api/sessions/acp/{id}/message"),
            &json!({"text": "again", "model": "openrouter:vendor/big", "effort": "low"}),
        )
        .await;
    let detail = wait_for(&server, &id, "the second turn", |d| texts(d).len() >= 4 && finished(d)).await;
    assert_eq!(detail["cliChoice"]["effort"], "low");
    assert_eq!(log_calls()[before..], ["session/set_config_option", "session/prompt"]);
    // A switched session is nobody else's default: a new one still starts on the agent's.
    let models = server.get_json("/api/models?source=acp").await;
    assert_eq!(models["models"][0]["defaultEffort"], "auto", "{models:#}");

    // What the agent does not offer is refused before anything is sent.
    let before = log_calls().len();
    let (status, body) = server
        .json(
            "POST",
            &format!("/api/sessions/acp/{id}/message"),
            &json!({"text": "x", "model": "not-a-model"}),
        )
        .await;
    assert_ne!(status, 200, "{body}");
    assert!(body.contains("not-a-model"), "{body}");
    let (status, body) = server
        .json(
            "POST",
            &format!("/api/sessions/acp/{id}/message"),
            &json!({"text": "x", "permission": "auto"}),
        )
        .await;
    assert_ne!(status, 200, "{body}");
    assert_eq!(log_calls().len(), before);

    // New settings may mean another configuration: the next list is probed afresh.
    server
        .json(
            "PUT",
            "/api/acp/settings",
            &json!({"env": format!("FAKE_AGENT_LOG={}\nFAKE_AGENT_MARK=changed", log.display())}),
        )
        .await;
    let initializes = log_calls().iter().filter(|m| *m == "initialize").count();
    server.get_json("/api/models?source=acp").await;
    assert_eq!(log_calls().iter().filter(|m| *m == "initialize").count(), initializes + 1);
    server.stop().await;
}
