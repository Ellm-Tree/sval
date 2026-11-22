// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The phone apps' native library: the engine (`sval_core`'s `ffi`) and the
//! shared-folder connectors.

// Linked in so its exported calls are in this library.
pub use sval_core;

pub mod blocking;
pub mod dropbox;
pub mod filter_syntax;
pub mod site;
pub mod smb;

uniffi::setup_scaffolding!();

/// A watcher's stop, which every wait of the watcher's sees, whether it
/// starts before the stop or is under way. Nothing is ever sent on the
/// channel: closing it is the stop, and a closed channel's `recv` returns
/// at once, for the waits under way and for every wait after.
pub(crate) struct Stop {
    sender: smol::channel::Sender<()>,
    receiver: smol::channel::Receiver<()>,
}

impl Stop {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = smol::channel::bounded(1);
        Self { sender, receiver }
    }

    pub(crate) fn stop(&self) {
        self.sender.close();
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.sender.is_closed()
    }

    /// Returns once the watcher is stopped.
    pub(crate) async fn stopped(&self) {
        let _ = self.receiver.recv().await;
    }

    /// Sleeps for `duration`, or until the watcher is stopped, and says
    /// whether it was.
    pub(crate) fn sleep(&self, duration: std::time::Duration) -> bool {
        smol::block_on(smol::future::or(
            async {
                self.stopped().await;
                true
            },
            async {
                smol::Timer::after(duration).await;
                false
            },
        ))
    }
}

/// A file in a shared folder, as its listing describes it, for a caller
/// that decides what to read before reading it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FileEntry {
    /// By path relative to the folder.
    pub path: String,
    pub size: u64,
    /// When it last changed, in milliseconds since the Unix epoch, or 0
    /// when the listing gives no time.
    pub modified_ms: i64,
}

/// Why a connector call failed. Each message is the one the app shows, and
/// names no file.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ConnectorError {
    /// The path does not exist.
    #[error("That folder isn't on the server.")]
    NotFound,
    /// The server refused the username or password.
    #[error("The server didn't accept that username and password.")]
    SignIn,
    /// Signed in, with no access to this share or path.
    #[error("This account can't open that share or folder.")]
    AccessDenied,
    /// The server could not be reached, or the connection dropped.
    #[error(
        "Can't reach the server. Check that this iPhone is on the same network, or connected to it by VPN."
    )]
    Unreachable { message: String },
    /// Dropbox no longer accepts this iPhone's sign-in, or never did.
    #[error("Dropbox didn't accept this iPhone's sign-in. Sign in to Dropbox again.")]
    DropboxSignIn,
    /// Dropbox could not be reached.
    #[error("Can't reach Dropbox. Check that this iPhone is online.")]
    DropboxUnreachable { message: String },
    /// Anything else.
    #[error("{message}")]
    Other { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_stop_ends_a_sleep() {
        let stop = Arc::new(Stop::new());
        let (done, ended) = mpsc::channel();
        let sleeping = Arc::clone(&stop);
        std::thread::spawn(move || done.send(sleeping.sleep(Duration::from_secs(3600))));
        stop.stop();
        assert_eq!(ended.recv_timeout(Duration::from_secs(1)), Ok(true));
    }

    #[test]
    fn a_sleep_after_the_stop_returns_at_once() {
        let stop = Stop::new();
        stop.stop();
        assert!(stop.is_stopped());
        assert!(stop.sleep(Duration::from_secs(3600)));
    }

    #[test]
    fn a_sleep_without_a_stop_runs_its_time() {
        let stop = Stop::new();
        assert!(!stop.sleep(Duration::from_millis(10)));
        assert!(!stop.is_stopped());
    }
}
