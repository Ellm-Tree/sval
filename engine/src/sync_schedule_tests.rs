// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! `sync` driven as devices use it, checked against a reference model.
//!
//! Each device has its own folder, a real [`MemoryStore`], which a cloud
//! client fills with copies of the other devices' files: late, skipping
//! versions, sometimes cut short, and sometimes while a pass is reading. Edits
//! and passes interleave, a pass can be handed a clock reading taken before
//! the edits it carries, and the folder can fail any call a real one can.
//! Everything, the key and every id included, comes from the seed, so a
//! failing seed reproduces.
//!
//! The model records every write the edits made and every file each pass
//! read, and judges the result by the spec's rules without calling the
//! merge:
//!
//! - a node nobody removed is on every device at the end, holding the
//!   greatest write of each group by the order of spec §5.3, which the model
//!   computes itself;
//! - a node removed on a device that had read, for every write to it, a file
//!   of that write's device covering it (spec §5.4), is gone from every
//!   device at the end.
//!
//! A removal the model cannot settle that way is judged by convergence alone:
//! the absence rule keeps such a node when any copy carries news (decision
//! 0017), and which copies still do depends on the merge order.

use crate::crypto::{self, Key};
use crate::store::{self, DeviceId, MemoryStore, StorageProvider};
use crate::sync::{SyncReport, sync};
use crate::tree;
use crate::types::test_support::{
    PUBLISHED_AT, generate_peers, peer_device, pool_ids, shared_state, unreachable_node,
};
use crate::types::{Document, Error, NodeId, NodeKind, Timestamp};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const WS: &str = "ws-1";

/// splitmix64, seeded once per schedule.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn one_in(&mut self, n: u64) -> bool {
        self.next().is_multiple_of(n)
    }
}

/// A storage call the folder fails, as a disk or a mount fails it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    List,
    /// The read of this device's own file.
    ReadOwn,
    /// The `n`th read of a peer's file in the pass.
    ReadPeer(usize),
    Write,
}

fn injected() -> Error {
    Error::Io(std::io::Error::other("injected"))
}

/// One device's folder. The files are a real [`MemoryStore`]; this adds what
/// the world does to it during a pass: a fault on one call, and files a cloud
/// client lands while the pass reads. A failed write leaves the file as it
/// was, as [`store::LocalFolder`]'s rename does.
struct Folder<'a> {
    files: &'a MemoryStore,
    own: &'a str,
    fault: Option<Fault>,
    /// Files the cloud client writes into the folder, one before each read.
    arriving: RefCell<VecDeque<(String, Vec<u8>)>>,
    /// Every read that returned bytes, with the bytes.
    reads: RefCell<Vec<(String, Vec<u8>)>>,
    peer_reads: Cell<usize>,
    /// Whether the pass asked to write, and whether the write landed.
    tried: Cell<bool>,
    wrote: Cell<bool>,
}

impl<'a> Folder<'a> {
    fn new(files: &'a MemoryStore, own: &'a str, fault: Option<Fault>) -> Self {
        Folder {
            files,
            own,
            fault,
            arriving: RefCell::new(VecDeque::new()),
            reads: RefCell::new(Vec::new()),
            peer_reads: Cell::new(0),
            tried: Cell::new(false),
            wrote: Cell::new(false),
        }
    }
}

