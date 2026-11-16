// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The sync loop: read our own stored file and every peer's, merge each in,
//! repair, write our own back only if it changed.
//!
//! This is the one place the crate's pieces come together for a caller (the
//! WASM boundary, a native test): [`crypto`] seals and opens files,
//! [`store`] names and lists them, [`crate::merge::merge`] reconciles them,
//! [`tree::repair_unreachable_ancestry`] fixes up anything a peer's close
//! left unreachable, and this module sequences all of that into one call.

use crate::crypto::{self, Key};
use crate::store::{self, DeviceId, StorageProvider};
use crate::tree;
use crate::types::{Document, Error, Node, NodeId, Timestamp};

/// What one call to [`sync_to`] did.
///
/// Every peer file is accounted for in exactly one of `merged`, `errors` or
/// `schema_too_new`. A single bad file never aborts the run: the user could
/// not sync at all until they found and removed the device that wrote it.
/// `repaired` lists the ids [`tree::repair_unreachable_ancestry`] touched,
/// so a caller can show that a repair happened.
#[derive(Debug, Default, Clone)]
pub struct SyncReport {
    /// Peer files (this device's own stored file included) that decrypted,
    /// parsed, and were merged in.
    pub merged: usize,
    /// Files that failed to decrypt or failed to parse: the file itself is
    /// damaged.
    pub errors: Vec<FileProblem>,
    /// Files skipped because their major schema version, or the version of
    /// the format they are sealed in, is newer than this build supports.
    /// Kept apart from `errors` so a caller can word "this file is corrupt"
    /// and "this peer is ahead of you, update your app" differently.
    pub schema_too_new: Vec<FileProblem>,
    /// Whether this device's own file exists but could not be read, so
    /// [`sync_to`] did not overwrite it. A device in this state publishes
    /// nothing until the file is readable again.
    pub refused_write: bool,
    /// Ids [`tree::repair_unreachable_ancestry`] reparented while bringing
    /// the merged document back to a state where every node is reachable
    /// from a workspace.
    pub repaired: Vec<NodeId>,
    /// Nodes this pass added or changed, of any kind: present after it and
    /// absent or different before it. A host writes them into its own store
    /// (store-mirror spec §3). The document a pass starts from already holds
    /// the host's own mutations, so only what the merge and repair brought
    /// is here.
    pub changed: Vec<NodeId>,
    /// Nodes the document held before this pass and no longer does, because
    /// another device deleted them, so a host removes them from its store
    /// too.
    pub removed: Vec<NodeId>,
    /// Devices whose clock set ahead cost this device something in this
    /// pass, so a host can tell the user (decision 1714). A device counts
    /// when its file was written more than [`CLOCK_AHEAD_MARGIN`] after
    /// `now`, and merging that file either replaced a value this device held
    /// with one of its facts stamped after `now`, or brought back a node this
    /// device's own file holds and its document had closed, carrying a stamp
    /// after `now`. A file that is ahead and changes nothing is merged and
    /// not listed. Everything in such a file is merged, and its `written_at`
    /// is no watermark (decision 0135).
    pub harmed_by_clock: Vec<DeviceId>,
    /// This device's own watermark once the pass is done, `seen[device]`:
    /// the latest time it has written under, or published, which a host
    /// keeps its next stamps above (decision 1714). `0` when it has none.
    pub own_watermark: Timestamp,
}

/// How far past `now` a peer's `written_at` may be before [`sync_to`] takes
/// its device's clock for one set ahead ([`SyncReport::harmed_by_clock`]):
/// ten minutes, far wider than the few seconds between two devices stamping
/// with corrected time (decision 1714).
pub const CLOCK_AHEAD_MARGIN: Timestamp = 10 * 60 * 1000;

/// One file [`sync_to`] could not use, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileProblem {
    /// The file's path in the store.
    pub path: String,
    /// Whether it is this device's own file.
    pub own: bool,
    /// What went wrong, worded for a person.
    pub reason: String,
}

/// A file being read in one [`sync_to`] pass.
#[derive(Clone, Copy)]
struct Source<'a> {
    path: &'a str,
    own: bool,
    /// The device the path names. The path is authenticated as associated
    /// data (spec §6.5), so this is who the file speaks for.
    device: DeviceId,
}

impl Source<'_> {
    fn problem(self, reason: impl std::fmt::Display) -> FileProblem {
        FileProblem {
            path: self.path.to_string(),
            own: self.own,
            reason: reason.to_string(),
        }
    }
}

/// Parses `json`, read from `source`. A failure is recorded in `report` and
/// not propagated: a `SchemaTooNew` in `report.schema_too_new`, anything
/// else in `report.errors`.
fn read_document(json: &str, source: Source, report: &mut SyncReport) -> Option<Document> {
    match Document::from_json(json) {
        Ok(remote) => Some(remote),
        Err(err @ Error::SchemaTooNew { .. }) => {
            report.schema_too_new.push(source.problem(err));
            None
        }
        Err(err) => {
            report.errors.push(source.problem(err));
            None
        }
    }
}

/// Whether `remote`'s `written_by` is the device its path names, recording
/// the file in `report.errors` when it is not.
///
/// A file naming another writer is damaged: merged, it would record its
/// `written_at` as that device's watermark, and under our own name it would
/// be spared the drop half of the merge as our own past self (spec §5.4). A
/// document with no writer predates attribution and is read as it is
/// (decision 0019).
fn written_by_its_path(remote: &Document, source: Source, report: &mut SyncReport) -> bool {
    match remote.written_by {
        Some(writer) if writer != source.device => {
            report.errors.push(source.problem(format_args!(
                "says device {writer} wrote it, but it is device {}'s file",
                source.device
            )));
            false
        }
        _ => true,
    }
}

fn merge_in(
    doc: &mut Document,
    remote: &Document,
    report: &mut SyncReport,
    known: &mut tree::KnownPlaces,
    unheld: Option<(DeviceId, Timestamp)>,
) {
    known.note(remote);
    crate::merge::merge_unheld(doc, remote, unheld);
    report.merged += 1;
}

/// What `doc` never held of `device`'s writes, when `remote` holds some of
/// it: `doc` began under `device` at `began_at`, has taken the id's earlier
/// writes up to `earlier_to` from files, and `remote`'s watermark for
/// `device` falls between the two. Its own watermark covers those writes, so
/// merging `remote` treats the id's stamps before `began_at` as news, and
/// `doc` then holds them up to `remote`'s watermark (decision 2232). Every
/// file `device` wrote carries a watermark for it, its own included.
fn take_unheld(
    doc: &mut Document,
    remote: &Document,
    device: DeviceId,
) -> Option<(DeviceId, Timestamp)> {
    let at = *remote.seen.get(&device)?;
    if at <= doc.earlier_to || at >= doc.began_at {
        return None;
    }
    doc.earlier_to = at;
    Some((device, doc.began_at))
}

/// Drops every watermark in a peer's `seen` that is later than `newest`'s
/// entry for its device, and every watermark for a device `newest` does not
/// name. `newest` holds the newest write of each device this pass can vouch
/// for: what `doc` had already incorporated, and every device file read in
/// this pass.
///
/// A watermark claims its device wrote a file at that time (spec §5.4), and
/// the device's own file is in the same folder, so no truthful claim is
/// later than both. Taken on, a claim beyond every write would make each
/// node that device writes later not news to the claimant, the max-merge
/// would carry it to every device, and the device would delete its own new
/// nodes on reading any of them (spec §5.4, the drop half). Lowering it to
/// the newest write would not do: it would come true again with the
/// device's next write. A truthful claim that is ahead only because the
/// device's newer file has not reached this folder yet is dropped too, which
/// makes more nodes news and so keeps them: the same direction as a
/// watermark published late (decision 0018), and lifted on the pass that
/// sees the newer file.
///
/// A watermark more than [`WATERMARK_MARGIN`] later than `now`, this
/// device's corrected time, is dropped as well (decision 0135). It is a fast
/// clock's reading, and taken on it would make every node its device writes
/// once the clock is put right not news, until real time passed it. Dropping
/// it is the keep direction again: what the fast device closes lingers here
/// until then, and nothing is lost. One within the margin is taken: two
/// corrected clocks differ by a second or two, and dropping a truthful
/// watermark would leave a peer's close unhonoured.
fn bound_watermarks(
    seen: &mut std::collections::BTreeMap<DeviceId, Timestamp>,
    newest: &std::collections::BTreeMap<DeviceId, Timestamp>,
    now: Timestamp,
) {
    let latest = now.saturating_add(WATERMARK_MARGIN);
    seen.retain(|device, at| {
        *at <= latest && newest.get(device).is_some_and(|newest| *at <= *newest)
    });
}

/// How far past `now` a watermark may be and still be taken (decision 0135):
/// one minute. Two devices on corrected time differ by the `Date` header's
/// one-second precision and the request's latency (decision 1714), so a
/// truthful watermark is seconds ahead at most. A fast clock less than this
/// ahead costs at most this long of the harm decision 0135 guards against.
pub const WATERMARK_MARGIN: Timestamp = 60 * 1000;

/// Leaves a peer's own write out of the version vector when it is more than
/// [`WATERMARK_MARGIN`] later than `now`, by reading the file as one with no
/// writer, which [`crate::merge`] records no watermark for. Its `written_at`
/// is the watermark every reader would hold for its device, so it is bounded
/// like the ones in `seen` ([`bound_watermarks`]).
fn forget_a_write_after(remote: &mut Document, now: Timestamp) {
    if remote.written_at > now.saturating_add(WATERMARK_MARGIN) {
        remote.written_by = None;
    }
}

/// Whether merging `remote`, a file from a device whose clock is set ahead,
/// cost this device something ([`SyncReport::harmed_by_clock`]): a fact of
/// `remote`'s stamped after `now` replaced a different value `before` held,
/// or a node in `own_ids`, this device's own file, that `before` lacked came
/// back from `remote` with a stamp after `now`. Read off the documents on
/// either side of the merge, never inside it (rule 8).
fn clock_cost(
    before: &std::collections::BTreeMap<NodeId, Node>,
    after: &Document,
    remote: &Document,
    own_ids: &std::collections::BTreeSet<NodeId>,
    now: Timestamp,
) -> bool {
    remote.nodes.iter().any(|(id, theirs)| {
        let Some(now_held) = after.nodes.get(id) else {
            return false;
        };
        let Some(held) = before.get(id) else {
            return own_ids.contains(id) && theirs.attributions().iter().any(|&(_, at)| at > now);
        };
        let took = |was: bool, is: bool, at: Timestamp, theirs_at: Timestamp| {
            was && is && at == theirs_at && at > now
        };
        took(
            held.content != now_held.content,
            now_held.content == theirs.content,
            now_held.content_at,
            theirs.content_at,
        ) || took(
            held.placement != now_held.placement,
            now_held.placement == theirs.placement,
            now_held.placement_at,
            theirs.placement_at,
        ) || took(
            held.lifecycle != now_held.lifecycle,
            now_held.lifecycle == theirs.lifecycle,
            now_held.lifecycle_at,
            theirs.lifecycle_at,
        ) || took(
            held.appearance != now_held.appearance,
            now_held.appearance == theirs.appearance,
            now_held.appearance_at,
            theirs.appearance_at,
        )
    })
}

/// Decrypts `sealed`, read from `source`, and reads it as UTF-8 JSON. A
/// failure of either is recorded in `report` and skips this one file, like a
/// failure to parse. A file sealed in a newer format goes in
/// `report.schema_too_new`, like a newer document schema.
fn open_and_decode(
    sealed: &[u8],
    key: &Key,
    source: Source,
    report: &mut SyncReport,
) -> Option<String> {
    let plaintext = match crypto::open(key, source.path.as_bytes(), sealed) {
        Ok(bytes) => bytes,
        Err(err @ Error::SchemaTooNew { .. }) => {
            report.schema_too_new.push(source.problem(err));
            return None;
        }
        Err(err) => {
            report.errors.push(source.problem(err));
            return None;
        }
    };
    match String::from_utf8(plaintext) {
        Ok(json) => Some(json),
        Err(_) => {
            report.errors.push(source.problem(Error::NotUtf8));
            None
        }
    }
}

/// [`sync_to`] on this device's profile copy of an ordinary document.
#[cfg(test)]
pub(crate) fn sync<S: StorageProvider>(
    store: &S,
    key: &Key,
    device: DeviceId,
    workspace: &str,
    doc: &mut Document,
    now: Timestamp,
) -> Result<SyncReport, Error> {
    sync_expiring(store, key, device, workspace, doc, now, None)
}

/// [`sync_to`] on this device's profile copy, expiring Archive entries older
/// than `retention`.
#[cfg(test)]
pub(crate) fn sync_expiring<S: StorageProvider>(
    store: &S,
    key: &Key,
    device: DeviceId,
    workspace: &str,
    doc: &mut Document,
    now: Timestamp,
    retention: Option<Timestamp>,
) -> Result<SyncReport, Error> {
    sync_to(
        store,
        key,
        device,
        workspace,
        doc,
        now,
        retention,
        Target::Profile,
        None,
    )
}

/// Which copy a pass reads and writes, which decides what happens to the
/// nodes marked [`crate::types::Content::local`] (decision 1372).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// This device's own copy in its profile, which holds every node, local
    /// ones included, as it holds any other.
    Profile,
    /// The folder devices exchange files through, which holds no local node.
    /// The pass sets this device's local nodes aside, merges every file
    /// without them, and puts them back before repair, so a file that lacks
    /// one can never delete it, and one that holds a node of the same id
    /// never replaces it. It writes the document without them.
    Shared,
}

/// Drops the [`crate::types::Content::local`] mark from every node of a file
/// read from `source`. Only this device's own file in its profile can say
/// that an address stays on this device; a mark in any other file was put
/// there by another device, and its node is read as synced.
fn drop_foreign_marks(remote: &mut Document, source: Source, target: Target) {
    if source.own && target == Target::Profile {
        return;
    }
    for node in remote.nodes.values_mut() {
        node.content.local = false;
    }
}

/// Takes every local node out of `doc`, for a [`Target::Shared`] pass.
fn set_aside_local(doc: &mut Document) -> std::collections::BTreeMap<NodeId, Node> {
    let (local, shared) = std::mem::take(&mut doc.nodes)
        .into_iter()
        .partition(|(_, node)| node.content.local);
    doc.nodes = shared;
    local
}

