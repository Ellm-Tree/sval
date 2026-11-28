// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! What the helper answers for each operation, and the checks that keep it
//! inside the shared folder.

use super::*;
use crate::test_dir::TempDir;
use serde_json::json;

/// A shared folder and a request directory, side by side in a fresh
/// temporary directory.
struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    requests: PathBuf,
    folder: Folder,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let root = dir.0.join("shared");
        let requests = dir.0.join("requests");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&requests).unwrap();
        let folder = Folder::new(requests.clone());
        Fixture {
            _dir: dir,
            root,
            requests,
            folder,
        }
    }

    fn root(&self) -> &str {
        self.root.to_str().unwrap()
    }

    /// The path `relative`, `/`-separated, below the root.
    fn at(&self, relative: &str) -> PathBuf {
        join(&self.root, &relative.split('/').collect::<Vec<_>>())
    }

    fn put(&self, relative: &str, bytes: &[u8]) {
        let path = self.at(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// Asks `request`, given the fixture's root and an id, and checks the
    /// answer carries the id.
    fn ask(&self, mut request: Value) -> Value {
        request["id"] = "req-1".into();
        if request.get("root").is_none() {
            request["root"] = self.root().into();
        }
        if request.get("requireTop").is_none() {
            request["requireTop"] = Value::Null;
        }
        let mut answer = self.folder.answer(&request);
        assert_eq!(answer["id"], "req-1", "the answer carries the request's id");
        answer.as_object_mut().unwrap().remove("id");
        answer
    }

    /// Writes `bytes` as the payload `n` of request `req-1`.
    fn payload(&self, n: usize, bytes: &[u8]) -> String {
        let name = format!("payload-req-1-{n}.bin");
        fs::write(self.requests.join(&name), bytes).unwrap();
        name
    }

    fn write(&self, path: &str, bytes: &[u8], require_top: Value) -> Value {
        let payload = self.payload(0, bytes);
        self.ask(json!({ "op": "write", "path": path, "payloads": [payload], "requireTop": require_top }))
    }

    /// The bytes of each entry a listing copied, by name.
    fn copies(&self, entries: &Value, into: &Path) -> Vec<(String, Vec<u8>)> {
        entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let copy = entry["copy"].as_str().unwrap();
                (
                    entry["name"].as_str().unwrap().to_owned(),
                    fs::read(into.join(copy)).unwrap(),
                )
            })
            .collect()
    }

    fn files(&self) -> PathBuf {
        self.requests.join("files-req-1")
    }
}

fn names(entries: &Value) -> Vec<&str> {
    entries
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect()
}

fn reason(answer: &Value) -> (Value, Value) {
    (answer["reachable"].clone(), answer["reason"].clone())
}

#[test]
fn a_file_written_reads_back_and_is_removed() {
    let f = Fixture::new("round-trip");
    let bytes = [1u8, 2, 3, 250];
    assert_eq!(
        f.write("sval/ws/abc/me.json", &bytes, Value::Null),
        json!({ "reachable": true }),
        "first use creates sval/ and writes the file"
    );
    assert_eq!(fs::read(f.at("sval/ws/abc/me.json")).unwrap(), bytes);
    assert_eq!(
        children(&f.at("sval/ws/abc")).unwrap().len(),
        1,
        "and no temporary file is left"
    );

    f.put("sval/ws/abc/peer.json.tmp", b"half-written");
    let read = f.ask(json!({
        "op": "readDir", "path": "sval/ws/abc", "suffix": ".json", "mine": "me.json", "requireTop": "sval"
    }));
    assert_eq!(read["reachable"], true);
    assert_eq!(
        names(&read["entries"]),
        ["me.json"],
        "a leftover .tmp is not a candidate"
    );
    assert_eq!(
        f.copies(&read["entries"], &f.files()),
        [("me.json".into(), bytes.to_vec())]
    );
    assert_eq!(read["unreadable"], json!([]));

    let exists = || f.ask(json!({ "op": "exists", "path": "sval/ws/abc/me.json" }));
    assert_eq!(exists(), json!({ "reachable": true, "exists": true }));
    assert_eq!(
        f.ask(json!({ "op": "remove", "path": "sval/ws/abc/me.json" })),
        json!({ "reachable": true })
    );
    assert_eq!(
        exists(),
        json!({ "reachable": true, "exists": false }),
        "removing it removed it"
    );
    assert_eq!(
        f.ask(json!({ "op": "remove", "path": "sval/ws/abc/me.json" })),
        json!({ "reachable": true }),
        "and removing nothing is not a failure"
    );
}

