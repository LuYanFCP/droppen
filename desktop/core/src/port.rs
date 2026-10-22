//! A loopback port for the server.
//!
//! The port is part of the web app's origin (`http://127.0.0.1:<port>`), and an
//! origin is what the webview keys `localStorage` and IndexedDB by — the web
//! app's login, its preferences and cached session list, and for cloud use the
//! browser's device keys. A new port makes the app's window a new device that
//! has to be added again. So the port the app picked last time is kept
//! ([`crate::state`]) and reused while it is free, whatever range it came from;
//! only when something else holds it does the app choose a new one.
//!
//! A new port comes from [`RANGE`], a fixed range below the kernel's ephemeral
//! range (49152–65535 on macOS). Every outgoing connection on the Mac takes its
//! local port from the ephemeral range, so a port chosen there is often taken
//! by someone else at the next start; one below it is only ever taken by a
//! server that asked for it. Earlier versions took the port from the ephemeral
//! range: an install that has one keeps it while it is free.
//!
//! [`OTHERS`] are the ports other Droppen installs on the same Mac use by
//! default. The app never uses one of them, even if it happens to be free right
//! now and even if `state.json` names it.
//!
//! A port held for a moment at start-up (a process that is just exiting, a
//! probe) is no reason to give up the origin: [`pick`] asks again for
//! [`PATIENCE`] before it moves. And the shell writes a new port to
//! `state.json` only once a window has loaded the web app on it, so a start
//! that fails after choosing one goes back to the old port next time.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::ops::RangeInclusive;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::Duration;

/// Where a new port is chosen from: below the ephemeral range, clear of
/// [`OTHERS`], and with no port in it registered with IANA — 18700–18759. An
/// end-to-end test build chooses from a range of its own, 18800–18859
/// ([`crate::identity`]), so a test run never takes a port the release would.
pub const RANGE: RangeInclusive<u16> = crate::identity::THIS.ports;

/// Ports never used, even when free: a command-line install's (8700, and each
/// next one up to 8749 its installer tries when one is taken), the apps a
/// server runs (8710–8899), and the web app's development server (5180) — and
/// in an end-to-end test build, the release's whole range too, even when its
/// `state.json` names one.
pub const OTHERS: &[RangeInclusive<u16>] = if cfg!(feature = "e2e") {
    &[8700..=8899, 5180..=5180, crate::identity::RELEASE.ports]
} else {
    &[8700..=8899, 5180..=5180]
};

/// Whether `port` is one the app may run its server on.
pub fn usable(port: u16) -> bool {
    port != 0 && !OTHERS.iter().any(|others| others.contains(&port))
}

/// How long [`pick`] waits for the port in use to come free before it moves.
pub const PATIENCE: Duration = Duration::from_secs(5);

/// How often it asks in the meantime.
const POLL: Duration = Duration::from_millis(250);

/// How long a knock on a loopback port waits for an answer. Loopback answers
/// at once — accepted or refused — so this only bounds the odd case.
const KNOCK: Duration = Duration::from_millis(200);

/// Whether the server can have `port` to itself: 127.0.0.1 can be bound, and
/// nothing answers a knock on `127.0.0.1:<port>` or `[::1]:<port>`.
///
/// The knock is what finds a listener on a wildcard address (`0.0.0.0`,
/// `[::]`) or on `::1`: on macOS such a listener does not stop a bind to
/// 127.0.0.1, which would then take its loopback connections. It is a connect,
/// not a bind to the wildcard address: macOS refuses a wildcard bind whenever
/// a socket of another user has the port anywhere — a system daemon's
/// outgoing connection holds an ephemeral port for hours, and an earlier
/// version's saved port is from the ephemeral range — and a wildcard listener
/// could bring up the firewall's "accept incoming connections?" question. No
/// probe here listens on anything but 127.0.0.1.
///
/// A probe, and so a race by nature: the port can be taken between this answer
/// and the server's own bind. The supervisor covers that — a server that cannot
/// bind exits at once, and the next start asks again ([`pick`]).
pub fn is_free(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    // Let go of the bind before knocking.
    if TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_err() {
        return false;
    }
    !answers(SocketAddr::from((Ipv4Addr::LOCALHOST, port))) && !answers(SocketAddr::from((Ipv6Addr::LOCALHOST, port)))
}

/// Whether something listening at `address` takes a connection. Refused, no
/// answer in [`KNOCK`], or no IPv6: nobody.
fn answers(address: SocketAddr) -> bool {
    match TcpStream::connect_timeout(&address, KNOCK) {
        // A connection to itself — TCP's simultaneous open, when the kernel
        // happens to hand out the very port as the local one — is nobody.
        Ok(stream) => !matches!((stream.local_addr(), stream.peer_addr()), (Ok(local), Ok(peer)) if local == peer),
        Err(_) => false,
    }
}