/// Reads this device's own stored file (if any) and every other device's
/// file for `workspace`, merges each into `doc`, repairs reachability, and
/// writes `doc` back under `device`'s own file unless nothing changed.
///
/// **Reads its own file first, before any peer.** A device restored from an
/// older backup keeps its persisted device id beside a rolled-back local
/// document. Merging our own stored file in first folds back whatever we
/// last wrote, so the write that follows cannot discard what this device
/// wrote offline that no peer saw. A missing own file (first run on this
/// device) is not an error. A corrupt or unreadable own file is skipped and
/// reported like a corrupt peer, marked `own`, so the sync spec §6.2
/// promises still runs.
///
/// Peer files follow in whatever order [`store::peer_files`] returns them;
/// `merge` is commutative and idempotent per fact group, so the order does
/// not affect the result. Repair runs once, after every file has been
/// merged, and never inside `merge`: [`tree::repair_unreachable_ancestry`]
/// says why.
///
/// Every peer file is read before any is merged, so that each one's `seen`
/// can be checked against every device file in the folder, and a file is
/// bound to the device its path names (decision 0134). Both describe what a
/// file may claim, so neither depends on the order files are read in.
///
/// The write is skipped when the merged, repaired document's **shared
/// state** ([`Document::shared_state_json`]) equals what this device's own
/// file already held. It is compared as parsed JSON, because
/// [`crypto::seal`]'s fresh nonce makes the ciphertext differ on every call.
/// Otherwise idle devices would reseal and rewrite their file on every poll,
/// and that traffic would turn the write-timestamp metadata leak spec §6.5
/// accepts from "the user edited something" into "sval is running".
///
/// The bookkeeping (`written_at`, `written_by`, `seen`) stays out of that
/// comparison. Merging a peer raises `seen`, so two devices polling each
/// other would each see a change on every poll and never go quiet. A
/// watermark advance rides along with the next write that has a real reason
/// to happen. That is safe because an unpublished watermark only makes a
/// peer treat more nodes as news and keep them (spec §5.4, decision 0018).
///
/// The write is also skipped, whatever the comparison says, when this
/// device's own stored file declares a newer major schema than this build
/// supports. Writing would replace that file with this build's older view of
/// the document and discard whatever the newer build added.
///
/// `now` is this write's timestamp, supplied by the caller like every other
/// timestamp in this crate (see [`crate::types::Timestamp`]).
/// [`Document::stamp_write`] stamps it (`written_at`, `written_by` and
/// `seen[device]`) only when a write happens, after the comparison. Stamped
/// earlier, every document would differ from its stored file on every poll.
///
/// Recording our own write in `seen` is what makes the own-file read safe:
/// without it, merging our own stored file would re-insert everything we
/// have deleted since writing it (see [`crate::merge::merge`]).
///
/// `retention`, when given, drops every Archive entry closed at least that
/// long before `now` once the merge is done and before the write decision
/// ([`crate::archive::expire`], idle-tab archive spec §3.3). A host passes
/// the retention period for the Archive's document and `None` for every
/// other. `target` says which copy the pass reads and writes.
///
/// `clamp_from`, the time a device's first time reading arrived, pulls back
/// the stamps it took before then from a clock that may run ahead, which it
/// has never published (decision 1714; [`Document::pull_back_own_stamps`]).
/// Its own stored file's stamps later than `clamp_from` go back to
/// `clamp_from` before that file is merged, so a change made since the
/// reading, stamped later, still wins over what the file held. Once every
/// file is merged, the document's stamps later than `now` go back to `now`.
/// A host passes it on one pass of each document. It runs here on the read
/// path, never inside `merge` (rule 8).
#[expect(clippy::too_many_arguments)]
pub fn sync_to<S: StorageProvider>(
    store: &S,
    key: &Key,
    device: DeviceId,
    workspace: &str,
    doc: &mut Document,
    now: Timestamp,
    retention: Option<Timestamp>,
    target: Target,
    clamp_from: Option<Timestamp>,
) -> Result<SyncReport, Error> {
    let mut report = SyncReport::default();
    let before = doc.nodes.clone();
    let mut known = tree::KnownPlaces::default();
    known.note(doc);
    let local = match target {
        Target::Profile => std::collections::BTreeMap::new(),
        Target::Shared => set_aside_local(doc),
    };

    let own_path = store::device_path(key, workspace, device);
    let own = Source {
        path: &own_path,
        own: true,
        device,
    };
    let mut own_snapshot: Option<String> = None;
    // Set when this device's own file exists but what it holds could not be
    // established: a wrong-key decryption failure (most likely a restored
    // profile or rotated key material), a non-UTF-8 payload, a newer schema
    // than this build supports, or an authenticated document this build
    // cannot parse. Such a file is never overwritten: it may be the only copy
    // of what it contains. A read and merge whose `shared_state_json` then
    // fails does not set it. That file's data is already in `doc`, so
    // writing loses nothing; the pass only loses the unchanged-state check.
    let mut refuse_write = false;
    let mut own_ids = std::collections::BTreeSet::new();
    match store.read(&own_path) {
        Ok(sealed) => match open_and_decode(&sealed, key, own, &mut report) {
            Some(json) => match read_document(&json, own, &mut report) {
                // Nothing of ours is in a file naming another writer, so
                // it is passed over and our write replaces it.
                Some(stored) if !written_by_its_path(&stored, own, &mut report) => {}
                Some(mut stored) => {
                    drop_foreign_marks(&mut stored, own, target);
                    // Taken before any clamp, so a clamp that changes the
                    // file's stamps rewrites it.
                    match stored.shared_state_json() {
                        Ok(snapshot) => own_snapshot = Some(snapshot),
                        Err(err) => report.errors.push(own.problem(err)),
                    }
                    if let Some(at) = clamp_from {
                        stored.pull_back_own_stamps(device, at);
                    }
                    own_ids.extend(stored.nodes.keys().copied());
                    if doc.began_at == 0 {
                        doc.began_at = stored.began_at;
                        doc.earlier_to = stored.earlier_to;
                    }
                    let unheld = take_unheld(doc, &stored, device);
                    merge_in(doc, &stored, &mut report, &mut known, unheld);
                }
                None => refuse_write = true,
            },
            None => refuse_write = true,
        },
        // A copy that has never written under this id begins here, holding
        // none of the id's earlier writes (decision 2232).
        Err(Error::NotFound(_)) if doc.began_at == 0 && !doc.seen.contains_key(&device) => {
            doc.began_at = now.max(1);
        }
        Err(Error::NotFound(_)) => {}
        Err(err) => {
            report.errors.push(own.problem(err));
            refuse_write = true;
        }
    }
    report.refused_write = refuse_write;

    let mut peers = Vec::new();
    for (path, writer) in store::peer_files(store, key, device, workspace)? {
        let peer = Source {
            path: &path,
            own: false,
            device: writer,
        };
        let sealed = match store.read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                report.errors.push(peer.problem(err));
                continue;
            }
        };
        let Some(json) = open_and_decode(&sealed, key, peer, &mut report) else {
            continue;
        };
        if let Some(mut remote) = read_document(&json, peer, &mut report)
            && written_by_its_path(&remote, peer, &mut report)
        {
            drop_foreign_marks(&mut remote, peer, target);
            peers.push(remote);
        }
    }
    let mut ahead = Vec::with_capacity(peers.len());
    for remote in &mut peers {
        ahead.push(
            remote
                .written_by
                .filter(|_| remote.written_at > now.saturating_add(CLOCK_AHEAD_MARGIN)),
        );
        forget_a_write_after(remote, now);
    }
    let mut newest = doc.seen.clone();
    for remote in &peers {
        if let Some(writer) = remote.written_by {
            let entry = newest.entry(writer).or_insert(remote.written_at);
            *entry = (*entry).max(remote.written_at);
        }
    }
    for (mut remote, ahead) in peers.into_iter().zip(ahead) {
        bound_watermarks(&mut remote.seen, &newest, now);
        let before = ahead.map(|_| doc.nodes.clone());
        let unheld = take_unheld(doc, &remote, device);
        merge_in(doc, &remote, &mut report, &mut known, unheld);
        if let (Some(writer), Some(before)) = (ahead, before)
            && clock_cost(&before, doc, &remote, &own_ids, now)
            && !report.harmed_by_clock.contains(&writer)
        {
            report.harmed_by_clock.push(writer);
        }
    }
    doc.nodes.extend(local);
    if clamp_from.is_some() {
        doc.pull_back_own_stamps(device, now);
    }

    if let Some(retention) = retention {
        crate::archive::expire(doc, retention, now);
    }
    report.repaired = tree::repair_unreachable_ancestry_knowing(doc, &known);
    report.changed = doc
        .nodes
        .iter()
        .filter(|(id, node)| before.get(id) != Some(node))
        .map(|(id, _)| *id)
        .collect();
    report.removed = before
        .keys()
        .filter(|id| !doc.nodes.contains_key(id))
        .copied()
        .collect();

    let published = |doc: &Document| {
        let mut view = doc.clone();
        if target == Target::Shared {
            view.nodes.retain(|_, node| !node.content.local);
            // When this copy began is a fact about this copy (decision 2232).
            view.began_at = 0;
            view.earlier_to = 0;
        }
        view
    };
    let unchanged = match &own_snapshot {
        Some(snapshot) => {
            published(doc).shared_state_json().ok().as_deref() == Some(snapshot.as_str())
        }
        None => false,
    };
    if !unchanged && !refuse_write {
        // Stamped over every node, local ones included: a node that went
        // local was last written here, and a watermark that covers that write
        // is what lets each peer read its absence as a delete (spec §5.4).
        doc.stamp_write(device, now);
        store::save_document(store, key, device, workspace, &published(doc))?;
    }
    report.own_watermark = doc.seen.get(&device).copied().unwrap_or(0);

    Ok(report)
}