#[test]
fn a_folder_that_is_not_there_or_not_mounted_says_so() {
    let f = Fixture::new("unreachable");
    let missing = f.root.join("gone");
    assert_eq!(
        f.ask(json!({ "op": "exists", "path": "sval", "root": missing.to_str().unwrap() })),
        json!({ "reachable": false, "reason": "missing", "error": "NotFoundError" })
    );
    f.put("file", b"x");
    assert_eq!(
        f.ask(json!({ "op": "exists", "path": "sval", "root": f.at("file").to_str().unwrap() })),
        json!({ "reachable": false, "reason": "not-a-directory" })
    );
    assert_eq!(
        f.write("sval/ws/me.json", b"x", json!("sval")),
        json!({ "reachable": false, "reason": "no-sval-dir" }),
        "a folder without Sval's top directory is never written into"
    );
    assert!(!f.at("sval").exists());
}

/// Only the system's "no such entry" or "not a directory" makes a folder
/// missing. A look that fails any other way, as a loop of links or a slow
/// disk's error does, is an I/O error, which the browser retries, and never
/// reads as a folder that is not there.
#[cfg(unix)]
#[test]
fn a_look_that_fails_is_never_a_missing_folder() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("look-fails");
    let looped = f.root.join("looped");
    symlink(&looped, &looped).unwrap();
    let answer = f.ask(json!({ "op": "exists", "path": "sval", "root": looped.to_str().unwrap() }));
    assert_eq!(answer["reachable"], false);
    assert_eq!(
        answer["reason"], "io-error",
        "a loop of links is no absence"
    );

    f.put("file", b"x");
    let below_a_file = f.at("file").join("folder");
    assert_eq!(
        f.ask(json!({ "op": "exists", "path": "sval", "root": below_a_file.to_str().unwrap() })),
        json!({ "reachable": false, "reason": "not-a-directory" }),
        "a path through a file is not a folder"
    );
}

/// A top directory that fails to look up, other than by being absent, is that
/// failure: it never reads as a folder without Sval's files.
#[cfg(unix)]
#[test]
fn a_top_directory_that_fails_to_look_up_is_never_no_sval_dir() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new("top-fails");
    // The link check passes the top directory over, so the look itself is
    // what fails: a loop of links answers ELOOP.
    f.folder.linked_dir = |_| Ok(false);
    let top = f.at("sval");
    symlink(&top, &top).unwrap();
    let answer = f.ask(json!({ "op": "exists", "path": "sval", "requireTop": "sval" }));
    assert_eq!(answer["reachable"], false);
    assert_eq!(
        answer["reason"], "io-error",
        "a top directory that fails to look up is not a missing one"
    );
    assert_eq!(
        f.ask(json!({ "op": "exists", "path": "x", "root": f.root(), "requireTop": "absent" })),
        json!({ "reachable": false, "reason": "no-sval-dir" }),
        "and one the system says is not there still is"
    );
}

