//! Talking to the server over its HTTP API — the routes the web app uses, and
//! one for the app alone:
//!
//! * `GET /api/auth/status` — answers without a token; the health check.
//! * `POST /api/auth/login` — `{username, password}` to a bearer token.
//! * `POST /api/auth/logout` — revokes one token, at quit.
//! * `GET /api/settings` — with the token: which instance answered, so the app
//!   never mistakes some other server on the port for its own.
//! * `POST /api/auth/local-open/grant` — with the token: *Open in Browser*'s
//!   one-time page link ([`local_open_grant`]). The app's instance never
//!   leaves its setup state (its account is app-internal), so its server's
//!   control socket, which any process of the user could ask, opens nothing
//!   there; the app's own login is what asks.
//!
//! Loopback only, plain HTTP, never through a proxy (an `HTTP_PROXY` in the
//! environment must not see the password), and never following a redirect.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The `User-Agent` the app logs in with. The server keeps it as the login's
/// label, which is how the session list in Settings names this one.
pub const USER_AGENT: &str = "Droppen desktop app";

/// The base URL of a server on `port`.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// What went wrong talking to the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// Nothing answered, or the connection failed.
    Unreachable(String),
    /// The login was refused (`401`): wrong password, no such account, or
    /// locked — the server does not say which.
    Refused,
    /// Something answered, but not the way a Droppen server does.
    Unexpected(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(why) => write!(f, "the server is unreachable: {why}"),
            Self::Refused => f.write_str("the server refused the login"),
            Self::Unexpected(why) => write!(f, "unexpected answer from the server: {why}"),
        }
    }
}

impl std::error::Error for ApiError {}

/// `GET /api/auth/status`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// Whether this caller has to sign in. From this device, only once the
    /// instance has a user account: the app's own is app-internal and does
    /// not count.
    pub auth_required: bool,
    /// Who the token (if one was sent) belongs to.
    #[serde(default)]
    pub user: Option<String>,
}

/// One status probe.
pub fn status(port: u16, timeout: Duration) -> Result<AuthStatus, ApiError> {
    let mut response = agent(timeout)
        .get(format!("{}/api/auth/status", base_url(port)))
        .call()
        .map_err(|error| ApiError::Unreachable(error.to_string()))?;
    if response.status() != 200 {
        return Err(ApiError::Unexpected(format!("status answered {}", response.status())));
    }
    response
        .body_mut()
        .read_json()
        .map_err(|error| ApiError::Unexpected(format!("status is not JSON: {error}")))
}

/// Wait until the server on `port` answers its status route, giving up at
/// `deadline` or as soon as `still_running` says the process is gone (a server
/// that cannot bind its port exits at once, and waiting out the deadline for it
/// would only delay the retry).
pub fn wait_healthy(port: u16, deadline: Instant, still_running: impl Fn() -> bool) -> Result<AuthStatus, ApiError> {
    let mut last = ApiError::Unreachable("not tried".into());
    while Instant::now() < deadline {
        if !still_running() {
            return Err(ApiError::Unreachable("the server process exited".into()));
        }
        match status(port, Duration::from_secs(2)) {
            Ok(status) => return Ok(status),
            Err(error) => last = error,
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(last)
}

#[derive(Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
}

/// A login.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    /// The bearer token — the only copy anywhere. **Never log it.**
    pub token: String,
    /// When it stops working, ISO-8601.
    pub expires_at: String,
    /// Whose it is.
    pub username: String,
}

impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Login")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("username", &self.username)
            .finish()
    }
}

/// `POST /api/auth/login`.
pub fn login(port: u16, username: &str, password: &str) -> Result<Login, ApiError> {
    // Serialised here rather than with `send_json`, so the body goes with a
    // `Content-Length` instead of chunked.
    let body = serde_json::to_vec(&LoginRequest { username, password }).map_err(|error| ApiError::Unexpected(error.to_string()))?;
    let mut response = agent(Duration::from_secs(15))
        .post(format!("{}/api/auth/login", base_url(port)))
        .header("Content-Type", "application/json")
        .send(&body[..])
        .map_err(|error| ApiError::Unreachable(error.to_string()))?;
    match response.status().as_u16() {
        200 => response
            .body_mut()
            .read_json()
            .map_err(|error| ApiError::Unexpected(format!("login is not JSON: {error}"))),
        401 => Err(ApiError::Refused),
        other => Err(ApiError::Unexpected(format!("login answered {other}"))),
    }
}

/// `POST /api/auth/logout`: revoke `token`. Best effort — at quit, a server
/// that does not answer is about to be stopped anyway, and the token expires
/// on its own.
pub fn logout(port: u16, token: &str) -> Result<(), ApiError> {
    let response = agent(Duration::from_millis(1500))
        .post(format!("{}/api/auth/logout", base_url(port)))
        .header("Authorization", &format!("Bearer {token}"))
        .send_empty()
        .map_err(|error| ApiError::Unreachable(error.to_string()))?;
    match response.status().as_u16() {
        200 | 204 | 401 => Ok(()),
        other => Err(ApiError::Unexpected(format!("logout answered {other}"))),
    }
}

