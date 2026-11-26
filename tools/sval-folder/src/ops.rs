// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The operations the browser asks of the shared folder (local-copy spec
//! §4.2), each with the checks that keep it inside the folder.
//!
//! The helper moves bytes and nothing else. The browser computes every
//! directory and file name and does every merge, so the document key never
//! reaches here. File contents travel through the browser's private request
//! directory: a write's bytes are read from a payload file there, and every
//! file a listing reads is copied raw under `files-<id>/`, named by number,
//! each entry naming its copy.

use crate::errors::{error_name, Failure};
use crate::links::is_link;
use crate::paths::{is_contained, is_root, join};
use crate::remote::{auth_for, Location};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The most one file may hold. A larger entry is listed as unreadable, and a
/// larger write is refused: no reader would accept it.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// The most one listing reads in all; entries past it are unreadable.
pub const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

/// The most one `readDirs` reads in all, the limit decision 0032 puts on one
/// shared step: a step reads its documents with one `readDirs`. Past it the
/// request reads nothing more and answers "too-large": what it copies goes to
/// the profile and on into the engine's memory, and anyone who can write to
/// the folder chooses how much is there.
pub const MAX_STEP_BYTES: u64 = 256 * 1024 * 1024;

/// The most matching entries one listing reads; the rest are unreadable.
pub const MAX_ENTRIES: usize = 1000;

/// Keeps the answer small however many entries are refused.
const MAX_UNREADABLE_LISTED: usize = 100;

/// The most directories one `readDirs`, or files one `writeFiles`, names.
pub const MAX_BATCH: usize = 64;

/// What `read_listing` finds wrong with an entry that stays wrong until
/// someone removes it.
const LASTING_PROBLEMS: [&str; 4] = ["Symlink", "IsDirectory", "NotAFile", "TooLarge"];

/// A temporary file `write_atomically` leaves behind belongs to a helper
/// killed between its write and its rename. Only this device writes
/// temporary files named for its own file, and a helper's request ends itself
/// at 21 s plus however long the kernel holds it on a hung mount, which is
/// well under this. The age is measured against the folder's clock, so a skew
/// this large between two machines could remove a live one; the write it
/// belonged to then fails, which its browser had already stopped waiting for.
const STALE_TEMPORARY: Duration = Duration::from_secs(10 * 60);

/// A failure's answer: the folder is not reachable, for `reason`, with the
/// name of the error behind it when there is one. Never a path.
pub fn unreachable(reason: &str, error: Option<&str>) -> Value {
    match error {
        Some(error) => json!({ "reachable": false, "reason": reason, "error": error }),
        None => json!({ "reachable": false, "reason": reason }),
    }
}

fn symlink() -> Value {
    unreachable("io-error", Some("Symlink"))
}

/// Orders names as the browser's `Array.prototype.sort` does, by UTF-16 code
/// unit, which differs from Rust's code point order above U+E000.
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// One directory a listing reads.
struct Listing<'a> {
    path: &'a str,
    suffix: Option<&'a str>,
    mine: Option<&'a str>,
    max_bytes: u64,
}