#[test]
fn a_request_that_is_not_one_is_refused_whole() {
    let f = Fixture::new("invalid");
    let refused = json!({ "reachable": false, "reason": "io-error", "error": "InvalidRequest" });
    let payload = f.payload(0, b"x");
    for request in [
        json!({ "op": "format", "path": "sval" }),
        json!({ "op": "exists", "path": "../sval" }),
        json!({ "op": "exists", "path": "sval", "root": "relative" }),
        json!({ "op": "exists", "path": "sval", "requireTop": "/sval" }),
        json!({ "op": "readDir", "path": "sval", "maxBytes": MAX_FILE_BYTES + 1 }),
        json!({ "op": "readDir", "path": "sval", "maxBytes": 0 }),
        json!({ "op": "readDir", "path": "sval", "maxBytes": 1.5 }),
        json!({ "op": "readDir", "path": "sval", "suffix": 5 }),
        json!({ "op": "listNames", "path": "sval", "holding": "a/b" }),
        json!({ "op": "write", "path": "sval/me.json" }),
        json!({ "op": "write", "path": "sval/me.json", "payloads": ["../secret"] }),
        json!({ "op": "write", "path": "sval/me.json", "payloads": ["payload-x.bin", "payload-y.bin"] }),
        json!({ "op": "writeFiles", "files": [{ "path": "a" }, { "path": "b" }], "payloads": [payload] }),
        json!({ "op": "readDirs", "dirs": (0..=MAX_BATCH).map(|_| json!({ "path": "sval" })).collect::<Vec<_>>() }),
        json!({ "op": "move", "from": "sval/a", "to": "/tmp/b" }),
    ] {
        assert_eq!(f.ask(request.clone()), refused, "{request} is refused");
    }
    let mut no_top = json!({ "id": "req-1", "op": "exists", "path": "sval", "root": f.root() });
    assert_eq!(
        f.folder.answer(&no_top)["error"],
        "InvalidRequest",
        "requireTop is always named"
    );
    no_top["requireTop"] = Value::Null;
    no_top["id"] = "../up".into();
    assert_eq!(
        f.folder.answer(&no_top),
        json!({ "id": null, "reachable": false, "reason": "io-error", "error": "InvalidRequest" }),
        "an id that could name a path is refused, and not echoed"
    );
}

#[test]
fn a_link_check_that_fails_fails_the_request_closed() {
    let mut f = Fixture::new("fail-closed");
    f.folder.linked_dir = |_| Err(io::Error::from(io::ErrorKind::Other));
    let payload = f.payload(0, &[1]);
    for op in [
        "readDir",
        "write",
        "remove",
        "exists",
        "listNames",
        "removeDir",
        "makeDir",
    ] {
        let answer = f.ask(json!({
            "op": op, "path": "sval/ws/abc/me.json", "suffix": ".json", "mine": "me.json", "payloads": [payload]
        }));
        assert_eq!(
            reason(&answer),
            (json!(false), json!("io-error")),
            "{op} fails when the check fails"
        );
    }
    assert_eq!(
        reason(&f.write("sval/ws/abc/me.json", &[1], json!("sval"))),
        (json!(false), json!("io-error"))
    );
    assert!(!f.at("sval").exists(), "nothing was written");
    f.folder.linked_dir = is_link;
    assert_eq!(
        f.write("sval/ws/abc/me.json", &[1], Value::Null),
        json!({ "reachable": true })
    );
}

#[test]
fn a_write_sweeps_its_own_stale_temporary_files() {
    let f = Fixture::new("temporaries");
    let stale = "me.json.0123456789abcdef.tmp";
    let recent = "me.json.fedcba9876543210.tmp";
    let peers = "peer.json.0123456789abcdef.tmp";
    let unlike = "me.json.tmp";
    let hour_ago = SystemTime::now() - Duration::from_secs(3600);
    for name in [stale, recent, peers, unlike] {
        f.put(&format!("sval/ws/abc/{name}"), b"half-written");
        if name != recent {
            let file = fs::File::options()
                .write(true)
                .open(f.at(&format!("sval/ws/abc/{name}")))
                .unwrap();
            file.set_modified(hour_ago).unwrap();
        }
    }
    assert_eq!(
        f.write("sval/ws/abc/me.json", &[7], Value::Null),
        json!({ "reachable": true })
    );
    let mut left: Vec<String> = children(&f.at("sval/ws/abc"))
        .unwrap()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    left.sort();
    let mut expected = vec!["me.json", recent, unlike, peers];
    expected.sort();
    assert_eq!(
        left, expected,
        "only this file's stale temporary file is gone"
    );
}

