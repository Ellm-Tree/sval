// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The shared folder's operations on a remote folder (desktop connectors
//! spec §2), answering as the local ones in `ops.rs` answer, with the same
//! limits and the same refusals.
//!
//! Two things differ. A listing reads each file through the network, so the
//! bytes of every file read are kept for the browser run, by the version
//! the store reports, and read again only once that changes. And a read
//! that fails because the network did fails the whole request: a peer's
//! document listed as unreadable would be one the browser sets aside.

use super::{
    unreachable, utf16_cmp, Listing, Op, Request, LASTING_PROBLEMS, MAX_ENTRIES, MAX_FILE_BYTES,
    MAX_STEP_BYTES, MAX_TOTAL_BYTES, MAX_UNREADABLE_LISTED,
};
use crate::errors::Failure;
use crate::remote::{join, Child, Kind, Location, RemoteError, Store, Stores};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// The most bytes the kept copies hold. Past it every copy is dropped, and
/// the next listing reads its files again.
const MAX_KEPT_BYTES: usize = MAX_STEP_BYTES as usize;

/// What the helper keeps between requests for remote folders.
#[derive(Default)]
pub struct RemoteState {
    pub(crate) stores: Stores,
    /// The bytes of each file read, by its location and path, with the
    /// version they were read at.
    kept: HashMap<(Location, String), (String, Vec<u8>)>,
    kept_bytes: usize,
}

impl RemoteState {
    fn keep(&mut self, location: &Location, path: String, version: String, bytes: Vec<u8>) {
        if version.is_empty() {
            return;
        }
        if self.kept_bytes + bytes.len() > MAX_KEPT_BYTES {
            self.kept.clear();
            self.kept_bytes = 0;
        }
        self.kept_bytes += bytes.len();
        if let Some((_, old)) = self.kept.insert((location.clone(), path), (version, bytes)) {
            self.kept_bytes -= old.len();
        }
    }

    fn forget(&mut self, location: &Location, path: &str) {
        if let Some((_, old)) = self.kept.remove(&(location.clone(), path.to_owned())) {
            self.kept_bytes -= old.len();
        }
    }
}

fn failed(err: RemoteError) -> Value {
    unreachable("io-error", Some(err.name()))
}

fn symlink() -> Value {
    super::symlink()
}

/// Whether a failed read says something about the folder as a whole, so the
/// request fails, rather than about the one file.
fn fails_request(err: &RemoteError) -> bool {
    matches!(err, RemoteError::Unreachable | RemoteError::SignIn)
}

