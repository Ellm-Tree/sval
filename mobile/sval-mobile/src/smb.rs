// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A folder on an SMB share, reached over SMB 2/3 (mobile spec §8.1). Paths
//! are relative to the folder, as the engine names them (`sval/ws/...`).
//!
//! Every call blocks until the server answers, so an app calls in from a
//! thread of its own, never its UI thread.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use smb2::{ClientConfig, ErrorKind, RenameOptions, SmbClient, Tree};

use crate::{ConnectorError, FileEntry};

/// Where a shared folder is, and the sign-in for it.
#[derive(Clone, uniffi::Record)]
pub struct SmbLocation {
    /// A host name or address, with `:port` when it isn't 445.
    pub host: String,
    pub share: String,
    /// The folder within the share, `/`-separated. Empty for the share's root.
    pub path: String,
    pub username: String,
    pub password: String,
}

/// How long a call waits on a server that has stopped answering.
const TIMEOUT: Duration = Duration::from_secs(10);

/// One signed-in connection and the share it opened.
struct Session {
    client: SmbClient,
    tree: Tree,
}

#[derive(uniffi::Object)]
pub struct SmbFolder {
    location: SmbLocation,
    /// None until the first call, and again after a call found the connection
    /// gone, so the next call signs in afresh.
    session: Mutex<Option<Session>>,
}

#[uniffi::export]
impl SmbFolder {
    /// Signs in and opens the share, so a wrong password or a share that
    /// isn't there is reported here.
    #[uniffi::constructor]
    pub fn connect(location: SmbLocation) -> Result<Arc<Self>, ConnectorError> {
        let session = smol::block_on(open(&location))?;
        Ok(Arc::new(Self {
            location,
            session: Mutex::new(Some(session)),
        }))
    }

