// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! `StorageProvider`, the seam through which all platform I/O passes.
//!
//! A workspace document is never written to storage in the clear, and never
//! under its own name: [`save_document`] seals it with [`crate::crypto::seal`]
//! and hashes the workspace id with [`crate::crypto::hashed_name`] before
//! either touches a [`StorageProvider`]. What lands on a user's iCloud,
//! OneDrive or plain folder is ciphertext at an unreadable path.
//!
//! Layout is one file per device per document, `sval/ws/<hashed>/<device>.json`.
//! Two devices never write the same file. A cloud sync client resolves a
//! same-file race by keeping both writes as a "conflicted copy", so this
//! layout leaves it no race to resolve for workspace data.

use crate::crypto::{self, Key};
use crate::types::{Document, Error};
use std::collections::BTreeMap;
use std::sync::Mutex;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::{AtomicU64, Ordering};

/// Everything sval-core needs from a storage backend.
///
/// This is the seam a WASM host must satisfy through a JS shim, since WASM has
/// no filesystem of its own. Adding a method here means adding it to every
/// host.
pub trait StorageProvider {
    fn list(&self, prefix: &str) -> Result<Vec<String>, Error>;
    fn read(&self, path: &str) -> Result<Vec<u8>, Error>;
    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Error>;
}

/// A device's identity within the file layout, e.g. the `<device>` in
/// `sval/ws/<hashed>/<device>.json`.
///
/// Built from caller-supplied bytes only. This crate must not mint ids or
/// read the environment (see the `Timestamp` doc comment in `types.rs`), so
/// a host (the desktop fork, a mobile app) generates its own device identity
/// once, persists it, and passes it in on every call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceId([u8; 16]);

impl DeviceId {
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// A fresh id for tests only, from
    /// [`crate::types::test_support::next_in_sequence`]. Real callers use
    /// [`DeviceId::from_bytes`] with bytes the host supplies.
    #[cfg(test)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let mut bytes = [0xde; 16];
        bytes[8..].copy_from_slice(&crate::types::test_support::next_in_sequence().to_le_bytes());
        Self(bytes)
    }

    /// Parses the 32-character lowercase-hex form [`Display`] produces, which
    /// is also the spelling a document's version vector uses on disk (spec
    /// §6.2).
    ///
    /// [`Display`]: std::fmt::Display
    pub fn from_hex(text: &str) -> Option<Self> {
        crate::hex::decode(text)?.try_into().ok().map(Self)
    }
}

/// Serialised as hex text: a `DeviceId` is a **key** in a document's `seen`
/// map (`Document::seen`), and JSON object keys are strings. It is the same
/// spelling the file layout already uses for the
/// `<device>` in a path, so one device has one spelling everywhere.
impl serde::Serialize for DeviceId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> serde::Deserialize<'de> for DeviceId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
        DeviceId::from_hex(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("not a device id: {text}")))
    }
}

impl std::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::hex::encode(&self.0))
    }
}

/// The directory in the shared folder that holds every file Sval keeps
/// there (spec §6.2).
pub const TOP_DIR: &str = "sval";

/// Whether a folder named `name`, picked as the shared folder, is Sval's own
/// directory, so that the folder holding it is the shared folder (spec
/// §6.4). The name alone decides: what the folder holds changes as devices
/// write to it, and a test of its contents gives one pick two readings.
/// The match is exact, so a folder of the user's own named `Sval` is the
/// folder that holds `sval/`.
pub fn is_top_dir_name(name: &str) -> bool {
    name == TOP_DIR
}

/// The shared folder a pick of the `/`-separated `path` names: the folder
/// that holds it when `path` is Sval's own directory (`is_top_dir_name`),
/// and `path` otherwise. A pick of `sval` alone names the root, as empty.
pub fn shared_root_of(path: &str) -> String {
    let bare = path.trim_end_matches('/');
    let (parent, name) = bare.rsplit_once('/').unwrap_or(("", bare));
    if is_top_dir_name(name) {
        parent.to_owned()
    } else {
        path.to_owned()
    }
}

