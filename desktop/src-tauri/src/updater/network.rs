//! Whether the network is one to spare: macOS's own view (Network.framework's
//! path monitor), so a 50 MB download waits while the Mac is on a personal
//! hotspot, a cellular link or Low Data Mode. Checks, a few hundred bytes,
//! still run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

static METERED: AtomicBool = AtomicBool::new(false);
static WATCH: Once = Once::new();

/// Start watching, at launch: macOS answers the monitor a moment after it
/// starts, so a watch begun only when a download is due would let the first
/// one through on any network.
pub fn start() {
    WATCH.call_once(watch);
}

/// Whether the current network is expensive or constrained. False until
/// macOS has said, and on any other platform.
pub fn metered() -> bool {
    start();
    METERED.load(Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
fn watch() {
    use std::ffi::c_void;

    #[link(name = "Network", kind = "framework")]
    extern "C" {
        fn nw_path_monitor_create() -> *mut c_void;
        fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
        fn nw_path_monitor_set_update_handler(monitor: *mut c_void, handler: &block2::DynBlock<dyn Fn(*mut c_void)>);
        fn nw_path_monitor_start(monitor: *mut c_void);
        fn nw_path_is_expensive(path: *mut c_void) -> bool;
        fn nw_path_is_constrained(path: *mut c_void) -> bool;
    }
    extern "C" {
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
    }

    let handler = block2::RcBlock::new(|path: *mut c_void| {
        if path.is_null() {
            return;
        }
        // SAFETY: Network.framework hands the handler a valid path object for
        // the duration of the call.
        let metered = unsafe { nw_path_is_expensive(path) || nw_path_is_constrained(path) };
        if METERED.swap(metered, Ordering::Relaxed) != metered {
            log::info!(
                "updates: the network is {}",
                if metered { "metered: downloads wait" } else { "not metered" }
            );
        }
    });
    // SAFETY: the monitor is created, configured and started once and lives for
    // the rest of the process (it is never released); the handler block is
    // copied by Network.framework; the global queue is never released either.
    unsafe {
        let monitor = nw_path_monitor_create();
        if monitor.is_null() {
            return;
        }
        nw_path_monitor_set_queue(monitor, dispatch_get_global_queue(0, 0));
        nw_path_monitor_set_update_handler(monitor, &handler);
        nw_path_monitor_start(monitor);
    }
}

#[cfg(not(target_os = "macos"))]
fn watch() {}
