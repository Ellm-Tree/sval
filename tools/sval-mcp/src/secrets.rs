// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Where an agent's pairing secret lives on the agent's side: a file only its
//! owner can read, in the profile's `sval-agents` directory. Sval keeps only a
//! hash.

use crate::proof::to_hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credentials {
    pub agent_id: String,
    pub secret: String,
}

/// A secret must not reach a log or a panic message through `{:?}`.
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("agent_id", &self.agent_id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

pub trait SecretStore: Send + Sync {
    fn load(&self, account: &str) -> Option<Credentials>;
    fn save(&self, account: &str, credentials: &Credentials) -> Result<(), String>;
    fn forget(&self, account: &str);
}

/// One JSON file per account, in the profile's `sval-agents` directory, which
/// only its owner can open (`bridge::agent_dir`). The file is mode 0600 on
/// Unix. On Windows it inherits the directory's DACL, which Sval's
/// `makePrivateDirectory` limits to the user and SYSTEM, as for Sval's own
/// files there.
///
/// Spec §3.6 and decision 0088 give the reasoning: a process running as the
/// user can already read the profile, so an OS credential store adds nothing
/// against it.
pub struct FileStore {
    dir: PathBuf,
}

impl FileStore {
    pub fn new(dir: PathBuf) -> Self {
        FileStore { dir }
    }

    pub fn path_for(&self, account: &str) -> PathBuf {
        self.dir.join(format!("secret-{}.json", digest_of(account)))
    }
}

/// A file name's part for `account`: a hash, so an account of any shape names
/// a plain file inside the directory.
pub(crate) fn digest_of(account: &str) -> String {
    to_hex(&Sha256::digest(account.as_bytes()))[..32].to_owned()
}

/// Removes the `live-<hash>.lock` files a profile can carry, one per account,
/// from a `sval-mcp` that locked each account in a file of its own. Only a
/// file no process holds goes: one an older shim still holds is left, and a
/// later start removes it once that shim has exited. Nothing else in the
/// directory is touched.
pub fn remove_account_lock_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|n| n.starts_with("live-") && n.ends_with(".lock"))
        {
            continue;
        }
        let path = entry.path();
        let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) else {
            continue;
        };
        if file.try_lock().is_ok() {
            remove_unheld(file, &path);
        }
    }
}

/// Removes the file `file` is open on, whose whole-file lock this process
/// holds. On Unix it is unlinked under the lock. Windows refuses to remove an
/// open file, so the handle closes first, and the removal fails if an older
/// shim has opened the file since: it opens without delete sharing.
fn remove_unheld(file: File, path: &Path) {
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(path);
        drop(file);
    }
    #[cfg(not(unix))]
    {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
}