pub(crate) fn workspace_dir(key: &Key, workspace: &str) -> String {
    format!("{TOP_DIR}/ws/{}", crypto::hashed_name(key, workspace))
}

pub(crate) fn device_path(key: &Key, workspace: &str, device: DeviceId) -> String {
    format!("{}/{device}.json", workspace_dir(key, workspace))
}

/// Seals `doc` and writes it to this device's own file for `workspace`.
///
/// Never writes any other device's file, so cloud clients never see two
/// writers race on one path.
pub fn save_document<S: StorageProvider>(
    store: &S,
    key: &Key,
    device: DeviceId,
    workspace: &str,
    doc: &Document,
) -> Result<(), Error> {
    let path = device_path(key, workspace, device);
    let (_, sealed) = seal_document(key, &path, doc)?;
    store.write(&path, &sealed)
}

/// `doc` as JSON, and that JSON sealed for `path`.
pub fn seal_document(key: &Key, path: &str, doc: &Document) -> Result<(String, Vec<u8>), Error> {
    let json = doc.to_json()?;
    let sealed = crypto::seal(key, path.as_bytes(), json.as_bytes())?;
    Ok((json, sealed))
}

/// Reads back and opens this device's own file for `workspace`.
#[cfg(test)]
pub(crate) fn load_document<S: StorageProvider>(
    store: &S,
    key: &Key,
    device: DeviceId,
    workspace: &str,
) -> Result<Document, Error> {
    let path = device_path(key, workspace, device);
    let sealed = store.read(&path)?;
    let json = crypto::open(key, path.as_bytes(), &sealed)?;
    let json = String::from_utf8(json).map_err(|_| Error::NotUtf8)?;
    Document::from_json(&json)
}

/// The device whose file `path` is in the directory `dir`, if it names one:
/// a `<device>.json` directly inside it, the name [`device_path`] gives.
///
/// The folder is the user's, and cloud clients write into it: a conflict
/// copy of a directory beside it (`<hashed> (1)/`), a `.DS_Store`, a
/// conflict copy of a file (`<device> (1).json`). None of those is a peer's
/// state, so none is opened. A file with a device's name that will not open
/// is a peer's state that this key cannot read, and `sync` reports it.
pub(crate) fn device_of(dir: &str, path: &str) -> Option<DeviceId> {
    path.strip_prefix(dir)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|name| name.strip_suffix(".json"))
        .and_then(DeviceId::from_hex)
}

/// Lists every other device's file for `workspace`, with the device each
/// one's name gives. Only device files count (`device_of`). The listing names
/// the directory with its separator, so a sibling whose name merely starts
/// with the same characters is not inside it.
pub fn peer_files<S: StorageProvider>(
    store: &S,
    key: &Key,
    me: DeviceId,
    workspace: &str,
) -> Result<Vec<(String, DeviceId)>, Error> {
    let dir = workspace_dir(key, workspace);
    Ok(store
        .list(&format!("{dir}/"))?
        .into_iter()
        .filter_map(|path| {
            let device = device_of(&dir, &path)?;
            (device != me).then_some((path, device))
        })
        .collect())
}

/// An in-memory [`StorageProvider`], so the merge and sync tests never touch
/// a disk. Kept outside `#[cfg(test)]` so a host can use it as a
/// dependency-free backend.
#[derive(Default)]
pub struct MemoryStore {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl StorageProvider for MemoryStore {
    fn list(&self, prefix: &str) -> Result<Vec<String>, Error> {
        let files = self.files.lock().map_err(|_| Error::Poisoned)?;
        Ok(files
            .keys()
            .filter(|path| path.starts_with(prefix))
            .cloned()
            .collect())
    }