/// Performs `request` on the remote folder at `location`, signed in with
/// `auth`.
pub(super) fn perform(
    state: &mut RemoteState,
    request: &Request,
    location: &Location,
    auth: &str,
    payloads: &[Vec<u8>],
    request_dir: &Path,
) -> Value {
    let answer = {
        let store = state.stores.get(location, auth);
        match store.kind("") {
            Ok(None) | Err(RemoteError::NotFound) => {
                return unreachable("missing", Some("NotFoundError"))
            }
            Ok(Some(Kind::File)) => return unreachable("not-a-directory", None),
            Ok(Some(_)) => {}
            Err(err) => return failed(err),
        }
        if let Some(top) = request.require_top {
            match store.kind(top) {
                Ok(Some(Kind::Link)) => return symlink(),
                // A chosen folder holds Sval's top directory, made when the
                // user chose it, as `perform_below` in `ops.rs` requires.
                Ok(None) => return unreachable("no-sval-dir", None),
                Ok(Some(_)) => {}
                Err(err) => return failed(err),
            }
        }
        None
    };
    if let Some(answer) = answer {
        return answer;
    }
    let files = request_dir.join(format!("files-{}", request.id));
    let done = match &request.op {
        Op::ReadDir(listing) => fs::create_dir_all(&files)
            .map_err(Failure::from)
            .and_then(|()| read_listing(state, location, auth, listing, &files, None)),
        Op::ReadDirs(listings) => {
            let mut step = MAX_STEP_BYTES;
            let mut dirs = Vec::with_capacity(listings.len());
            let mut answer = None;
            for (index, listing) in listings.iter().enumerate() {
                let into = files.join(index.to_string());
                if let Err(err) = fs::create_dir_all(&into) {
                    return unreachable("io-error", Some(Failure::from(err).0));
                }
                let mut read =
                    match read_listing(state, location, auth, listing, &into, Some(&mut step)) {
                        Ok(read) => read,
                        Err(Failure(name)) => return unreachable("io-error", Some(name)),
                    };
                if read["reachable"] != true {
                    if read["reason"] == "own-file-unreadable" {
                        read["dir"] = index.into();
                    }
                    answer = Some(read);
                    break;
                }
                dirs.push(json!({ "entries": read["entries"].take(), "unreadable": read["unreadable"].take() }));
            }
            Ok(answer.unwrap_or_else(|| json!({ "reachable": true, "dirs": dirs })))
        }
        Op::Write(path) => Ok(write(state, location, auth, path, &payloads[0])),
        Op::WriteFiles(paths) => {
            let mut answer = json!({ "reachable": true });
            for (path, bytes) in paths.iter().zip(payloads) {
                let wrote = write(state, location, auth, path, bytes);
                if wrote["reachable"] != true {
                    answer = wrote;
                    break;
                }
            }
            Ok(answer)
        }
        Op::Move(from, to) => Ok(move_file(state, location, auth, from, to)),
        Op::Remove(path) => {
            state.forget(location, path);
            let store = state.stores.get(location, auth);
            let removed = match store.kind(path) {
                Ok(None) => Ok(()),
                Ok(Some(Kind::Dir)) => store.remove_dir(path),
                Ok(Some(_)) => store.remove_file(path),
                Err(err) => Err(err),
            };
            Ok(removed.map_or_else(failed, |()| json!({ "reachable": true })))
        }
        Op::Exists(path) => {
            let store = state.stores.get(location, auth);
            Ok(match store.kind(path) {
                Ok(Some(Kind::Link)) => symlink(),
                Ok(found) => json!({ "reachable": true, "exists": found.is_some() }),
                Err(err) => failed(err),
            })
        }
        Op::RemoveDir(path) => Ok(remove_dir(state.stores.get(location, auth), path)),
        Op::ListNames(path, holding) => {
            Ok(list_names(state.stores.get(location, auth), path, *holding))
        }
        Op::MakeDir(path) => {
            let store = state.stores.get(location, auth);
            Ok(match store.make_dirs(path) {
                Ok(()) => json!({ "reachable": true }),
                Err(err) => failed(err),
            })
        }
        Op::ListFolders => Ok(list_folders(state.stores.get(location, auth))),
    };
    done.unwrap_or_else(|Failure(name)| unreachable("io-error", Some(name)))
}