impl SecretStore for FileStore {
    fn load(&self, account: &str) -> Option<Credentials> {
        let text = std::fs::read_to_string(self.path_for(account)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn save(&self, account: &str, credentials: &Credentials) -> Result<(), String> {
        let json = serde_json::to_vec(credentials).map_err(|e| e.to_string())?;
        make_private_dir(&self.dir).map_err(|e| e.to_string())?;
        write_private(&self.path_for(account), &json).map_err(|e| e.to_string())
    }

    fn forget(&self, account: &str) {
        let _ = std::fs::remove_file(self.path_for(account));
    }
}

/// Makes `dir` a directory only its owner can open, 0700, and tightens one
/// that has group or other bits, as Sval's `makePrivateDirectory` does.
#[cfg(unix)]
fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let mode = std::fs::metadata(dir)?.permissions().mode();
    if mode & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Writes `bytes` to a fresh temporary file beside `path`, created 0600 on
/// Unix so it is never readable by anyone else, then renames it over `path`.
/// A reader sees the old file or the new one, never part of either. The
/// temporary name is unique per write, so two `sval-mcp` processes pairing at
/// once cannot write into one file.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(std::io::Error::other)?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", to_hex(&suffix)));
    let tmp = PathBuf::from(tmp);

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| std::fs::rename(&tmp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed
}

/// For tests, and nothing else.
#[derive(Default)]
pub struct MemoryStore(Mutex<BTreeMap<String, Credentials>>);

impl SecretStore for MemoryStore {
    fn load(&self, account: &str) -> Option<Credentials> {
        self.0.lock().unwrap().get(account).cloned()
    }
    fn save(&self, account: &str, credentials: &Credentials) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_owned(), credentials.clone());
        Ok(())
    }
    fn forget(&self, account: &str) {
        self.0.lock().unwrap().remove(account);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TempDir;

    fn credentials(secret: &str) -> Credentials {
        Credentials {
            agent_id: "a1".into(),
            secret: secret.into(),
        }
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_saved_secret_loads_back_and_forget_deletes_its_file() {
        let profile = TempDir::new("secrets-roundtrip");
        let store = FileStore::new(profile.0.join("sval-agents"));
        assert_eq!(store.load("p|Agent"), None);
        store.save("p|Agent", &credentials("s1")).unwrap();
        assert_eq!(store.load("p|Agent"), Some(credentials("s1")));
        assert!(store.path_for("p|Agent").is_file());
        store.forget("p|Agent");
        assert_eq!(store.load("p|Agent"), None);
        assert!(!store.path_for("p|Agent").exists());
        // Forgetting what is not there is not an error.
        store.forget("p|Agent");
    }

    #[test]
    fn each_account_has_its_own_file() {
        let profile = TempDir::new("secrets-accounts");
        let store = FileStore::new(profile.0.join("sval-agents"));
        store.save("p|One", &credentials("s1")).unwrap();
        store.save("p|Two", &credentials("s2")).unwrap();
        assert_ne!(store.path_for("p|One"), store.path_for("p|Two"));
        store.forget("p|One");
        assert_eq!(store.load("p|One"), None);
        assert_eq!(store.load("p|Two"), Some(credentials("s2")));
    }

    #[test]
    fn a_client_name_of_any_shape_stays_inside_the_directory() {
        let profile = TempDir::new("secrets-names");
        let dir = profile.0.join("sval-agents");
        let store = FileStore::new(dir.clone());
        let account = "p|../../etc/passwd\\ \u{0}name";
        store.save(account, &credentials("s1")).unwrap();
        assert_eq!(store.path_for(account).parent(), Some(dir.as_path()));
        assert_eq!(store.load(account), Some(credentials("s1")));
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_no_temporary_file() {
        let profile = TempDir::new("secrets-replace");
        let dir = profile.0.join("sval-agents");
        let store = FileStore::new(dir.clone());
        store.save("p|Agent", &credentials("first")).unwrap();
        let long = "x".repeat(4096);
        store.save("p|Agent", &credentials(&long)).unwrap();
        store.save("p|Agent", &credentials("short")).unwrap();
        assert_eq!(store.load("p|Agent"), Some(credentials("short")));
        let file = store.path_for("p|Agent");
        assert_eq!(
            entries(&dir),
            vec![file.file_name().unwrap().to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn a_failed_save_keeps_the_previous_secret_and_cleans_up() {
        let profile = TempDir::new("secrets-failed");
        let dir = profile.0.join("sval-agents");
        let store = FileStore::new(dir.clone());
        store.save("p|Agent", &credentials("kept")).unwrap();
        // A directory where the file belongs makes the rename fail.
        let other = "p|Other";
        std::fs::create_dir(store.path_for(other)).unwrap();
        std::fs::write(store.path_for(other).join("inside"), b"x").unwrap();
        // The error this platform gives for renaming a file over that directory.
        let probe = profile.0.join("probe");
        std::fs::write(&probe, b"x").unwrap();
        let refused = std::fs::rename(&probe, store.path_for(other)).unwrap_err();
        std::fs::remove_file(&probe).unwrap();
        assert_eq!(
            store.save(other, &credentials("lost")),
            Err(refused.to_string())
        );
        assert_eq!(store.load("p|Agent"), Some(credentials("kept")));
        assert!(!entries(&dir).iter().any(|n| n.ends_with(".tmp")));
    }

    #[test]
    fn a_file_that_is_not_credentials_loads_as_none() {
        let profile = TempDir::new("secrets-garbage");
        let dir = profile.0.join("sval-agents");
        let store = FileStore::new(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store.path_for("p|Agent"), b"{not json").unwrap();
        assert_eq!(store.load("p|Agent"), None);
    }

    /// A `live-<hash>.lock` as a shim that locked each account in a file of
    /// its own leaves it. That shim held it with `File::try_lock`.
    fn account_lock_file(dir: &Path, account: &str) -> PathBuf {
        let path = dir.join(format!("live-{}.lock", digest_of(account)));
        std::fs::write(&path, b"").unwrap();
        path
    }

    #[test]
    fn an_unheld_account_lock_file_is_removed_and_nothing_else_is() {
        let profile = TempDir::new("secrets-account-locks");
        let dir = profile.0.join("sval-agents");
        let store = FileStore::new(dir.clone());
        store.save("p|Agent", &credentials("s1")).unwrap();
        std::fs::write(dir.join("agents.json"), b"{}").unwrap();
        std::fs::write(dir.join("port.json"), b"{}").unwrap();
        let unheld = account_lock_file(&dir, "p|unheld|0");
        let held = account_lock_file(&dir, "p|held|0");
        let holder = File::options().write(true).open(&held).unwrap();
        holder.try_lock().unwrap();

        remove_account_lock_files(&dir);

        assert!(!unheld.exists(), "an unheld account lock file goes");
        assert!(held.exists(), "one an older shim holds stays");
        assert_eq!(
            entries(&dir),
            [
                "agents.json".to_owned(),
                held.file_name().unwrap().to_string_lossy().into_owned(),
                "port.json".to_owned(),
                store
                    .path_for("p|Agent")
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ]
        );
        drop(holder);
    }

    #[test]
    fn debug_never_shows_the_secret() {
        let shown = format!("{:?}", credentials("hunter2"));
        assert!(!shown.contains("hunter2"));
        assert!(shown.contains("<redacted>"));
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn mode(path: &Path) -> u32 {
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn the_file_is_0600_and_a_new_directory_is_0700() {
            let profile = TempDir::new("secrets-modes");
            let dir = profile.0.join("sval-agents");
            let store = FileStore::new(dir.clone());
            store.save("p|Agent", &credentials("s1")).unwrap();
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&store.path_for("p|Agent")), 0o600);
            store.save("p|Agent", &credentials("s2")).unwrap();
            assert_eq!(mode(&store.path_for("p|Agent")), 0o600);
        }

        #[test]
        fn a_loose_directory_is_tightened_before_the_secret_is_written() {
            let profile = TempDir::new("secrets-loose");
            let dir = profile.0.join("sval-agents");
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            let store = FileStore::new(dir.clone());
            store.save("p|Agent", &credentials("s1")).unwrap();
            assert_eq!(mode(&dir), 0o700);
        }

        #[test]
        fn a_replaced_file_takes_0600_whatever_the_old_file_had() {
            let profile = TempDir::new("secrets-oldmode");
            let dir = profile.0.join("sval-agents");
            let store = FileStore::new(dir.clone());
            store.save("p|Agent", &credentials("s1")).unwrap();
            let file = store.path_for("p|Agent");
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            store.save("p|Agent", &credentials("s2")).unwrap();
            assert_eq!(mode(&file), 0o600);
        }
    }
}