#[derive(Deserialize)]
struct Settings {
    instance: String,
}

/// The instance the server on `port` says it is, asked with `token`.
pub fn instance(port: u16, token: &str) -> Result<String, ApiError> {
    let mut response = agent(Duration::from_secs(10))
        .get(format!("{}/api/settings", base_url(port)))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|error| ApiError::Unreachable(error.to_string()))?;
    match response.status().as_u16() {
        200 => response
            .body_mut()
            .read_json::<Settings>()
            .map(|settings| settings.instance)
            .map_err(|error| ApiError::Unexpected(format!("settings are not JSON: {error}"))),
        401 => Err(ApiError::Refused),
        other => Err(ApiError::Unexpected(format!("settings answered {other}"))),
    }
}

#[derive(Deserialize)]
struct Grant {
    token: Option<String>,
}

/// `POST /api/auth/local-open/grant`, with the app's own login: a one-time
/// token that opens the server's page signed in as this device's owner
/// (`http://127.0.0.1:<port>/#local-open=<token>`, once, within a minute) —
/// or `None` once the instance has a user account, whose login page is the one
/// to open. **Never log the token.**
pub fn local_open_grant(port: u16, token: &str) -> Result<Option<String>, ApiError> {
    let mut response = agent(Duration::from_secs(10))
        .post(format!("{}/api/auth/local-open/grant", base_url(port)))
        .header("Authorization", &format!("Bearer {token}"))
        .send_empty()
        .map_err(|error| ApiError::Unreachable(error.to_string()))?;
    match response.status().as_u16() {
        200 => response
            .body_mut()
            .read_json::<Grant>()
            .map(|grant| grant.token)
            .map_err(|error| ApiError::Unexpected(format!("the page link is not JSON: {error}"))),
        401 => Err(ApiError::Refused),
        other => Err(ApiError::Unexpected(format!("the page link answered {other}"))),
    }
}

/// A page link as [`local_open_grant`] gives it, asked with the window's
/// `token` by `ask` — and, if the server no longer takes that login (it
/// expired or was revoked: `401`), once more with the login `sign_in_again`
/// makes (and answers the token of). Never more than once: a login the server
/// refuses straight after it was made is a fault to report, not to loop on.
pub fn grant_signing_in_again(
    token: &str,
    ask: impl Fn(&str) -> Result<Option<String>, ApiError>,
    sign_in_again: impl FnOnce() -> Result<String, String>,
) -> Result<Option<String>, String> {
    match ask(token) {
        Err(ApiError::Refused) => {
            log::info!("the window's login is no longer taken: signing in again for the page link");
            let fresh = sign_in_again().map_err(|why| format!("could not sign in again: {why}"))?;
            ask(&fresh).map_err(|error| format!("the server gave no page link: {error}"))
        }
        other => other.map_err(|error| format!("the server gave no page link: {error}")),
    }
}

