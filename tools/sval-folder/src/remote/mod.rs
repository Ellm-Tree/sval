// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A shared folder the helper reaches over the network: a folder on an SMB
//! share, or a folder in the user's Dropbox (desktop connectors spec §2).
//! The browser names one by a root of its own form, `smb://` or `dropbox:`,
//! and sends the sign-in with each request, so a helper that was killed and
//! started again needs nothing from the one before.

pub mod dropbox;
pub mod smb;

use serde_json::Value;
use std::collections::HashMap;

/// What a remote store calls an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    /// An entry that sends a path elsewhere, as `links::is_link` judges a
    /// local one.
    Link,
}

/// One entry of a remote directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub name: String,
    pub kind: Kind,
    pub size: u64,
    /// What changes whenever the file's bytes do, so bytes read earlier
    /// can be reused while it holds. Empty when the store has nothing that
    /// says so.
    pub version: String,
}

/// Why a remote call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    NotFound,
    /// Something is already at the path a call would create.
    Exists,
    /// The server or Dropbox refused the sign-in.
    SignIn,
    /// Signed in, without access to the path.
    Denied,
    /// The server or Dropbox could not be reached, or the connection broke.
    Unreachable,
    Other,
}

impl RemoteError {
    /// The error name an answer carries for this failure. A refused access
    /// is named as `IOUtils` names one, so the browser reports both alike
    /// (`folderProblem` in `SvalSharedFolder.sys.mjs`).
    pub fn name(&self) -> &'static str {
        match self {
            RemoteError::NotFound => "NotFoundError",
            RemoteError::Exists => "Exists",
            RemoteError::SignIn => "SignInError",
            RemoteError::Denied => "NotAllowedError",
            RemoteError::Unreachable => "NetworkError",
            RemoteError::Other => "UnknownError",
        }
    }
}

pub type Result<T> = std::result::Result<T, RemoteError>;

/// The calls the helper's operations make of a remote folder. Paths are
/// `/`-separated and relative to the folder; the empty path is the folder.
pub trait Store {
    /// What is at `path`, or None when nothing is.
    fn kind(&mut self, path: &str) -> Result<Option<Kind>>;
    /// The entries of the directory `dir`. A directory that does not exist
    /// holds none.
    fn list(&mut self, dir: &str) -> Result<Vec<Child>>;
    /// The bytes of each file in `paths`, in order, each read for at most
    /// its limit: a file longer than its limit reads as its first `limit`
    /// bytes, so the caller tells a file that grew from one that didn't
    /// without holding more than it allows. A store may read them at once.
    fn read_all(&mut self, paths: &[(&str, u64)]) -> Vec<Result<Vec<u8>>>;
    /// Writes `bytes` at `path` so that no reader sees half of them, making
    /// the directories on the way.
    fn write(&mut self, path: &str, bytes: &[u8]) -> Result<()>;
    /// Renames the file at `from` to `to`, refusing with `Exists` when
    /// anything is at `to`.
    fn rename_new(&mut self, from: &str, to: &str) -> Result<()>;
    /// Removes the file at `path`; nothing there is not a failure.
    fn remove_file(&mut self, path: &str) -> Result<()>;
    /// Removes the empty directory at `path`; nothing there is not a
    /// failure.
    fn remove_dir(&mut self, path: &str) -> Result<()>;
    /// Makes the directory at `path` and every one on the way.
    fn make_dirs(&mut self, path: &str) -> Result<()>;
}

/// Where a remote shared folder is, from a request's `root`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Location {
    /// `smb://[user@]host[:port]/share[/folder...]`.
    Smb {
        host: String,
        port: u16,
        share: String,
        path: String,
        username: String,
    },
    /// `dropbox:/folder...`, the folder's Dropbox path. `dropbox:/` is the
    /// root of the user's Dropbox.
    Dropbox { path: String },
}

/// Whether `root` names a remote folder: it starts with one of the forms
/// [`Location`] reads. A root that does is never a local path, on any
/// platform.
pub fn is_remote_root(root: &str) -> bool {
    root.starts_with("smb://") || root.starts_with("dropbox:")
}

