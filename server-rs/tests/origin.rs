//! The `/api/*` origin guard, from the outside.
//!
//! This is a security boundary, not a convenience: the filesystem routes can
//! read anything under `$HOME` and write into it, so a page on another origin
//! must not be able to reach them even though the browser will happily send the
//! request. What the tests pin down is therefore the *refusal* as much as the
//! allowance — including that a tool with no `Origin` at all is unaffected.

mod common;

use serde_json::Value;

/// Case-insensitive header lookup over a raw response head.
fn header(head: &str, name: &str) -> Option<String> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
}

#[tokio::test]
async fn a_request_without_an_origin_is_untouched() {
    let server = common::TestServer::start().await;
    let (status, head, _) = server.request_full("GET", "/api/settings", &[], &[]).await;
    assert_eq!(status, 200, "curl and the tests send no Origin at all");
    assert!(
        header(&head, "access-control-allow-origin").is_none(),
        "there is no origin to allow, so nothing is echoed"
    );
    server.stop().await;
}

#[tokio::test]
async fn a_same_host_origin_is_allowed_and_echoed() {
    let server = common::TestServer::start().await;
    let origin = format!("http://{}", server.addr);
    let (status, head, _) = server.request_full("GET", "/api/settings", &[("Origin", &origin)], &[]).await;

    assert_eq!(status, 200);
    assert_eq!(header(&head, "access-control-allow-origin").as_deref(), Some(origin.as_str()));
    assert!(
        header(&head, "vary").is_some_and(|v| v.contains("Origin")),
        "a per-origin answer must not be cached across origins"
    );
    server.stop().await;
}

#[tokio::test]
async fn a_foreign_origin_is_refused_with_the_contract_error_body() {
    let server = common::TestServer::start().await;
    let (status, head, body) = server
        .request_full("GET", "/api/settings", &[("Origin", "https://evil.example.com")], &[])
        .await;

    assert_eq!(status, 403);
    assert_eq!(serde_json::from_str::<Value>(&body).expect("json")["error"], "forbidden origin");
    assert!(
        header(&head, "access-control-allow-origin").is_none(),
        "a refusal must not hand the caller a CORS grant"
    );
    server.stop().await;
}

#[tokio::test]
async fn the_preflight_is_answered_without_routing() {
    let server = common::TestServer::start().await;
    let origin = format!("http://{}", server.addr);
    let (status, head, _) = server
        .request_full(
            "OPTIONS",
            "/api/fs/list",
            &[("Origin", &origin), ("Access-Control-Request-Headers", "content-type")],
            &[],
        )
        .await;

    assert_eq!(status, 204, "hono's cors() answers every OPTIONS itself");
    assert_eq!(
        header(&head, "access-control-allow-methods").as_deref(),
        Some("GET,HEAD,PUT,POST,DELETE,PATCH"),
        "hono's default method list, which the TypeScript does not override"
    );
    assert_eq!(
        header(&head, "access-control-allow-headers").as_deref(),
        Some("content-type"),
        "with no allowHeaders configured, the request's own list is echoed"
    );

    let (refused, _, _) = server
        .request_full("OPTIONS", "/api/fs/list", &[("Origin", "https://evil.example.com")], &[])
        .await;
    assert_eq!(refused, 403, "the guard runs before the preflight answer");
    server.stop().await;
}

#[tokio::test]
async fn the_guard_only_covers_the_api() {
    let server = common::TestServer::start().await;
    // The SPA is a static asset: framing it from elsewhere is the embedded
    // deployment's business, and the TypeScript scopes its middleware to
    // `/api/*` for exactly that reason.
    let (status, _, _) = server
        .request_full("GET", "/sessions/claude/x", &[("Origin", "https://evil.example.com")], &[])
        .await;
    assert!(status == 200 || status == 503, "the SPA fallback answered {status}");
    server.stop().await;
}