/// The page on `port` with a one-time sign-in in its fragment.
pub fn signed_in_page(port: u16, local_open: &str) -> String {
    format!("{}/#local-open={local_open}", base_url(port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A one-thread HTTP stand-in for the server: answers each request with
    /// what `route` returns for its method and path, and records the requests.
    struct Stub {
        port: u16,
        seen: Arc<Mutex<Vec<String>>>,
    }

    fn stub(route: impl Fn(&str, &str, &str) -> (u16, String) + Send + 'static) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut length = 0usize;
                let mut authorization = String::new();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        authorization = header.trim().to_string();
                    }
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let body = String::from_utf8_lossy(&body).into_owned();
                log.lock().expect("lock").push(format!("{method} {path} {authorization} {body}"));
                let (code, reply) = route(&method, &path, &body);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        Stub { port, seen }
    }

    #[test]
    fn health_waits_for_the_status_route() {
        let server = stub(|_, path, _| match path {
            "/api/auth/status" => (200, r#"{"authRequired":true,"user":null}"#.into()),
            _ => (404, "{}".into()),
        });
        let status = wait_healthy(server.port, Instant::now() + Duration::from_secs(5), || true).expect("healthy");
        assert!(status.auth_required);
        assert_eq!(status.user, None);
    }

    #[test]
    fn health_gives_up_when_the_process_is_gone() {
        let port = crate::port::unused();
        let started = Instant::now();
        let error = wait_healthy(port, Instant::now() + Duration::from_secs(30), || false).expect_err("gone");
        assert!(matches!(error, ApiError::Unreachable(_)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn health_times_out_on_a_silent_port() {
        let port = crate::port::unused();
        let error = wait_healthy(port, Instant::now() + Duration::from_millis(400), || true).expect_err("silent");
        assert!(matches!(error, ApiError::Unreachable(_)), "{error:?}");
    }

    #[test]
    fn something_else_on_the_port_is_not_healthy() {
        let server = stub(|_, _, _| (200, "<html>not droppen</html>".into()));
        let error = status(server.port, Duration::from_secs(2)).expect_err("not json");
        assert!(matches!(error, ApiError::Unexpected(_)));
    }

    #[test]
    fn login_sends_the_credentials_and_reads_the_token() {
        let server = stub(|method, path, body| match (method, path) {
            ("POST", "/api/auth/login") if body.contains(r#""username":"ada""#) && body.contains(r#""password":"right-password""#) => {
                (200, r#"{"token":"tok-123","expiresAt":"2026-10-25T00:00:00Z","username":"ada"}"#.into())
            }
            ("POST", "/api/auth/login") => (401, r#"{"error":"invalid credentials"}"#.into()),
            _ => (404, "{}".into()),
        });
        let login = login(server.port, "ada", "right-password").expect("login");
        assert_eq!(login.token, "tok-123");
        assert_eq!(login.username, "ada");
        assert!(!format!("{login:?}").contains("tok-123"), "Debug hides the token");
        assert_eq!(super::login(server.port, "ada", "wrong").expect_err("refused"), ApiError::Refused);
    }

    #[test]
    fn the_instance_and_logout_carry_the_bearer_token() {
        let server = stub(|method, path, _| match (method, path) {
            ("GET", "/api/settings") => (200, r#"{"instance":"desktop","hostname":"x"}"#.into()),
            ("POST", "/api/auth/logout") => (204, String::new()),
            _ => (404, "{}".into()),
        });
        assert_eq!(instance(server.port, "tok-9").expect("instance"), "desktop");
        logout(server.port, "tok-9").expect("logout");
        let seen = server.seen.lock().expect("lock").clone();
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().all(|line| line.contains("Bearer tok-9")), "{seen:?}");
    }

    #[test]
    fn the_page_link_is_asked_for_with_the_apps_login() {
        let server = stub(|method, path, _| match (method, path) {
            ("POST", "/api/auth/local-open/grant") => (200, r#"{"token":"one-time-xyz"}"#.into()),
            _ => (404, "{}".into()),
        });
        assert_eq!(local_open_grant(server.port, "tok-9").expect("grant").as_deref(), Some("one-time-xyz"));
        let seen = server.seen.lock().expect("lock").clone();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].starts_with("POST /api/auth/local-open/grant ") && seen[0].contains("Bearer tok-9"), "{seen:?}");
        assert_eq!(signed_in_page(5555, "one-time-xyz"), "http://127.0.0.1:5555/#local-open=one-time-xyz");

        // An account: the login page instead. A login the server no longer takes: refused.
        let accounts = stub(|_, _, _| (200, r#"{"token":null}"#.into()));
        assert_eq!(local_open_grant(accounts.port, "tok-9").expect("grant"), None);
        let refused = stub(|_, _, _| (401, r#"{"error":"unauthorized"}"#.into()));
        assert_eq!(local_open_grant(refused.port, "tok-9").expect_err("refused"), ApiError::Refused);
        let other = stub(|_, _, _| (403, r#"{"error":"not_desktop_app"}"#.into()));
        assert!(matches!(local_open_grant(other.port, "tok-9"), Err(ApiError::Unexpected(_))));
    }

    #[test]
    fn a_login_the_server_no_longer_takes_is_made_again_once() {
        use std::cell::RefCell;
        let asked = RefCell::new(Vec::new());
        let ask = |token: &str| {
            asked.borrow_mut().push(token.to_string());
            match token {
                "fresh" => Ok(Some("one-time".to_string())),
                _ => Err(ApiError::Refused),
            }
        };
        // The window's login is gone: signed in again, and asked again with it.
        let grant = grant_signing_in_again("expired", ask, || Ok("fresh".into()));
        assert_eq!(grant, Ok(Some("one-time".into())));
        assert_eq!(*asked.borrow(), ["expired", "fresh"]);

        // Refused again straight after: an error, not a loop.
        asked.borrow_mut().clear();
        let grant = grant_signing_in_again("expired", ask, || Ok("also-refused".into()));
        assert!(grant.is_err(), "{grant:?}");
        assert_eq!(*asked.borrow(), ["expired", "also-refused"]);

        // No new login to be had: why.
        let grant = grant_signing_in_again("expired", ask, || Err("the server is not running".into()));
        assert_eq!(grant, Err("could not sign in again: the server is not running".into()));

        // A login that is taken is used as it is, and nothing signs in again.
        let grant = grant_signing_in_again("fresh", ask, || panic!("no sign-in needed"));
        assert_eq!(grant, Ok(Some("one-time".into())));
        // Any other failure is not a lost login: no sign-in either.
        let other = |_: &str| Err(ApiError::Unexpected("the page link answered 403".into()));
        assert!(grant_signing_in_again("t", other, || panic!("no sign-in for a 403")).is_err());
    }

    #[test]
    fn a_proxy_in_the_environment_is_never_used() {
        // ureq would read HTTP_PROXY by default; the agent is built with none,
        // which this pins without touching the process environment.
        let config = agent(Duration::from_secs(1));
        assert!(config.config().proxy().is_none());
    }
}