/// Serialises `doc` to plaintext JSON for export: the user's way to get
/// their data back out, independent of the encrypted sync path.
///
/// Returns the serialisation error. An empty `"{}"` on failure would hand
/// the user a worthless backup without telling them the export failed.
///
/// Indented, because a person reads it.
pub fn export_json(doc: &Document) -> Result<String, Error> {
    Ok(serde_json::to_string_pretty(doc)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::seal;

    /// Seals `plaintext` for `path` and writes it there, the way
    /// [`store::save_document`] would.
    fn seal_at(store: &MemoryStore, key: &Key, path: &str, plaintext: &[u8]) {
        store
            .write(path, &seal(key, path.as_bytes(), plaintext).unwrap())
            .unwrap();
    }

    /// Reads and opens the file at `path`.
    fn open_at(store: &MemoryStore, key: &Key, path: &str) -> Vec<u8> {
        crate::crypto::open(key, path.as_bytes(), &store.read(path).unwrap()).unwrap()
    }
    use crate::store::MemoryStore;
    use crate::tree;
    use crate::types::test_support::{base_doc, shared_state, test_device, ws_of};
    use uuid::Uuid;

    fn assert_every_node_is_reachable(doc: &Document) {
        if let Some(problem) = crate::types::test_support::unreachable_node(doc) {
            panic!("{problem}");
        }
    }

    /// Two devices sharing one store, both holding a tab T that both have
    /// published and both have read the other's file for: the mutual
    /// knowledge that makes a later absence mean something (spec §5.4).
    ///
    /// Returns the store, the key, both device ids, both documents, and T's
    /// id. The timeline is: T created at 100, A publishes at 110, B picks it
    /// up and publishes at 120, A reads B's file at 130.
    #[allow(clippy::type_complexity)]
    fn two_devices_in_sync() -> (
        MemoryStore,
        Key,
        (DeviceId, DeviceId),
        (Document, Document),
        NodeId,
    ) {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());

        let mut a = base_doc();
        let tab = a.add_tab(
            ws_of(&a),
            "T",
            "https://t.example",
            Uuid::from_u128(1_000),
            dev_a,
            100,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 110).unwrap();

        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 120).unwrap();
        assert!(b.node(tab).is_some(), "B must have picked T up");

        sync(&store, &key, dev_a, "ws-1", &mut a, 130).unwrap();

        (store, key, (dev_a, dev_b), (a, b), tab)
    }

    /// A pass reports what the merge brought: a peer's rename as changed, a
    /// peer's close as removed, and nothing for this device's own edit,
    /// which the host made and already knows (store-mirror spec §3).
    #[test]
    fn a_pass_reports_what_it_brought_and_not_what_this_device_did() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();
        let other = b.add_tab(
            ws_of(&b),
            "U",
            "https://u.example",
            Uuid::from_u128(2_000),
            dev_b,
            140,
        );
        sync(&store, &key, dev_b, "ws-1", &mut b, 150).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 160).unwrap();

        a.set_content(
            tab,
            "Renamed",
            Some("https://t.example".into()),
            None,
            None,
            false,
            dev_a,
            200,
        );
        let mine = sync(&store, &key, dev_a, "ws-1", &mut a, 210).unwrap();
        assert!(mine.changed.is_empty(), "{:?}", mine.changed);
        assert!(mine.removed.is_empty(), "{:?}", mine.removed);

        b.remove(other);
        let theirs = sync(&store, &key, dev_b, "ws-1", &mut b, 220).unwrap();
        assert_eq!(theirs.changed, [tab], "A's rename arrives at B");
        assert!(theirs.removed.is_empty(), "B's own close is not news to B");

        let back = sync(&store, &key, dev_a, "ws-1", &mut a, 230).unwrap();
        assert!(back.changed.is_empty(), "{:?}", back.changed);
        assert_eq!(back.removed, [other], "B's close arrives at A");
    }

    // --- the scenarios of spec §5.4 -----------------------------------

    #[test]
    fn scenario_1_an_ordinary_close_removes_the_tab_everywhere() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        a.remove(tab);
        sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 210).unwrap();

        assert!(a.node(tab).is_none(), "A must still have it deleted");
        assert!(
            b.node(tab).is_none(),
            "the deletion must propagate to B, whose file was current"
        );
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn scenario_2_an_abandoned_peers_stale_file_never_resurrects_the_tab() {
        // A peer file that predates the close never re-inserts the tab. A
        // does not need to have read B's file first either: see
        // `a_deletion_stands_even_against_a_peer_file_we_have_never_read`.
        let (store, key, (dev_a, _), (mut a, _b), tab) = two_devices_in_sync();

        a.remove(tab);
        sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        // B is gone for good; its file still holds T. Every later sync must
        // leave T deleted.
        for (round, now) in [300, 400, 500].into_iter().enumerate() {
            sync(&store, &key, dev_a, "ws-1", &mut a, now).unwrap();
            assert!(
                a.node(tab).is_none(),
                "the abandoned peer's stale file resurrected the tab on round {round}"
            );
        }
    }

    #[test]
    fn a_deletion_stands_even_against_a_peer_file_we_have_never_read() {
        // A watermark is checked against the writer of each group. T was
        // written by A, and A's watermark for itself covers its own writes,
        // so A's deletion stands without A having read B's file. The same
        // holds for any other holder, since a device can only have the node
        // by having incorporated a file from its writer. What brings a node
        // back is a group a peer wrote that we have not seen (scenario 6).
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());

        let mut a = base_doc();
        let tab = a.add_tab(
            ws_of(&a),
            "T",
            "https://t.example",
            Uuid::from_u128(1_020),
            dev_a,
            100,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 110).unwrap();

        // B picks T up and publishes. A never reads that file before deleting.
        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 120).unwrap();
        assert!(b.node(tab).is_some());

        a.remove(tab);
        for now in [200, 300, 400] {
            sync(&store, &key, dev_a, "ws-1", &mut a, now).unwrap();
            assert!(
                a.node(tab).is_none(),
                "a peer file A had never read resurrected the deletion at {now}"
            );
        }

        sync(&store, &key, dev_b, "ws-1", &mut b, 500).unwrap();
        assert!(b.node(tab).is_none(), "the deletion must still reach B");
    }

    #[test]
    fn scenario_3_a_concurrent_add_and_delete_keep_the_add_and_lose_the_tab() {
        // Both nodes arrive in the *same* peer file and take opposite
        // branches: U is adopted because it is newer than what A had
        // incorporated from B, T is not because it is older. A single verdict
        // for the whole file would either resurrect T or lose U, so the rule
        // is per node.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        let u = b.add_tab(
            ws_of(&b),
            "U",
            "https://u.example",
            Uuid::from_u128(1_001),
            dev_b,
            150,
        );
        sync(&store, &key, dev_b, "ws-1", &mut b, 150).unwrap();

        a.remove(tab);
        sync(&store, &key, dev_a, "ws-1", &mut a, 160).unwrap();

        assert!(a.node(u).is_some(), "U is news and must be adopted");
        assert!(
            a.node(tab).is_none(),
            "T is not news and must not come back — from the very same file"
        );

        sync(&store, &key, dev_b, "ws-1", &mut b, 170).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 180).unwrap();

        for (label, doc) in [("A", &a), ("B", &b)] {
            assert!(doc.node(u).is_some(), "{label} must have U");
            assert!(doc.node(tab).is_none(), "{label} must not have T");
        }
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn scenario_4_a_returning_device_learns_the_news_and_its_stale_file_deletes_nothing() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), _tab) = two_devices_in_sync();

        // B goes quiet. A adds V and publishes.
        let v = a.add_tab(
            ws_of(&a),
            "V",
            "https://v.example",
            Uuid::from_u128(1_002),
            dev_a,
            200,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 205).unwrap();

        // A keeps syncing while B's file is stale: B's file lacks V, and
        // must not be read as B having deleted it.
        sync(&store, &key, dev_a, "ws-1", &mut a, 210).unwrap();
        assert!(
            a.node(v).is_some(),
            "a stale peer file deleted a node that peer has never seen"
        );

        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        assert!(b.node(v).is_some(), "B must learn about V on its return");

        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();
        assert!(a.node(v).is_some(), "V must survive B's return");
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn scenario_5_an_offline_creation_survives_and_propagates() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), _tab) = two_devices_in_sync();

        // A carries on; B is offline and creates W of its own.
        sync(&store, &key, dev_a, "ws-1", &mut a, 180).unwrap();
        let w = b.add_tab(
            ws_of(&b),
            "W",
            "https://w.example",
            Uuid::from_u128(1_003),
            dev_b,
            190,
        );

        // B returns: A's file has no W, and that must not be mistaken for a
        // deletion of B's own unsynced work.
        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        assert!(b.node(w).is_some(), "B's own offline creation was deleted");

        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();
        assert!(a.node(w).is_some(), "W must propagate to A");
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    /// Decision 0135 drops a watermark more than [`WATERMARK_MARGIN`] past
    /// the reader's clock, and a file written exactly that far ahead is
    /// within it: it is incorporated.
    #[test]
    fn a_peer_file_written_at_the_edge_of_the_margin_is_incorporated() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), _tab) = two_devices_in_sync();
        let edge = 200 + WATERMARK_MARGIN;
        b.rename(ws_of(&b), "renamed", dev_b, edge);
        sync(&store, &key, dev_b, "ws-1", &mut b, edge).unwrap();

        sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        assert_eq!(a.seen.get(&dev_b), Some(&edge));
    }

    #[test]
    fn scenario_6_a_returning_device_with_an_unsynced_edit_brings_the_tab_back() {
        // The one accepted resurrection (spec §5.4). B holds unsynced work
        // on the node A deleted. Losing it silently would be worse than the
        // tab reappearing, and no rule can tell this case from scenario 5's
        // offline creation without a per-node record of who saw what.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        // B, offline since its last sync, renames T at 150 and never syncs.
        // The rename is B's write, so the content group records B, and A's
        // watermark for B predates it: that makes the node news to A.
        b.rename(tab, "renamed on B", dev_b, 150);

        // A deletes T and publishes.
        a.remove(tab);
        sync(&store, &key, dev_a, "ws-1", &mut a, 205).unwrap();

        // B returns at 300: its rename is newer than anything it has
        // incorporated from A, so the node stays and is republished.
        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        assert!(
            b.node(tab).is_some(),
            "B's unsynced edit must not be silently discarded"
        );

        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();
        let back = a
            .node(tab)
            .expect("the node must come back, carrying B's edit");
        assert_eq!(back.content.name, "renamed on B");
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn a_rename_survives_a_close_and_undo_on_another_device() {
        // Rename on one device, close and undo on another: the rename
        // survives. Closing deletes the record (spec §5.4), so undo is a
        // fresh add under the same id, and that add writes B's groups. The
        // rename survives because `content` is judged on its own: A's write
        // is the later one for that group. One timestamp per record would
        // hand the whole node to B's restore and lose the rename.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        // B, offline since 120: close T, then undo.
        b.remove(tab);
        b.add_tab(ws_of(&b), "T", "https://t.example", tab, dev_b, 145);

        // A renames T, later than B's restore, and publishes.
        a.rename(tab, "Quarterly review", dev_a, 150);
        sync(&store, &key, dev_a, "ws-1", &mut a, 160).unwrap();

        // B returns; A reads the result back.
        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();

        for (label, doc) in [("A", &a), ("B", &b)] {
            let node = doc
                .node(tab)
                .unwrap_or_else(|| panic!("{label}: the restored tab must exist"));
            assert_eq!(
                node.content.name, "Quarterly review",
                "{label}: the rename must survive the close and the undo"
            );
            assert_eq!(node.content_at, 150, "{label}");
            assert_eq!(node.content_by, Some(dev_a), "{label}");
            assert_eq!(
                node.placement_at, 145,
                "{label}: B's restore is what wrote placement"
            );
            assert_eq!(node.placement_by, Some(dev_b), "{label}");
            assert_eq!(
                node.lifecycle_at, 145,
                "{label}: B's restore is what wrote lifecycle"
            );
            assert_eq!(node.lifecycle_by, Some(dev_b), "{label}");
        }
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    // --- the returning laptop, per fact group (spec §5.3, §5.4) --------
    //
    // Each uses `two_devices_in_sync`, so "the laptop" (B) last synced at
    // 120 and had incorporated the desktop's file written at 110; it returns
    // at 300. T was created at 100 and both devices have it.

    #[test]
    fn an_offline_edit_loses_to_a_later_edit_elsewhere_but_keeps_its_own_move() {
        // "Latest action wins", per fact group. The laptop's rename is older
        // than the desktop's, so the desktop's name wins everywhere, while
        // the laptop's *placement* change, an unrelated act, survives. One
        // timestamp per record would let the desktop's later rename drag the
        // tab back out of the group the laptop filed it into.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        // On the plane: rename T, and file it into a new group.
        b.rename(tab, "renamed on the laptop", dev_b, 150);
        let shelf = b.add_group(
            ws_of(&b),
            "Plane reading",
            None,
            Uuid::from_u128(1_010),
            dev_b,
            150,
        );
        tree::move_node(&mut b, tab, shelf, None, None, dev_b, 150).unwrap();

        // Meanwhile the desktop renames the same tab, later.
        a.rename(tab, "renamed on the desktop", dev_a, 200);
        sync(&store, &key, dev_a, "ws-1", &mut a, 205).unwrap();

        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();

        for (label, doc) in [("A", &a), ("B", &b)] {
            let node = doc
                .node(tab)
                .unwrap_or_else(|| panic!("{label}: the tab must still exist"));
            assert_eq!(
                node.content.name, "renamed on the desktop",
                "{label}: the later rename must win the content group"
            );
            assert_eq!(
                node.placement.parent,
                Some(shelf),
                "{label}: the laptop's move must survive the desktop's rename"
            );
        }
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn an_offline_edit_wins_over_an_older_value() {
        // The other half: nothing touched T on the desktop since it was
        // created, so the laptop's offline rename is the latest action and
        // wins everywhere on its return.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        b.rename(tab, "renamed on the laptop", dev_b, 150);

        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();

        for (label, doc) in [("A", &a), ("B", &b)] {
            assert_eq!(
                doc.node(tab).unwrap().content.name,
                "renamed on the laptop",
                "{label}: the offline rename must beat the older value"
            );
        }
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn an_offline_delete_propagates_when_nobody_else_touched_the_node() {
        // Scenario 1's drop clause from the offline direction: the deleting
        // device is the one that was away. Nothing else touched T, so there is
        // no edit newer than what the laptop had incorporated, and the
        // deletion stands on both sides.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        b.remove(tab);

        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        assert!(
            b.node(tab).is_none(),
            "the desktop's file must not resurrect the laptop's delete"
        );

        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();
        assert!(a.node(tab).is_none(), "the delete must reach the desktop");
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn an_offline_delete_loses_to_a_concurrent_edit() {
        // The design is biased toward keeping data. An edit never loses to a
        // stale absence, but a delete can lose to a concurrent edit: the
        // desktop's edit at 140 is newer than anything the laptop had
        // incorporated from the desktop, so the laptop's absence of T is not
        // evidence, and T comes back carrying the edit.
        //
        // A delete that outranks an edit it never saw needs remembered
        // deletions, which spec §5.4 rejects. A lost delete here is the
        // trade; do not answer it with a tombstone.
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();

        // The desktop edits T after the laptop's last sync, and publishes.
        a.rename(tab, "edited on the desktop", dev_a, 140);
        sync(&store, &key, dev_a, "ws-1", &mut a, 145).unwrap();

        // The laptop, still offline and unaware, deletes T at 150.
        b.remove(tab);

        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();

        for (label, doc) in [("A", &a), ("B", &b)] {
            let node = doc
                .node(tab)
                .unwrap_or_else(|| panic!("{label}: the edited tab must survive the stale delete"));
            assert_eq!(
                node.content.name, "edited on the desktop",
                "{label}: it must come back carrying the edit"
            );
        }
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    // Scenario 7 (convergence under any schedule, deletions in the mix) is
    // `sync_schedule_tests`, and its merge-level counterpart
    // `merge::tests::any_gossip_schedule_converges`.

    #[test]
    fn a_third_devices_older_file_cannot_suppress_an_offline_creation() {
        // Three devices is the smallest case: C creates W while offline,
        // and B, an active device, then syncs, producing a file that
        // postdates W's timestamp and does not contain it, because C was
        // away the whole time.
        //
        // B's absence of W says nothing: W's groups are attributed to C, and
        // B's watermark *for C* still predates them, so B cannot be read as
        // having seen W. A watermark for another device is not evidence
        // about C's writes (decision 0015).
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b, dev_c) = (DeviceId::new(), DeviceId::new(), DeviceId::new());
        let (mut a, mut b, mut c) = (base_doc(), base_doc(), base_doc());

        sync(&store, &key, dev_a, "ws-1", &mut a, 100).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 110).unwrap();
        sync(&store, &key, dev_c, "ws-1", &mut c, 120).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 130).unwrap();

        // C, offline, creates W at 125, before A's next publish.
        let w = c.add_tab(
            ws_of(&c),
            "W",
            "https://w.example",
            Uuid::from_u128(2_000),
            dev_c,
            125,
        );
        a.add_tab(
            ws_of(&a),
            "something of A's",
            "https://a.example",
            Uuid::from_u128(2_001),
            dev_a,
            128,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 130).unwrap();

        // B syncs, incorporating A's 130 file. Its version vector reaches
        // past 125 for A only.
        sync(&store, &key, dev_b, "ws-1", &mut b, 150).unwrap();
        assert!(b.node(w).is_none(), "test setup: B must never have seen W");

        // C returns; A merges C's file and B's in the same pass, then again.
        sync(&store, &key, dev_c, "ws-1", &mut c, 300).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 310).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 320).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 330).unwrap();
        sync(&store, &key, dev_c, "ws-1", &mut c, 340).unwrap();

        for (label, doc) in [("A", &a), ("B", &b), ("C", &c)] {
            assert!(
                doc.node(w).is_some(),
                "{label} lost a tab C created offline, which no device ever deleted"
            );
        }
        assert_eq!(shared_state(&a), shared_state(&b));
        assert_eq!(shared_state(&a), shared_state(&c));
    }

    // --- the sync loop itself ------------------------------------------

    #[test]
    fn two_devices_converge_through_a_shared_store() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (d1, d2) = (DeviceId::new(), DeviceId::new());
        let (mut a, mut b) = (base_doc(), base_doc());

        a.add_tab(
            ws_of(&a),
            "from A",
            "https://a.example",
            crate::types::test_support::test_id(),
            d1,
            100,
        );
        sync(&store, &key, d1, "ws-1", &mut a, 110).unwrap();

        b.add_tab(
            ws_of(&b),
            "from B",
            "https://b.example",
            crate::types::test_support::test_id(),
            d2,
            100,
        );
        sync(&store, &key, d2, "ws-1", &mut b, 120).unwrap();
        sync(&store, &key, d1, "ws-1", &mut a, 130).unwrap();

        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn an_offline_device_converges_when_it_returns() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (online, plane) = (DeviceId::new(), DeviceId::new());
        let (mut a, mut b) = (base_doc(), base_doc());

        // Four hours offline: both sides move.
        for i in 0..5 {
            a.add_tab(
                ws_of(&a),
                format!("online {i}"),
                "https://e.example",
                crate::types::test_support::test_id(),
                online,
                100 + i,
            );
        }
        for i in 0..3 {
            b.add_tab(
                ws_of(&b),
                format!("plane {i}"),
                "https://e.example",
                crate::types::test_support::test_id(),
                plane,
                100 + i,
            );
        }
        sync(&store, &key, online, "ws-1", &mut a, 200).unwrap();

        sync(&store, &key, plane, "ws-1", &mut b, 300).unwrap();
        sync(&store, &key, online, "ws-1", &mut a, 400).unwrap();

        assert_eq!(shared_state(&a), shared_state(&b));
        assert_eq!(a.nodes.len(), 1 + 5 + 3, "an add was lost");
    }

    #[test]
    fn a_peer_file_from_a_newer_schema_is_skipped_not_fatal() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();
        // A peer file this build cannot read must not break the whole sync.
        // Only the schema header is peeked before the version check, so a
        // minimal document with just that field is a faithful fixture.
        let future = r#"{"schema":{"major":99,"minor":0},"nodes":{}}"#;
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", DeviceId::new()),
            future.as_bytes(),
        );

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert!(report.errors.is_empty());
        assert_eq!(report.schema_too_new.len(), 1);
    }

    #[test]
    fn a_peer_sealed_in_a_newer_format_is_too_new_not_an_error() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let other = DeviceId::new();
        let mut doc = base_doc();
        let path = store::device_path(&key, "ws-1", other);
        seal_at(
            &store,
            &key,
            &path,
            base_doc().to_json().unwrap().as_bytes(),
        );
        let mut sealed = store.read(&path).unwrap();
        sealed[3] += 1;
        store.write(&path, &sealed).unwrap();

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.schema_too_new.len(), 1);
        assert_eq!(report.schema_too_new[0].path, path);
        assert!(!report.schema_too_new[0].own);
        assert!(!report.refused_write);
    }

    #[test]
    fn a_corrupt_peer_file_is_skipped_not_fatal() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();
        store::save_document(&store, &key, me, "ws-1", &doc).unwrap();
        let garbage = store::device_path(&key, "ws-1", DeviceId::new());

        // Not sealed at all: decrypting it must fail cleanly, not panic.
        store.write(&garbage, b"not encrypted").unwrap();

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert_eq!(report.errors.len(), 1);
        assert!(report.schema_too_new.is_empty());
        assert!(!report.errors[0].own);
        assert_eq!(report.errors[0].path, garbage);
        assert!(
            !report.refused_write,
            "a bad peer file must not stop this device writing its own"
        );
    }

    /// Seals `doc` at `device`'s path, whatever `doc` says about who wrote it.
    fn plant(store: &MemoryStore, key: &Key, device: DeviceId, doc: &Document) {
        let path = store::device_path(key, "ws-1", device);
        seal_at(store, key, &path, doc.to_json().unwrap().as_bytes());
    }

    /// A file stored under one device's name that says another wrote it is
    /// refused as damaged, so it cannot speak for that device: a tab the
    /// named device opens afterwards still reaches its peer.
    #[test]
    fn a_file_naming_another_writer_than_its_path_is_refused() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();
        let impostor = DeviceId::new();
        let mut posing = Document::new();
        posing.written_by = Some(dev_b);
        posing.written_at = u64::MAX;
        plant(&store, &key, impostor, &posing);

        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();
        let later = b.add_tab(
            ws_of(&b),
            "U",
            "https://u.example",
            Uuid::from_u128(1_201),
            dev_b,
            300,
        );
        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 400).unwrap();

        assert!(a.node(later).is_some(), "B's new tab never reached A");
        assert!(a.node(tab).is_some());
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert_eq!(
            report.errors[0].path,
            store::device_path(&key, "ws-1", impostor)
        );
    }

    /// This device's own file saying another device wrote it holds nothing
    /// of ours: it is reported, merged neither as our past self nor as that
    /// device, and replaced by our write.
    #[test]
    fn an_own_file_naming_another_writer_is_refused_and_replaced() {
        let (store, key, (dev_a, dev_b), (mut a, _b), _tab) = two_devices_in_sync();
        let mut posing = base_doc();
        let planted = posing.add_tab(
            ws_of(&posing),
            "P",
            "https://p.example",
            Uuid::from_u128(1_301),
            dev_b,
            150,
        );
        posing.written_by = Some(dev_b);
        posing.written_at = 190;
        plant(&store, &key, dev_a, &posing);

        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].own);
        assert!(!report.refused_write);
        assert!(a.node(planted).is_none());
        assert_eq!(a.seen.get(&dev_b), Some(&120));
        let stored = store::load_document(&store, &key, dev_a, "ws-1").unwrap();
        assert_eq!(stored.written_by, Some(dev_a));
    }

    /// A file claiming to have seen far more of every device than any of
    /// them has written deletes nothing and blocks nothing: the tab both
    /// devices held, a tab opened before it that no file had carried yet,
    /// and tabs opened afterwards all end up on both devices.
    #[test]
    fn a_file_claiming_to_have_seen_beyond_every_write_blocks_nothing() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();
        let unpublished = a.add_tab(
            ws_of(&a),
            "P",
            "https://p.example",
            Uuid::from_u128(1_210),
            dev_a,
            140,
        );
        let hostile = DeviceId::new();
        let mut claims = Document::new();
        claims.written_by = Some(hostile);
        claims.written_at = 150;
        claims.seen.insert(dev_a, u64::MAX);
        claims.seen.insert(dev_b, u64::MAX);
        plant(&store, &key, hostile, &claims);

        sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 210).unwrap();
        let from_a = a.add_tab(
            ws_of(&a),
            "A",
            "https://a.example",
            Uuid::from_u128(1_211),
            dev_a,
            300,
        );
        let from_b = b.add_tab(
            ws_of(&b),
            "B",
            "https://b.example",
            Uuid::from_u128(1_212),
            dev_b,
            300,
        );
        for now in [400, 410, 420, 430] {
            sync(&store, &key, dev_a, "ws-1", &mut a, now).unwrap();
            sync(&store, &key, dev_b, "ws-1", &mut b, now + 5).unwrap();
        }

        for id in [tab, unpublished, from_a, from_b] {
            assert!(a.node(id).is_some(), "A lost {id}");
            assert!(b.node(id).is_some(), "B never got {id}");
        }
    }

    /// A peer whose file was written more than [`CLOCK_AHEAD_MARGIN`] after
    /// this device's `now`, and which only adds tabs, costs this device
    /// nothing: everything in it is merged and no device is reported
    /// (decision 1714). A peer a few minutes ahead is within the margin.
    #[test]
    fn a_peer_far_ahead_that_replaces_nothing_is_not_reported() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (me, fast, slightly) = (DeviceId::new(), DeviceId::new(), DeviceId::new());
        let now: Timestamp = 1_000_000_000;
        let mut kept = Vec::new();
        for (device, at, n) in [
            (fast, now + CLOCK_AHEAD_MARGIN + 60_000, 1_220),
            (slightly, now + 5 * 60_000, 1_221),
        ] {
            let mut theirs = base_doc();
            kept.push(theirs.add_tab(
                ws_of(&theirs),
                "T",
                "https://t.example",
                Uuid::from_u128(n),
                device,
                at,
            ));
            sync(&store, &key, device, "ws-1", &mut theirs, at).unwrap();
        }

        let mut doc = base_doc();
        let report = sync(&store, &key, me, "ws-1", &mut doc, now).unwrap();

        assert!(
            report.harmed_by_clock.is_empty(),
            "{:?}",
            report.harmed_by_clock
        );
        assert_eq!(report.merged, 2, "both peers' files merge");
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        for id in kept {
            assert!(doc.node(id).is_some(), "lost {id}");
        }
        assert!(
            !doc.seen.contains_key(&fast),
            "the fast device's write is no watermark here (decision 0135)"
        );
    }

    /// A rename from a device whose clock is set ahead replaces this
    /// device's name for the tab, and that device is reported (decision
    /// 1714).
    #[test]
    fn a_fast_peers_rename_that_replaces_a_name_is_reported() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();
        let far = 200 + CLOCK_AHEAD_MARGIN + 60_000;
        b.rename(tab, "Theirs", dev_b, far);
        sync(&store, &key, dev_b, "ws-1", &mut b, far).unwrap();

        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        assert_eq!(report.harmed_by_clock, vec![dev_b]);
        assert_eq!(a.node(tab).unwrap().content.name, "Theirs");
    }

    /// The same rename read from the shared folder, as the host's shared
    /// step reads it, reports the device too (decision 1714).
    #[test]
    fn a_fast_peers_rename_read_from_the_shared_folder_is_reported() {
        let store = MemoryStore::new();
        let key = Key::generate();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());
        let shared = |doc: &mut Document, device, now| {
            sync_to(
                &store,
                &key,
                device,
                "ws-1",
                doc,
                now,
                None,
                Target::Shared,
                None,
            )
            .unwrap()
        };
        let mut a = base_doc();
        let tab = a.add_tab(
            ws_of(&a),
            "T",
            "https://t.example",
            Uuid::from_u128(1_000),
            dev_a,
            100,
        );
        shared(&mut a, dev_a, 110);
        let mut b = base_doc();
        shared(&mut b, dev_b, 120);
        assert!(b.node(tab).is_some(), "B must have picked T up");
        shared(&mut a, dev_a, 130);

        let far = 200 + CLOCK_AHEAD_MARGIN + 60_000;
        b.rename(tab, "Theirs", dev_b, far);
        shared(&mut b, dev_b, far);

        let report = shared(&mut a, dev_a, 200);

        assert_eq!(a.node(tab).unwrap().content.name, "Theirs");
        assert_eq!(report.harmed_by_clock, vec![dev_b]);
    }

    /// A tab this device closed comes back from a device whose clock is set
    /// ahead and that touched it, and that device is reported (decision
    /// 1714).
    #[test]
    fn a_closed_tab_a_fast_peer_brings_back_is_reported() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();
        let far = 200 + CLOCK_AHEAD_MARGIN + 60_000;
        b.rename(tab, "Theirs", dev_b, far);
        sync(&store, &key, dev_b, "ws-1", &mut b, far).unwrap();
        a.remove(tab);

        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        assert!(a.node(tab).is_some(), "the tab came back");
        assert_eq!(report.harmed_by_clock, vec![dev_b]);
    }

    /// [`two_devices_in_sync`] with fixed ids and key, so the order the
    /// peers' files are read in, which decides which file a fact arrives in
    /// first, is the same on every run.
    #[allow(clippy::type_complexity)]
    fn two_fixed_devices_in_sync() -> (
        MemoryStore,
        Key,
        (DeviceId, DeviceId),
        (Document, Document),
        NodeId,
    ) {
        let store = MemoryStore::new();
        let key = Key::from_bytes(&[5u8; 32]).unwrap();
        let (dev_a, dev_b) = (
            DeviceId::from_bytes([0xa; 16]),
            DeviceId::from_bytes([0xb; 16]),
        );
        let mut a = base_doc();
        let tab = a.add_tab(
            ws_of(&a),
            "T",
            "https://t.example",
            Uuid::from_u128(1_000),
            dev_a,
            100,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 110).unwrap();
        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 120).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 130).unwrap();
        (store, key, (dev_a, dev_b), (a, b), tab)
    }

    /// What A's pass at 200 reports after `edit` runs on both devices and B,
    /// on a clock `ahead` of A's, writes.
    fn harm_after(
        ahead: Timestamp,
        edit: impl FnOnce(&mut Document, &mut Document, NodeId, DeviceId),
    ) -> (Vec<DeviceId>, Document, NodeId) {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_fixed_devices_in_sync();
        edit(&mut a, &mut b, tab, dev_b);
        sync(&store, &key, dev_b, "ws-1", &mut b, 200 + ahead).unwrap();
        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();
        (report.harmed_by_clock, a, tab)
    }

    /// A move, a lifecycle write and a recolour from a device whose clock is set ahead
    /// each replace this device's fact, and that device is reported, as for
    /// a rename (decision 1714).
    #[test]
    fn a_fast_peers_move_lifecycle_write_or_recolour_is_reported() {
        let far = CLOCK_AHEAD_MARGIN + 60_000;
        let at = 200 + far;
        let edits: [fn(&mut Document, NodeId, DeviceId, Timestamp); 3] = [
            |b, tab, by, at| {
                let ws = ws_of(b);
                let group = b.add_group(ws, "G", None, Uuid::from_u128(1_400), by, 140);
                tree::move_node(b, tab, group, None, None, by, at).unwrap();
            },
            |b, tab, by, at| b.set_isolation(tab, true, by, at),
            |b, tab, by, at| b.set_appearance(tab, Some("blue".into()), None, None, by, at),
        ];
        for (i, edit) in edits.into_iter().enumerate() {
            let (harmed, _, _) = harm_after(far, |_, b, tab, by| edit(b, tab, by, at));
            assert_eq!(harmed.len(), 1, "edit {i}");
        }
    }

    /// A fast device's write that gives a fact the value this device already
    /// holds, a write within [`CLOCK_AHEAD_MARGIN`] or exactly at it, and a
    /// write stamped at this device's own reading from a file written far
    /// ahead each cost nothing, and no device is reported.
    #[test]
    fn a_fast_peers_write_that_changes_nothing_here_is_not_reported() {
        let far = CLOCK_AHEAD_MARGIN + 60_000;
        let (harmed, _, _) = harm_after(far, |a, b, tab, by| {
            a.rename(tab, "Same", DeviceId::from_bytes([0xa; 16]), 150);
            b.rename(tab, "Same", by, 200 + far);
        });
        assert!(harmed.is_empty(), "the same value");
        for ahead in [5 * 60_000, CLOCK_AHEAD_MARGIN] {
            let (harmed, a, tab) = harm_after(ahead, |_, b, tab, by| {
                b.rename(tab, "Theirs", by, 200 + ahead);
            });
            assert_eq!(a.node(tab).unwrap().content.name, "Theirs");
            assert!(harmed.is_empty(), "{ahead} ms ahead");
        }
        let (harmed, a, tab) = harm_after(far, |_, b, tab, by| b.rename(tab, "Theirs", by, 200));
        assert_eq!(a.node(tab).unwrap().content.name, "Theirs");
        assert!(harmed.is_empty(), "stamped at the reading");
    }

    /// A tab this device closed that a fast device touched at this device's
    /// own reading comes back with no stamp after it, and costs nothing; a
    /// tab that only ever was the fast device's is no loss to this device.
    #[test]
    fn a_tab_from_a_fast_peer_stamped_no_later_than_now_or_never_ours_is_not_reported() {
        let far = CLOCK_AHEAD_MARGIN + 60_000;
        let (harmed, a, tab) = harm_after(far, |a, b, tab, by| {
            b.touch(tab, by, 200);
            a.remove(tab);
        });
        assert!(a.node(tab).is_some(), "the touch is news");
        assert!(harmed.is_empty(), "returned at the reading");

        let (harmed, a, _) = harm_after(far, |_, b, _, by| {
            let ws = ws_of(b);
            b.add_tab(
                ws,
                "New",
                "https://n.example",
                Uuid::from_u128(1_401),
                by,
                200 + far,
            );
        });
        assert!(a.node(Uuid::from_u128(1_401)).is_some());
        assert!(harmed.is_empty(), "never this device's");
    }

    /// The same rename stamped in real time is an ordinary edit, and no
    /// device is reported.
    #[test]
    fn a_peers_rename_in_real_time_is_not_reported() {
        let (store, key, (dev_a, dev_b), (mut a, mut b), tab) = two_devices_in_sync();
        b.rename(tab, "Theirs", dev_b, 150);
        sync(&store, &key, dev_b, "ws-1", &mut b, 160).unwrap();

        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        assert_eq!(a.node(tab).unwrap().content.name, "Theirs");
        assert!(report.harmed_by_clock.is_empty());
    }

    /// A peer that reads this device's file while its own clock is a little
    /// behind takes the watermark all the same, so the tab it then closes is
    /// closed here too (decision 0135's margin). Two corrected clocks differ
    /// by a second or two.
    #[test]
    fn a_watermark_slightly_ahead_of_the_readers_now_is_taken() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());
        let mut a = base_doc();
        let tab = a.add_tab(
            ws_of(&a),
            "T",
            "https://t.example",
            Uuid::from_u128(1_240),
            dev_a,
            10_000,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 10_000).unwrap();

        // B's clock is two seconds behind A's.
        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 8_000).unwrap();
        assert!(b.node(tab).is_some(), "B has the tab");
        b.remove(tab);
        sync(&store, &key, dev_b, "ws-1", &mut b, 8_100).unwrap();

        sync(&store, &key, dev_a, "ws-1", &mut a, 10_200).unwrap();
        assert!(a.node(tab).is_none(), "B's close is honoured");
    }

    /// A pass reports this device's own watermark, which a host keeps its
    /// next stamps above (decision 1714).
    #[test]
    fn a_pass_reports_this_devices_own_watermark() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();
        doc.add_tab(
            ws_of(&doc),
            "T",
            "https://t.example",
            Uuid::from_u128(1_241),
            me,
            500,
        );
        let report = sync(&store, &key, me, "ws-1", &mut doc, 700).unwrap();
        assert_eq!(report.own_watermark, 700);
        let mut fresh = base_doc();
        let loaded = sync(&store, &key, me, "ws-1", &mut fresh, 600).unwrap();
        assert_eq!(loaded.own_watermark, 700, "read back from its own file");
    }

    /// A device whose clock ran ahead before its first time reading holds
    /// stamps later than corrected time, in memory and in its profile file.
    /// The pass that clamps them keeps a rename made since the reading, and
    /// the first file it publishes has no stamp of its own later than the
    /// time it was published. A peer's stamps stay as the peer wrote them
    /// (decision 1714).
    #[test]
    fn a_clamping_pass_publishes_no_own_stamp_ahead_of_now() {
        let (profile, shared) = (MemoryStore::new(), MemoryStore::new());
        let key = crate::types::test_support::test_key();
        let (me, peer) = (DeviceId::new(), DeviceId::new());
        let at: Timestamp = 1_000_000;
        let ahead = at + 3_600_000;

        let mut theirs = base_doc();
        let theirs_tab = theirs.add_tab(
            ws_of(&theirs),
            "P",
            "https://p.example",
            Uuid::from_u128(1_230),
            peer,
            at + 120_000,
        );
        sync(&shared, &key, peer, "ws-1", &mut theirs, at + 120_000).unwrap();

        let mut doc = base_doc();
        let mine = doc.add_tab(
            ws_of(&doc),
            "M",
            "https://m.example",
            Uuid::from_u128(1_231),
            me,
            ahead,
        );
        sync(&profile, &key, me, "ws-1", &mut doc, ahead).unwrap();

        // The reading arrives at `at`; the next stamp is later.
        doc.rename(mine, "Renamed", me, at + 1);
        let pass = |store: &MemoryStore, doc: &mut Document, now, clamp, target| {
            sync_to(store, &key, me, "ws-1", doc, now, None, target, clamp).unwrap()
        };
        pass(&profile, &mut doc, at + 5, Some(at), Target::Profile);
        pass(&shared, &mut doc, at + 10, None, Target::Shared);
        pass(&profile, &mut doc, at + 15, None, Target::Profile);

        let read = |store: &MemoryStore| {
            let path = store::device_path(&key, "ws-1", me);
            Document::from_json(std::str::from_utf8(&open_at(store, &key, &path)).unwrap()).unwrap()
        };
        let published = read(&shared);
        for node in published.nodes.values() {
            for (by, stamp) in node.attributions() {
                if by == Some(me) {
                    assert!(stamp <= at + 10, "an own stamp {stamp} is ahead");
                }
            }
        }
        assert!(published.written_at <= at + 10);
        assert!(published.seen.get(&me).is_some_and(|seen| *seen <= at + 10));
        assert_eq!(published.node(mine).unwrap().content.name, "Renamed");
        assert_eq!(
            published.node(theirs_tab).unwrap().content_at,
            at + 120_000,
            "a peer's stamp is the peer's"
        );
        let kept = read(&profile);
        assert_eq!(kept.node(mine).unwrap().content.name, "Renamed");
        assert!(kept.node(mine).unwrap().content_at <= at + 15);
    }

    #[test]
    fn what_a_cloud_client_leaves_in_the_folder_is_no_error_and_no_peer() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (me, peer) = (DeviceId::new(), DeviceId::new());
        let mut theirs = base_doc();
        let tab = theirs.add_tab(
            ws_of(&theirs),
            "theirs",
            "https://e.example",
            crate::types::test_support::test_id(),
            peer,
            100,
        );
        sync(&store, &key, peer, "ws-1", &mut theirs, 200).unwrap();
        let peer_path = store::device_path(&key, "ws-1", peer);
        let (dir, _) = peer_path.rsplit_once('/').unwrap();
        let copy = store.read(&peer_path).unwrap();
        // A conflict copy of the directory and of the peer's file, both
        // holding the peer's bytes, which are bound to the peer's own path
        // and so open nowhere else, and Finder's metadata.
        store
            .write(&format!("{dir} (1)/{peer}.json"), &copy)
            .unwrap();
        store
            .write(&format!("{dir}/{peer} (1).json"), &copy)
            .unwrap();
        store
            .write(&format!("{dir}/.DS_Store"), b"\0\0\0\x01Bud1")
            .unwrap();

        let mut doc = base_doc();
        let report = sync(&store, &key, me, "ws-1", &mut doc, 300).unwrap();

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(doc.node(tab).is_some(), "the real peer still merges");
    }

    #[test]
    fn a_corrupt_own_file_is_skipped_not_fatal_and_not_overwritten() {
        // This device's own file gets the same skip-and-report handling as
        // a corrupt peer. A `?` here would leave the device unable to sync at
        // all, since the error would only show as `sync` returning `Err`.
        //
        // An undecryptable own file most likely means the wrong key (a
        // restored profile, or rotated key material), so it is not
        // overwritten either: it may be the only copy of what it holds.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();
        let path = store::device_path(&key, "ws-1", me);

        // Not sealed at all: decrypting this device's own file must fail
        // cleanly, not propagate as `sync`'s own `Result::Err`.
        store.write(&path, b"not encrypted").unwrap();

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert_eq!(report.errors.len(), 1);
        assert!(report.schema_too_new.is_empty());
        assert!(report.errors[0].own, "{:?}", report.errors);
        assert_eq!(report.errors[0].path, path);
        assert!(report.refused_write);
        assert_eq!(
            store.read(&path).unwrap(),
            b"not encrypted",
            "an own file we could not decrypt must survive this sync untouched"
        );
    }

    #[test]
    fn a_too_new_own_file_is_reported_and_the_write_is_refused() {
        // A build downgraded after a newer one wrote this device's own file
        // must not overwrite it with its older-schema view of the document,
        // which lacks whatever the newer build wrote.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();

        let future = r#"{"schema":{"major":99,"minor":0},"nodes":{}}"#;
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", me),
            future.as_bytes(),
        );

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert_eq!(report.schema_too_new.len(), 1);
        assert!(report.schema_too_new[0].own);
        assert_eq!(
            report.schema_too_new[0].path,
            store::device_path(&key, "ws-1", me)
        );
        assert!(report.refused_write);
        assert!(report.errors.is_empty());

        let reopened = open_at(&store, &key, &store::device_path(&key, "ws-1", me));
        assert_eq!(
            String::from_utf8(reopened).unwrap(),
            future,
            "the newer-schema own file must survive this sync untouched"
        );
    }

    #[test]
    fn an_own_file_that_decrypts_but_does_not_parse_is_never_overwritten() {
        // It passed authentication under this device's key, so this device
        // wrote it, and a build that cannot read it is no judge of what it
        // holds.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();
        let unreadable = r#"{"schema":{"major":1,"minor":0},"nodes":5}"#;
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", me),
            unreadable.as_bytes(),
        );

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        let reopened = open_at(&store, &key, &store::device_path(&key, "ws-1", me));
        assert_eq!(String::from_utf8(reopened).unwrap(), unreadable);
    }

    #[test]
    fn a_file_that_opens_but_is_not_utf8_is_reported_as_load_document_reports_it() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let other = DeviceId::new();
        let mut doc = base_doc();
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", other),
            &[0xff, 0xfe],
        );

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert_eq!(report.errors[0].reason, Error::NotUtf8.to_string());
    }

    #[test]
    fn a_peer_with_an_unknown_node_kind_merges_and_its_node_is_republished() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let other = DeviceId::new();
        let mut doc = base_doc();
        let ws = ws_of(&doc);

        let mut peer: serde_json::Value =
            serde_json::from_str(&base_doc().to_json().unwrap()).unwrap();
        let note_id = "018f0000-0000-7000-8000-0000000000aa";
        peer["nodes"][note_id] = serde_json::json!({
            "kind": "note",
            "content": { "name": "from a newer build", "body": "kept" },
            "content_at": 100,
            "placement": { "parent": ws.to_string(), "order": "80" },
            "placement_at": 100,
            "lifecycle": {},
            "lifecycle_at": 100
        });
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", other),
            peer.to_string().as_bytes(),
        );

        let report = sync(&store, &key, me, "ws-1", &mut doc, 500).unwrap();

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(report.repaired.is_empty(), "{:?}", report.repaired);
        let mine: serde_json::Value = serde_json::from_slice(&open_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", me),
        ))
        .unwrap();
        assert_eq!(mine["nodes"][note_id]["kind"], "note");
        assert_eq!(mine["nodes"][note_id]["content"]["body"], "kept");
    }

    #[test]
    fn a_peer_file_that_fails_to_parse_is_skipped_and_a_good_peer_still_merges() {
        // Distinct from the schema-too-new and decrypt-failure cases: this
        // file decrypts fine and is valid UTF-8, but is not a `Document`.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let me = DeviceId::new();
        let mut doc = base_doc();

        let unparseable = r#"{"schema":{"major":1,"minor":0},"nodes":5}"#;
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", DeviceId::new()),
            unparseable.as_bytes(),
        );

        let other = DeviceId::new();
        let mut good_peer = base_doc();
        let good_tab = good_peer.add_tab(
            ws_of(&good_peer),
            "from a good peer",
            "https://good.example",
            crate::types::test_support::test_id(),
            other,
            100,
        );
        sync(&store, &key, other, "ws-1", &mut good_peer, 200).unwrap();

        let report = sync(&store, &key, me, "ws-1", &mut doc, 300).unwrap();

        assert_eq!(
            report.errors.len(),
            1,
            "the unparseable peer must be recorded"
        );
        assert!(report.schema_too_new.is_empty());
        assert!(
            doc.node(good_tab).is_some(),
            "a good peer's file must still merge despite a bad one alongside it"
        );
    }

    #[test]
    fn a_group_deleted_with_its_contents_takes_them_off_every_device() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());
        let mut a = base_doc();
        let ws = ws_of(&a);
        let group = a.add_group(
            ws,
            "Group",
            None,
            crate::types::test_support::test_id(),
            dev_a,
            100,
        );
        let tab = a.add_tab(
            group,
            "t",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev_a,
            100,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 110).unwrap();
        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 120).unwrap();
        assert!(b.node(tab).is_some(), "test setup: b holds the tab");

        a.remove(group);
        sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 300).unwrap();

        for doc in [&a, &b] {
            assert!(doc.node(group).is_none());
            assert!(doc.node(tab).is_none(), "the tab went with its group");
        }
    }

    #[test]
    fn tabs_added_into_a_group_a_peer_deleted_remain_reachable_after_sync() {
        // Device A adds tabs into a group while device B deletes that group.
        // Neither edit is wrong on its own, but once merged the tabs' parent
        // is gone, and they are invisible to `children()` unless `sync`
        // repairs the tree.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());

        let mut a = base_doc();
        let ws = ws_of(&a);
        let group = a.add_group(
            ws,
            "Group",
            None,
            crate::types::test_support::test_id(),
            dev_a,
            100,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 110).unwrap();

        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 120).unwrap();
        assert!(b.node(group).is_some(), "b must have seen the group");
        sync(&store, &key, dev_a, "ws-1", &mut a, 130).unwrap();

        b.remove(group);
        sync(&store, &key, dev_b, "ws-1", &mut b, 1_000).unwrap();

        let tab = a.add_tab(
            group,
            "orphan-to-be",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev_a,
            2_000,
        );
        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 2_100).unwrap();

        assert!(a.node(group).is_none(), "the group's deletion must land");
        assert!(a.node(tab).is_some(), "the tab record itself must survive");
        assert!(
            !report.repaired.is_empty(),
            "deleting the parent group should have triggered a repair"
        );
        let reachable = tree::children(&a, ws);
        assert!(
            reachable.contains(&tab),
            "the tab must be reachable from a workspace after sync, not stranded under a deleted group"
        );
    }

    /// Ids for the deleted-group tests: `base_doc`'s workspace is id 1, so
    /// [`W2`] is never the lowest-id workspace repair falls back to.
    const W2: NodeId = Uuid::from_u128(0x200);
    const P: NodeId = Uuid::from_u128(0x201);
    const S1: NodeId = Uuid::from_u128(0x202);
    const G: NodeId = Uuid::from_u128(0x203);
    const S2: NodeId = Uuid::from_u128(0x204);
    const G2: NodeId = Uuid::from_u128(0x205);
    const INNER: NodeId = Uuid::from_u128(0x206);
    const T1: NodeId = Uuid::from_u128(0x301);
    const T2: NodeId = Uuid::from_u128(0x302);

    /// `devices` documents that all hold `P [S1, G, S2]` in workspace W2,
    /// with G holding group G2 and G2 holding tab INNER, every device having
    /// read every other's file.
    fn devices_holding_a_nested_group(
        devices: usize,
    ) -> (MemoryStore, Key, Vec<DeviceId>, Vec<Document>) {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let ids: Vec<DeviceId> = (0..devices)
            .map(|i| DeviceId::from_bytes([i as u8 + 1; 16]))
            .collect();
        let mut first = base_doc();
        let by = ids[0];
        first.add_workspace("W2", None, W2, by, 10);
        first.add_group(W2, "P", None, P, by, 10);
        first.add_tab(P, "s1", "https://s1.example", S1, by, 11);
        first.add_group(P, "G", None, G, by, 12);
        first.add_tab(P, "s2", "https://s2.example", S2, by, 13);
        first.add_group(G, "G2", None, G2, by, 14);
        first.add_tab(G2, "inner", "https://i.example", INNER, by, 15);
        let mut docs = vec![first];
        docs.resize_with(devices, base_doc);
        let mut now = 100;
        for _ in 0..2 {
            for (doc, &id) in docs.iter_mut().zip(&ids) {
                sync(&store, &key, id, "ws-1", doc, now).unwrap();
                now += 10;
            }
        }
        for doc in &docs {
            assert_eq!(tree::children(doc, P), vec![S1, G, S2], "test setup");
        }
        (store, key, ids, docs)
    }

    /// Syncs every device in `first` order, then two full rounds, and
    /// returns the converged shared state.
    fn sync_in_order(
        store: &MemoryStore,
        key: &Key,
        ids: &[DeviceId],
        docs: &mut [Document],
        first: &[usize],
    ) -> String {
        let mut now = 10_000;
        let all: Vec<usize> = (0..ids.len()).collect();
        for &i in first.iter().chain(&all).chain(&all) {
            sync(store, key, ids[i], "ws-1", &mut docs[i], now).unwrap();
            now += 10;
        }
        let state = shared_state(&docs[0]);
        for doc in docs.iter() {
            assert_eq!(shared_state(doc), state, "every device must converge");
            assert_every_node_is_reachable(doc);
        }
        state
    }

    /// Every ordering of `0..n`.
    fn orders(n: usize) -> Vec<Vec<usize>> {
        if n == 0 {
            return vec![vec![]];
        }
        let mut out = Vec::new();
        for rest in orders(n - 1) {
            for at in 0..=rest.len() {
                let mut order = rest.clone();
                order.insert(at, n - 1);
                out.push(order);
            }
        }
        out
    }

    #[test]
    fn tabs_filed_into_a_group_a_peer_deleted_land_at_the_groups_place() {
        // A deletes G with everything in it while B, not having seen that,
        // files two tabs into G. The tabs land where G was, in G's parent P,
        // on both devices, whichever of them syncs first.
        let mut states = Vec::new();
        for first in orders(2) {
            let (store, key, ids, mut docs) = devices_holding_a_nested_group(2);
            docs[0].remove(G);
            let b = ids[1];
            docs[1].add_tab(G, "t1", "https://t1.example", T1, b, 5_000);
            docs[1].add_tab(G, "t2", "https://t2.example", T2, b, 5_001);

            states.push(sync_in_order(&store, &key, &ids, &mut docs, &first));

            for doc in &docs {
                assert_eq!(
                    tree::children(doc, P),
                    vec![S1, T1, T2, S2],
                    "order {first:?}"
                );
                assert!(doc.node(G).is_none() && doc.node(INNER).is_none());
            }
        }
        assert_eq!(states[0], states[1], "the order of syncs must not matter");
    }

    #[test]
    fn a_tab_filed_into_a_nested_deleted_group_lands_at_the_first_surviving_ancestor() {
        // A deletes G, and G2 inside it, while B files a tab into G2. G2's
        // parent is gone too, so the tab lands at G's place in P, the first
        // ancestor that still exists.
        let (store, key, ids, mut docs) = devices_holding_a_nested_group(2);
        docs[0].remove(G);
        docs[1].add_tab(G2, "t1", "https://t1.example", T1, ids[1], 5_000);

        sync_in_order(&store, &key, &ids, &mut docs, &[1, 0]);

        for doc in &docs {
            assert_eq!(tree::children(doc, P), vec![S1, T1, S2]);
            assert!(doc.node(G2).is_none());
        }
    }

    #[test]
    fn three_devices_place_a_tab_from_a_deleted_group_alike_in_any_order() {
        // C holds the same tree and edits nothing. Whichever of the three
        // syncs first, and so whichever device first sees the tab without its
        // group, all three put the tab at G's place and agree on every byte.
        let mut states = Vec::new();
        for first in orders(3) {
            let (store, key, ids, mut docs) = devices_holding_a_nested_group(3);
            docs[0].remove(G);
            docs[1].add_tab(G, "t1", "https://t1.example", T1, ids[1], 5_000);

            states.push(sync_in_order(&store, &key, &ids, &mut docs, &first));

            for doc in &docs {
                assert_eq!(tree::children(doc, P), vec![S1, T1, S2], "order {first:?}");
            }
        }
        assert!(
            states.windows(2).all(|w| w[0] == w[1]),
            "every order must reach the same document"
        );
    }

    // --- splits (split-view spec §5.3) ------------------------------------

    const SP: NodeId = Uuid::from_u128(0x400);
    const GR: NodeId = Uuid::from_u128(0x401);
    const SP2: NodeId = Uuid::from_u128(0x402);
    const X: NodeId = Uuid::from_u128(0x411);
    const Y: NodeId = Uuid::from_u128(0x412);
    const Z: NodeId = Uuid::from_u128(0x413);
    const Q: NodeId = Uuid::from_u128(0x414);
    const NEW_W: NodeId = Uuid::from_u128(0x421);
    const NEW_V: NodeId = Uuid::from_u128(0x422);

    /// Two devices that both hold workspace W2 as `build` makes it, each
    /// having read the other's file.
    fn two_devices_holding(
        build: impl Fn(&mut Document, DeviceId),
    ) -> (MemoryStore, Key, Vec<DeviceId>, Vec<Document>) {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let ids = vec![DeviceId::from_bytes([1; 16]), DeviceId::from_bytes([2; 16])];
        let mut first = base_doc();
        first.add_workspace("W2", None, W2, ids[0], 10);
        build(&mut first, ids[0]);
        let mut docs = vec![first, base_doc()];
        let mut now = 100;
        for _ in 0..2 {
            for (doc, &id) in docs.iter_mut().zip(&ids) {
                sync(&store, &key, id, "ws-1", doc, now).unwrap();
                now += 10;
            }
        }
        assert_eq!(shared_state(&docs[0]), shared_state(&docs[1]), "test setup");
        (store, key, ids, docs)
    }

    /// W2 holding tab S1, split SP of `panes`, tab S2 and an empty group GR.
    fn with_split(panes: &'static [NodeId]) -> impl Fn(&mut Document, DeviceId) {
        move |doc, by| {
            doc.add_tab(W2, "s1", "https://s1.example", S1, by, 11);
            doc.add_split(W2, "", SP, by, 12);
            doc.add_tab(W2, "s2", "https://s2.example", S2, by, 13);
            doc.add_group(W2, "GR", None, GR, by, 14);
            for &pane in panes {
                doc.add_tab(SP, "pane", "https://p.example", pane, by, 15);
            }
        }
    }

    /// Runs `edit` on fresh devices for each sync order, checks that every
    /// order reaches the same document, and returns the first device's copy.
    fn converge_on_split(
        panes: &'static [NodeId],
        edit: impl Fn(&mut [Document], &[DeviceId]),
    ) -> Document {
        let mut states = Vec::new();
        let mut last = None;
        for first in orders(2) {
            let (store, key, ids, mut docs) = two_devices_holding(with_split(panes));
            edit(&mut docs, &ids);
            states.push(sync_in_order(&store, &key, &ids, &mut docs, &first));
            last = Some(docs.swap_remove(0));
        }
        assert_eq!(states[0], states[1], "the order of syncs must not matter");
        last.unwrap()
    }

    #[test]
    fn a_pane_moved_on_one_device_and_the_split_moved_on_another_both_survive() {
        let doc = converge_on_split(&[X, Y], |docs, ids| {
            tree::move_node(&mut docs[0], Y, SP, None, Some(X), ids[0], 5_000).unwrap();
            tree::move_node(&mut docs[1], SP, GR, None, None, ids[1], 5_001).unwrap();
        });
        assert_eq!(doc.node(SP).unwrap().placement.parent, Some(GR));
        assert_eq!(tree::children(&doc, SP), vec![Y, X]);
    }

    #[test]
    fn a_split_separated_on_one_device_while_another_moves_a_pane_leaves_two_tabs_in_its_place() {
        let doc = converge_on_split(&[X, Y], |docs, ids| {
            tree::remove_keeping_children(&mut docs[0], SP, ids[0], 5_000).unwrap();
            tree::move_node(&mut docs[1], Y, SP, None, Some(X), ids[1], 5_001).unwrap();
        });
        assert!(doc.node(SP).is_none());
        let row = tree::children(&doc, W2);
        assert_eq!((row[0], row[3], row[4]), (S1, S2, GR), "{row:?}");
        let mut panes = row[1..3].to_vec();
        panes.sort();
        assert_eq!(panes, vec![X, Y]);
    }

    #[test]
    fn a_pane_closed_on_one_device_comes_back_when_another_moved_it_unseen() {
        let doc = converge_on_split(&[X, Y], |docs, ids| {
            docs[0].remove(X);
            tree::remove_keeping_children(&mut docs[0], SP, ids[0], 5_000).unwrap();
            tree::move_node(&mut docs[1], X, SP, Some(Y), None, ids[1], 5_001).unwrap();
        });
        assert!(doc.node(SP).is_none());
        let row = tree::children(&doc, W2);
        assert_eq!((row[0], row[3], row[4]), (S1, S2, GR), "{row:?}");
        let mut tabs = row[1..3].to_vec();
        tabs.sort();
        assert_eq!(tabs, vec![X, Y]);
    }

    #[test]
    fn a_pane_closed_on_one_device_leaves_the_other_an_ordinary_tab_everywhere() {
        let doc = converge_on_split(&[X, Y], |docs, ids| {
            docs[0].remove(X);
            tree::remove_keeping_children(&mut docs[0], SP, ids[0], 5_000).unwrap();
        });
        assert!(doc.node(SP).is_none() && doc.node(X).is_none());
        assert_eq!(tree::children(&doc, W2), vec![S1, Y, S2, GR]);
    }

    #[test]
    fn the_same_pane_replaced_on_two_devices_leaves_more_panes_than_a_split_holds() {
        // The one shape a local edit never makes: a host draws it in chunks
        // of four (split-view spec §5.1).
        let doc = converge_on_split(&[X, Y, Z, Q], |docs, ids| {
            for (doc, (by, new, at)) in docs
                .iter_mut()
                .zip([(ids[0], NEW_W, 5_000), (ids[1], NEW_V, 5_001)])
            {
                doc.remove(X);
                doc.add_tab(W2, "new", "https://n.example", new, by, at);
                tree::move_node(doc, new, SP, None, Some(Y), by, at).unwrap();
            }
        });
        let panes = tree::children(&doc, SP);
        assert_eq!(panes.len(), 5, "{panes:?}");
        assert_eq!(&panes[2..], &[Y, Z, Q]);
        assert!(panes.contains(&NEW_W) && panes.contains(&NEW_V));
    }

    #[test]
    fn a_tab_split_on_two_devices_goes_to_the_later_split_and_the_earlier_keeps_one_tab() {
        let mut states = Vec::new();
        for first in orders(2) {
            let (store, key, ids, mut docs) = two_devices_holding(|doc, by| {
                for (tab, at) in [(X, 11), (Y, 12), (Z, 13)] {
                    doc.add_tab(W2, "t", "https://t.example", tab, by, at);
                }
            });
            for (doc, (by, split, other, at)) in docs
                .iter_mut()
                .zip([(ids[0], SP, Y, 5_000), (ids[1], SP2, Z, 5_001)])
            {
                doc.add_split(W2, "", split, by, at);
                tree::move_node(doc, X, split, None, None, by, at).unwrap();
                tree::move_node(doc, other, split, Some(X), None, by, at).unwrap();
            }
            states.push(sync_in_order(&store, &key, &ids, &mut docs, &first));
            for doc in &docs {
                assert_eq!(tree::children(doc, SP), vec![Y], "order {first:?}");
                assert_eq!(tree::children(doc, SP2), vec![X, Z], "order {first:?}");
            }
        }
        assert_eq!(states[0], states[1], "the order of syncs must not matter");
    }

    #[test]
    fn a_split_moved_into_a_group_another_device_deleted_lands_at_the_groups_place() {
        let doc = converge_on_split(&[X, Y], |docs, ids| {
            docs[0].remove(GR);
            tree::move_node(&mut docs[1], SP, GR, None, None, ids[1], 5_001).unwrap();
        });
        assert!(doc.node(GR).is_none());
        assert_eq!(tree::children(&doc, W2), vec![S1, S2, SP]);
        assert_eq!(tree::children(&doc, SP), vec![X, Y]);
    }

    #[test]
    fn a_tab_filed_into_a_split_another_device_closed_lands_at_the_splits_place() {
        let doc = converge_on_split(&[X, Y], |docs, ids| {
            docs[0].remove(SP);
            docs[1].add_tab(SP, "t1", "https://t1.example", T1, ids[1], 5_001);
        });
        assert!(doc.node(SP).is_none() && doc.node(X).is_none() && doc.node(Y).is_none());
        assert_eq!(tree::children(&doc, W2), vec![S1, T1, S2, GR]);
    }

    #[test]
    fn a_tab_whose_parent_no_file_knows_lands_on_the_lowest_id_workspace() {
        // A peer's file holds a tab under a group no file has ever held, so
        // nothing says where that group stood.
        let (store, key, ids, mut docs) = devices_holding_a_nested_group(1);
        let peer = DeviceId::from_bytes([0x77; 16]);
        let mut theirs = base_doc();
        theirs.add_tab(
            Uuid::from_u128(0x999),
            "t1",
            "https://t1.example",
            T1,
            peer,
            5_000,
        );
        theirs.stamp_write(peer, 5_000);
        store::save_document(&store, &key, peer, "ws-1", &theirs).unwrap();

        sync(&store, &key, ids[0], "ws-1", &mut docs[0], 6_000).unwrap();

        let lowest = ws_of(&base_doc());
        assert_eq!(docs[0].node(T1).unwrap().placement.parent, Some(lowest));
    }

    #[test]
    fn a_group_a_peer_filed_under_a_tab_lands_beside_that_tab_after_sync() {
        // `move_node` refuses a tab as a parent, but a peer on another build
        // can still write one. The group and what is in it must come out of
        // the sync beside that tab, in the tab's workspace, which is not the
        // lowest-id one.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());

        let mut a = base_doc();
        let work = a.add_workspace("work", None, Uuid::from_u128(u128::MAX), dev_a, 100);
        let tab = a.add_tab(
            work,
            "a tab",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev_a,
            101,
        );
        let after = a.add_tab(
            work,
            "after",
            "https://g.example",
            crate::types::test_support::test_id(),
            dev_a,
            102,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 110).unwrap();

        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 120).unwrap();
        let group = b.add_group(
            tab,
            "under a tab",
            None,
            crate::types::test_support::test_id(),
            dev_b,
            130,
        );
        let inside = b.add_tab(
            group,
            "inside",
            "https://f.example",
            crate::types::test_support::test_id(),
            dev_b,
            140,
        );
        // Written as that build would, without this build's repair.
        b.stamp_write(dev_b, 150);
        seal_at(
            &store,
            &key,
            &store::device_path(&key, "ws-1", dev_b),
            b.to_json().unwrap().as_bytes(),
        );

        let report = sync(&store, &key, dev_a, "ws-1", &mut a, 200).unwrap();

        assert_eq!(report.repaired, vec![group]);
        assert_eq!(tree::children(&a, work), vec![tab, group, after]);
        assert_eq!(tree::children(&a, group), vec![inside]);
    }

    #[test]
    fn a_device_restored_from_backup_recovers_its_own_offline_writes() {
        // A device's persisted id survives a restore from backup, but its
        // local document is rolled back to before an offline-written node
        // existed. `sync` reads this device's own stored file, which still
        // has that node, and merges it back in before writing, or the
        // rollback becomes permanent and reaches every peer.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();

        let mut doc = base_doc();
        let offline_tab = doc.add_tab(
            ws_of(&doc),
            "written while offline",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev,
            100,
        );
        sync(&store, &key, dev, "ws-1", &mut doc, 110).unwrap();
        assert!(doc.node(offline_tab).is_some());

        // Simulate the restore: the same device id, but a document rolled
        // back to before `offline_tab` existed.
        let mut restored = base_doc();
        let report = sync(&store, &key, dev, "ws-1", &mut restored, 200).unwrap();

        assert!(
            restored.node(offline_tab).is_some(),
            "sync did not recover this device's own previously-written node from its own stored file"
        );
        assert!(report.merged >= 1, "own file must count as merged");
    }

    #[test]
    fn a_local_deletion_survives_the_next_sync_reading_our_own_file() {
        // The mirror of the test above: our own stored file predates the
        // deletion, and merging it must not undo it.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();

        let mut doc = base_doc();
        let tab = doc.add_tab(
            ws_of(&doc),
            "doomed",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev,
            100,
        );
        sync(&store, &key, dev, "ws-1", &mut doc, 110).unwrap();

        doc.remove(tab);
        sync(&store, &key, dev, "ws-1", &mut doc, 200).unwrap();
        assert!(doc.node(tab).is_none(), "our own file resurrected it");

        // And it stays gone: the written file must not contain it either.
        sync(&store, &key, dev, "ws-1", &mut doc, 300).unwrap();
        assert!(doc.node(tab).is_none());
        let stored = crate::store::load_document(&store, &key, dev, "ws-1").unwrap();
        assert!(
            stored.node(tab).is_none(),
            "the published file still has it"
        );
    }

    /// A pass is stamped with the time it began, and the host may add a node
    /// during it, stamped later. The file the pass writes must still claim
    /// everything this device put in it, or that node reads as news to the
    /// device itself once removed, from its own file or from a peer's copy
    /// of it, and comes back.
    #[test]
    fn a_node_added_during_a_pass_stays_removed_through_its_own_file() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();

        let mut doc = base_doc();
        let tab = doc.add_tab(
            ws_of(&doc),
            "added mid-pass",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev,
            200,
        );
        sync(&store, &key, dev, "ws-1", &mut doc, 100).unwrap();

        doc.remove(tab);
        sync(&store, &key, dev, "ws-1", &mut doc, 300).unwrap();
        assert!(doc.node(tab).is_none(), "our own file brought it back");
        let stored = crate::store::load_document(&store, &key, dev, "ws-1").unwrap();
        assert!(
            stored.node(tab).is_none(),
            "the published file still has it"
        );
    }

    #[test]
    fn a_node_added_during_a_pass_stays_removed_through_a_peer() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());

        let mut a = base_doc();
        let tab = a.add_tab(
            ws_of(&a),
            "added mid-pass",
            "https://e.example",
            crate::types::test_support::test_id(),
            dev_a,
            200,
        );
        sync(&store, &key, dev_a, "ws-1", &mut a, 100).unwrap();
        let mut b = base_doc();
        sync(&store, &key, dev_b, "ws-1", &mut b, 110).unwrap();
        assert!(b.node(tab).is_some(), "B must have picked it up");

        a.remove(tab);
        sync(&store, &key, dev_a, "ws-1", &mut a, 300).unwrap();
        assert!(a.node(tab).is_none(), "B's copy brought it back to A");
        sync(&store, &key, dev_b, "ws-1", &mut b, 310).unwrap();
        assert!(b.node(tab).is_none(), "the removal must reach B");
        sync(&store, &key, dev_a, "ws-1", &mut a, 320).unwrap();
        assert!(a.node(tab).is_none());
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn a_recolour_publishes_and_reaches_the_other_device() {
        // The write decision is made from shared state alone, so after two
        // devices have settled, a recolour on one must be reason enough to
        // write, and must arrive on the other. With appearance outside
        // `Document::shared_state_json`, the colour would never leave A.
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());
        let mut a = base_doc();
        let mut b = base_doc();

        sync(&store, &key, dev_a, "ws-1", &mut a, 100).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 110).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 120).unwrap();
        let settled = shared_state(&a);
        assert_eq!(settled, shared_state(&b), "the two must start settled");

        let ws = ws_of(&a);
        a.set_appearance(
            ws,
            Some("purple".into()),
            Some("🌳".into()),
            None,
            dev_a,
            200,
        );
        assert_ne!(
            shared_state(&a),
            settled,
            "a recolour must register as a change to publish"
        );

        sync(&store, &key, dev_a, "ws-1", &mut a, 210).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 220).unwrap();

        let landed = b.node(ws).unwrap();
        assert_eq!(
            landed
                .appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("purple"),
            "the recolour must reach the other device"
        );
        assert_eq!(landed.appearance.emoji.as_deref(), Some("🌳"));
        assert_eq!(landed.appearance_at, 200);
        assert_eq!(landed.appearance_by, Some(dev_a));
    }

    #[test]
    fn an_idle_device_does_not_rewrite_its_own_file_on_every_sync() {
        let store = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let dev = DeviceId::new();
        let mut doc = base_doc();

        sync(&store, &key, dev, "ws-1", &mut doc, 100).unwrap();
        let mine = store.list("sval/ws/").unwrap().into_iter().next().unwrap();
        let first_write = store.read(&mine).unwrap();

        // Nothing changed locally and no peer wrote anything: a second sync
        // must not reseal and rewrite the file, nor stamp a fresh
        // `written_at`, which would make every poll a write (spec §6.5).
        sync(&store, &key, dev, "ws-1", &mut doc, 200).unwrap();
        let second_write = store.read(&mine).unwrap();

        assert_eq!(
            first_write, second_write,
            "an idle device's own file was rewritten with no changes to sync"
        );
    }

    /// A [`StorageProvider`] that counts the writes reaching it, wrapping a
    /// [`MemoryStore`] and delegating everything else.
    ///
    /// The idle-device guarantee is about traffic into the user's folder, so
    /// the measurement has to be writes: a test that counted syncs, or
    /// compared only the final bytes, would pass against an engine that
    /// rewrote each file on every poll with the same content.
    struct CountingStore {
        inner: MemoryStore,
        writes: std::sync::atomic::AtomicUsize,
    }

    impl CountingStore {
        fn new() -> Self {
            CountingStore {
                inner: MemoryStore::new(),
                writes: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn writes(&self) -> usize {
            self.writes.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl StorageProvider for CountingStore {
        fn list(&self, prefix: &str) -> Result<Vec<String>, Error> {
            self.inner.list(prefix)
        }

        fn read(&self, path: &str) -> Result<Vec<u8>, Error> {
            self.inner.read(path)
        }

        fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Error> {
            self.writes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.write(path, bytes)
        }
    }

    #[test]
    fn two_idle_devices_write_nothing_however_long_they_poll() {
        // Two devices is the case a poller runs. Merging a peer raises
        // `seen`, so a write decision over the whole document would find a
        // difference on every poll, write, raise the peer's `seen` in turn,
        // and never go quiet.
        let store = CountingStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());
        let mut a = base_doc();
        let mut b = base_doc();

        // Each device publishes once, which is a real write: neither had a
        // file before.
        sync(&store, &key, dev_a, "ws-1", &mut a, 100).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 110).unwrap();
        // One more round each, so both have read the other and both `seen`
        // maps are populated.
        sync(&store, &key, dev_a, "ws-1", &mut a, 120).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 130).unwrap();
        let settled_writes = store.writes();
        assert_eq!(
            settled_writes, 2,
            "settling two devices from nothing takes exactly one write each"
        );
        let path_a = store::device_path(&key, "ws-1", dev_a);
        let path_b = store::device_path(&key, "ws-1", dev_b);
        let bytes_a = store.read(&path_a).unwrap();
        let bytes_b = store.read(&path_b).unwrap();

        for now in [200, 210, 220, 230, 240, 250, 260, 270] {
            sync(&store, &key, dev_a, "ws-1", &mut a, now).unwrap();
            sync(&store, &key, dev_b, "ws-1", &mut b, now + 5).unwrap();
        }

        assert_eq!(
            store.writes(),
            settled_writes,
            "two idle devices wrote {} times over eight mutual polls",
            store.writes() - settled_writes
        );
        assert_eq!(bytes_a, store.read(&path_a).unwrap());
        assert_eq!(bytes_b, store.read(&path_b).unwrap());
        assert_eq!(shared_state(&a), shared_state(&b));
    }

    #[test]
    fn a_real_change_still_writes_and_publishes_the_current_watermarks() {
        let store = CountingStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b) = (DeviceId::new(), DeviceId::new());
        let mut a = base_doc();
        let mut b = base_doc();

        sync(&store, &key, dev_a, "ws-1", &mut a, 100).unwrap();
        sync(&store, &key, dev_b, "ws-1", &mut b, 110).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 120).unwrap();
        let idle_writes = store.writes();

        // B publishes a tab. A's next sync has a real reason to write, and the
        // file it writes must carry the watermarks A has accumulated, B's
        // newest write among them: that is the evidence a peer needs to read
        // a later absence as a deletion (spec §5.4).
        let tab = b.add_tab(
            ws_of(&b),
            "V",
            "https://v.example",
            Uuid::from_u128(11),
            dev_b,
            200,
        );
        sync(&store, &key, dev_b, "ws-1", &mut b, 210).unwrap();
        sync(&store, &key, dev_a, "ws-1", &mut a, 220).unwrap();

        assert_eq!(
            store.writes(),
            idle_writes + 2,
            "a real change on each side must produce exactly one write each"
        );
        assert!(a.node(tab).is_some(), "A must have picked the tab up");
        let published = store::load_document(&store, &key, dev_a, "ws-1").unwrap();
        assert_eq!(
            published.seen.get(&dev_b),
            Some(&210),
            "A's published file must carry what A has incorporated from B"
        );
        assert_eq!(published.seen.get(&dev_a), Some(&220));
        assert_eq!(published.written_at, 220);
        assert_eq!(published.written_by, Some(dev_a));
    }

    #[test]
    fn a_deletion_a_stale_file_delayed_propagates_on_the_next_real_change() {
        // Watermark advances ride along with the next write that has a reason
        // to happen, so a device whose evidence for a deletion arrived after
        // its last write publishes that evidence late. This asserts the cost
        // is a *delay*: B keeps the node while A's file is stale, and while
        // the watermark A publishes is ahead of every file B can see from the
        // device it names, and drops it once both have arrived.
        //
        // B syncs against its own store holding a copy of A's published file,
        // which is what a provider mid-propagation looks like: B can see A's
        // file without yet seeing C's.
        let main = MemoryStore::new();
        let key = crate::types::test_support::test_key();
        let (dev_a, dev_b, dev_c) = (DeviceId::new(), DeviceId::new(), DeviceId::new());

        // C creates U, publishes, edits it, publishes again, then deletes it
        // and publishes a third time.
        let mut c = base_doc();
        let u = c.add_tab(
            ws_of(&c),
            "U",
            "https://u.example",
            Uuid::from_u128(21),
            dev_c,
            100,
        );
        sync(&main, &key, dev_c, "ws-1", &mut c, 110).unwrap();

        // A picks U up at its first value and publishes: its watermark for C
        // covers the creation but nothing later.
        let mut a = base_doc();
        sync(&main, &key, dev_a, "ws-1", &mut a, 120).unwrap();
        assert!(a.node(u).is_some());

        // A closes U and publishes, holding only the 110 watermark for C.
        a.remove(u);
        sync(&main, &key, dev_a, "ws-1", &mut a, 130).unwrap();
        let stale = store::load_document(&main, &key, dev_a, "ws-1").unwrap();
        assert_eq!(stale.seen.get(&dev_c), Some(&110));
        assert!(stale.node(u).is_none());

        // C, which has not read A's file, edits U and publishes. B takes that
        // file and nothing else, so B holds U at its edited value.
        c.set_content(
            u,
            "U edited",
            Some("https://u.example".into()),
            None,
            None,
            false,
            dev_c,
            200,
        );
        sync(&main, &key, dev_c, "ws-1", &mut c, 210).unwrap();
        let mut b = base_doc();
        crate::merge::merge(
            &mut b,
            &store::load_document(&main, &key, dev_c, "ws-1").unwrap(),
        );
        assert_eq!(b.node(u).map(|n| n.content_at), Some(200));

        // C closes U too and publishes. A reads that file, which lacks U and
        // so offers nothing to adopt, and learns C's 300 watermark, which
        // covers the 200 edit. Nothing else changed, so A does not write and
        // its published file keeps the 110 watermark.
        c.remove(u);
        sync(&main, &key, dev_c, "ws-1", &mut c, 300).unwrap();
        sync(&main, &key, dev_a, "ws-1", &mut a, 310).unwrap();
        assert!(a.node(u).is_none(), "A must keep U deleted");
        assert_eq!(a.seen.get(&dev_c), Some(&300));
        let still_stale = store::load_document(&main, &key, dev_a, "ws-1").unwrap();
        assert_eq!(
            still_stale.seen.get(&dev_c),
            Some(&110),
            "an idle A must not have rewritten its file"
        );

        // B, seeing only A's stale file, keeps U. This is the delay, and it is
        // the safe direction: a stale watermark makes more things news.
        let b_store = MemoryStore::new();
        let a_path = store::device_path(&key, "ws-1", dev_a);
        b_store
            .write(&a_path, &main.read(&a_path).unwrap())
            .unwrap();
        sync(&b_store, &key, dev_b, "ws-1", &mut b, 400).unwrap();
        assert!(
            b.node(u).is_some(),
            "a stale published watermark must keep the node, not drop it"
        );

        // A does something real. The write carries the watermarks it has been
        // holding, and B applies the deletion.
        let v = a.add_tab(
            ws_of(&a),
            "V",
            "https://v.example",
            Uuid::from_u128(22),
            dev_a,
            500,
        );
        sync(&main, &key, dev_a, "ws-1", &mut a, 510).unwrap();
        let published = store::load_document(&main, &key, dev_a, "ws-1").unwrap();
        assert_eq!(published.seen.get(&dev_c), Some(&300));

        b_store
            .write(&a_path, &main.read(&a_path).unwrap())
            .unwrap();
        sync(&b_store, &key, dev_b, "ws-1", &mut b, 520).unwrap();
        assert!(b.node(v).is_some(), "B must pick up A's new tab");
        assert!(
            b.node(u).is_some(),
            "A's watermark for C is ahead of every C file B can see, so it \
             is not taken on yet"
        );

        // C's file reaches B's folder, which bears A's watermark out, and B
        // applies the deletion.
        let c_path = store::device_path(&key, "ws-1", dev_c);
        b_store
            .write(&c_path, &main.read(&c_path).unwrap())
            .unwrap();
        sync(&b_store, &key, dev_b, "ws-1", &mut b, 530).unwrap();
        assert!(b.node(u).is_none(), "the deletion must land");
        assert_eq!(b.seen.get(&dev_c), Some(&300));
    }

    #[test]
    fn export_is_plaintext_and_contains_the_tree() {
        let mut doc = base_doc();
        doc.add_workspace(
            "Client A",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let out = export_json(&doc).unwrap();
        assert!(out.contains("Client A"));
        serde_json::from_str::<serde_json::Value>(&out).expect("export must be valid json");
    }

    // --- a copy that begins under an id with earlier writes (decision 2232)

    /// A pass on `store` as `device`, of the copy `target` names.
    fn pass_on(
        store: &MemoryStore,
        key: &Key,
        device: DeviceId,
        doc: &mut Document,
        now: Timestamp,
        target: Target,
    ) -> SyncReport {
        sync_to(store, key, device, "ws-1", doc, now, None, target, None).unwrap()
    }

    /// A copies `folder`'s file of `device` into `into`.
    fn copy_file(folder: &MemoryStore, into: &MemoryStore, key: &Key, device: DeviceId) {
        let path = store::device_path(key, "ws-1", device);
        into.write(&path, &folder.read(&path).unwrap()).unwrap();
    }

    /// A begins again with an empty copy under the id it synced under, its
    /// old file still in the folder: its own copy first, then the folder.
    /// What it made before is kept on both devices.
    #[test]
    fn a_copy_begun_again_under_its_old_id_keeps_what_the_id_made() {
        let (folder, key, (dev_a, dev_b), (_, mut b), tab) = two_devices_in_sync();

        let profile = MemoryStore::new();
        let mut again = Document::new();
        pass_on(&profile, &key, dev_a, &mut again, 300, Target::Profile);
        pass_on(&folder, &key, dev_a, &mut again, 310, Target::Shared);
        assert!(again.node(tab).is_some(), "A gets back what it made");

        sync_to(
            &folder,
            &key,
            dev_b,
            "ws-1",
            &mut b,
            320,
            None,
            Target::Shared,
            None,
        )
        .unwrap();
        assert!(b.node(tab).is_some(), "B keeps what A made");
        assert_eq!(shared_state(&again), shared_state(&b));
    }

    /// The start is kept in the copy's own file, so a copy that begins, stops
    /// before it reaches the folder, and is read back from its file still
    /// knows what it never held.
    #[test]
    fn a_copy_read_back_from_its_own_file_keeps_its_start() {
        let (folder, key, (dev_a, _), _, tab) = two_devices_in_sync();

        let profile = MemoryStore::new();
        let mut begun = Document::new();
        pass_on(&profile, &key, dev_a, &mut begun, 300, Target::Profile);

        let mut reopened = Document::new();
        pass_on(&profile, &key, dev_a, &mut reopened, 305, Target::Profile);
        pass_on(&folder, &key, dev_a, &mut reopened, 310, Target::Shared);
        assert!(reopened.node(tab).is_some());
    }

    /// With its old file gone from the folder, a copy begun again under the
    /// id gets the id's earlier writes back from a peer's file.
    #[test]
    fn a_copy_begun_again_gets_the_ids_writes_back_from_a_peer() {
        let (folder, key, (dev_a, dev_b), (_, mut b), tab) = two_devices_in_sync();
        let only_b = MemoryStore::new();
        copy_file(&folder, &only_b, &key, dev_b);

        let mut again = Document::new();
        pass_on(
            &MemoryStore::new(),
            &key,
            dev_a,
            &mut again,
            300,
            Target::Profile,
        );
        pass_on(&only_b, &key, dev_a, &mut again, 310, Target::Shared);
        assert!(again.node(tab).is_some(), "A gets T back from B's file");

        sync_to(
            &only_b,
            &key,
            dev_b,
            "ws-1",
            &mut b,
            320,
            None,
            Target::Shared,
            None,
        )
        .unwrap();
        assert!(b.node(tab).is_some(), "B keeps T");
    }

    /// Once the copy holds the id's earlier writes, deleting one deletes it
    /// everywhere, as any deletion does.
    #[test]
    fn a_deletion_after_the_copy_got_the_ids_writes_back_spreads() {
        let (folder, key, (dev_a, dev_b), (_, mut b), tab) = two_devices_in_sync();

        let mut again = Document::new();
        pass_on(
            &MemoryStore::new(),
            &key,
            dev_a,
            &mut again,
            300,
            Target::Profile,
        );
        pass_on(&folder, &key, dev_a, &mut again, 310, Target::Shared);
        sync_to(
            &folder,
            &key,
            dev_b,
            "ws-1",
            &mut b,
            320,
            None,
            Target::Shared,
            None,
        )
        .unwrap();

        again.remove(tab);
        pass_on(&folder, &key, dev_a, &mut again, 400, Target::Shared);
        sync_to(
            &folder,
            &key,
            dev_b,
            "ws-1",
            &mut b,
            410,
            None,
            Target::Shared,
            None,
        )
        .unwrap();
        pass_on(&folder, &key, dev_a, &mut again, 420, Target::Shared);
        assert!(b.node(tab).is_none(), "A's deletion reaches B");
        assert!(again.node(tab).is_none(), "B's file brings nothing back");
    }

    /// The copy's own file keeps how much of the id's earlier work it took,
    /// so a deletion made after it is read back still spreads.
    #[test]
    fn a_copy_read_back_after_taking_the_ids_writes_keeps_its_deletions() {
        let (folder, key, (dev_a, dev_b), (_, mut b), tab) = two_devices_in_sync();
        let profile = MemoryStore::new();

        let mut again = Document::new();
        pass_on(&profile, &key, dev_a, &mut again, 300, Target::Profile);
        pass_on(&folder, &key, dev_a, &mut again, 310, Target::Shared);
        pass_on(&profile, &key, dev_a, &mut again, 315, Target::Profile);

        let mut reopened = Document::new();
        pass_on(&profile, &key, dev_a, &mut reopened, 320, Target::Profile);
        reopened.remove(tab);
        pass_on(&folder, &key, dev_a, &mut reopened, 400, Target::Shared);
        sync_to(
            &folder,
            &key,
            dev_b,
            "ws-1",
            &mut b,
            410,
            None,
            Target::Shared,
            None,
        )
        .unwrap();
        assert!(
            reopened.node(tab).is_none(),
            "B's idle file brings nothing back"
        );
        assert!(b.node(tab).is_none(), "the deletion reaches B");
    }

    /// When a copy began stays in its profile copy: a peer that reads the
    /// folder never takes it as its own.
    #[test]
    fn the_folder_never_holds_when_a_copy_began() {
        let key = crate::types::test_support::test_key();
        let device = DeviceId::new();
        let (profile, folder) = (MemoryStore::new(), MemoryStore::new());
        let mut doc = base_doc();
        pass_on(&profile, &key, device, &mut doc, 100, Target::Profile);
        doc.earlier_to = 50;
        pass_on(&folder, &key, device, &mut doc, 110, Target::Shared);

        let read = |store: &MemoryStore| {
            let path = store::device_path(&key, "ws-1", device);
            Document::from_json(std::str::from_utf8(&open_at(store, &key, &path)).unwrap()).unwrap()
        };
        assert_eq!(read(&profile).began_at, 100);
        let published = read(&folder);
        assert_eq!((published.began_at, published.earlier_to), (0, 0));
    }

    /// A file showing the id's earlier writes brings back only that id's
    /// stamps: what another device wrote, and the copy has since deleted,
    /// stays deleted. Here C's file, which read A's last old file, reaches
    /// the folder after the copy took the earlier work from B's.
    #[test]
    fn a_file_of_earlier_writes_brings_back_only_the_ids_own() {
        let (folder, key, (dev_a, dev_b), (mut a, mut b), _) = two_devices_in_sync();
        let theirs = b.add_tab(
            ws_of(&b),
            "U",
            "https://u.example",
            Uuid::from_u128(2_000),
            dev_b,
            140,
        );
        sync(&folder, &key, dev_b, "ws-1", &mut b, 150).unwrap();
        let later = MemoryStore::new();
        copy_file(&folder, &later, &key, dev_b);
        a.rename(ws_of(&a), "Renamed", dev_a, 155);
        sync(&folder, &key, dev_a, "ws-1", &mut a, 160).unwrap();
        let dev_c = DeviceId::new();
        let mut c = Document::new();
        sync(&folder, &key, dev_c, "ws-1", &mut c, 170).unwrap();
        assert!(c.node(theirs).is_some(), "C holds U");

        let mut again = Document::new();
        pass_on(
            &MemoryStore::new(),
            &key,
            dev_a,
            &mut again,
            300,
            Target::Profile,
        );
        pass_on(&later, &key, dev_a, &mut again, 310, Target::Shared);
        again.remove(theirs);
        pass_on(&later, &key, dev_a, &mut again, 320, Target::Shared);

        copy_file(&folder, &later, &key, dev_c);
        pass_on(&later, &key, dev_a, &mut again, 330, Target::Shared);
        assert!(again.node(theirs).is_none(), "B's tab stays deleted");
    }
}