/// What a listed entry comes to before any file is read.
enum Plan {
    Problem(String, &'static str),
    Read(Child),
}

/// Every file in the listing's directory whose name ends in its suffix,
/// each copied raw into `into` and named there by number, as
/// `Folder::read_listing` in `ops.rs` copies a local one.
fn read_listing(
    state: &mut RemoteState,
    location: &Location,
    auth: &str,
    listing: &Listing,
    into: &Path,
    mut step: Option<&mut u64>,
) -> Result<Value, Failure> {
    let cap = listing.max_bytes;
    let listed = match state.stores.get(location, auth).list(listing.path) {
        Ok(listed) => listed,
        Err(err) => return Ok(failed(err)),
    };
    let mut candidates: Vec<Child> = listed
        .into_iter()
        .filter(|child| {
            listing
                .suffix
                .is_none_or(|suffix| suffix.is_empty() || child.name.ends_with(suffix))
        })
        .collect();
    candidates.sort_by(|a, b| utf16_cmp(&a.name, &b.name));
    // This device's file goes first, so a full listing never starves it.
    if let Some(own) = candidates
        .iter()
        .position(|child| Some(child.name.as_str()) == listing.mine)
    {
        let entry = candidates.remove(own);
        candidates.insert(0, entry);
    }

    // What each entry comes to, measured by the size the listing reports.
    let mut total = 0u64;
    let mut planned = Vec::with_capacity(candidates.len());
    for (index, child) in candidates.into_iter().enumerate() {
        let problem = if index >= MAX_ENTRIES {
            Some("TooManyEntries")
        } else if total >= MAX_TOTAL_BYTES {
            Some("ListingTooLarge")
        } else if child.kind == Kind::Link {
            Some("Symlink")
        } else if child.kind == Kind::Dir {
            Some("IsDirectory")
        } else if child.size > cap {
            Some("TooLarge")
        } else if step.as_deref().is_some_and(|left| child.size > *left) {
            return Ok(unreachable("too-large", None));
        } else if total + child.size > MAX_TOTAL_BYTES {
            Some("ListingTooLarge")
        } else {
            None
        };
        let plan = if let Some(problem) = problem {
            Plan::Problem(child.name, problem)
        } else {
            total += child.size;
            if let Some(left) = step.as_deref_mut() {
                *left -= child.size;
            }
            Plan::Read(child)
        };
        planned.push(plan);
    }

    // The kept bytes still at the version listed, taken before anything is
    // read, since keeping what is read may drop them; the rest are read at
    // once, each for one byte past its listed size, which tells a file that
    // grew since the listing.
    let mut reused: HashMap<String, Vec<u8>> = HashMap::new();
    let mut wanted: Vec<(String, u64)> = Vec::new();
    for plan in &planned {
        let Plan::Read(child) = plan else {
            continue;
        };
        let path = join(listing.path, &child.name);
        match state.kept.get(&(location.clone(), path.clone())) {
            Some((version, bytes)) if *version == child.version => {
                reused.insert(path, bytes.clone());
            }
            _ => wanted.push((path, child.size + 1)),
        }
    }
    let read = {
        let paths: Vec<(&str, u64)> = wanted
            .iter()
            .map(|(path, limit)| (path.as_str(), *limit))
            .collect();
        state.stores.get(location, auth).read_all(&paths)
    };
    let wanted: Vec<String> = wanted.into_iter().map(|(path, _)| path).collect();
    let mut fresh: HashMap<String, Result<Vec<u8>, RemoteError>> =
        wanted.into_iter().zip(read).collect();
    if let Some(err) = fresh
        .values()
        .find_map(|read| read.as_ref().err().filter(|err| fails_request(err)))
    {
        return Ok(failed(err.clone()));
    }

    let mut entries: Vec<(String, String)> = Vec::new();
    let mut unreadable = Vec::new();
    for plan in planned {
        let (name, problem_or_bytes) = match plan {
            Plan::Problem(name, problem) => (name, Err(problem)),
            Plan::Read(child) => {
                let path = join(listing.path, &child.name);
                let bytes = match fresh.remove(&path) {
                    Some(Ok(bytes)) => {
                        state.keep(location, path, child.version.clone(), bytes.clone());
                        Ok(bytes)
                    }
                    Some(Err(err)) => Err(err.name()),
                    None => reused.remove(&path).ok_or("Changed"),
                };
                let checked = bytes.and_then(|bytes| {
                    let len = bytes.len() as u64;
                    if len > cap {
                        Err("TooLarge")
                    } else if len > child.size {
                        Err("Changed")
                    } else {
                        Ok(bytes)
                    }
                });
                (child.name, checked)
            }
        };
        match problem_or_bytes {
            Ok(bytes) => {
                let copy = entries.len().to_string();
                fs::write(into.join(&copy), &bytes)?;
                entries.push((name, copy));
            }
            Err(problem) => {
                // As `Folder::read_listing` reasons: this device's own file
                // existing and not reading must never look like an absence.
                if Some(name.as_str()) == listing.mine && !LASTING_PROBLEMS.contains(&problem) {
                    return Ok(unreachable("own-file-unreadable", Some(problem)));
                }
                if unreadable.len() < MAX_UNREADABLE_LISTED {
                    unreadable.push(json!({ "name": name, "reason": problem }));
                }
            }
        }
    }
    entries.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(name, copy)| json!({ "name": name, "copy": copy }))
        .collect();
    Ok(json!({ "reachable": true, "entries": entries, "unreadable": unreadable }))
}