/// Each `/`-separated segment of `path` percent-decoded, rejoined with `/`,
/// or None when a segment is empty, `.` or `..`, or decodes to a `/`, a
/// backslash or a NUL.
fn decoded_segments(path: &str) -> Option<String> {
    let mut out = Vec::new();
    for raw in path.split('/').filter(|s| !s.is_empty()) {
        let segment = percent_decode(raw)?;
        if segment == "." || segment == ".." || segment.contains(['/', '\\', '\0']) {
            return None;
        }
        out.push(segment);
    }
    Some(out.join("/"))
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

impl Location {
    /// The location `root` names, or None when it is not a well-formed
    /// remote root.
    pub fn parse(root: &str) -> Option<Location> {
        if let Some(rest) = root.strip_prefix("smb://") {
            let (authority, path) = rest.split_once('/')?;
            let (username, hostport) = match authority.rsplit_once('@') {
                Some((user, hostport)) => (percent_decode(user)?, hostport),
                None => (String::new(), authority),
            };
            let (host, port) = match hostport.rsplit_once(':') {
                // An IPv6 address is bracketed, and its colons are inside.
                Some((host, port)) if !port.contains(']') => (host, port.parse().ok()?),
                _ => (hostport, 445),
            };
            if host.is_empty() || host.contains(['/', '\\', '\0', ' ']) {
                return None;
            }
            let path = decoded_segments(path)?;
            let (share, path) = match path.split_once('/') {
                Some((share, path)) => (share.to_owned(), path.to_owned()),
                None => (path, String::new()),
            };
            if share.is_empty() {
                return None;
            }
            return Some(Location::Smb {
                host: host.to_owned(),
                port,
                share,
                path,
                username,
            });
        }
        let rest = root.strip_prefix("dropbox:")?;
        if !rest.starts_with('/') {
            return None;
        }
        Some(Location::Dropbox {
            path: decoded_segments(rest)?,
        })
    }
}

/// The sign-in a request carries for a remote root, from its `auth`: an SMB
/// password, or Dropbox's refresh token. None when the field is missing or
/// does not suit the location.
pub fn auth_for(location: &Location, request: &Value) -> Option<String> {
    let auth = request.get("auth")?;
    let field = match location {
        Location::Smb { .. } => "password",
        Location::Dropbox { .. } => "refreshToken",
    };
    auth.get(field)?.as_str().map(str::to_owned)
}

/// The stores this helper has opened, one per location and sign-in, kept
/// for the browser run so each request reuses a connection and the bytes it
/// read before.
#[derive(Default)]
pub struct Stores {
    open: HashMap<(Location, String), Box<dyn Store + Send>>,
}

impl Stores {
    /// Puts `store` in place for `location` and `auth`, as a test's fake.
    #[cfg(test)]
    pub(crate) fn insert(&mut self, location: &Location, auth: &str, store: Box<dyn Store + Send>) {
        self.open.insert((location.clone(), auth.to_owned()), store);
    }

    /// The store for `location` signed in with `auth`. A store is made once
    /// and kept; a new password or token makes a new one and drops the old.
    pub fn get(&mut self, location: &Location, auth: &str) -> &mut (dyn Store + Send) {
        let key = (location.clone(), auth.to_owned());
        if !self.open.contains_key(&key) {
            self.open.retain(|(at, _), _| at != location);
            self.open.insert(key.clone(), open(location, auth));
        }
        self.open.get_mut(&key).expect("inserted above").as_mut()
    }
}

fn open(location: &Location, auth: &str) -> Box<dyn Store + Send> {
    match location {
        Location::Smb {
            host,
            port,
            share,
            path,
            username,
        } => Box::new(smb::SmbStore::new(smb::SmbTarget {
            addr: format!("{host}:{port}"),
            share: share.clone(),
            path: path.clone(),
            username: username.clone(),
            password: auth.to_owned(),
        })),
        Location::Dropbox { path } => Box::new(dropbox::DropboxStore::new(auth, path)),
    }
}

/// `a/b` from `a` and `b`, either of which may be empty.
pub fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_owned(),
        (_, true) => a.to_owned(),
        _ => format!("{a}/{b}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn smb(host: &str, port: u16, share: &str, path: &str, user: &str) -> Location {
        Location::Smb {
            host: host.into(),
            port,
            share: share.into(),
            path: path.into(),
            username: user.into(),
        }
    }

    #[test]
    fn reads_an_smb_root() {
        assert_eq!(
            Location::parse("smb://nas.local/Shared/Sval%20Sync"),
            Some(smb("nas.local", 445, "Shared", "Sval Sync", ""))
        );
        assert_eq!(
            Location::parse("smb://me%40home@192.168.1.5:4445/share/a/b/"),
            Some(smb("192.168.1.5", 4445, "share", "a/b", "me@home"))
        );
        assert_eq!(
            Location::parse("smb://[fe80::1]/share"),
            Some(smb("[fe80::1]", 445, "share", "", ""))
        );
        assert_eq!(
            Location::parse("smb://[fe80::1]:139/share"),
            Some(smb("[fe80::1]", 139, "share", "", ""))
        );
        for refused in [
            "smb://",
            "smb://host",
            "smb://host/",
            "smb:///share",
            "smb://host:notaport/share",
            "smb://host/share/../up",
            "smb://host/share/%2Fslash",
            "smb://host/share/%5Cback",
            "smb://host/share/%00",
            "smb://host/share/%zz",
        ] {
            assert_eq!(Location::parse(refused), None, "{refused:?} is refused");
        }
    }

    #[test]
    fn reads_a_dropbox_root() {
        assert_eq!(
            Location::parse("dropbox:/"),
            Some(Location::Dropbox { path: "".into() })
        );
        assert_eq!(
            Location::parse("dropbox:/Apps/Sval%20Sync"),
            Some(Location::Dropbox {
                path: "Apps/Sval Sync".into()
            })
        );
        assert_eq!(Location::parse("dropbox:Sval"), None);
        assert_eq!(Location::parse("dropbox:/a/../b"), None);
    }

    #[test]
    fn a_remote_root_is_never_a_local_one() {
        assert!(is_remote_root("smb://host/share"));
        assert!(is_remote_root("dropbox:/"));
        assert!(!is_remote_root("/Volumes/share"));
        assert!(!is_remote_root("C:\\Users\\me"));
        assert!(!crate::paths::is_root("smb://host/share"));
    }

    #[test]
    fn the_sign_in_suits_the_location() {
        let at = smb("h", 445, "s", "", "u");
        assert_eq!(
            auth_for(&at, &json!({ "auth": { "password": "pw" } })),
            Some("pw".into())
        );
        assert_eq!(
            auth_for(&at, &json!({ "auth": { "refreshToken": "t" } })),
            None
        );
        assert_eq!(auth_for(&at, &json!({})), None);
        let dropbox = Location::Dropbox { path: "".into() };
        assert_eq!(
            auth_for(&dropbox, &json!({ "auth": { "refreshToken": "t" } })),
            Some("t".into())
        );
    }
}
