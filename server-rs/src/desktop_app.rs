//! A server run by the Droppen desktop app (`desktop/` in this repository).
//!
//! The app starts this binary as a sidecar with `DROPPEN_DESKTOP_APP=1` (and,
//! for a server from before the rename to Droppen, `RH_DESKTOP_APP=1`, which is
//! still read: [`crate::env`]), and two things are different about such a
//! server:
//!
//! * **It never replaces its binary.** The app runs the server it ships
//!   inside its own bundle and is updated as a whole. `POST
//!   /api/server/self-upgrade` would instead write `<data>/bin`, the store
//!   every `up`-supervised instance on the device runs from, and leave the app
//!   itself unchanged — so it is refused ([`crate::selfupdate`]).
//! * **Its login is the app's.** The app made the password and signs in with
//!   it on every launch; nobody is meant to know it. `GET /api/auth/status`
//!   says `desktopApp: true`, and the web app hides what would be a dead end
//!   there — changing a password nobody has, and signing out of a login the
//!   app restores at once — and signs in to Droppen through the system browser
//!   instead of a popup its window cannot have (the browser hand-off,
//!   [`crate::api::link_handoff`]).
//!
//! Read once, at boot, into [`crate::api::AppState::desktop_app`], so a test
//! sets the field instead of the process environment every test shares.

/// The environment variable the app sets (under its old name too).
pub const ENV: &str = "DROPPEN_DESKTOP_APP";

/// Whether this process was started by the desktop app.
pub fn from_env() -> bool {
    enabled(crate::env::var(ENV).as_deref())
}

/// The switch's spellings: `1`, `true`, `yes`, `on` (any case) turn it on.
pub fn enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_yes_turns_it_on() {
        for on in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(enabled(Some(on)), "{on:?}");
        }
        for off in [None, Some(""), Some("0"), Some("false"), Some("off"), Some("desktop")] {
            assert!(!enabled(off), "{off:?}");
        }
    }
}
