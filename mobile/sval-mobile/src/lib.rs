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