#[test]
fn a_write_refuses_a_directory_and_a_file_too_large() {
    let f = Fixture::new("write-refusals");
    fs::create_dir_all(f.at("sval/ws/me.json")).unwrap();
    assert_eq!(
        f.write("sval/ws/me.json", b"x", Value::Null),
        json!({ "reachable": false, "reason": "io-error", "error": "IsDirectory" })
    );
    let big = vec![0u8; MAX_FILE_BYTES as usize + 1];
    assert_eq!(
        f.write("sval/ws/other.json", &big, Value::Null),
        json!({ "reachable": false, "reason": "io-error", "error": "TooLarge" }),
        "a write no reader would accept is refused"
    );
    assert!(!f.at("sval/ws/other.json").exists());
}

#[test]
fn list_folders_names_only_the_roots_folders() {
    let f = Fixture::new("folders");
    fs::create_dir_all(f.at("b")).unwrap();
    fs::create_dir_all(f.at("a")).unwrap();
    f.put("loose.txt", b"x");
    assert_eq!(
        f.ask(json!({ "op": "listFolders" })),
        json!({ "reachable": true, "folders": ["a", "b"] })
    );
}

#[test]
fn list_names_names_a_directory_and_reads_nothing() {
    let f = Fixture::new("names");
    let list =
        |holding: Value| f.ask(json!({ "op": "listNames", "path": "sval/ws", "holding": holding }));
    assert_eq!(
        list(Value::Null),
        json!({ "reachable": true, "names": [] }),
        "an absent directory has none"
    );
    for name in ["bbb", "aaa", "ccc"] {
        fs::create_dir_all(f.at(&format!("sval/ws/{name}"))).unwrap();
    }
    f.put("sval/ws/ccc/doc.json", b"x");
    f.put("sval/ws/aaa/doc.json", b"x");
    assert_eq!(
        list(Value::Null),
        json!({ "reachable": true, "names": ["aaa", "bbb", "ccc"] })
    );
    assert_eq!(
        list(json!("doc.json")),
        json!({ "reachable": true, "names": ["aaa", "bbb", "ccc"], "holding": ["aaa", "ccc"] })
    );
}

#[test]
fn one_request_writes_and_reads_many_files() {
    let f = Fixture::new("batch");
    fs::create_dir_all(f.at("sval")).unwrap();
    let written: Vec<(&str, Vec<u8>)> = vec![
        ("sval/ws/one/a.json", vec![1]),
        ("sval/ws/one/z-mine.json", vec![2, 2]),
        ("sval/ws/two/b.json", vec![3, 3, 3]),
    ];
    let payloads: Vec<String> = written
        .iter()
        .enumerate()
        .map(|(i, (_, bytes))| f.payload(i, bytes))
        .collect();
    let files: Vec<Value> = written
        .iter()
        .map(|(path, _)| json!({ "path": path }))
        .collect();
    assert_eq!(
        f.ask(json!({ "op": "writeFiles", "files": files, "payloads": payloads, "requireTop": "sval" })),
        json!({ "reachable": true })
    );
    let mut expected_one = vec![
        ("a.json".to_owned(), vec![1]),
        ("z-mine.json".to_owned(), vec![2, 2]),
    ];
    if cfg!(unix) {
        // A name a cloud client or another system may give a file, which
        // Sval never writes itself.
        f.put("sval/ws/one/m:c.json", &[4, 4, 4, 4]);
        expected_one.insert(1, ("m:c.json".to_owned(), vec![4, 4, 4, 4]));
    }
    let read = f.ask(json!({
        "op": "readDirs",
        "dirs": [
            { "path": "sval/ws/one", "suffix": ".json", "mine": "z-mine.json" },
            { "path": "sval/ws/two", "suffix": ".json", "mine": "z-mine.json" },
        ],
        "requireTop": "sval",
    }));
    assert_eq!(read["reachable"], true);
    assert_eq!(
        f.copies(&read["dirs"][0]["entries"], &f.files().join("0")),
        expected_one,
        "in name order"
    );
    assert_eq!(
        f.copies(&read["dirs"][1]["entries"], &f.files().join("1")),
        [("b.json".to_owned(), vec![3, 3, 3])]
    );
}