enum Op<'a> {
    ReadDir(Listing<'a>),
    ReadDirs(Vec<Listing<'a>>),
    Write(&'a str),
    WriteFiles(Vec<&'a str>),
    Move(&'a str, &'a str),
    Remove(&'a str),
    Exists(&'a str),
    RemoveDir(&'a str),
    ListNames(&'a str, Option<&'a str>),
    MakeDir(&'a str),
}

struct Request<'a> {
    id: &'a str,
    root: &'a str,
    require_top: Option<&'a str>,
    op: Op<'a>,
    payloads: Vec<&'a str>,
}

/// A request's id, which names its files in the request directory: letters,
/// digits and `-`, as a UUID is written.
pub fn is_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// What a payload file in the request directory is called.
fn is_payload_name(name: &str) -> bool {
    name.strip_prefix("payload-")
        .and_then(|rest| rest.strip_suffix(".bin"))
        .is_some_and(|middle| {
            (1..=100).contains(&middle.len())
                && middle
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// A field that is absent or null, or a string. `None` for anything else.
fn optional_str<'a>(request: &'a Value, key: &str) -> Option<Option<&'a str>> {
    match request.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s)),
        Some(_) => None,
    }
}

/// `maxBytes` from a listing: absent, for `MAX_FILE_BYTES`, or a whole number
/// of bytes up to it.
fn file_cap(listing: &Value) -> Option<u64> {
    match listing.get("maxBytes") {
        None | Some(Value::Null) => Some(MAX_FILE_BYTES),
        Some(n) => n
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= MAX_FILE_BYTES as f64)
            .map(|n| n as u64),
    }
}

fn contained<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str().filter(|path| is_contained(path))
}

fn listing(value: &Value) -> Option<Listing<'_>> {
    Some(Listing {
        path: contained(value, "path")?,
        suffix: optional_str(value, "suffix")?,
        mine: optional_str(value, "mine")?,
        max_bytes: file_cap(value)?,
    })
}

fn batch<'a, T>(
    request: &'a Value,
    key: &str,
    each: impl Fn(&'a Value) -> Option<T>,
) -> Option<Vec<T>> {
    let items = request.get(key)?.as_array()?;
    if items.len() > MAX_BATCH {
        return None;
    }
    items.iter().map(each).collect()
}

/// The request in `value`, if it is one this helper will act on.
fn parse(value: &Value) -> Option<Request<'_>> {
    let id = value.get("id")?.as_str().filter(|id| is_id(id))?;
    let root = value
        .get("root")?
        .as_str()
        .filter(|root| is_root(root) || Location::parse(root).is_some())?;
    let require_top = match value.get("requireTop")? {
        Value::Null => None,
        Value::String(top) if is_contained(top) => Some(top.as_str()),
        _ => return None,
    };
    let path = || contained(value, "path");
    let op = match value.get("op")?.as_str()? {
        "readDir" => Op::ReadDir(listing(value)?),
        "readDirs" => Op::ReadDirs(batch(value, "dirs", listing)?),
        "write" => Op::Write(path()?),
        "writeFiles" => Op::WriteFiles(batch(value, "files", |each| contained(each, "path"))?),
        "move" => Op::Move(contained(value, "from")?, contained(value, "to")?),
        "remove" => Op::Remove(path()?),
        "exists" => Op::Exists(path()?),
        "removeDir" => Op::RemoveDir(path()?),
        "listNames" => {
            let holding = optional_str(value, "holding")?;
            if holding.is_some_and(|name| !is_contained(name) || name.contains('/')) {
                return None;
            }
            Op::ListNames(path()?, holding)
        }
        "makeDir" => Op::MakeDir(path()?),
        _ => return None,
    };
    let wanted = match &op {
        Op::Write(_) => 1,
        Op::WriteFiles(files) => files.len(),
        _ => 0,
    };
    let payloads = if wanted == 0 {
        Vec::new()
    } else {
        batch(value, "payloads", |name| {
            name.as_str().filter(|name| is_payload_name(name))
        })?
    };
    if payloads.len() != wanted {
        return None;
    }
    Some(Request {
        id,
        root,
        require_top,
        op,
        payloads,
    })
}

/// The names and paths of the entries in `dir`, in the order the system
/// lists them. A directory that does not exist has none: it is the first-use
/// case.
fn children(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    entries
        .map(|entry| {
            let entry = entry?;
            Ok((
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ))
        })
        .collect()
}

/// Whether anything is at `path`, following a link, as `nsIFile::Exists`
/// answers: a failure to look counts as nothing there.
fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// Whether the entry `meta` describes, read without following it, is removed
/// as a directory. On Windows a directory symbolic link or a junction is one.
fn removes_as_directory(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY
            != 0
    }
    #[cfg(not(windows))]
    meta.is_dir()
}