impl StorageProvider for Folder<'_> {
    fn list(&self, prefix: &str) -> Result<Vec<String>, Error> {
        if self.fault == Some(Fault::List) {
            return Err(injected());
        }
        self.files.list(prefix)
    }

    fn read(&self, path: &str) -> Result<Vec<u8>, Error> {
        if let Some((landing, bytes)) = self.arriving.borrow_mut().pop_front() {
            self.files.write(&landing, &bytes)?;
        }
        if path == self.own {
            if self.fault == Some(Fault::ReadOwn) {
                return Err(injected());
            }
        } else {
            let n = self.peer_reads.get();
            self.peer_reads.set(n + 1);
            if self.fault == Some(Fault::ReadPeer(n)) {
                return Err(injected());
            }
        }
        let bytes = self.files.read(path)?;
        self.reads
            .borrow_mut()
            .push((path.to_string(), bytes.clone()));
        Ok(bytes)
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Error> {
        self.tried.set(true);
        if self.fault == Some(Fault::Write) {
            return Err(injected());
        }
        self.files.write(path, bytes)?;
        self.wrote.set(true);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Group {
    Content,
    Placement,
    Lifecycle,
    Appearance,
    Touch,
}

const GROUPS: [Group; 5] = [
    Group::Content,
    Group::Placement,
    Group::Lifecycle,
    Group::Appearance,
    Group::Touch,
];

/// One fact group of a node as one edit left it.
#[derive(Debug, Clone)]
struct Version {
    group: Group,
    at: Timestamp,
    by: Option<DeviceId>,
    /// The schedule step that wrote it.
    step: usize,
    /// The group's value and writer, as the model orders them.
    value: Vec<u8>,
}

/// The model's encoding of a group's value paired with its writer, which
/// orders exact timestamp ties (spec §5.3): JSON with object keys in byte
/// order. serde_json's own text, which spells every value this schedule
/// writes (ASCII strings with no control characters, integers, booleans)
/// exactly as the spec's canonical encoding does.
fn encode<T: serde::Serialize>(value: &T, by: Option<DeviceId>) -> Vec<u8> {
    let value = serde_json::to_value(value).unwrap();
    serde_json::to_vec(&serde_json::json!([value, by])).unwrap()
}

fn version_of(node: &crate::types::Node, group: Group, step: usize) -> Version {
    let (at, by, value) = match group {
        Group::Content => (
            node.content_at,
            node.content_by,
            encode(&node.content, node.content_by),
        ),
        Group::Placement => (node.placement_at, node.placement_by, Vec::new()),
        Group::Lifecycle => (
            node.lifecycle_at,
            node.lifecycle_by,
            encode(&node.lifecycle, node.lifecycle_by),
        ),
        Group::Appearance => (
            node.appearance_at,
            node.appearance_by,
            encode(&node.appearance, node.appearance_by),
        ),
        Group::Touch => (
            node.touched_at,
            node.touched_by,
            encode(&(), node.touched_by),
        ),
    };
    Version {
        group,
        at,
        by,
        step,
        value,
    }
}

/// A removal: `node` left device `device`'s document at `step`, when that
/// device had read, for each device, a file of it written at the time
/// `known` gives.
struct Removal {
    node: NodeId,
    device: DeviceId,
    step: usize,
    known: BTreeMap<DeviceId, Timestamp>,
}

/// What the model knows of the run.
#[derive(Default)]
struct Model {
    writes: BTreeMap<NodeId, Vec<Version>>,
    removals: Vec<Removal>,
    /// For each reader, the `written_at` of the newest file of each other
    /// device it has merged, read from its own folder.
    known: Vec<BTreeMap<DeviceId, Timestamp>>,
}

impl Model {
    /// Records what one edit on `device` did to its document, by comparing
    /// it with `before`.
    fn edited(&mut self, before: &Document, after: &Document, device: usize, step: usize) {
        for (id, node) in &after.nodes {
            let old = before.node(*id);
            for group in GROUPS {
                let version = version_of(node, group, step);
                let changed = old.is_none_or(|old| {
                    let was = version_of(old, group, step);
                    (was.at, was.by, &was.value) != (version.at, version.by, &version.value)
                });
                if changed {
                    self.writes.entry(*id).or_default().push(version);
                }
            }
        }
        for id in before
            .nodes
            .keys()
            .filter(|id| !after.nodes.contains_key(id))
        {
            self.removed(*id, device, step);
        }
    }

    fn removed(&mut self, node: NodeId, device: usize, step: usize) {
        self.removals.push(Removal {
            node,
            device: peer_device(device),
            step,
            known: self.known[device].clone(),
        });
    }

    /// Takes on every file `reader` read in a pass that ran at `now` and
    /// merged its peers: one that opens, names the device its path names,
    /// and was written no later than `now` (decision 0135).
    fn read(&mut self, reader: usize, key: &Key, reads: &[(String, Vec<u8>)], now: Timestamp) {
        let me = peer_device(reader);
        let dir = store::workspace_dir(key, WS);
        for (path, bytes) in reads {
            let Some(device) = store::device_of(&dir, path) else {
                continue;
            };
            if device == me {
                continue;
            }
            let Ok(plain) = crypto::open(key, path.as_bytes(), bytes) else {
                continue;
            };
            let doc = Document::from_json(std::str::from_utf8(&plain).unwrap()).unwrap();
            if doc.written_by == Some(device) && doc.written_at <= now {
                let entry = self.known[reader].entry(device).or_insert(0);
                *entry = (*entry).max(doc.written_at);
            }
        }
    }

    /// Whether `removal` saw every write to its node: its own made before it,
    /// and every other device's covered by a file of that device it had read.
    /// A group never written (no timestamp and no writer) has nothing to see
    /// (spec §5.4).
    fn settled(&self, removal: &Removal) -> bool {
        self.writes
            .get(&removal.node)
            .into_iter()
            .flatten()
            .all(|v| {
                if v.at == 0 && v.by.is_none() {
                    return true;
                }
                match v.by {
                    Some(by) if by == removal.device => v.step < removal.step,
                    Some(by) => removal.known.get(&by).is_some_and(|&known| v.at <= known),
                    None => false,
                }
            })
    }

    /// The greatest write of `group` to `id`, by timestamp, then by the
    /// encoded value and writer.
    fn winner(&self, id: NodeId, group: Group) -> Option<&Version> {
        self.writes
            .get(&id)?
            .iter()
            .filter(|v| v.group == group)
            .max_by(|a, b| a.at.cmp(&b.at).then_with(|| a.value.cmp(&b.value)))
    }
}

/// Every device's latest file, and which version of each one every other
/// device's folder holds.
struct Cloud {
    paths: Vec<String>,
    versions: Vec<Vec<Vec<u8>>>,
    delivered: Vec<Vec<Option<usize>>>,
}

impl Cloud {
    /// A version of `writer`'s file for `viewer`'s folder: one no older than
    /// what it holds, sometimes skipping versions, sometimes cut short as a
    /// client that has not finished downloading leaves it. `None` when it
    /// holds the latest already.
    fn next_copy(
        &mut self,
        rng: &mut Rng,
        viewer: usize,
        writer: usize,
    ) -> Option<(String, Vec<u8>)> {
        let latest = self.versions[writer].len().checked_sub(1)?;
        let from = self.delivered[viewer][writer].map_or(0, |held| held + 1);
        if from > latest {
            return None;
        }
        let index = from + rng.below(latest - from + 1);
        let bytes = &self.versions[writer][index];
        if rng.one_in(8) {
            let cut = rng.below(bytes.len());
            return Some((self.paths[writer].clone(), bytes[..cut].to_vec()));
        }
        self.delivered[viewer][writer] = Some(index);
        Some((self.paths[writer].clone(), bytes.clone()))
    }

    /// Every device's latest file, whole, in every other device's folder.
    fn deliver_all(&mut self, folders: &[MemoryStore]) {
        for (viewer, folder) in folders.iter().enumerate() {
            for writer in 0..self.versions.len() {
                if writer == viewer {
                    continue;
                }
                if let Some(latest) = self.versions[writer].last() {
                    folder.write(&self.paths[writer], latest).unwrap();
                    self.delivered[viewer][writer] = Some(self.versions[writer].len() - 1);
                }
            }
        }
    }
}

/// The pass a schedule runs: [`sync`], or a wrong one a check on the checks
/// substitutes for it.
type Pass = fn(&Folder, &Key, DeviceId, &mut Document, Timestamp) -> Result<SyncReport, Error>;

fn real_pass(
    folder: &Folder,
    key: &Key,
    device: DeviceId,
    doc: &mut Document,
    now: Timestamp,
) -> Result<SyncReport, Error> {
    sync(folder, key, device, WS, doc, now)
}

/// A random node of `doc` whose kind is in `kinds`.
fn pick(rng: &mut Rng, doc: &Document, kinds: &[NodeKind]) -> Option<NodeId> {
    let ids: Vec<NodeId> = doc
        .nodes
        .iter()
        .filter(|(_, node)| kinds.contains(&node.kind))
        .map(|(id, _)| *id)
        .collect();
    (!ids.is_empty()).then(|| ids[rng.below(ids.len())])
}

const CONTAINERS: &[NodeKind] = &[NodeKind::Workspace, NodeKind::Group];
const ANY: &[NodeKind] = &[NodeKind::Workspace, NodeKind::Group, NodeKind::Tab];

/// One edit a user could make on `device`, through the document's own API.
fn edit(rng: &mut Rng, doc: &mut Document, by: DeviceId, now: Timestamp, fresh: NodeId) {
    let choice = rng.below(9);
    match choice {
        0 | 1 => {
            if let Some(parent) = pick(rng, doc, CONTAINERS) {
                doc.add_tab(parent, "t", "https://t.example", fresh, by, now);
            } else {
                doc.add_workspace("w", None, fresh, by, now);
            }
        }
        2 => {
            if let Some(parent) = pick(rng, doc, &[NodeKind::Workspace]) {
                doc.add_group(parent, "g", None, fresh, by, now);
            }
        }
        3 => {
            if let Some(id) = pick(rng, doc, ANY) {
                doc.rename(id, format!("name-{}", rng.below(3)), by, now);
            }
        }
        4 => {
            if let Some(id) = pick(rng, doc, ANY) {
                let color = ["blue", "purple"][rng.below(2)];
                doc.set_appearance(id, Some(color.into()), None, None, by, now);
            }
        }
        5 => {
            if let Some(id) = pick(rng, doc, &[NodeKind::Tab]) {
                doc.set_isolation(id, rng.one_in(2), by, now);
            }
        }
        6 => {
            if let Some(id) = pick(rng, doc, ANY) {
                doc.touch(id, by, now);
            }
        }
        7 => {
            let (id, parent) = (
                pick(rng, doc, &[NodeKind::Group, NodeKind::Tab]),
                pick(rng, doc, CONTAINERS),
            );
            if let (Some(id), Some(parent)) = (id, parent) {
                // A refused move changes nothing, as for a user.
                let _ = tree::move_node(doc, id, parent, None, None, by, now);
            }
        }
        _ => {
            if let Some(id) = pick(rng, doc, ANY) {
                if rng.one_in(2) {
                    doc.remove(id);
                } else {
                    let _ = tree::remove_keeping_children(doc, id, by, now);
                }
            }
        }
    }
}

/// Runs a schedule of edits and passes across `count` devices from `seed`,
/// then lets every device write and read until none writes, and returns
/// whatever broke a rule, or nothing.
fn run_schedule(seed: u64, count: usize, pass: Pass) -> Vec<String> {
    let mut rng = Rng(seed ^ 0x5EED_5EED_5EED_5EED);
    let mut key_bytes = [0u8; 32];
    for chunk in key_bytes.chunks_mut(8) {
        chunk.copy_from_slice(&rng.next().to_le_bytes());
    }
    let key = Key::from_bytes(&key_bytes).unwrap();
    let devices: Vec<DeviceId> = (0..count).map(peer_device).collect();
    let paths: Vec<String> = devices
        .iter()
        .map(|&d| store::device_path(&key, WS, d))
        .collect();
    let folders: Vec<MemoryStore> = (0..count).map(|_| MemoryStore::new()).collect();
    let mut docs = generate_peers(seed, count);
    let mut cloud = Cloud {
        paths: paths.clone(),
        versions: vec![Vec::new(); count],
        delivered: vec![vec![None; count]; count],
    };
    let mut problems = Vec::new();

    // What the generator left: every group of every node as a write, every
    // pool node a peer lacks as that peer's removal, and the watermark every
    // peer carries for every other as a file read.
    let mut model = Model {
        known: vec![devices.iter().map(|&d| (d, PUBLISHED_AT)).collect(); count],
        ..Model::default()
    };
    for (i, doc) in docs.iter().enumerate() {
        model.edited(&Document::new(), doc, i, 0);
        for id in pool_ids() {
            if doc.node(id).is_none() {
                model.removed(id, i, 1);
            }
        }
    }

    let mut clock: Timestamp = 1_000;
    let mut tick = || {
        clock += 1;
        clock
    };
    let mut fresh_ids = 0u64;
    let mut fresh = || {
        fresh_ids += 1;
        NodeId::from_u64_pair(seed, fresh_ids)
    };
    let mut pass_began: Vec<Option<Timestamp>> = vec![None; count];

    let steps = 14 * count;
    for step in 2..steps + 2 {
        let d = rng.below(count);
        match rng.below(10) {
            0..=3 => {
                let before = docs[d].clone();
                edit(&mut rng, &mut docs[d], devices[d], tick(), fresh());
                model.edited(&before, &docs[d], d, step);
            }
            4 => {
                // The host takes its clock reading as a pass begins and
                // applies the edits that arrive while it reads.
                pass_began[d].get_or_insert_with(&mut tick);
            }
            5 | 6 => {
                let writer = rng.below(count);
                if writer != d
                    && let Some((path, bytes)) = cloud.next_copy(&mut rng, d, writer)
                {
                    folders[d].write(&path, &bytes).unwrap();
                }
            }
            _ => {
                let now = pass_began[d].take().unwrap_or_else(&mut tick);
                let fault = match rng.below(12) {
                    0 => Some(Fault::List),
                    1 => Some(Fault::ReadOwn),
                    2 => Some(Fault::ReadPeer(rng.below(count))),
                    3 => Some(Fault::Write),
                    _ => None,
                };
                let mut arriving = VecDeque::new();
                if rng.one_in(3) {
                    let writer = rng.below(count);
                    if writer != d
                        && let Some(copy) = cloud.next_copy(&mut rng, d, writer)
                    {
                        arriving.push_back(copy);
                    }
                }
                let stored = folders[d].read(&paths[d]).ok();
                let folder = Folder::new(&folders[d], &paths[d], fault);
                *folder.arriving.borrow_mut() = arriving;
                let result = pass(&folder, &key, devices[d], &mut docs[d], now);
                problems.extend(check_pass(step, d, fault, &result, &folder, &stored));
                if result.is_ok() || fault == Some(Fault::Write) {
                    model.read(d, &key, &folder.reads.borrow(), now);
                }
                if result.is_ok()
                    && let Some(problem) = unreachable_node(&docs[d])
                {
                    problems.push(format!("step {step}, device {d}: {problem}"));
                }
                // What the client had not landed by the end lands anyway.
                for (path, bytes) in folder.arriving.into_inner() {
                    folders[d].write(&path, &bytes).unwrap();
                }
                if folder.wrote.get() {
                    cloud.versions[d].push(folders[d].read(&paths[d]).unwrap());
                }
            }
        }
    }

    // Every device goes on being used: each makes a real edit and syncs,
    // with every file reaching every folder at once, until a whole round
    // writes nothing.
    for d in 0..count {
        let before = docs[d].clone();
        docs[d].add_workspace("last", None, fresh(), devices[d], tick());
        model.edited(&before, &docs[d], d, steps + 2);
    }
    let mut settled = false;
    for _ in 0..4 * count {
        let mut wrote = false;
        for d in 0..count {
            cloud.deliver_all(&folders);
            let folder = Folder::new(&folders[d], &paths[d], None);
            if let Err(err) = pass(&folder, &key, devices[d], &mut docs[d], tick()) {
                problems.push(format!("a pass with nothing failing failed: {err}"));
            }
            if folder.wrote.get() {
                wrote = true;
                cloud.versions[d].push(folders[d].read(&paths[d]).unwrap());
            }
        }
        if !wrote {
            settled = true;
            break;
        }
    }
    if !settled {
        problems.push("the devices never stopped writing".into());
    }

    let reference = shared_state(&docs[0]);
    for (d, doc) in docs.iter().enumerate().skip(1) {
        if shared_state(doc) != reference {
            problems.push(format!("device {d} did not converge with device 0"));
        }
    }
    problems.extend(check_outcome(&model, &docs));
    problems
}

/// What one pass under `fault` must have done to the folder and the report.
fn check_pass(
    step: usize,
    device: usize,
    fault: Option<Fault>,
    result: &Result<SyncReport, Error>,
    folder: &Folder,
    stored: &Option<Vec<u8>>,
) -> Vec<String> {
    let mut problems = Vec::new();
    let at = format!("step {step}, device {device}, {fault:?}");
    let untouched = folder.files.read(folder.own).ok() == *stored;
    match fault {
        Some(Fault::List) | Some(Fault::Write) => {
            let failed = fault == Some(Fault::List) || folder.tried.get();
            if failed == result.is_ok() {
                problems.push(format!("{at}: the pass reported {result:?}"));
            }
            if !untouched {
                problems.push(format!("{at}: the own file changed"));
            }
        }
        Some(Fault::ReadOwn) => match result {
            Ok(report) if report.refused_write && report.errors.iter().any(|e| e.own) => {}
            _ => problems.push(format!("{at}: an unreadable own file was not refused")),
        },
        Some(Fault::ReadPeer(_)) | None => match result {
            Err(err) => problems.push(format!("{at}: the pass failed: {err}")),
            Ok(report) => {
                let failed_peer =
                    matches!(fault, Some(Fault::ReadPeer(n)) if n < folder.peer_reads.get());
                if failed_peer && !report.errors.iter().any(|e| !e.own) {
                    problems.push(format!("{at}: a failed peer read went unreported"));
                }
                if report.refused_write {
                    problems.push(format!("{at}: a readable own file was refused"));
                }
            }
        },
    }
    if !untouched && fault == Some(Fault::ReadOwn) {
        problems.push(format!(
            "{at}: an own file it could not read was overwritten"
        ));
    }
    problems
}

/// The model's verdicts on the devices' final documents.
fn check_outcome(model: &Model, docs: &[Document]) -> Vec<String> {
    let mut problems = Vec::new();
    let removed: BTreeSet<NodeId> = model.removals.iter().map(|r| r.node).collect();
    for (&id, _) in model.writes.iter().filter(|(id, _)| !removed.contains(id)) {
        for (d, doc) in docs.iter().enumerate() {
            let Some(node) = doc.node(id) else {
                problems.push(format!("device {d} lost {id}, which nobody removed"));
                continue;
            };
            for group in GROUPS {
                let Some(winner) = model.winner(id, group) else {
                    continue;
                };
                let held = version_of(node, group, 0);
                let same = match group {
                    // Repair moves a node and keeps its placement's stamp
                    // (`tree::repair_unreachable_ancestry`), so only the stamp
                    // is the greatest write's.
                    Group::Placement => held.at == winner.at,
                    _ => (held.at, held.by, &held.value) == (winner.at, winner.by, &winner.value),
                };
                if !same {
                    problems.push(format!(
                        "device {d} holds {id}'s {group:?} at {} by {:?}, \
                         where the greatest write is at {} by {:?}",
                        held.at, held.by, winner.at, winner.by
                    ));
                }
            }
        }
    }
    for removal in model.removals.iter().filter(|r| model.settled(r)) {
        for (d, doc) in docs.iter().enumerate() {
            if doc.node(removal.node).is_some() {
                problems.push(format!(
                    "device {d} holds {}, removed at step {} on a device that had \
                     seen every write to it",
                    removal.node, removal.step
                ));
            }
        }
    }
    problems
}

proptest::proptest! {
    // `n = 3`. A device more roughly doubles a case's cost, so the four-device
    // run below takes a fixed, smaller set of seeds.
    #[test]
    fn any_schedule_of_edits_and_passes_converges_as_the_model_says(seed in proptest::num::u64::ANY) {
        let problems = run_schedule(seed, 3, real_pass);
        proptest::prop_assert!(problems.is_empty(), "seed {}: {:#?}", seed, problems);
    }
}

#[test]
fn any_schedule_of_edits_and_passes_converges_with_four_devices() {
    for seed in 0u64..24 {
        let problems = run_schedule(seed, 4, real_pass);
        assert!(problems.is_empty(), "seed {seed}: {problems:#?}");
    }
}

/// [`sync`], then forgets every watermark but its own: a merge that keeps no
/// version vector, so every node reads as news.
fn forgetful_pass(
    folder: &Folder,
    key: &Key,
    device: DeviceId,
    doc: &mut Document,
    now: Timestamp,
) -> Result<SyncReport, Error> {
    let result = sync(folder, key, device, WS, doc, now);
    doc.seen.retain(|seen, _| *seen == device);
    result
}

/// [`sync`], then puts back the content this device held before the pass: a
/// merge in which the local side always wins the content group.
fn stubborn_pass(
    folder: &Folder,
    key: &Key,
    device: DeviceId,
    doc: &mut Document,
    now: Timestamp,
) -> Result<SyncReport, Error> {
    let before = doc.nodes.clone();
    let result = sync(folder, key, device, WS, doc, now);
    for (id, node) in doc.nodes.iter_mut() {
        if let Some(old) = before.get(id) {
            node.content = old.content.clone();
            node.content_at = old.content_at;
            node.content_by = old.content_by;
        }
    }
    result
}

/// [`sync`], then drops every node the pass brought in: a merge that never
/// adopts a peer's node.
fn insular_pass(
    folder: &Folder,
    key: &Key,
    device: DeviceId,
    doc: &mut Document,
    now: Timestamp,
) -> Result<SyncReport, Error> {
    let before: BTreeSet<NodeId> = doc.nodes.keys().copied().collect();
    let result = sync(folder, key, device, WS, doc, now);
    doc.nodes.retain(|id, _| before.contains(id));
    result
}

/// Whether some seed of a few makes the schedule report a problem that
/// contains `expected` when `pass` stands in for [`sync`].
fn catches(pass: Pass, expected: &str) -> bool {
    (0u64..16).any(|seed| {
        run_schedule(seed, 3, pass)
            .iter()
            .any(|problem| problem.contains(expected))
    })
}

// Checks on the checks: each wrong pass breaks one rule the model judges,
// and the schedule must say so.

#[test]
fn the_schedule_catches_a_merge_that_keeps_no_version_vector() {
    assert!(catches(forgetful_pass, "had seen every write to it"));
}

#[test]
fn the_schedule_catches_a_merge_whose_local_content_always_wins() {
    assert!(catches(stubborn_pass, "Content at"));
}

#[test]
fn the_schedule_catches_a_merge_that_never_adopts_a_node() {
    assert!(catches(insular_pass, "which nobody removed"));
}

/// Two devices whose folders hold each other's latest file, both holding the
/// tab `t` the first created, and the first device's folder and own path.
struct Pair {
    key: Key,
    folders: [MemoryStore; 2],
    paths: [String; 2],
    docs: [Document; 2],
    ws: NodeId,
    tab: NodeId,
}

impl Pair {
    fn new() -> Pair {
        let key = Key::from_bytes(&[3u8; 32]).unwrap();
        let paths = [0, 1].map(|i| store::device_path(&key, WS, peer_device(i)));
        let mut a = Document::new();
        let ws = a.add_workspace("w", None, NodeId::from_u128(1), peer_device(0), 100);
        let tab = a.add_tab(
            ws,
            "t",
            "https://t.example",
            NodeId::from_u128(2),
            peer_device(0),
            100,
        );
        let mut pair = Pair {
            key,
            folders: [MemoryStore::new(), MemoryStore::new()],
            paths,
            docs: [a, Document::new()],
            ws,
            tab,
        };
        pair.pass(0, None, 110).unwrap();
        pair.pass(1, None, 120).unwrap();
        pair.pass(0, None, 130).unwrap();
        pair
    }

    /// One pass on device `d` under `fault`, then the cloud client copies
    /// `d`'s file into the other folder.
    fn pass(
        &mut self,
        d: usize,
        fault: Option<Fault>,
        now: Timestamp,
    ) -> Result<SyncReport, Error> {
        let folder = Folder::new(&self.folders[d], &self.paths[d], fault);
        let result = sync(
            &folder,
            &self.key,
            peer_device(d),
            WS,
            &mut self.docs[d],
            now,
        );
        if let Ok(bytes) = self.folders[d].read(&self.paths[d]) {
            self.folders[1 - d].write(&self.paths[d], &bytes).unwrap();
        }
        result
    }

    fn own_file(&self, d: usize) -> Option<Vec<u8>> {
        self.folders[d].read(&self.paths[d]).ok()
    }
}

#[test]
fn an_own_file_the_disk_cannot_read_is_never_overwritten_and_the_pass_goes_on() {
    let mut pair = Pair::new();
    pair.docs[1].remove(pair.tab);
    pair.pass(1, None, 200).unwrap();
    let stored = pair.own_file(0);
    let (ws, by) = (pair.ws, peer_device(0));
    pair.docs[0].rename(ws, "renamed", by, 210);

    let report = pair.pass(0, Some(Fault::ReadOwn), 220).unwrap();

    assert!(report.refused_write);
    assert!(report.errors.iter().any(|e| e.own));
    assert_eq!(
        pair.own_file(0),
        stored,
        "the file it could not read must stand"
    );
    assert!(
        pair.docs[0].node(pair.tab).is_none(),
        "the peer's file is still read and merged"
    );

    pair.pass(0, None, 230).unwrap();
    pair.pass(1, None, 240).unwrap();
    assert_eq!(pair.docs[1].node(ws).unwrap().content.name, "renamed");
    assert_eq!(shared_state(&pair.docs[0]), shared_state(&pair.docs[1]));
}

#[test]
fn a_peer_file_the_disk_cannot_read_is_reported_and_read_on_the_next_pass() {
    let mut pair = Pair::new();
    pair.docs[1].remove(pair.tab);
    pair.pass(1, None, 200).unwrap();

    let report = pair.pass(0, Some(Fault::ReadPeer(0)), 210).unwrap();

    assert_eq!(report.errors.len(), 1);
    assert!(!report.errors[0].own && report.errors[0].path == pair.paths[1]);
    assert!(
        pair.docs[0].node(pair.tab).is_some(),
        "a deletion in a file that was not read is not applied"
    );
    assert_eq!(pair.docs[0].seen.get(&peer_device(1)), Some(&120));

    pair.pass(0, None, 220).unwrap();
    assert!(pair.docs[0].node(pair.tab).is_none());
    assert_eq!(shared_state(&pair.docs[0]), shared_state(&pair.docs[1]));
}

#[test]
fn a_failed_listing_fails_the_pass_and_writes_nothing() {
    let mut pair = Pair::new();
    let (ws, by) = (pair.ws, peer_device(0));
    pair.docs[0].rename(ws, "renamed", by, 200);
    let stored = pair.own_file(0);

    assert!(pair.pass(0, Some(Fault::List), 210).is_err());
    assert_eq!(pair.own_file(0), stored);

    pair.pass(0, None, 220).unwrap();
    pair.pass(1, None, 230).unwrap();
    assert_eq!(pair.docs[1].node(ws).unwrap().content.name, "renamed");
}

#[test]
fn a_write_that_fails_after_the_stamp_loses_nothing_and_resurrects_nothing() {
    // The pass stamps the document before it writes (`Document::stamp_write`),
    // so a failed write leaves a document claiming a write its file does not
    // hold. The next pass merges the older file, and must neither bring back
    // what was closed since nor lose what was made since.
    let mut pair = Pair::new();
    let (ws, by) = (pair.ws, peer_device(0));
    pair.docs[0].remove(pair.tab);
    let made = pair.docs[0].add_tab(ws, "u", "https://u.example", NodeId::from_u128(3), by, 200);
    let stored = pair.own_file(0);

    assert!(pair.pass(0, Some(Fault::Write), 210).is_err());
    assert_eq!(
        pair.own_file(0),
        stored,
        "a failed write leaves the file as it was"
    );
    assert_eq!(pair.docs[0].written_at, 210);

    pair.pass(0, None, 220).unwrap();
    assert!(
        pair.docs[0].node(pair.tab).is_none(),
        "the older own file must not resurrect it"
    );
    assert!(pair.docs[0].node(made).is_some());
    pair.pass(1, None, 230).unwrap();
    assert!(pair.docs[1].node(pair.tab).is_none());
    assert!(pair.docs[1].node(made).is_some());
    assert_eq!(shared_state(&pair.docs[0]), shared_state(&pair.docs[1]));
}