/// The port to start the server on: `preferred` (the one in use) if it is
/// usable and free — asking again for up to [`PATIENCE`] while it is taken —
/// otherwise a new one ([`choose`]). `support`: the app's support folder,
/// which places this install's search ([`start`]).
pub fn pick(preferred: Option<u16>, support: &Path) -> io::Result<u16> {
    pick_with(preferred, start(support), is_free, PATIENCE, std::thread::sleep)
}

/// A free port from [`RANGE`], or an error that names the range when none is.
///
/// The search starts at a place fixed for each install ([`start`]), so two
/// apps that both choose — two macOS users' (each runs its own server, and
/// loopback ports are shared), or a second copy of one user's — start apart
/// and do not push each other off a port at the next start.
pub fn choose(support: &Path) -> io::Result<u16> {
    choose_with(start(support), is_free)
}

fn pick_with(
    preferred: Option<u16>,
    offset: u16,
    is_free: impl Fn(u16) -> bool,
    patience: Duration,
    mut sleep: impl FnMut(Duration),
) -> io::Result<u16> {
    if let Some(port) = preferred.filter(|&port| usable(port)) {
        let mut waited = Duration::ZERO;
        loop {
            if is_free(port) {
                return Ok(port);
            }
            if waited >= patience {
                break;
            }
            sleep(POLL);
            waited += POLL;
        }
        log::info!("port {port} is still taken after {}s", waited.as_secs_f32());
    }
    choose_with(offset, is_free)
}

fn choose_with(offset: u16, is_free: impl Fn(u16) -> bool) -> io::Result<u16> {
    let (first, last) = (*RANGE.start(), *RANGE.end());
    let size = last - first + 1;
    (0..size)
        .map(|step| first + (offset % size + step) % size)
        .find(|&port| usable(port) && is_free(port))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AddrNotAvailable,
                format!("none of the ports {first}–{last} on 127.0.0.1 is free"),
            )
        })
}

/// Where this install's search starts in [`RANGE`]: [`offset_for`] the uid,
/// and `support` unless it is the usual support folder under the user's own
/// home (the user database's, whatever `$HOME` says).
fn start(support: &Path) -> u16 {
    let usual = crate::dirs::account_home().map(|home| crate::dirs::ShellDirs::under(home).support);
    let elsewhere = (usual.as_deref() != Some(support)).then_some(support);
    // SAFETY: getuid cannot fail and touches no memory of ours.
    offset_for(unsafe { libc::getuid() }, elsewhere)
}

/// The same for the same install, every launch. For the usual install, from
/// the uid alone: since the step (7) shares no factor with the range's size
/// (60), different for any 60 consecutive uids — macOS gives its users 501,
/// 502, … — and 7 ports apart for neighbours, so a user who finds their start
/// taken moves on without reaching the next one's. A copy elsewhere (another
/// home, as an end-to-end run has) is shifted by a hash of its folder, so it
/// does not start where the user's usual app does.
fn offset_for(uid: u32, elsewhere: Option<&Path>) -> u16 {
    const STEP: u32 = 7;
    let size = u32::from(*RANGE.end() - *RANGE.start() + 1);
    let shift = elsewhere.map_or(0, |folder| {
        // FNV-1a: stable across builds, unlike std's hasher.
        let hash = folder
            .as_os_str()
            .as_bytes()
            .iter()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3));
        (hash % u64::from(size)) as u32
    });
    ((uid % size) * STEP % size + shift).rem_euclid(size) as u16
}