fn write(
    state: &mut RemoteState,
    location: &Location,
    auth: &str,
    path: &str,
    bytes: &[u8],
) -> Value {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return unreachable("io-error", Some("TooLarge"));
    }
    state.forget(location, path);
    let store = state.stores.get(location, auth);
    match store.kind(path) {
        Ok(Some(Kind::Link)) => return symlink(),
        Ok(Some(Kind::Dir)) => return unreachable("io-error", Some("IsDirectory")),
        Ok(_) => {}
        Err(err) => return failed(err),
    }
    match store.write(path, bytes) {
        Ok(()) => json!({ "reachable": true }),
        Err(err) => failed(err),
    }
}

/// Renames the file at `from` to `to`, never replacing anything at `to`, as
/// `Folder::move_file` in `ops.rs` does.
fn move_file(
    state: &mut RemoteState,
    location: &Location,
    auth: &str,
    from: &str,
    to: &str,
) -> Value {
    state.forget(location, from);
    state.forget(location, to);
    let store = state.stores.get(location, auth);
    match store.kind(to) {
        Ok(Some(Kind::Link)) => return symlink(),
        Ok(Some(_)) => return unreachable("io-error", Some("Exists")),
        Ok(None) => {}
        Err(err) => return failed(err),
    }
    match store.kind(from) {
        Ok(None) => return json!({ "reachable": true }),
        Ok(Some(Kind::Link)) => return symlink(),
        Ok(Some(Kind::Dir)) => return unreachable("io-error", Some("IsDirectory")),
        Ok(Some(Kind::File)) => {}
        Err(err) => return failed(err),
    }
    match store.rename_new(from, to) {
        Ok(()) | Err(RemoteError::NotFound) => json!({ "reachable": true }),
        Err(RemoteError::Exists) => unreachable("io-error", Some("Exists")),
        Err(err) => failed(err),
    }
}

/// Removes one key's directory: its files, and then the directory, leaving
/// any directory inside alone, as `remove_dir` in `ops.rs` does.
fn remove_dir(store: &mut (dyn Store + Send), path: &str) -> Value {
    let listed = match store.list(path) {
        Ok(listed) => listed,
        Err(err) => return failed(err),
    };
    let mut kept_any = false;
    for child in listed {
        if child.kind == Kind::Dir {
            kept_any = true;
            continue;
        }
        if let Err(err) = store.remove_file(&join(path, &child.name)) {
            return failed(err);
        }
    }
    if !kept_any {
        if let Err(err) = store.remove_dir(path) {
            return failed(err);
        }
    }
    json!({ "reachable": true, "removed": !kept_any })
}

/// The folders in the root, at most `MAX_ENTRIES`. A link is passed over.
fn list_folders(store: &mut (dyn Store + Send)) -> Value {
    let listed = match store.list("") {
        Ok(listed) => listed,
        Err(err) => return failed(err),
    };
    let mut folders: Vec<String> = listed
        .into_iter()
        .filter(|child| child.kind == Kind::Dir)
        .map(|child| child.name)
        .collect();
    folders.truncate(MAX_ENTRIES);
    folders.sort_by(|a, b| utf16_cmp(a, b));
    json!({ "reachable": true, "folders": folders })
}

/// The names in `path`, at most `MAX_ENTRIES`, reading none of them; with
/// `holding`, also which of those hold an entry by that name.
fn list_names(store: &mut (dyn Store + Send), path: &str, holding: Option<&str>) -> Value {
    let mut listed = match store.list(path) {
        Ok(listed) => listed,
        Err(err) => return failed(err),
    };
    listed.truncate(MAX_ENTRIES);
    let mut names: Vec<&str> = listed.iter().map(|child| child.name.as_str()).collect();
    names.sort_by(|a, b| utf16_cmp(a, b));
    let mut answer = Map::new();
    answer.insert("reachable".into(), true.into());
    answer.insert("names".into(), json!(names));
    if let Some(holding) = holding {
        let mut holders = Vec::new();
        for child in &listed {
            if child.kind == Kind::Link {
                continue;
            }
            match store.kind(&join(&join(path, &child.name), holding)) {
                Ok(Some(_)) => holders.push(child.name.as_str()),
                Ok(None) => {}
                Err(err) => return failed(err),
            }
        }
        holders.sort_by(|a, b| utf16_cmp(a, b));
        answer.insert("holding".into(), json!(holders));
    }
    Value::Object(answer)
}

#[cfg(test)]
mod tests;