#[test]
fn a_batch_stops_at_its_first_failure() {
    let f = Fixture::new("batch-stop");
    fs::create_dir_all(f.at("sval/ws/b.json")).unwrap();
    let payloads = [f.payload(0, b"a"), f.payload(1, b"b"), f.payload(2, b"c")];
    let answer = f.ask(json!({
        "op": "writeFiles",
        "files": [{ "path": "sval/ws/a.json" }, { "path": "sval/ws/b.json" }, { "path": "sval/ws/c.json" }],
        "payloads": payloads,
    }));
    assert_eq!(
        answer,
        json!({ "reachable": false, "reason": "io-error", "error": "IsDirectory" })
    );
    assert!(f.at("sval/ws/a.json").exists());
    assert!(
        !f.at("sval/ws/c.json").exists(),
        "nothing after the failure was written"
    );
}

#[test]
fn an_own_entry_that_is_a_directory_is_listed_and_the_peers_read() {
    let f = Fixture::new("own-dir");
    fs::create_dir_all(f.at("sval/ws/abc/me.json")).unwrap();
    fs::create_dir_all(f.at("sval/ws/abc/other.json")).unwrap();
    f.put("sval/ws/abc/peer.json", b"peer");
    let read = f.ask(
        json!({ "op": "readDir", "path": "sval/ws/abc", "suffix": ".json", "mine": "me.json" }),
    );
    assert_eq!(read["reachable"], true, "the peers still read");
    assert_eq!(names(&read["entries"]), ["peer.json"]);
    assert_eq!(
        read["unreadable"],
        json!([{ "name": "me.json", "reason": "IsDirectory" }, { "name": "other.json", "reason": "IsDirectory" }]),
        "this device's own entry first"
    );
}

/// Fails the test when this process can still read a file with no
/// permissions, as root can: the denial the test provokes would never happen,
/// and its assertions would hold whether the helper is right or wrong.
#[cfg(unix)]
fn assert_unreadable(path: &Path) {
    assert!(
        fs::read(path).is_err(),
        "{} still reads with no permissions; run the tests as an unprivileged user",
        path.display()
    );
}

#[cfg(unix)]
#[test]
fn an_own_file_that_does_not_read_for_now_is_an_outage() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("own-denied");
    f.put("sval/ws/abc/me.json", b"mine");
    f.put("sval/ws/abc/peer.json", b"peer");
    let mine = f.at("sval/ws/abc/me.json");
    fs::set_permissions(&mine, fs::Permissions::from_mode(0o000)).unwrap();
    assert_unreadable(&mine);
    let read = f.ask(
        json!({ "op": "readDir", "path": "sval/ws/abc", "suffix": ".json", "mine": "me.json" }),
    );
    fs::set_permissions(&mine, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read,
        json!({ "reachable": false, "reason": "own-file-unreadable", "error": "NotAllowedError" }),
        "never read as an absence, which the engine would overwrite"
    );
    let batch = f.ask(json!({ "op": "readDirs", "dirs": [{ "path": "sval/ws" }, { "path": "sval/ws/abc", "mine": "me.json" }] }));
    assert_eq!(
        batch["reachable"], true,
        "with the permission back the batch reads"
    );
}

#[cfg(unix)]
#[test]
fn a_readdirs_names_the_directory_whose_own_file_did_not_read() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("own-denied-batch");
    f.put("sval/ws/one/me.json", b"mine");
    f.put("sval/ws/two/me.json", b"mine");
    let mine = f.at("sval/ws/two/me.json");
    fs::set_permissions(&mine, fs::Permissions::from_mode(0o000)).unwrap();
    assert_unreadable(&mine);
    let read = f.ask(json!({
        "op": "readDirs",
        "dirs": [{ "path": "sval/ws/one", "mine": "me.json" }, { "path": "sval/ws/two", "mine": "me.json" }],
    }));
    fs::set_permissions(&mine, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read,
        json!({ "reachable": false, "reason": "own-file-unreadable", "error": "NotAllowedError", "dir": 1 })
    );
}

