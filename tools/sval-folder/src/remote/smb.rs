// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A folder on an SMB share, reached over SMB 2 and 3 with `smb2`, so the
//! operating system never mounts the share. It signs in as the iPhone app's
//! connector does (`mobile/sval-mobile/src/smb.rs`): encrypted wherever the
//! server can be, with DFS referrals refused.

use super::{join, Child, Kind, RemoteError, Result, Store};
use smb2::{ClientConfig, ErrorKind, RenameOptions, SmbClient, Tree};
use std::time::{Duration, SystemTime};

/// How long a call waits on a server that has stopped answering. Under the
/// request's own 20 s deadline, so a dead server fails the request with an
/// answer before the browser gives up on the helper.
const TIMEOUT: Duration = Duration::from_secs(8);

/// A temporary file older than this belongs to a helper killed between its
/// write and its rename, as `STALE_TEMPORARY` in `ops.rs` reasons for a
/// local one.
const STALE_TEMPORARY: Duration = Duration::from_secs(10 * 60);

/// Where the folder is and the sign-in for it.
pub struct SmbTarget {
    /// `host:port`.
    pub addr: String,
    pub share: String,
    /// The folder within the share, `/`-separated. Empty for its root.
    pub path: String,
    pub username: String,
    pub password: String,
}

struct Session {
    client: SmbClient,
    tree: Tree,
}

pub struct SmbStore {
    target: SmbTarget,
    /// None until the first call, and again after a call found the
    /// connection gone, so the next call signs in afresh.
    session: Option<Session>,
}

impl SmbStore {
    pub fn new(target: SmbTarget) -> Self {
        SmbStore {
            target,
            session: None,
        }
    }

    fn full(&self, path: &str) -> String {
        join(&self.target.path, path)
    }

    /// Runs `call` on the open session, signing in first when there is none.
    /// A call that finds the connection gone drops the session, so the next
    /// call signs in again.
    fn with_session<T>(
        &mut self,
        call: impl for<'a> FnOnce(
            &'a mut Session,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = smb2::Result<T>> + Send + 'a>,
        >,
    ) -> Result<T> {
        if self.session.is_none() {
            self.session = Some(smol::block_on(open(&self.target))?);
        }
        let session = self.session.as_mut().expect("opened above");
        smol::block_on(call(session)).map_err(|err| {
            let mapped = map_error(&err);
            if mapped == RemoteError::Unreachable {
                self.session = None;
            }
            mapped
        })
    }

    /// Removes this device's temporary files for `name` in `parent` that a
    /// killed helper left. The write has already succeeded, so nothing here
    /// may fail it.
    fn sweep_stale_temporaries(&mut self, parent: &str, name: &str) {
        let Ok(listed) = self.list(parent) else {
            return;
        };
        let now = SystemTime::now();
        for child in listed {
            if child.kind != Kind::File || !is_temporary_of(&child.name, name) {
                continue;
            }
            // The version is the change time; a stale file is one whose
            // change time is old by the server's clock read through it.
            let stale = child
                .version
                .split_once(':')
                .and_then(|(ticks, _)| ticks.parse::<u64>().ok())
                .and_then(|ticks| {
                    smb2::pack::FileTime(ticks)
                        .to_system_time()
                        .and_then(|at| now.duration_since(at).ok())
                })
                .is_some_and(|age| age > STALE_TEMPORARY);
            if stale {
                let _ = self.remove_file(&join(parent, &child.name));
            }
        }
    }
}

/// The temporary name a write to `name` goes through: hidden, so the iPhone
/// app's listing passes it over, with a suffix no listing filter matches.
fn temporary_name(name: &str) -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(".{name}.{hex}.tmp")
}

fn is_temporary_of(candidate: &str, name: &str) -> bool {
    candidate
        .strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(name))
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

impl Store for SmbStore {
    fn kind(&mut self, path: &str) -> Result<Option<Kind>> {
        let full = self.full(path);
        let found = self.with_session(|session| {
            Box::pin(async move { session.client.stat(&mut session.tree, &full).await })
        });
        match found {
            Ok(info) if info.is_link() => Ok(Some(Kind::Link)),
            Ok(info) if info.is_directory => Ok(Some(Kind::Dir)),
            Ok(_) => Ok(Some(Kind::File)),
            Err(RemoteError::NotFound) => Ok(None),
            Err(err) => Err(err),
        }
    }

    fn list(&mut self, dir: &str) -> Result<Vec<Child>> {
        let full = self.full(dir);
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
            Err(RemoteError::NotFound) => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        Ok(entries
            .into_iter()
            .filter(|entry| entry.name != "." && entry.name != "..")
            .map(|entry| Child {
                kind: if entry.is_link() {
                    Kind::Link
                } else if entry.is_directory {
                    Kind::Dir
                } else {
                    Kind::File
                },
                size: entry.size,
                // The change time moves on every write, the size with most;
                // together they say the bytes are the ones read before.
                version: format!("{}:{}", entry.changed.0, entry.size),
                name: entry.name,
            })
            .collect())
    }