    fn read(&self, path: &str) -> Result<Vec<u8>, Error> {
        let files = self.files.lock().map_err(|_| Error::Poisoned)?;
        files
            .get(path)
            .cloned()
            .ok_or_else(|| Error::NotFound(path.to_string()))
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Error> {
        let mut files = self.files.lock().map_err(|_| Error::Poisoned)?;
        files.insert(path.to_string(), bytes.to_vec());
        Ok(())
    }
}

// Distinguishes concurrent writers to the same path: two calls to
// `LocalFolder::write` for the same target must not share one temp file, or
// one writer's partial content can end up renamed over the other's. Two
// writes from one process race too, so a per-process counter rides along with
// the process id. Neither is entropy: `process::id()` is fixed when the
// process starts.
#[cfg(not(target_arch = "wasm32"))]
static TMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A [`StorageProvider`] backed by a plain folder on disk: the folder the user
/// picks, which is what SMB, a synced iCloud Drive folder or a mounted
/// OneDrive folder all reduce to once mounted.
///
/// Compiled out on `wasm32-unknown-unknown`: WASM has no filesystem, so this
/// type cannot exist there. The desktop fork supplies a JS shim implementing
/// [`StorageProvider`]; only the trait crosses that boundary.
#[cfg(not(target_arch = "wasm32"))]
pub struct LocalFolder {
    root: std::path::PathBuf,
}

#[cfg(not(target_arch = "wasm32"))]
impl LocalFolder {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn full_path(&self, path: &str) -> std::path::PathBuf {
        self.root.join(path)
    }

    fn walk(
        dir: &std::path::Path,
        root: &std::path::Path,
        out: &mut Vec<String>,
    ) -> Result<(), Error> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            // `file_type` does not follow links. A link is skipped: one back up
            // the tree would be walked forever, and one out of the folder
            // names files that are not this store's.
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                Self::walk(&path, root, out)?;
                continue;
            }
            if let Ok(relative) = path.strip_prefix(root) {
                let mut components = Vec::new();
                for part in relative.components() {
                    components.push(part.as_os_str().to_string_lossy().into_owned());
                }
                out.push(components.join("/"));
            }
        }
        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl StorageProvider for LocalFolder {
    fn list(&self, prefix: &str) -> Result<Vec<String>, Error> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        // The contract is `MemoryStore`'s: every path whose relative
        // representation has `prefix` as a string prefix, including a sibling
        // that merely starts with the same characters, such as
        // `sval/ws/abcdef.json` next to a `sval/ws/abcdef/` directory. A
        // prefix ending in `/` names a directory, and only that directory is
        // walked. Any other prefix walks its parent and filters by string
        // prefix afterward.
        let candidate = self.root.join(prefix);
        let scope = if prefix.is_empty() {
            self.root.clone()
        } else if prefix.ends_with('/') {
            candidate
        } else {
            candidate.parent().unwrap_or(&self.root).to_path_buf()
        };
        let mut all = Vec::new();
        if scope.exists() {
            Self::walk(&scope, &self.root, &mut all)?;
        }
        // `read_dir` makes no ordering promise, while `MemoryStore::list`
        // returns its `BTreeMap`'s sorted key order. Sorting here gives both
        // providers the same order, so `sync` merges peers in the same order
        // whichever one backs it.
        let mut matching: Vec<String> = all.into_iter().filter(|p| p.starts_with(prefix)).collect();
        matching.sort();
        Ok(matching)
    }