#[test]
fn a_file_over_the_cap_is_listed_and_never_returned() {
    let f = Fixture::new("big");
    f.put("sval/ws/abc/peer.json", b"peer");
    let big = fs::File::create(f.at("sval/ws/abc/big.json")).unwrap();
    big.set_len(MAX_FILE_BYTES + 1).unwrap();
    drop(big);
    let ask = || {
        f.ask(
            json!({ "op": "readDir", "path": "sval/ws/abc", "suffix": ".json", "mine": "me.json" }),
        )
    };
    let read = ask();
    assert_eq!(names(&read["entries"]), ["peer.json"]);
    assert_eq!(
        read["unreadable"],
        json!([{ "name": "big.json", "reason": "TooLarge" }])
    );
    fs::rename(f.at("sval/ws/abc/big.json"), f.at("sval/ws/abc/me.json")).unwrap();
    assert_eq!(
        ask()["unreadable"],
        json!([{ "name": "me.json", "reason": "TooLarge" }]),
        "this device's own file over the cap is listed the same way"
    );
}

#[test]
fn a_listing_with_its_own_cap_never_reads_past_it() {
    let f = Fixture::new("capped");
    f.put("sval/keys/peer.key", b"sealed");
    f.put("sval/keys/planted.key", &vec![0u8; 1024 * 1024]);
    let read = f.ask(json!({ "op": "readDir", "path": "sval/keys", "suffix": ".key", "mine": "me.key", "maxBytes": 4096 }));
    assert_eq!(names(&read["entries"]), ["peer.key"]);
    assert_eq!(
        read["unreadable"],
        json!([{ "name": "planted.key", "reason": "TooLarge" }])
    );
}

#[test]
fn entries_past_the_limit_are_listed_and_the_own_file_is_never_starved() {
    let f = Fixture::new("many");
    let peers = MAX_ENTRIES + 2;
    for i in 0..peers {
        f.put(&format!("sval/ws/abc/f{i:04}.json"), b"x");
    }
    f.put("sval/ws/abc/zz-me.json", b"me");
    let read = f.ask(
        json!({ "op": "readDir", "path": "sval/ws/abc", "suffix": ".json", "mine": "zz-me.json" }),
    );
    let listed = names(&read["entries"]);
    assert_eq!(listed.len(), MAX_ENTRIES);
    assert!(
        listed.contains(&"zz-me.json"),
        "this device's own file among them"
    );
    let mut sorted = listed.clone();
    sorted.sort();
    assert_eq!(listed, sorted, "in name order");
    let unreadable = read["unreadable"].as_array().unwrap();
    assert_eq!(unreadable.len(), peers + 1 - MAX_ENTRIES);
    assert_eq!(unreadable[0]["reason"], "TooManyEntries");
}