    fn read_all(&mut self, paths: &[(&str, u64)]) -> Vec<Result<Vec<u8>>> {
        paths
            .iter()
            .map(|&(path, limit)| {
                let full = self.full(path);
                self.with_session(|session| {
                    Box::pin(async move {
                        let mut download = session.client.download(&session.tree, &full).await?;
                        let mut bytes = Vec::new();
                        // Dropping the download mid-file closes it; nothing
                        // past the limit is held.
                        while let Some(chunk) = download.next_chunk().await {
                            bytes.extend_from_slice(&chunk?);
                            if bytes.len() as u64 >= limit {
                                bytes.truncate(limit as usize);
                                break;
                            }
                        }
                        Ok(bytes)
                    })
                })
            })
            .collect()
    }

    /// A temporary file beside the target, renamed over it, so a reader
    /// never sees half a file (spec §6.3).
    fn write(&mut self, path: &str, bytes: &[u8]) -> Result<()> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let temporary = join(parent, &temporary_name(name));
        let (full, full_temporary) = (self.full(path), self.full(&temporary));
        let written = {
            let (t, b) = (full_temporary.clone(), bytes.to_vec());
            self.with_session(|session| {
                Box::pin(async move { session.client.write_file(&session.tree, &t, &b).await })
            })
        };
        match written {
            Ok(_) => {}
            Err(RemoteError::NotFound) => {
                self.make_dirs(parent)?;
                let (t, b) = (full_temporary.clone(), bytes.to_vec());
                self.with_session(|session| {
                    Box::pin(async move { session.client.write_file(&session.tree, &t, &b).await })
                })?;
            }
            Err(err) => return Err(err),
        }
        let renamed = {
            let (t, f) = (full_temporary.clone(), full);
            self.with_session(|session| {
                Box::pin(async move {
                    session
                        .client
                        .rename_with(
                            &session.tree,
                            &t,
                            &f,
                            RenameOptions::new().replace_if_exists(true),
                        )
                        .await
                })
            })
        };
        if let Err(err) = renamed {
            let _ = self.remove_file(&temporary);
            return Err(err);
        }
        self.sweep_stale_temporaries(parent, name);
        Ok(())
    }

    fn rename_new(&mut self, from: &str, to: &str) -> Result<()> {
        let (from, to) = (self.full(from), self.full(to));
        self.with_session(|session| {
            Box::pin(async move {
                session
                    .client
                    .rename_with(&session.tree, &from, &to, RenameOptions::new())
                    .await
            })
        })
    }

    fn remove_file(&mut self, path: &str) -> Result<()> {
        let full = self.full(path);
        match self.with_session(|session| {
            Box::pin(async move { session.client.delete_file(&session.tree, &full).await })
        }) {
            Err(RemoteError::NotFound) => Ok(()),
            other => other,
        }
    }

    fn remove_dir(&mut self, path: &str) -> Result<()> {
        let full = self.full(path);
        match self.with_session(|session| {
            Box::pin(async move { session.client.delete_directory(&session.tree, &full).await })
        }) {
            Err(RemoteError::NotFound) => Ok(()),
            other => other,
        }
    }

    fn make_dirs(&mut self, path: &str) -> Result<()> {
        let mut so_far = String::new();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            so_far = join(&so_far, part);
            let full = self.full(&so_far);
            match self.with_session(|session| {
                Box::pin(async move { session.client.create_directory(&session.tree, &full).await })
            }) {
                Ok(()) | Err(RemoteError::Exists) => {}
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }
}

async fn open(target: &SmbTarget) -> Result<Session> {
    let config = ClientConfig {
        addr: target.addr.clone(),
        timeout: TIMEOUT,
        username: target.username.clone(),
        password: target.password.clone(),
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
    .map_err(|err| map_error(&err))?;
    let tree = client
        .connect_share(&target.share)
        .await
        .map_err(|err| map_error(&err))?;
    Ok(Session { client, tree })
}

fn map_error(err: &smb2::Error) -> RemoteError {
    match err.kind() {
        ErrorKind::NotFound => RemoteError::NotFound,
        ErrorKind::AlreadyExists => RemoteError::Exists,
        ErrorKind::AuthRequired | ErrorKind::SigningRequired => RemoteError::SignIn,
        ErrorKind::AccessDenied | ErrorKind::SharingViolation => RemoteError::Denied,
        ErrorKind::ConnectionLost | ErrorKind::TimedOut | ErrorKind::SessionExpired => {
            RemoteError::Unreachable
        }
        _ => match err {
            smb2::Error::Io(_) => RemoteError::Unreachable,
            _ => RemoteError::Other,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temporary_name_is_hidden_and_known_as_this_files() {
        let name = temporary_name("me.json");
        assert!(name.starts_with(".me.json."));
        assert!(is_temporary_of(&name, "me.json"));
        assert!(!is_temporary_of(&name, "you.json"));
        assert!(!is_temporary_of(".me.json.writing", "me.json"));
        assert!(!name.ends_with(".json"));
    }

    #[test]
    fn a_server_that_does_not_answer_is_unreachable() {
        // Nothing listens on loopback's port 9.
        let mut store = SmbStore::new(SmbTarget {
            addr: "127.0.0.1:9".into(),
            share: "share".into(),
            path: String::new(),
            username: "u".into(),
            password: "p".into(),
        });
        assert_eq!(store.kind(""), Err(RemoteError::Unreachable));
    }
}