/// A port nothing listens on, from the kernel, for tests that need one.
#[cfg(test)]
pub(crate) fn unused() -> u16 {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
    listener.local_addr().expect("addr").port()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const EPHEMERAL: RangeInclusive<u16> = 49152..=65535;

    /// [`pick_with`] that must not wait.
    fn pick_now(preferred: Option<u16>, offset: u16, is_free: impl Fn(u16) -> bool) -> io::Result<u16> {
        pick_with(preferred, offset, is_free, Duration::ZERO, |_| panic!("waited"))
    }

    #[test]
    fn the_range_is_below_the_ephemeral_range_and_clear_of_other_installs() {
        assert!(RANGE.end() < EPHEMERAL.start());
        assert!(RANGE.clone().all(usable));
        for port in [8700, 8701, 8710, 8749, 8899, 5180] {
            assert!(!usable(port), "{port} belongs to another install");
        }
        assert!(!usable(0));
    }

    /// A free port from a stretch nothing on a Mac uses by default (below the
    /// ephemeral range, outside [`RANGE`] and [`OTHERS`]), found the same way
    /// every run — not one the kernel hands out, which others may be given too.
    fn quiet_port() -> u16 {
        (47_800..=47_899).find(|&port| is_free(port)).expect("a free port in 47800–47899")
    }

    #[test]
    fn a_free_saved_port_is_kept_whatever_range_it_is_from() {
        // An earlier version's port, from the ephemeral range.
        assert_eq!(pick_now(Some(51_234), 0, |_| true).expect("pick"), 51_234);
        let in_range = *RANGE.start() + 31;
        assert_eq!(pick_now(Some(in_range), 0, |_| true).expect("pick"), in_range);
        // And for real.
        let port = quiet_port();
        assert_eq!(pick_now(Some(port), 0, is_free).expect("pick"), port);
    }

    #[test]
    fn a_taken_saved_port_is_replaced_by_one_from_the_range() {
        let picked = pick_now(Some(51_234), 0, |port| port != 51_234).expect("pick");
        assert_eq!(picked, *RANGE.start());

        // For real: the saved port is held by someone else.
        let holder = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let taken = holder.local_addr().expect("addr").port();
        assert!(!is_free(taken));
        let picked = pick_with(Some(taken), 0, is_free, Duration::ZERO, |_| {}).expect("pick");
        assert_ne!(picked, taken);
        assert!(RANGE.contains(&picked), "{picked} is outside {RANGE:?}");
    }

    #[test]
    fn no_saved_port_means_one_from_the_range() {
        let picked = pick(None, Path::new("/nowhere/app.droppen.desktop")).expect("pick");
        assert!(RANGE.contains(&picked), "{picked} is outside {RANGE:?}");
    }

    #[test]
    fn the_choice_skips_taken_ports_and_wraps_around() {
        let (second, last_but_one) = (*RANGE.start() + 2, *RANGE.end() - 1);
        let free = |port: u16| port == second || port == last_but_one;
        assert_eq!(choose_with(0, free).expect("choose"), second);
        assert_eq!(choose_with(3, free).expect("choose"), last_but_one);
        // Starting past the last free one wraps to the first.
        assert_eq!(choose_with(59, free).expect("choose"), second);
        // The start is anywhere in the range, whatever the offset.
        for offset in [0, 1, 59, 60, 61, 1000, u16::MAX] {
            let picked = choose_with(offset, |_| true).expect("choose");
            assert!(RANGE.contains(&picked));
        }
        assert_eq!(choose_with(60, |_| true).expect("choose"), *RANGE.start());
    }

    #[test]
    fn ports_of_other_installs_are_never_kept_even_when_free() {
        for port in [8700, 8701, 8710, 5180] {
            let picked = pick_now(Some(port), 0, |_| true).expect("pick");
            assert_eq!(picked, *RANGE.start(), "{port} was kept");
        }
    }

    #[test]
    fn an_end_to_end_build_never_takes_a_port_of_the_releases() {
        let release = crate::identity::RELEASE.ports;
        assert!(crate::identity::E2E.ports.clone().all(|port| !release.contains(&port)));
        if cfg!(feature = "e2e") {
            assert!(release.clone().all(|port| !usable(port)));
            let kept = pick_now(Some(*release.start()), 0, |_| true).expect("pick");
            assert_eq!(kept, *RANGE.start(), "a release port named by state.json is not kept");
        } else {
            assert!(release.clone().all(usable));
        }
    }

    #[test]
    fn no_free_port_is_a_clear_error() {
        let error = pick_with(Some(51_234), 7, |_| false, Duration::from_secs(1), |_| {}).expect_err("nothing free");
        assert_eq!(error.kind(), io::ErrorKind::AddrNotAvailable);
        assert_eq!(
            error.to_string(),
            format!("none of the ports {}–{} on 127.0.0.1 is free", RANGE.start(), RANGE.end())
        );
    }

    #[test]
    fn a_port_taken_for_a_moment_at_start_is_waited_for() {
        // Free again at the third look: kept, after two pauses.
        let looks = Cell::new(0);
        let pauses = Cell::new(0);
        let is_free = |port: u16| {
            if port != 51_234 {
                return true;
            }
            looks.set(looks.get() + 1);
            looks.get() >= 3
        };
        let picked = pick_with(Some(51_234), 0, is_free, PATIENCE, |pause| {
            assert_eq!(pause, POLL);
            pauses.set(pauses.get() + 1);
        });
        assert_eq!(picked.expect("pick"), 51_234);
        assert_eq!(pauses.get(), 2);

        // Taken all along: asked for the whole patience, then moved.
        let pauses = Cell::new(0);
        let picked = pick_with(Some(51_234), 0, |port| port != 51_234, PATIENCE, |_| pauses.set(pauses.get() + 1));
        assert_eq!(picked.expect("pick"), *RANGE.start());
        assert_eq!(pauses.get(), (PATIENCE.as_millis() / POLL.as_millis()) as usize);

        // Nothing to wait for: no saved port, or one the app never uses.
        assert_eq!(pick_now(None, 0, |_| true).expect("pick"), *RANGE.start());
        assert_eq!(pick_now(Some(8700), 0, |_| true).expect("pick"), *RANGE.start());
    }

    #[test]
    fn each_user_starts_at_a_place_of_their_own() {
        let size = usize::from(*RANGE.end() - *RANGE.start() + 1);
        let starts: std::collections::BTreeSet<u16> = (501..501 + size as u32).map(|uid| offset_for(uid, None)).collect();
        assert_eq!(starts.len(), size, "60 consecutive users, 60 different starts");
        assert_eq!(offset_for(501, None), offset_for(501, None), "the same every launch");
        let (first, second) = (offset_for(501, None), offset_for(502, None));
        assert_eq!((second + 60 - first) % 60, 7, "neighbours 7 apart");
        assert!(starts.iter().all(|&offset| usize::from(offset) < size));
    }

    #[test]
    fn a_copy_elsewhere_starts_apart_from_the_usual_install() {
        let usual = crate::dirs::account_home().map(|home| crate::dirs::ShellDirs::under(home).support).expect("a home");
        let uid = unsafe { libc::getuid() };
        assert_eq!(start(&usual), offset_for(uid, None), "the usual install: the uid alone");
        // An end-to-end run's home, another build's folder: shifted, the same
        // every launch, and inside the range.
        let elsewhere = Path::new("/private/tmp/droppen-e2e.Xa81/home/Library/Application Support/app.droppen.desktop");
        assert_eq!(start(elsewhere), offset_for(uid, Some(elsewhere)));
        assert_eq!(start(elsewhere), start(elsewhere));
        assert_ne!(start(elsewhere), start(&usual));
        let size = u16::try_from(RANGE.len()).expect("size");
        for folder in ["/a", "/b", "/tmp/x/Library/Application Support/app.droppen.desktop"] {
            assert!(offset_for(501, Some(Path::new(folder))) < size);
        }
    }

    #[test]
    fn a_listener_on_any_loopback_address_takes_the_port() {
        // Each on a port of its own, nothing else on it.
        let v4_any = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("bind 0.0.0.0");
        let port = v4_any.local_addr().expect("addr").port();
        assert!(!is_free(port), "0.0.0.0:{port} answers on 127.0.0.1");
        drop(v4_any);

        let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind 127.0.0.1");
        let port = v4.local_addr().expect("addr").port();
        assert!(!is_free(port), "127.0.0.1:{port}");
        drop(v4);

        if let Ok(v6) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) {
            let port = v6.local_addr().expect("addr").port();
            assert!(!is_free(port), "[::1]:{port} answers the knock");
        }
        if let Ok(v6_any) = TcpListener::bind((Ipv6Addr::UNSPECIFIED, 0)) {
            let port = v6_any.local_addr().expect("addr").port();
            assert!(!is_free(port), "[::]:{port}");
        }

        // Nothing listening: free, and the knock was refused, not answered.
        let port = quiet_port();
        assert!(is_free(port));
        assert!(!answers(SocketAddr::from((Ipv4Addr::LOCALHOST, port))));
        assert!(!answers(SocketAddr::from((Ipv6Addr::LOCALHOST, port))));
    }

    #[test]
    fn an_outgoing_connection_on_the_port_does_not_take_it() {
        // The local end of a connection to somewhere else holds the port, as a
        // daemon's long-lived connection does; nothing listens on it.
        let server = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let client = TcpStream::connect(server.local_addr().expect("addr")).expect("connect");
        let (_accepted, _) = server.accept().expect("accept");
        let port = client.local_addr().expect("local").port();
        assert!(!answers(SocketAddr::from((Ipv4Addr::LOCALHOST, port))), "nobody listens on {port}");
        assert!(!answers(SocketAddr::from((Ipv6Addr::LOCALHOST, port))));
    }

    #[test]
    fn port_zero_is_not_free() {
        assert!(!is_free(0));
    }
}