    /// The entries directly in `directory`, by path relative to the folder.
    /// A directory that does not exist holds none.
    pub fn list(&self, directory: String) -> Result<Vec<String>, ConnectorError> {
        let full = self.full(&directory);
        let listed = self.with_session(|session| {
            Box::pin(async move {
                session
                    .client
                    .list_directory(&mut session.tree, &full)
                    .await
            })
        });
        let entries = match listed {
            Ok(entries) => entries,
            Err(ConnectorError::NotFound) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        Ok(entries
            .into_iter()
            .map(|entry| entry.name)
            // `.` and `..`, and the temporary files `write` renames into
            // place, are no one's documents.
            .filter(|name| !name.starts_with('.'))
            .map(|name| join(&directory, &name))
            .collect())
    }

    /// The files directly in `directory`, with their sizes and times. A
    /// directory that does not exist holds none.
    pub fn files(&self, directory: String) -> Result<Vec<FileEntry>, ConnectorError> {
        let full = self.full(&directory);
        let listed = self.with_session(|session| {
            Box::pin(async move {
                session
                    .client
                    .list_directory(&mut session.tree, &full)
                    .await
            })
        });
        let entries = match listed {
            Ok(entries) => entries,
            Err(ConnectorError::NotFound) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        Ok(entries
            .into_iter()
            .filter(|entry| !entry.is_directory && !entry.name.starts_with('.'))
            .map(|entry| FileEntry {
                path: join(&directory, &entry.name),
                size: entry.size,
                modified_ms: entry
                    .modified
                    .to_system_time()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as i64),
            })
            .collect())
    }

    pub fn exists(&self, path: String) -> Result<bool, ConnectorError> {
        let full = self.full(&path);
        match self.with_session(|session| {
            Box::pin(async move { session.client.stat(&mut session.tree, &full).await })
        }) {
            Ok(_) => Ok(true),
            Err(ConnectorError::NotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn read(&self, path: String) -> Result<Vec<u8>, ConnectorError> {
        let full = self.full(&path);
        self.with_session(|session| {
            Box::pin(async move { session.client.read_file(&mut session.tree, &full).await })
        })
    }

    /// Writes `bytes` at `path` so that no reader sees half of it: a
    /// temporary file beside it, renamed over the old one (spec §6.3).
    /// Missing directories on the way are made.
    pub fn write(&self, path: String, bytes: Vec<u8>) -> Result<(), ConnectorError> {
        let full = self.full(&path);
        let (parent, name) = full.rsplit_once('/').unwrap_or(("", full.as_str()));
        let temporary = join(parent, &format!(".{name}.writing"));
        let parents = ancestors(parent);
        self.with_session(|session| {
            let (full, temporary, bytes, parents) = (
                full.clone(),
                temporary.clone(),
                bytes.clone(),
                parents.clone(),
            );
            Box::pin(async move {
                // Directories are made only when the write finds one missing,
                // which is once per document and device.
                if let Err(e) = session
                    .client
                    .write_file(&session.tree, &temporary, &bytes)
                    .await
                {
                    if e.kind() != ErrorKind::NotFound {
                        return Err(e);
                    }
                    for directory in &parents {
                        match session
                            .client
                            .create_directory(&session.tree, directory)
                            .await
                        {
                            Err(e) if e.kind() != ErrorKind::AlreadyExists => return Err(e),
                            _ => {}
                        }
                    }
                    session
                        .client
                        .write_file(&session.tree, &temporary, &bytes)
                        .await?;
                }
                session
                    .client
                    .rename_with(
                        &session.tree,
                        &temporary,
                        &full,
                        RenameOptions::new().replace_if_exists(true),
                    )
                    .await
            })
        })
    }

    pub fn delete(&self, path: String) -> Result<(), ConnectorError> {
        let full = self.full(&path);
        self.with_session(|session| {
            Box::pin(async move { session.client.delete_file(&session.tree, &full).await })
        })
    }

    /// Renames the file at `from` to `to`, in the same directory. The server
    /// refuses the rename when anything is at `to`, so nothing there is
    /// ever replaced.
    pub fn move_file(&self, from: String, to: String) -> Result<(), ConnectorError> {
        let (from, to) = (self.full(&from), self.full(&to));
        self.with_session(|session| {
            let (from, to) = (from.clone(), to.clone());
            Box::pin(async move {
                session
                    .client
                    .rename_with(&session.tree, &from, &to, RenameOptions::new())
                    .await
            })
        })
    }
}

impl SmbFolder {
    /// `path` within the share.
    fn full(&self, path: &str) -> String {
        join(&self.location.path, path)
    }

    /// Runs `call` on the open session, signing in first when there is none.
    /// A call that finds the connection gone drops the session, so the next
    /// call signs in again; this one reports the loss.
    fn with_session<T>(
        &self,
        call: impl for<'a> FnOnce(
            &'a mut Session,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = smb2::Result<T>> + Send + 'a>,
        >,
    ) -> Result<T, ConnectorError> {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(smol::block_on(open(&self.location))?);
        }
        let session = guard.as_mut().expect("opened above");
        let result = smol::block_on(call(session));
        result.map_err(|e| {
            let error = map_error(&e);
            if matches!(error, ConnectorError::Unreachable { .. }) {
                *guard = None;
            }
            error
        })
    }
}

/// A watch on a shared folder and everything below it, on a connection of
/// its own, so a wait never holds up the folder's calls.
#[derive(uniffi::Object)]
pub struct SmbWatcher {
    watcher: Mutex<smb2::client::Watcher>,
    /// Kept open for as long as the watch is.
    _client: Mutex<SmbClient>,
}

#[uniffi::export]
impl SmbWatcher {
    #[uniffi::constructor]
    pub fn watch(location: SmbLocation) -> Result<Arc<Self>, ConnectorError> {
        smol::block_on(async {
            let mut session = open(&location).await?;
            let watcher = session
                .client
                .watch(&session.tree, location.path.trim_matches('/'), true)
                .await
                .map_err(|e| map_error(&e))?;
            Ok(Arc::new(Self {
                watcher: Mutex::new(watcher),
                _client: Mutex::new(session.client),
            }))
        })
    }

    /// Waits until something in the folder changes, and returns what changed,
    /// relative to the folder. An empty list means the server didn't say. An
    /// error means the watch is over, and the app makes a new one when it
    /// wants to go on watching.
    pub fn wait(&self) -> Result<Vec<String>, ConnectorError> {
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        match smol::block_on(watcher.next_events()) {
            Ok(events) => Ok(events.into_iter().map(|event| event.filename).collect()),
            // Too many changes to list: still a change.
            Err(smb2::Error::Protocol { status, .. })
                if status == smb2::types::status::NtStatus::NOTIFY_ENUM_DIR =>
            {
                Ok(Vec::new())
            }
            Err(e) => Err(map_error(&e)),
        }
    }
}

async fn open(location: &SmbLocation) -> Result<Session, ConnectorError> {
    let addr = if location.host.contains(':') {
        location.host.clone()
    } else {
        format!("{}:445", location.host)
    };
    let config = ClientConfig {
        addr,
        timeout: TIMEOUT,
        username: location.username.clone(),
        password: location.password.clone(),
        // A referral would send the user's login to whatever server the
        // share names, and the shared folder lives on the server the user
        // typed.
        dfs_enabled: false,
        require_encryption: true,
        ..Default::default()
    };
    // Encrypted wherever the server can, and in the clear where it can't:
    // `EncryptionRequired` is the one answer that means the server has no
    // cipher, or the login is a guest's, which has no keys.
    let mut client = match SmbClient::connect(config.clone()).await {
        Err(smb2::Error::EncryptionRequired) => {
            SmbClient::connect(ClientConfig {
                require_encryption: false,
                ..config
            })
            .await
        }
        other => other,
    }
    .map_err(|e| map_error(&e))?;
    let tree = client
        .connect_share(&location.share)
        .await
        .map_err(|e| map_error(&e))?;
    Ok(Session { client, tree })
}

fn map_error(error: &smb2::Error) -> ConnectorError {
    match error.kind() {
        ErrorKind::NotFound => ConnectorError::NotFound,
        ErrorKind::AuthRequired | ErrorKind::SigningRequired => ConnectorError::SignIn,
        ErrorKind::AccessDenied => ConnectorError::AccessDenied,
        ErrorKind::ConnectionLost | ErrorKind::TimedOut | ErrorKind::SessionExpired => {
            ConnectorError::Unreachable {
                message: error.to_string(),
            }
        }
        _ => ConnectorError::Other {
            message: error.to_string(),
        },
    }
}

/// `a/b` from `a` and `b`, either of which may be empty.
fn join(a: &str, b: &str) -> String {
    let (a, b) = (a.trim_matches('/'), b.trim_matches('/'));
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_owned(),
        (_, true) => a.to_owned(),
        _ => format!("{a}/{b}"),
    }
}

/// `a`, `a/b`, `a/b/c` for `a/b/c`: each directory to make, outermost first.
fn ancestors(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut so_far = String::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        so_far = join(&so_far, part);
        out.push(so_far.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_paths_with_empty_ends() {
        assert_eq!(join("", "sval/ws"), "sval/ws");
        assert_eq!(join("Sval Test/", "/sval"), "Sval Test/sval");
        assert_eq!(join("Sval Test", ""), "Sval Test");
    }

    #[test]
    fn lists_each_directory_to_make_outermost_first() {
        assert_eq!(ancestors("a/b/c"), vec!["a", "a/b", "a/b/c"]);
        assert!(ancestors("").is_empty());
    }
}
