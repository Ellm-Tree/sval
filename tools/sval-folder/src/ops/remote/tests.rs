// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! What the helper answers for each operation on a remote folder, against a
//! store held in memory.

use super::super::Folder;
use crate::remote::{Child, Kind, Location, RemoteError, Store};
use crate::test_dir::TempDir;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
enum Node {
    File(Vec<u8>, u32),
    Dir,
    Link,
}

#[derive(Default)]
struct Remote {
    nodes: BTreeMap<String, Node>,
    /// How many files the store has been asked to read.
    reads: usize,
    /// Set to make every call fail as a network failure would.
    offline: bool,
    /// Bumped on each write, as a store's version moves.
    writes: u32,
}

impl Remote {
    fn put(&mut self, path: &str, bytes: &[u8]) {
        self.writes += 1;
        let mut so_far = String::new();
        let parts: Vec<&str> = path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            so_far = crate::remote::join(&so_far, part);
            self.nodes.entry(so_far.clone()).or_insert(Node::Dir);
        }
        self.nodes
            .insert(path.to_owned(), Node::File(bytes.to_vec(), self.writes));
    }
}

#[derive(Clone)]
struct Fake(Arc<Mutex<Remote>>);

impl Fake {
    fn up(&self) -> Result<std::sync::MutexGuard<'_, Remote>, RemoteError> {
        let remote = self.0.lock().unwrap();
        if remote.offline {
            return Err(RemoteError::Unreachable);
        }
        Ok(remote)
    }
}

impl Store for Fake {
    fn kind(&mut self, path: &str) -> Result<Option<Kind>, RemoteError> {
        if path.is_empty() {
            drop(self.up()?);
            return Ok(Some(Kind::Dir));
        }
        Ok(self.up()?.nodes.get(path).map(|node| match node {
            Node::File(..) => Kind::File,
            Node::Dir => Kind::Dir,
            Node::Link => Kind::Link,
        }))
    }

    fn list(&mut self, dir: &str) -> Result<Vec<Child>, RemoteError> {
        let remote = self.up()?;
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        Ok(remote
            .nodes
            .iter()
            .filter_map(|(path, node)| {
                let name = path.strip_prefix(&prefix)?;
                if name.contains('/') {
                    return None;
                }
                Some(match node {
                    Node::File(bytes, version) => Child {
                        name: name.into(),
                        kind: Kind::File,
                        size: bytes.len() as u64,
                        version: version.to_string(),
                    },
                    Node::Dir => Child {
                        name: name.into(),
                        kind: Kind::Dir,
                        size: 0,
                        version: String::new(),
                    },
                    Node::Link => Child {
                        name: name.into(),
                        kind: Kind::Link,
                        size: 0,
                        version: String::new(),
                    },
                })
            })
            .collect())
    }

    fn read_all(&mut self, paths: &[(&str, u64)]) -> Vec<Result<Vec<u8>, RemoteError>> {
        paths
            .iter()
            .map(|&(path, limit)| {
                let mut remote = self.up()?;
                remote.reads += 1;
                match remote.nodes.get(path) {
                    Some(Node::File(bytes, _)) => {
                        Ok(bytes[..bytes.len().min(limit as usize)].to_vec())
                    }
                    _ => Err(RemoteError::NotFound),
                }
            })
            .collect()
    }

    fn write(&mut self, path: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        self.up()?.put(path, bytes);
        Ok(())
    }

    fn rename_new(&mut self, from: &str, to: &str) -> Result<(), RemoteError> {
        let mut remote = self.up()?;
        if remote.nodes.contains_key(to) {
            return Err(RemoteError::Exists);
        }
        let node = remote.nodes.remove(from).ok_or(RemoteError::NotFound)?;
        remote.nodes.insert(to.into(), node);
        Ok(())
    }

    fn remove_file(&mut self, path: &str) -> Result<(), RemoteError> {
        self.up()?.nodes.remove(path);
        Ok(())
    }

    fn remove_dir(&mut self, path: &str) -> Result<(), RemoteError> {
        let mut remote = self.up()?;
        let prefix = format!("{path}/");
        if remote.nodes.keys().any(|key| key.starts_with(&prefix)) {
            return Err(RemoteError::Other);
        }
        remote.nodes.remove(path);
        Ok(())
    }

    fn make_dirs(&mut self, path: &str) -> Result<(), RemoteError> {
        let mut remote = self.up()?;
        let mut so_far = String::new();
        for part in path.split('/') {
            so_far = crate::remote::join(&so_far, part);
            remote.nodes.entry(so_far.clone()).or_insert(Node::Dir);
        }
        Ok(())
    }
}

const ROOT: &str = "smb://nas/share/Sval";