/// Removes the file, link or empty directory at `path`, never following a
/// link; nothing there is not a failure.
fn remove_entry(path: &Path) -> io::Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if removes_as_directory(&meta) => fs::remove_dir(path),
        Ok(_) => fs::remove_file(path),
        Err(err) => Err(err),
    };
    match removed {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// 16 random hexadecimal digits.
fn random_suffix() -> io::Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Whether `name` is a temporary name `write_atomically` gives a write to
/// `target_name`: the target's name, a 16-digit suffix, `.tmp`.
fn is_temporary_of(name: &str, target_name: &str) -> bool {
    name.strip_suffix(".tmp")
        .and_then(|rest| rest.strip_prefix(target_name))
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|hex| {
            hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// What reading one listed entry came to.
enum Entry {
    Bytes(Vec<u8>),
    Problem(&'static str),
    /// The `readDirs` it is part of has read all one step may.
    StepFull,
}

/// The shared folder's operations, against a browser's request directory.
pub struct Folder {
    request_dir: PathBuf,
    /// What `crosses_link` asks of each directory: `is_link`. Only a test
    /// replaces it.
    pub(crate) linked_dir: fn(&Path) -> io::Result<bool>,
    /// The remote folders' connections and the bytes read from them.
    pub(crate) remote: RefCell<remote::RemoteState>,
}

impl Folder {
    pub fn new(request_dir: PathBuf) -> Self {
        Folder {
            request_dir,
            linked_dir: is_link,
            remote: RefCell::default(),
        }
    }

    /// Performs `request` and says what happened, with the request's id.
    pub fn answer(&self, request: &Value) -> Value {
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_id(id))
            .map_or(Value::Null, Value::from);
        let mut answer = self.perform(request);
        answer
            .as_object_mut()
            .expect("every answer is an object")
            .insert("id".into(), id);
        answer
    }

    fn perform(&self, value: &Value) -> Value {
        let Some(request) = parse(value) else {
            return unreachable("io-error", Some("InvalidRequest"));
        };
        // Every payload is read before the shared folder is touched, since
        // that may hang this helper past the browser's reuse of the request
        // directory.
        let mut payloads = Vec::with_capacity(request.payloads.len());
        for name in &request.payloads {
            match fs::read(self.request_dir.join(name)) {
                Ok(bytes) => payloads.push(bytes),
                Err(err) => return unreachable("io-error", Some(error_name(&err))),
            }
        }
        if let Some(location) = Location::parse(request.root) {
            let Some(auth) = auth_for(&location, value) else {
                return unreachable("io-error", Some("SignInError"));
            };
            return remote::perform(
                &mut self.remote.borrow_mut(),
                &request,
                &location,
                &auth,
                &payloads,
                &self.request_dir,
            );
        }
        let root = Path::new(request.root);
        match fs::metadata(root) {
            Err(err) => {
                let name = error_name(&err);
                let reason = if name == "NotFoundError" {
                    "missing"
                } else {
                    "io-error"
                };
                return unreachable(reason, Some(name));
            }
            Ok(meta) if !meta.is_dir() => return unreachable("not-a-directory", None),
            Ok(_) => {}
        }
        self.perform_below(&request, root, &payloads)
            .unwrap_or_else(|Failure(name)| unreachable("io-error", Some(name)))
    }

    fn perform_below(
        &self,
        request: &Request,
        root: &Path,
        payloads: &[Vec<u8>],
    ) -> Result<Value, Failure> {
        if let Some(top) = request.require_top {
            let parts: Vec<&str> = top.split('/').collect();
            if self.crosses_link(root, &parts)? {
                return Ok(symlink());
            }
            // A chosen folder holds Sval's top directory, made when the user
            // chose it. A mount point that is not mounted is an empty local
            // directory, and writing into it would hide a file under the
            // mount when it returns.
            if !exists(&join(root, &parts)) {
                return Ok(unreachable("no-sval-dir", None));
            }
        }
        let files = self.request_dir.join(format!("files-{}", request.id));
        match &request.op {
            Op::ReadDir(listing) => {
                let parts: Vec<&str> = listing.path.split('/').collect();
                if self.crosses_link(root, &parts)? {
                    return Ok(symlink());
                }
                fs::create_dir_all(&files)?;
                self.read_listing(&join(root, &parts), listing, &files, None)
            }
            Op::ReadDirs(listings) => {
                let mut step = MAX_STEP_BYTES;
                let mut dirs = Vec::with_capacity(listings.len());
                for (index, listing) in listings.iter().enumerate() {
                    let into = files.join(index.to_string());
                    fs::create_dir_all(&into)?;
                    let parts: Vec<&str> = listing.path.split('/').collect();
                    if self.crosses_link(root, &parts)? {
                        return Ok(symlink());
                    }
                    let mut read =
                        self.read_listing(&join(root, &parts), listing, &into, Some(&mut step))?;
                    if read["reachable"] != true {
                        // Which directory's own file did not read: the
                        // browser sets that file aside once it has stayed so
                        // (decision 1144).
                        if read["reason"] == "own-file-unreadable" {
                            read["dir"] = index.into();
                        }
                        return Ok(read);
                    }
                    dirs.push(json!({ "entries": read["entries"].take(), "unreadable": read["unreadable"].take() }));
                }
                Ok(json!({ "reachable": true, "dirs": dirs }))
            }
            Op::Write(path) => self.write(root, path, &payloads[0]),
            Op::WriteFiles(paths) => {
                for (path, bytes) in paths.iter().zip(payloads) {
                    let wrote = self.write(root, path, bytes)?;
                    if wrote["reachable"] != true {
                        return Ok(wrote);
                    }
                }
                Ok(json!({ "reachable": true }))
            }
            Op::Move(from, to) => self.move_file(root, from, to),
            Op::Remove(path) => {
                let parts: Vec<&str> = path.split('/').collect();
                if self.crosses_link(root, &parts[..parts.len() - 1])? {
                    return Ok(symlink());
                }
                remove_entry(&join(root, &parts))?;
                Ok(json!({ "reachable": true }))
            }
            Op::Exists(path) => {
                let parts: Vec<&str> = path.split('/').collect();
                if self.crosses_link(root, &parts)? {
                    return Ok(symlink());
                }
                Ok(json!({ "reachable": true, "exists": exists(&join(root, &parts)) }))
            }
            Op::RemoveDir(path) => {
                let parts: Vec<&str> = path.split('/').collect();
                if self.crosses_link(root, &parts)? {
                    return Ok(symlink());
                }
                remove_dir(&join(root, &parts))
            }
            Op::ListNames(path, holding) => {
                let parts: Vec<&str> = path.split('/').collect();
                if self.crosses_link(root, &parts)? {
                    return Ok(symlink());
                }
                list_names(&join(root, &parts), *holding)
            }
            Op::MakeDir(path) => {
                let parts: Vec<&str> = path.split('/').collect();
                if self.crosses_link(root, &parts[..parts.len() - 1])? {
                    return Ok(symlink());
                }
                fs::create_dir_all(join(root, &parts))?;
                // Checked after the directories are made, since making them
                // walks through a link, and so finds one that was already at
                // the target too.
                if self.crosses_link(root, &parts)? {
                    return Ok(symlink());
                }
                Ok(json!({ "reachable": true }))
            }
        }
    }

    /// Whether any of `parts`, joined one at a time onto `root`, is a link.
    /// The root itself is not checked: users choose a folder through a link
    /// (a synced folder in the home directory often is one). Anything below
    /// it is written by other machines and other users, and a link there
    /// would carry a read or a write out of the shared folder.
    fn crosses_link(&self, root: &Path, parts: &[&str]) -> io::Result<bool> {
        let mut at = root.to_path_buf();
        for part in parts {
            at.push(part);
            if (self.linked_dir)(&at)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Every file in `target` whose name ends in the listing's suffix, each
    /// copied raw into `into` and named there by number, so no name another
    /// machine chose becomes a path on this one. `step`, for a `readDirs`, is
    /// what it may still read, and the listing takes what it reads from it.
    fn read_listing(
        &self,
        target: &Path,
        listing: &Listing,
        into: &Path,
        mut step: Option<&mut u64>,
    ) -> Result<Value, Failure> {
        let cap = listing.max_bytes;
        let mut candidates: Vec<(String, PathBuf)> = children(target)?
            .into_iter()
            .filter(|(name, _)| {
                listing
                    .suffix
                    .is_none_or(|suffix| suffix.is_empty() || name.ends_with(suffix))
            })
            .collect();
        candidates.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
        // This device's file goes first, so a full listing never starves it.
        if let Some(own) = candidates
            .iter()
            .position(|(name, _)| Some(name.as_str()) == listing.mine)
        {
            let entry = candidates.remove(own);
            candidates.insert(0, entry);
        }

        let mut entries: Vec<(String, String)> = Vec::new();
        let mut unreadable = Vec::new();
        let mut total = 0u64;
        for (index, (name, child)) in candidates.into_iter().enumerate() {
            let read = if index >= MAX_ENTRIES {
                Entry::Problem("TooManyEntries")
            } else if total >= MAX_TOTAL_BYTES {
                Entry::Problem("ListingTooLarge")
            } else {
                read_entry(&child, cap, total, step.as_deref().copied())
                    .unwrap_or_else(|err| Entry::Problem(error_name(&err)))
            };
            let bytes = match read {
                Entry::StepFull => return Ok(unreachable("too-large", None)),
                Entry::Problem(problem) => {
                    // This device's own file existing and not reading must
                    // never look like an absence: the engine treats a missing
                    // own file as a first run and overwrites it
                    // (`SvalSync.worker.mjs`, `#collect`). A problem that may
                    // pass, such as a placeholder not yet downloaded, makes
                    // the folder unreachable until it does. An entry that is
                    // a link, a directory, any other non-file or too large stays so until someone
                    // removes it, so it is listed, and the caller publishes
                    // nothing over it (`SvalEngine`, `#mergeOne`).
                    if Some(name.as_str()) == listing.mine && !LASTING_PROBLEMS.contains(&problem) {
                        return Ok(unreachable("own-file-unreadable", Some(problem)));
                    }
                    if unreadable.len() < MAX_UNREADABLE_LISTED {
                        unreadable.push(json!({ "name": name, "reason": problem }));
                    }
                    continue;
                }
                Entry::Bytes(bytes) => bytes,
            };
            let len = bytes.len() as u64;
            total += len;
            if let Some(left) = step.as_deref_mut() {
                *left -= len;
            }
            let copy = entries.len().to_string();
            fs::write(into.join(&copy), &bytes)?;
            entries.push((name, copy));
        }
        entries.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
        let entries: Vec<Value> = entries
            .into_iter()
            .map(|(name, copy)| json!({ "name": name, "copy": copy }))
            .collect();
        Ok(json!({ "reachable": true, "entries": entries, "unreadable": unreadable }))
    }

    fn write(&self, root: &Path, path: &str, bytes: &[u8]) -> Result<Value, Failure> {
        let parts: Vec<&str> = path.split('/').collect();
        if self.crosses_link(root, &parts[..parts.len() - 1])? {
            return Ok(symlink());
        }
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Ok(unreachable("io-error", Some("TooLarge")));
        }
        self.write_atomically(root, &parts, bytes)
    }

    /// Writes `bytes` to the file at `parts` below `root` so that a peer
    /// listing the directory never reads a half-written file (spec §6.3),
    /// and so that nothing planted beside it redirects the write. The
    /// temporary file has a random name and is created exclusively
    /// (`O_EXCL`, which does not follow a link) in the same directory, then
    /// renamed over the target; a rename replaces a link at the target
    /// instead of following it. A target that is a link is refused before
    /// that, on Windows too, where a cloud placeholder is not a link.
    ///
    /// Two properties remain. A directory swapped for a link between the
    /// check and the rename can still redirect this one write. And the write
    /// replaces the directory entry by rename, so a hard link at the target
    /// is never written through: the other name keeps the old bytes.
    fn write_atomically(
        &self,
        root: &Path,
        parts: &[&str],
        bytes: &[u8],
    ) -> Result<Value, Failure> {
        let target = join(root, parts);
        let parent = target.parent().expect("a path below the root has a parent");
        fs::create_dir_all(parent)?;
        // Checked after the directories are made, since making them walks
        // through a link.
        if self.crosses_link(root, &parts[..parts.len() - 1])? || is_link(&target)? {
            return Ok(symlink());
        }
        if exists(&target) && fs::metadata(&target)?.is_dir() {
            return Ok(unreachable("io-error", Some("IsDirectory")));
        }
        let name = parts[parts.len() - 1];
        // A name nobody can predict, so nothing planted in the folder can
        // occupy it and block every write this device makes.
        let temporary = parent.join(format!("{name}.{}.tmp", random_suffix()?));
        let written = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .and_then(|mut file| file.write_all(bytes))
            .and_then(|()| fs::rename(&temporary, &target));
        if let Err(err) = written {
            let _ = fs::remove_file(&temporary);
            return Err(err.into());
        }
        sweep_stale_temporaries(parent, name);
        Ok(json!({ "reachable": true }))
    }

    /// Renames the file at `from` to `to`, both below `root`. Nothing at `to`
    /// is ever replaced: an entry there, a link included, refuses the move,
    /// and so does a link or a directory at `from` or on the way to either.
    /// An absent `from` leaves nothing to move. An entry swapped for a link
    /// between the checks and the rename can still redirect it.
    fn move_file(&self, root: &Path, from: &str, to: &str) -> Result<Value, Failure> {
        let from: Vec<&str> = from.split('/').collect();
        let to: Vec<&str> = to.split('/').collect();
        let source = join(root, &from);
        let target = join(root, &to);
        if self.crosses_link(root, &from[..from.len() - 1])?
            || self.crosses_link(root, &to[..to.len() - 1])?
            || is_link(&source)?
            || is_link(&target)?
        {
            return Ok(symlink());
        }
        if exists(&target) {
            return Ok(unreachable("io-error", Some("Exists")));
        }
        match fs::metadata(&source) {
            Err(_) => return Ok(json!({ "reachable": true })),
            Ok(meta) if meta.is_dir() => return Ok(unreachable("io-error", Some("IsDirectory"))),
            Ok(_) => {}
        }
        fs::rename(&source, &target)?;
        Ok(json!({ "reachable": true }))
    }
}

/// Reads one listed entry, refusing a link, a directory, anything else that
/// is not a regular file, and anything over the caps. Opening a FIFO or a
/// device can block without end, and anyone who can write to the folder can
/// plant one, so such an entry is never opened: it is listed as `NotAFile`.
/// The file is opened without following a link and without blocking, and its
/// handle is checked again, so an entry swapped between the look and the open
/// is refused as well. It is read for what it measured plus one byte, which
/// says it grew after it was measured.
fn read_entry(child: &Path, cap: u64, total: u64, step: Option<u64>) -> io::Result<Entry> {
    if is_link(child)? {
        return Ok(Entry::Problem("Symlink"));
    }
    let meta = fs::metadata(child)?;
    if let Some(problem) = not_a_file(&meta) {
        return Ok(Entry::Problem(problem));
    }
    let size = meta.len();
    if size > cap {
        return Ok(Entry::Problem("TooLarge"));
    }
    if step.is_some_and(|left| size > left) {
        return Ok(Entry::StepFull);
    }
    if total + size > MAX_TOTAL_BYTES {
        return Ok(Entry::Problem("ListingTooLarge"));
    }
    let file = match open_entry(child) {
        Ok(file) => file,
        Err(err) if is_link_refusal(&err) => return Ok(Entry::Problem("Symlink")),
        Err(err) => return Err(err),
    };
    if let Some(problem) = not_a_file(&file.metadata()?) {
        return Ok(Entry::Problem(problem));
    }
    let mut bytes = Vec::new();
    file.take(size + 1).read_to_end(&mut bytes)?;
    let len = bytes.len() as u64;
    Ok(if len > cap {
        Entry::Problem("TooLarge")
    } else if len > size {
        Entry::Problem("Changed")
    } else if step.is_some_and(|left| len > left) {
        Entry::StepFull
    } else if total + len > MAX_TOTAL_BYTES {
        Entry::Problem("ListingTooLarge")
    } else {
        Entry::Bytes(bytes)
    })
}

/// What a listed entry that is not a regular file is listed as.
fn not_a_file(meta: &fs::Metadata) -> Option<&'static str> {
    if meta.is_dir() {
        Some("IsDirectory")
    } else if !meta.is_file() {
        Some("NotAFile")
    } else {
        None
    }
}

/// Opens a listed entry for reading. On Unix `O_NOFOLLOW` refuses a link
/// and `O_NONBLOCK` keeps the open of a FIFO from waiting for a writer; on a
/// regular file it changes nothing.
fn open_entry(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

/// Whether `open_entry` failed because the entry is a link: `O_NOFOLLOW`
/// answers `ELOOP` for one.
fn is_link_refusal(err: &io::Error) -> bool {
    #[cfg(unix)]
    return err.raw_os_error() == Some(libc::ELOOP);
    #[cfg(not(unix))]
    {
        let _ = err;
        false
    }
}

/// Removes the stale temporary files of earlier writes to `name` in
/// `parent`. The write has already succeeded, so nothing here may fail it.
fn sweep_stale_temporaries(parent: &Path, name: &str) {
    let Ok(listed) = children(parent) else {
        return;
    };
    let now = SystemTime::now();
    for (child_name, child) in listed {
        if !is_temporary_of(&child_name, name) || is_link(&child).unwrap_or(true) {
            continue;
        }
        let Ok(meta) = fs::metadata(&child) else {
            continue;
        };
        let stale = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STALE_TEMPORARY);
        if meta.is_file() && stale {
            let _ = fs::remove_file(&child);
        }
    }
}

/// Removes one key's directory, when the user starts over with a new key:
/// the files in it, and then the directory. The path to it, itself included,
/// has already been checked for links. Nothing here follows one: a link
/// inside is removed as a link, and a directory inside is left alone, because
/// Sval never writes one there and removing it would reach past what Sval
/// owns. The answer's `removed` says whether the directory itself is gone.
fn remove_dir(target: &Path) -> Result<Value, Failure> {
    let mut kept_any = false;
    for (_, child) in children(target)? {
        if is_link(&child)? {
            remove_entry(&child)?;
            continue;
        }
        if fs::metadata(&child)?.is_dir() {
            kept_any = true;
            continue;
        }
        remove_entry(&child)?;
    }
    if !kept_any {
        remove_entry(target)?;
    }
    Ok(json!({ "reachable": true, "removed": !kept_any }))
}

/// The names in `target`, at most `MAX_ENTRIES`, reading none of them; with
/// `holding`, also which of those hold an entry by that name, still without
/// reading it. A link is passed over there, as every walk here passes one
/// over.
fn list_names(target: &Path, holding: Option<&str>) -> Result<Value, Failure> {
    let mut listed = children(target)?;
    listed.truncate(MAX_ENTRIES);
    let mut names: Vec<&str> = listed.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_by(|a, b| utf16_cmp(a, b));
    let mut answer = Map::new();
    answer.insert("reachable".into(), true.into());
    answer.insert("names".into(), json!(names));
    if let Some(holding) = holding {
        let mut holders = Vec::new();
        for (name, child) in &listed {
            if !is_link(child)? && exists(&child.join(holding)) {
                holders.push(name.as_str());
            }
        }
        holders.sort_by(|a, b| utf16_cmp(a, b));
        answer.insert("holding".into(), json!(holders));
    }
    Ok(Value::Object(answer))
}

mod remote;

#[cfg(test)]
mod tests;