    fn read(&self, path: &str) -> Result<Vec<u8>, Error> {
        std::fs::read(self.full_path(path)).map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                Error::NotFound(path.to_string())
            } else {
                Error::Io(err)
            }
        })
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Error> {
        let target = self.full_path(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let unique = TMP_SEQUENCE.fetch_add(1, Ordering::SeqCst);
        let tmp = target.with_extension(format!("{}-{unique}.tmp", std::process::id()));
        // Flushed before the rename, so a crash cannot leave `target` naming a
        // file whose contents never reached the disk.
        let written = std::fs::File::create(&tmp).and_then(|mut file| {
            std::io::Write::write_all(&mut file, bytes)?;
            file.sync_all()
        });
        if let Err(err) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Io(err));
        }
        // Rename is atomic within a filesystem, so a peer reading `target`
        // never observes a partial write: it sees either the old file or the
        // new one, never a truncated one. It also succeeds when `target`
        // itself is read-only, because replacing a directory entry is
        // governed by the containing directory's permissions.
        if let Err(err) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Io(err));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::test_support::{base_doc, test_device};

    #[cfg(unix)]
    #[test]
    fn local_folder_list_does_not_follow_a_symlinked_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalFolder::new(dir.path());
        store.write("sval/ws/a/one.json", b"1").unwrap();
        // A link back up the tree: following it would walk forever, and a link
        // out of the folder would list files that are not the store's.
        std::os::unix::fs::symlink(dir.path().join("sval"), dir.path().join("sval/ws/a/loop"))
            .unwrap();

        assert_eq!(store.list("sval/").unwrap(), vec!["sval/ws/a/one.json"]);
    }

    #[test]
    fn a_device_id_has_exactly_one_spelling() {
        let canonical = "0f".repeat(16);
        assert_eq!(
            DeviceId::from_hex(&canonical),
            Some(DeviceId::from_bytes([0x0f; 16]))
        );
        // `u8::from_str_radix` accepts a leading sign, so `+f` would read as
        // `0f` and one device would answer to two names.
        assert_eq!(DeviceId::from_hex(&"+f".repeat(16)), None);
        assert_eq!(DeviceId::from_hex(&"0F".repeat(16)), None);
    }

    #[test]
    fn a_device_writes_and_reads_back_its_own_file() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();
        let doc = base_doc();

        save_document(&store, &key, dev, "ws-1", &doc).unwrap();
        let back = load_document(&store, &key, dev, "ws-1").unwrap();

        assert_eq!(back.to_json().unwrap(), doc.to_json().unwrap());
    }

    #[test]
    fn an_own_file_that_opens_but_is_not_utf8_is_not_called_a_decryption_failure() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();
        let path = device_path(&key, "ws-1", dev);
        let sealed = crypto::seal(&key, path.as_bytes(), &[0xff, 0xfe]).unwrap();
        store.write(&path, &sealed).unwrap();

        let err = load_document(&store, &key, dev, "ws-1").unwrap_err();

        assert!(matches!(err, Error::NotUtf8), "{err}");
    }

    #[test]
    fn peers_are_listed_and_the_writers_own_file_is_excluded() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (me, them) = (DeviceId::new(), DeviceId::new());
        save_document(&store, &key, me, "ws-1", &base_doc()).unwrap();
        save_document(&store, &key, them, "ws-1", &base_doc()).unwrap();

        let peers = peer_files(&store, &key, me, "ws-1").unwrap();
        assert_eq!(peers, vec![(device_path(&key, "ws-1", them), them)]);
    }

    #[test]
    fn stored_bytes_are_not_readable_plaintext() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let mut doc = base_doc();
        doc.add_workspace(
            "Secret Client Name",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        save_document(&store, &key, DeviceId::new(), "ws-1", &doc).unwrap();

        for name in store.list("").unwrap() {
            let raw = store.read(&name).unwrap();
            assert!(!String::from_utf8_lossy(&raw).contains("Secret Client Name"));
            assert!(!name.contains("Secret"));
        }
    }

    #[test]
    #[cfg(unix)]
    fn local_folder_write_survives_a_read_only_target_file() {
        // Discriminates a rename-based write from a direct one: a direct
        // `fs::write` to a read-only file fails with a permission error,
        // while a rename over it succeeds, because a rename needs write
        // permission on the *directory*.
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let store = LocalFolder::new(dir.path());
        store.write("a.json", b"first").unwrap();

        let target = dir.path().join("a.json");
        let mut locked = std::fs::metadata(&target).unwrap().permissions();
        locked.set_mode(0o444);
        std::fs::set_permissions(&target, locked).unwrap();
        // Root opens a read-only file for writing, so a direct write would
        // pass too and the test would discriminate nothing.
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .is_err(),
            "a read-only file opens for writing; run the tests as an unprivileged user"
        );

        let result = store.write("a.json", b"second-and-longer");

        // Restored unconditionally, including on failure, so the tempdir
        // can still be cleaned up when this test's assertions fail.
        let mut writable = std::fs::metadata(&target).unwrap().permissions();
        writable.set_mode(0o644);
        std::fs::set_permissions(&target, writable).unwrap();

        result.unwrap();
        assert_eq!(store.read("a.json").unwrap(), b"second-and-longer");

        let strays: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(strays.is_empty(), "temp file left behind: {strays:?}");
    }

    /// Writes paths chosen so one is a *string* prefix match for
    /// `"sval/ws/abcdef"` while sitting outside any directory of that name
    /// (`sval/ws/abcdef.json`, a sibling of `sval/ws/abcdef/`), then lists
    /// that prefix. The listing is left unsorted: both providers must return
    /// the same order for the same writes, or `sync` would merge peers in a
    /// provider-dependent order.
    fn run_storage_scenario<S: StorageProvider>(store: &S) -> Vec<String> {
        store.write("sval/ws/abcdef/dev1.json", b"one").unwrap();
        store.write("sval/ws/abcdefg/dev2.json", b"two").unwrap();
        store.write("sval/ws/abcdef.json", b"three").unwrap();
        store.write("sval/other/dev3.json", b"four").unwrap();

        store.list("sval/ws/abcdef").unwrap()
    }

    #[test]
    fn a_local_folder_reports_a_missing_file_as_not_found_and_other_failures_as_io() {
        // `sync` treats NotFound on a device's own file as a first run and
        // writes it; any other failure refuses the write, so it must stay
        // distinct or `sync` would overwrite a file it could not read.
        let dir = tempfile::tempdir().unwrap();
        let store = LocalFolder::new(dir.path());
        assert!(matches!(
            store.read("sval/ws/a/missing.json"),
            Err(Error::NotFound(path)) if path == "sval/ws/a/missing.json"
        ));
        std::fs::create_dir_all(dir.path().join("sval/ws/a/dir.json")).unwrap();
        assert!(matches!(
            store.read("sval/ws/a/dir.json"),
            Err(Error::Io(_))
        ));
    }

    #[test]
    fn memory_store_and_local_folder_agree_on_list_semantics() {
        // The two providers must report identically for the same writes, so
        // `sync` need not know which one it is talking to.
        let mem_list = run_storage_scenario(&MemoryStore::new());

        let dir = tempfile::tempdir().unwrap();
        let folder_list = run_storage_scenario(&LocalFolder::new(dir.path()));

        assert_eq!(
            mem_list, folder_list,
            "list() semantics diverged between providers"
        );
        assert_eq!(
            mem_list,
            vec![
                "sval/ws/abcdef.json".to_string(),
                "sval/ws/abcdef/dev1.json".to_string(),
                "sval/ws/abcdefg/dev2.json".to_string(),
            ],
            "expected every path whose relative path has this string as a \
             prefix, including the sibling file outside the same-named directory"
        );
    }

    /// What a cloud client leaves in and beside a document's directory, with
    /// one real peer among it, and the peers `me` finds there.
    fn peers_among_what_a_cloud_client_writes<S: StorageProvider>(
        store: &S,
    ) -> Vec<(String, DeviceId)> {
        let key = Key::from_bytes(&[7u8; 32]).unwrap();
        let me = DeviceId::from_bytes([1; 16]);
        let peer = DeviceId::from_bytes([2; 16]);
        let dir = workspace_dir(&key, "ws-1");
        save_document(store, &key, me, "ws-1", &base_doc()).unwrap();
        save_document(store, &key, peer, "ws-1", &base_doc()).unwrap();
        // A conflict copy of the directory, and a device's suffix on it.
        store
            .write(&format!("{dir} (1)/{peer}.json"), b"x")
            .unwrap();
        store
            .write(&format!("{dir}-DESKTOP/{peer}.json"), b"x")
            .unwrap();
        // Finder's metadata, a conflict copy of a peer's file, and a folder
        // a client made inside the directory.
        store.write(&format!("{dir}/.DS_Store"), b"x").unwrap();
        store
            .write(&format!("{dir}/{peer} (1).json"), b"x")
            .unwrap();
        store
            .write(&format!("{dir}/old/{peer}.json"), b"x")
            .unwrap();
        peer_files(store, &key, me, "ws-1").unwrap()
    }

    #[test]
    fn only_a_peers_own_file_is_a_peer_whatever_else_the_folder_holds() {
        let key = Key::from_bytes(&[7u8; 32]).unwrap();
        let peer = DeviceId::from_bytes([2; 16]);
        let expected = vec![(device_path(&key, "ws-1", peer), peer)];
        assert_eq!(
            peers_among_what_a_cloud_client_writes(&MemoryStore::new()),
            expected
        );
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            peers_among_what_a_cloud_client_writes(&LocalFolder::new(dir.path())),
            expected
        );
    }

    #[test]
    fn only_a_folder_named_exactly_sval_is_svals_own_directory() {
        assert!(is_top_dir_name("sval"));
        for name in [
            "Sval",
            "SVAL",
            "sval ",
            " sval",
            "sval.backup",
            "my sval",
            "",
            "ws",
        ] {
            assert!(!is_top_dir_name(name), "{name:?}");
        }
    }

    #[test]
    fn a_pick_of_svals_own_directory_names_the_folder_that_holds_it() {
        for (picked, root) in [
            // Dropbox's spelling, from the root of the user's Dropbox.
            ("/Sval/sval", "/Sval"),
            ("/Sval/sval/", "/Sval"),
            ("/sval", ""),
            ("/sval/", ""),
            // An SMB share's, relative to the share.
            ("Sval/sval", "Sval"),
            ("Backups/Browsers/sval", "Backups/Browsers"),
            ("sval", ""),
            ("sval/", ""),
            // A device's own absolute path.
            (
                "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Sval/sval",
                "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Sval",
            ),
            // A user's folder named `sval` is Sval's directory whatever it
            // holds: every device reads the pick the same way.
            ("/Users/me/Dropbox/sval", "/Users/me/Dropbox"),
            // A `sval` folder inside Sval's own: its parent is the pick.
            ("/Sval/sval/sval", "/Sval/sval"),
        ] {
            assert_eq!(shared_root_of(picked), root, "{picked:?}");
        }
    }

    #[test]
    fn a_pick_of_any_other_folder_is_the_shared_folder_as_picked() {
        for picked in [
            "/Sval",
            "/Sval/",
            "Sval",
            "",
            "/",
            "/Users/me/Dropbox",
            "/Users/me/SVAL",
            "/sval/ws",
            "/sval/Sval",
            "/svalbak",
            "sval/pair",
        ] {
            assert_eq!(shared_root_of(picked), picked, "{picked:?}");
        }
    }

    #[test]
    fn workspaces_live_in_svals_own_directory() {
        let key = crate::types::test_support::test_key();
        assert!(workspace_dir(&key, "x").starts_with(&format!("{TOP_DIR}/ws/")));
    }

    #[test]
    fn a_corrupt_file_is_an_error_not_a_panic() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();
        store
            .write(&device_path(&key, "x", dev), b"not encrypted json at all")
            .unwrap();

        let err = load_document(&store, &key, dev, "x").unwrap_err();
        assert!(
            matches!(err, Error::DecryptionFailed),
            "expected DecryptionFailed, got {err:?}"
        );
    }
}