struct Fixture {
    _dir: TempDir,
    requests: PathBuf,
    folder: Folder,
    fake: Fake,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(&format!("remote-{name}"));
        let requests = dir.0.join("requests");
        fs::create_dir_all(&requests).unwrap();
        let folder = Folder::new(requests.clone());
        let fake = Fake(Arc::default());
        folder.remote.borrow_mut().stores.insert(
            &Location::parse(ROOT).unwrap(),
            "pw",
            Box::new(fake.clone()),
        );
        Fixture {
            _dir: dir,
            requests,
            folder,
            fake,
        }
    }

    fn remote(&self) -> std::sync::MutexGuard<'_, Remote> {
        self.fake.0.lock().unwrap()
    }

    fn ask(&self, mut request: Value) -> Value {
        request["id"] = "req-1".into();
        request["root"] = ROOT.into();
        if request.get("auth").is_none() {
            request["auth"] = json!({ "password": "pw" });
        }
        if request.get("requireTop").is_none() {
            request["requireTop"] = Value::Null;
        }
        let mut answer = self.folder.answer(&request);
        assert_eq!(answer["id"], "req-1");
        answer.as_object_mut().unwrap().remove("id");
        answer
    }

    fn payload(&self, n: usize, bytes: &[u8]) -> String {
        let name = format!("payload-req-1-{n}.bin");
        fs::write(self.requests.join(&name), bytes).unwrap();
        name
    }

    /// The bytes of each entry a listing copied, by name.
    fn copies(&self, entries: &Value, sub: &str) -> Vec<(String, Vec<u8>)> {
        let into = self.requests.join("files-req-1").join(sub);
        entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["name"].as_str().unwrap().to_owned(),
                    fs::read(into.join(entry["copy"].as_str().unwrap())).unwrap(),
                )
            })
            .collect()
    }
}