#[test]
fn a_step_over_its_limit_copies_nothing_past_it() {
    let f = Fixture::new("step-cap");
    let mut dirs = Vec::new();
    for d in 0..3 {
        for i in 0..3 {
            let path = f.at(&format!("sval/doc{d}/f{i}.bin"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::File::create(path)
                .unwrap()
                .set_len(MAX_FILE_BYTES)
                .unwrap();
        }
        dirs.push(json!({ "path": format!("sval/doc{d}"), "suffix": ".bin" }));
    }
    let answer = f.ask(json!({ "op": "readDirs", "dirs": dirs }));
    assert_eq!(answer, json!({ "reachable": false, "reason": "too-large" }));
    let copied: u64 = (0..3)
        .flat_map(|d| children(&f.files().join(d.to_string())).unwrap())
        .map(|(_, path)| fs::metadata(path).unwrap().len())
        .sum();
    assert!(
        copied <= MAX_STEP_BYTES,
        "nothing past the limit was copied"
    );
}

#[test]
fn a_move_never_replaces_anything() {
    let f = Fixture::new("move");
    f.put("sval/ws/me.json", b"mine");
    f.put("sval/ws/taken.json", b"other");
    let mv = |from: &str, to: &str| f.ask(json!({ "op": "move", "from": from, "to": to }));
    assert_eq!(
        mv("sval/ws/me.json", "sval/ws/taken.json"),
        json!({ "reachable": false, "reason": "io-error", "error": "Exists" })
    );
    assert_eq!(fs::read(f.at("sval/ws/taken.json")).unwrap(), b"other");
    assert_eq!(
        mv("sval/ws/absent.json", "sval/ws/new.json"),
        json!({ "reachable": true }),
        "nothing to move"
    );
    fs::create_dir_all(f.at("sval/ws/dir.json")).unwrap();
    assert_eq!(
        mv("sval/ws/dir.json", "sval/ws/moved.json"),
        json!({ "reachable": false, "reason": "io-error", "error": "IsDirectory" })
    );
    assert_eq!(
        mv("sval/ws/me.json", "sval/ws/aside.json"),
        json!({ "reachable": true })
    );
    assert_eq!(fs::read(f.at("sval/ws/aside.json")).unwrap(), b"mine");
    assert!(!f.at("sval/ws/me.json").exists());
}

#[test]
fn remove_dir_removes_files_and_keeps_a_directory() {
    let f = Fixture::new("remove-dir");
    f.put("sval/ws/old/a.json", b"a");
    f.put("sval/ws/old/b.json", b"b");
    assert_eq!(
        f.ask(json!({ "op": "removeDir", "path": "sval/ws/old" })),
        json!({ "reachable": true, "removed": true })
    );
    assert!(!f.at("sval/ws/old").exists());
    f.put("sval/ws/kept/a.json", b"a");
    f.put("sval/ws/kept/inner/b.json", b"b");
    assert_eq!(
        f.ask(json!({ "op": "removeDir", "path": "sval/ws/kept" })),
        json!({ "reachable": true, "removed": false })
    );
    assert!(!f.at("sval/ws/kept/a.json").exists());
    assert!(
        f.at("sval/ws/kept/inner/b.json").exists(),
        "a directory inside is left alone"
    );
}

#[test]
fn make_dir_makes_a_directory_below_the_root() {
    let f = Fixture::new("make-dir");
    assert_eq!(
        f.ask(json!({ "op": "makeDir", "path": "sval/pair" })),
        json!({ "reachable": true })
    );
    assert!(f.at("sval/pair").is_dir());
    let gone = f.root.join("gone");
    assert_eq!(
        reason(&f.ask(json!({ "op": "makeDir", "path": "sval", "root": gone.to_str().unwrap() }))),
        (json!(false), json!("missing")),
        "the root itself is never made"
    );
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    fn symlinked() -> Value {
        json!({ "reachable": false, "reason": "io-error", "error": "Symlink" })
    }

    #[test]
    fn a_link_below_the_root_is_never_crossed() {
        let f = Fixture::new("link-dir");
        let outside = f.root.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("peer.json"), b"elsewhere").unwrap();
        fs::create_dir_all(f.at("sval")).unwrap();
        symlink(&outside, f.at("sval/ws")).unwrap();
        assert_eq!(
            f.ask(json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json" })),
            symlinked()
        );
        assert_eq!(f.write("sval/ws/me.json", b"x", Value::Null), symlinked());
        assert_eq!(
            f.ask(json!({ "op": "exists", "path": "sval/ws/peer.json" })),
            symlinked()
        );
        assert_eq!(
            f.ask(json!({ "op": "listNames", "path": "sval/ws" })),
            symlinked()
        );
        assert_eq!(
            f.ask(json!({ "op": "removeDir", "path": "sval/ws" })),
            symlinked()
        );
        assert_eq!(
            f.ask(json!({ "op": "makeDir", "path": "sval/ws/x" })),
            symlinked()
        );
        assert_eq!(
            f.ask(json!({ "op": "makeDir", "path": "sval/ws" })),
            symlinked(),
            "a link at the target too"
        );
        assert_eq!(
            f.ask(json!({ "op": "move", "from": "sval/ws/peer.json", "to": "sval/p.json" })),
            symlinked()
        );
        assert_eq!(
            f.write("sval/ws/me.json", b"x", json!("sval/ws")),
            symlinked(),
            "and the top directory"
        );
        assert_eq!(
            fs::read_dir(&outside).unwrap().count(),
            1,
            "nothing outside was touched"
        );
    }

    #[test]
    fn the_root_itself_may_be_a_link() {
        let f = Fixture::new("link-root");
        let real = f.root.parent().unwrap().join("real");
        fs::create_dir_all(real.join("sval")).unwrap();
        let linked = f.root.parent().unwrap().join("linked");
        symlink(&real, &linked).unwrap();
        assert_eq!(
            f.ask(json!({ "op": "exists", "path": "sval", "root": linked.to_str().unwrap() })),
            json!({ "reachable": true, "exists": true })
        );
    }

    #[test]
    fn a_linked_file_is_listed_and_never_written_through() {
        let f = Fixture::new("link-file");
        let outside = f.root.parent().unwrap().join("elsewhere.json");
        fs::write(&outside, b"elsewhere").unwrap();
        fs::create_dir_all(f.at("sval/ws")).unwrap();
        symlink(&outside, f.at("sval/ws/me.json")).unwrap();
        symlink(&outside, f.at("sval/ws/peer.json")).unwrap();
        let read = f.ask(
            json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json", "mine": "me.json" }),
        );
        assert_eq!(read["entries"], json!([]));
        assert_eq!(
            read["unreadable"],
            json!([{ "name": "me.json", "reason": "Symlink" }, { "name": "peer.json", "reason": "Symlink" }])
        );
        assert_eq!(f.write("sval/ws/me.json", b"x", Value::Null), symlinked());
        assert_eq!(
            f.ask(json!({ "op": "move", "from": "sval/ws/me.json", "to": "sval/ws/aside.json" })),
            symlinked()
        );
        assert_eq!(fs::read(&outside).unwrap(), b"elsewhere");

        assert_eq!(
            f.ask(json!({ "op": "removeDir", "path": "sval/ws" })),
            json!({ "reachable": true, "removed": true })
        );
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"elsewhere",
            "a link inside is removed as a link"
        );
    }

    #[test]
    fn list_names_passes_a_linked_directory_over() {
        let f = Fixture::new("link-holding");
        let outside = f.root.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("doc.json"), b"x").unwrap();
        fs::create_dir_all(f.at("sval/ws/real")).unwrap();
        fs::write(f.at("sval/ws/real/doc.json"), b"x").unwrap();
        symlink(&outside, f.at("sval/ws/linked")).unwrap();
        assert_eq!(
            f.ask(json!({ "op": "listNames", "path": "sval/ws", "holding": "doc.json" })),
            json!({ "reachable": true, "names": ["linked", "real"], "holding": ["real"] })
        );
    }

    #[test]
    fn a_device_is_never_read() {
        let read = read_entry(Path::new("/dev/zero"), 4096, 0, None).unwrap();
        assert!(
            matches!(read, Entry::Problem("NotAFile")),
            "a device that never ends is not a file"
        );
    }

    /// Anyone who can write to the folder can plant a FIFO, whose open would
    /// wait for a writer that never comes.
    #[test]
    fn a_planted_fifo_is_listed_and_never_opened() {
        let f = Fixture::new("fifo");
        f.put("sval/ws/peer.json", b"peer");
        for name in ["planted.json", "me.json"] {
            let fifo =
                std::ffi::CString::new(f.at(&format!("sval/ws/{name}")).to_str().unwrap()).unwrap();
            // SAFETY: a NUL-terminated path.
            assert_eq!(
                unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) },
                0,
                "mkfifo made the FIFO"
            );
        }
        let started = std::time::Instant::now();
        let read = f.ask(
            json!({ "op": "readDir", "path": "sval/ws", "suffix": ".json", "mine": "me.json" }),
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the listing answered at once"
        );
        assert_eq!(names(&read["entries"]), ["peer.json"]);
        assert_eq!(
            read["unreadable"],
            json!([{ "name": "me.json", "reason": "NotAFile" }, { "name": "planted.json", "reason": "NotAFile" }]),
            "this device's own entry stays listed, as a problem that lasts"
        );
    }
}
