//! Handing the default browser an address with a secret in it, keeping the
//! secret off every command line — where another user's `ps` could read it.
//!
//! *Open in Browser* gives the browser the server's page with a one-time
//! sign-in in its fragment (`#local-open=<token>`, [`crate::server::local_open_grant`]).
//! `open <url>` would put that in `open`'s arguments; AppleScript's
//! `open location`, which `osascript` reads from its standard input, puts it
//! nowhere but the browser — the way the server's own `open` command does it.

use std::io::Write;
use std::process::{Command, Stdio};

/// The AppleScript that opens `url` in the default browser.
pub fn open_location_script(url: &str) -> String {
    format!("open location {}\n", applescript_string(url))
}

/// `text` as an AppleScript string literal.
fn applescript_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Open `url` in the default browser through `osascript` on its standard
/// input: the address is in no process's arguments. An error says why
/// without the address, which may go to a log.
pub fn open_secret(url: &str) -> Result<(), String> {
    let mut child = Command::new("osascript")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("cannot run osascript: {}", error.kind()))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(open_location_script(url).as_bytes())
            .map_err(|error| format!("cannot hand osascript the address: {}", error.kind()))?;
    }
    let status = child.wait().map_err(|error| format!("osascript did not finish: {}", error.kind()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("osascript could not open the browser ({status})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_goes_to_the_script_as_one_string() {
        assert_eq!(
            open_location_script("http://127.0.0.1:5555/#local-open=abc-DEF_123"),
            "open location \"http://127.0.0.1:5555/#local-open=abc-DEF_123\"\n"
        );
        // Whatever it holds, it stays one string literal.
        assert_eq!(open_location_script(r#"a"b\c"#), "open location \"a\\\"b\\\\c\"\n");
    }
}