#[test]
fn a_listing_copies_matching_files_with_this_devices_first_read() {
    let f = Fixture::new("listing");
    f.remote().put("sval/ws/b.json", b"bee");
    f.remote().put("sval/ws/a.json", b"ay");
    f.remote().put("sval/ws/notes.txt", b"skip");
    f.remote().put("sval/ws/sub/c.json", b"deeper");
    let answer =
        f.ask(json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json", "mine": "b.json" }));
    assert_eq!(answer["reachable"], true);
    assert_eq!(
        f.copies(&answer["entries"], ""),
        vec![
            ("a.json".into(), b"ay".to_vec()),
            ("b.json".into(), b"bee".to_vec())
        ]
    );
    assert_eq!(answer["unreadable"], json!([]));
}

#[test]
fn a_file_read_before_is_read_again_only_once_it_changes() {
    let f = Fixture::new("kept");
    f.remote().put("sval/ws/a.json", b"one");
    f.remote().put("sval/ws/b.json", b"two");
    let list = json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json" });
    f.ask(list.clone());
    assert_eq!(f.remote().reads, 2);
    let again = f.ask(list.clone());
    assert_eq!(f.remote().reads, 2, "nothing changed, so nothing is read");
    assert_eq!(
        f.copies(&again["entries"], ""),
        vec![
            ("a.json".into(), b"one".to_vec()),
            ("b.json".into(), b"two".to_vec())
        ]
    );
    f.remote().put("sval/ws/b.json", b"three");
    let changed = f.ask(list);
    assert_eq!(f.remote().reads, 3, "only the changed file is read");
    assert_eq!(
        f.copies(&changed["entries"], "")[1],
        ("b.json".into(), b"three".to_vec())
    );
}

#[test]
fn a_link_or_a_directory_is_listed_as_unreadable() {
    let f = Fixture::new("unreadable");
    f.remote().put("sval/ws/a.json", b"ay");
    f.remote().nodes.insert("sval/ws/l.json".into(), Node::Link);
    f.remote().nodes.insert("sval/ws/d.json".into(), Node::Dir);
    let answer = f.ask(json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json" }));
    assert_eq!(
        answer["unreadable"],
        json!([{ "name": "d.json", "reason": "IsDirectory" }, { "name": "l.json", "reason": "Symlink" }])
    );
}

#[test]
fn a_file_over_the_cap_is_too_large() {
    let f = Fixture::new("cap");
    f.remote().put("sval/ws/a.json", b"12345");
    let answer =
        f.ask(json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json", "maxBytes": 4 }));
    assert_eq!(
        answer["unreadable"],
        json!([{ "name": "a.json", "reason": "TooLarge" }])
    );
    assert_eq!(f.remote().reads, 0, "a file listed too large is never read");
}

#[test]
fn a_network_failure_fails_the_request() {
    let f = Fixture::new("offline");
    f.remote().put("sval/ws/a.json", b"ay");
    f.remote().offline = true;
    let answer = f.ask(json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json" }));
    assert_eq!(
        answer,
        json!({ "reachable": false, "reason": "io-error", "error": "NetworkError" })
    );
}

#[test]
fn a_request_without_its_sign_in_is_refused() {
    let f = Fixture::new("no-auth");
    let answer = f.ask(json!({ "op": "exists", "path": "sval", "auth": {} }));
    assert_eq!(
        answer,
        json!({ "reachable": false, "reason": "io-error", "error": "SignInError" })
    );
}

#[test]
fn a_missing_top_directory_is_no_sval_dir() {
    let f = Fixture::new("top");
    let answer = f.ask(json!({ "op": "exists", "path": "sval/me.json", "requireTop": "sval" }));
    assert_eq!(
        answer,
        json!({ "reachable": false, "reason": "no-sval-dir" })
    );
}

#[test]
fn a_write_lands_and_the_next_listing_reads_it() {
    let f = Fixture::new("write");
    f.remote().put("sval/ws/a.json", b"old");
    let list = json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json" });
    f.ask(list.clone());
    let payload = f.payload(0, b"new");
    let wrote = f.ask(json!({ "op": "write", "path": "sval/ws/a.json", "payloads": [payload] }));
    assert_eq!(wrote, json!({ "reachable": true }));
    let answer = f.ask(list);
    assert_eq!(
        f.copies(&answer["entries"], ""),
        vec![("a.json".into(), b"new".to_vec())]
    );
}

#[test]
fn a_write_over_a_directory_or_a_link_is_refused() {
    let f = Fixture::new("write-refused");
    f.remote().nodes.insert("sval".into(), Node::Dir);
    f.remote().nodes.insert("sval/d.json".into(), Node::Dir);
    f.remote().nodes.insert("sval/l.json".into(), Node::Link);
    let payload = f.payload(0, b"x");
    let over_dir =
        f.ask(json!({ "op": "write", "path": "sval/d.json", "payloads": [payload.clone()] }));
    assert_eq!(over_dir["error"], "IsDirectory");
    let over_link = f.ask(json!({ "op": "write", "path": "sval/l.json", "payloads": [payload] }));
    assert_eq!(over_link["error"], "Symlink");
}

#[test]
fn a_move_never_replaces_anything() {
    let f = Fixture::new("move");
    f.remote().put("sval/a.json", b"a");
    f.remote().put("sval/b.json", b"b");
    let refused = f.ask(json!({ "op": "move", "from": "sval/a.json", "to": "sval/b.json" }));
    assert_eq!(refused["error"], "Exists");
    let moved = f.ask(json!({ "op": "move", "from": "sval/a.json", "to": "sval/c.json" }));
    assert_eq!(moved, json!({ "reachable": true }));
    assert!(f.remote().nodes.contains_key("sval/c.json"));
    let absent = f.ask(json!({ "op": "move", "from": "sval/gone.json", "to": "sval/d.json" }));
    assert_eq!(absent, json!({ "reachable": true }));
}

#[test]
fn removing_a_directory_leaves_directories_inside_it() {
    let f = Fixture::new("remove-dir");
    f.remote().put("sval/keys/k1/a.json", b"a");
    f.remote().put("sval/keys/k2/b.json", b"b");
    f.remote()
        .nodes
        .insert("sval/keys/k2/inner".into(), Node::Dir);
    let gone = f.ask(json!({ "op": "removeDir", "path": "sval/keys/k1" }));
    assert_eq!(gone, json!({ "reachable": true, "removed": true }));
    assert!(!f.remote().nodes.contains_key("sval/keys/k1"));
    let kept = f.ask(json!({ "op": "removeDir", "path": "sval/keys/k2" }));
    assert_eq!(kept, json!({ "reachable": true, "removed": false }));
    assert!(f.remote().nodes.contains_key("sval/keys/k2/inner"));
}

#[test]
fn list_names_says_which_hold_an_entry() {
    let f = Fixture::new("names");
    f.remote().put("sval/ws/x/me.json", b"1");
    f.remote().put("sval/ws/y/other.json", b"2");
    let answer = f.ask(json!({ "op": "listNames", "path": "sval/ws", "holding": "me.json" }));
    assert_eq!(
        answer,
        json!({ "reachable": true, "names": ["x", "y"], "holding": ["x"] })
    );
}

#[test]
fn list_folders_names_only_the_roots_folders() {
    let f = Fixture::new("folders");
    f.remote().put("b/doc.json", b"1");
    f.remote().put("a/doc.json", b"2");
    f.remote().put("loose.txt", b"3");
    let answer = f.ask(json!({ "op": "listFolders" }));
    assert_eq!(answer, json!({ "reachable": true, "folders": ["a", "b"] }));
}

#[test]
fn make_dir_makes_each_directory_on_the_way() {
    let f = Fixture::new("make-dir");
    let answer = f.ask(json!({ "op": "makeDir", "path": "sval/ws/abc" }));
    assert_eq!(answer, json!({ "reachable": true }));
    assert!(f.remote().nodes.contains_key("sval/ws"));
    assert!(f.remote().nodes.contains_key("sval/ws/abc"));
}

#[test]
fn a_step_past_its_limit_is_too_large() {
    let f = Fixture::new("step");
    f.remote().put("sval/ws/a.json", b"ay");
    let mut state = f.folder.remote.borrow_mut();
    let location = Location::parse(ROOT).unwrap();
    let listing = super::Listing {
        path: "sval/ws",
        suffix: Some(".json"),
        mine: None,
        max_bytes: super::MAX_FILE_BYTES,
    };
    let into = f.requests.join("step");
    fs::create_dir_all(&into).unwrap();
    let mut left = 1;
    let answer = super::read_listing(
        &mut state,
        &location,
        "pw",
        &listing,
        &into,
        Some(&mut left),
    )
    .unwrap();
    assert_eq!(answer, json!({ "reachable": false, "reason": "too-large" }));
}

/// Every operation against a real SMB server, named by `SVAL_SMB_TEST_ROOT`
/// (`smb://user@host:port/share/folder`) with its password in
/// `SVAL_SMB_TEST_PASSWORD`. Run by hand, against a server set up for it.
#[test]
#[ignore = "needs a real SMB server"]
fn every_operation_works_against_a_real_smb_server() {
    let root = std::env::var("SVAL_SMB_TEST_ROOT").expect("SVAL_SMB_TEST_ROOT");
    let password = std::env::var("SVAL_SMB_TEST_PASSWORD").expect("SVAL_SMB_TEST_PASSWORD");
    let dir = TempDir::new("remote-live");
    let requests = dir.0.join("requests");
    fs::create_dir_all(&requests).unwrap();
    let folder = Folder::new(requests.clone());
    let ask = |mut request: Value| {
        request["id"] = "live-1".into();
        request["root"] = root.clone().into();
        request["auth"] = json!({ "password": password });
        if request.get("requireTop").is_none() {
            request["requireTop"] = Value::Null;
        }
        let mut answer = folder.answer(&request);
        answer.as_object_mut().unwrap().remove("id");
        answer
    };
    let payload = |bytes: &[u8]| {
        fs::write(requests.join("payload-live-1-0.bin"), bytes).unwrap();
        json!(["payload-live-1-0.bin"])
    };

    // A run cut short leaves its files; each run starts from none.
    ask(json!({ "op": "removeDir", "path": "sval-live/ws" }));
    assert_eq!(
        ask(json!({ "op": "makeDir", "path": "sval-live/ws" })),
        json!({ "reachable": true })
    );
    assert_eq!(
        ask(
            json!({ "op": "write", "path": "sval-live/ws/a.json", "payloads": payload(b"one"), "requireTop": "sval-live" })
        ),
        json!({ "reachable": true })
    );
    assert_eq!(
        ask(json!({ "op": "write", "path": "sval-live/ws/a.json", "payloads": payload(b"two!") })),
        json!({ "reachable": true }),
        "a write replaces the file"
    );
    let listed = ask(json!({ "op": "readDir", "path": "sval-live/ws", "suffix": ".json" }));
    assert_eq!(
        listed["entries"],
        json!([{ "name": "a.json", "copy": "0" }]),
        "{listed}"
    );
    assert_eq!(fs::read(requests.join("files-live-1/0")).unwrap(), b"two!");
    assert_eq!(
        ask(json!({ "op": "exists", "path": "sval-live/ws/a.json" })),
        json!({ "reachable": true, "exists": true })
    );
    assert_eq!(
        ask(json!({ "op": "move", "from": "sval-live/ws/a.json", "to": "sval-live/ws/b.json" })),
        json!({ "reachable": true })
    );
    ask(json!({ "op": "write", "path": "sval-live/ws/a.json", "payloads": payload(b"x") }));
    assert_eq!(
        ask(json!({ "op": "move", "from": "sval-live/ws/a.json", "to": "sval-live/ws/b.json" }))
            ["error"],
        "Exists",
        "a move never replaces"
    );
    assert_eq!(
        ask(json!({ "op": "listNames", "path": "sval-live/ws" })),
        json!({ "reachable": true, "names": ["a.json", "b.json"] })
    );
    assert_eq!(
        ask(json!({ "op": "removeDir", "path": "sval-live/ws" })),
        json!({ "reachable": true, "removed": true })
    );
    assert_eq!(
        ask(json!({ "op": "exists", "path": "sval-live/ws" })),
        json!({ "reachable": true, "exists": false })
    );

    let mut wrong = json!({ "op": "exists", "path": "sval-live", "id": "live-2", "root": root, "requireTop": null });
    wrong["auth"] = json!({ "password": "not it" });
    let refused = folder.answer(&wrong);
    assert_eq!(refused["error"], "SignInError", "{refused}");
}
