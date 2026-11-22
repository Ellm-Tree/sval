// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The calls a host makes that are more than one change to a document: a
//! sync pass over files the host already read, the Archive's sweep, restore
//! and import, and sealing a pairing file. Each takes plain Rust values and
//! answers a [`Failure`] on refusal, so the `wasm` and `ffi` boundaries call
//! the same checked function, and it runs under plain `cargo test`.

use crate::crypto::Key;
use crate::failure::{Failure, Invalid, Reason};
#[cfg(any(feature = "wasm", test))]
use crate::ops::parse_id;
use crate::ops::{MAX_SAFE_TIMESTAMP, parse_device_id, parse_timestamp};
use crate::store::StorageProvider;
use crate::sync::{FileProblem, SyncReport, Target};
use crate::types::{Document, Error, NodeId, Timestamp};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::BTreeMap;

/// A [`StorageProvider`] over files a WASM host already fetched, and one
/// write slot for whatever [`crate::sync::sync_to`] produces.
pub(crate) struct PreloadedStore {
    files: BTreeMap<String, Vec<u8>>,
    written: RefCell<Option<PathAndBytes>>,
}

impl PreloadedStore {
    pub(crate) fn new(files: Vec<PathAndBytes>) -> Self {
        PreloadedStore {
            files: files.into_iter().collect(),
            written: RefCell::new(None),
        }
    }

    /// Takes the one write `sync` made, if any, for the host to persist.
    pub(crate) fn into_written(self) -> Option<PathAndBytes> {
        self.written.into_inner()
    }
}

impl StorageProvider for PreloadedStore {
    fn list(&self, prefix: &str) -> Result<Vec<String>, Error> {
        Ok(self
            .files
            .keys()
            .filter(|path| path.starts_with(prefix))
            .cloned()
            .collect())
    }

    fn read(&self, path: &str) -> Result<Vec<u8>, Error> {
        // A file absent from the snapshot is "not found". `sync` treats a
        // fresh device's own missing file as nothing to merge yet.
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| Error::NotFound(path.to_string()))
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Error> {
        *self.written.borrow_mut() = Some((path.to_string(), bytes.to_vec()));
        Ok(())
    }
}

/// A mirror of [`SyncReport`] with the field names `docs/host-contract.md`
/// promises a host, pinned by
/// `sync_report_field_names_are_the_contracts_promise`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsSyncReport {
    merged: usize,
    errors: Vec<JsFileProblem>,
    schema_too_new: Vec<JsFileProblem>,
    refused_write: bool,
    repaired_ids: Vec<String>,
    pub(crate) changed_ids: Vec<String>,
    pub(crate) removed_ids: Vec<String>,
    harmed_by_clock: Vec<String>,
    own_watermark: Timestamp,
}

/// One [`FileProblem`], as a host reads it.
#[derive(Serialize)]
pub(crate) struct JsFileProblem {
    path: String,
    own: bool,
    device: String,
    reason: String,
}

impl From<FileProblem> for JsFileProblem {
    fn from(problem: FileProblem) -> Self {
        JsFileProblem {
            path: problem.path,
            own: problem.own,
            device: problem.device.to_string(),
            reason: problem.reason,
        }
    }
}

/// Node ids as the host reads them.
fn id_strings<'a>(ids: impl IntoIterator<Item = &'a NodeId>) -> Vec<String> {
    ids.into_iter().map(NodeId::to_string).collect()
}

impl From<SyncReport> for JsSyncReport {
    fn from(report: SyncReport) -> Self {
        JsSyncReport {
            merged: report.merged,
            errors: report.errors.into_iter().map(Into::into).collect(),
            schema_too_new: report.schema_too_new.into_iter().map(Into::into).collect(),
            refused_write: report.refused_write,
            repaired_ids: id_strings(&report.repaired),
            changed_ids: id_strings(&report.changed),
            removed_ids: id_strings(&report.removed),
            harmed_by_clock: report
                .harmed_by_clock
                .iter()
                .map(ToString::to_string)
                .collect(),
            own_watermark: report.own_watermark,
        }
    }
}

type PathAndBytes = (String, Vec<u8>);

/// [`run_sync_to`] on this device's profile copy of an ordinary document.
#[cfg(test)]
pub(crate) fn run_sync(
    doc: &mut Document,
    key_bytes: &[u8],
    device_id_bytes: &[u8],
    workspace: &str,
    peer_files: Vec<PathAndBytes>,
    now: f64,
) -> Result<(JsSyncReport, Option<PathAndBytes>), Failure> {
    run_sync_expiring(
        doc,
        key_bytes,
        device_id_bytes,
        workspace,
        peer_files,
        now,
        None,
    )
}

/// [`run_sync_to`] on this device's profile copy, dropping Archive entries
/// older than `retention` milliseconds.
#[cfg(test)]
pub(crate) fn run_sync_expiring(
    doc: &mut Document,
    key_bytes: &[u8],
    device_id_bytes: &[u8],
    workspace: &str,
    peer_files: Vec<PathAndBytes>,
    now: f64,
    retention: Option<f64>,
) -> Result<(JsSyncReport, Option<PathAndBytes>), Failure> {
    run_sync_to(
        doc,
        &mut crate::sync::OwnCopies::default(),
        key_bytes,
        device_id_bytes,
        workspace,
        peer_files,
        now,
        retention,
        Target::Profile,
        None,
    )
}

/// The pure-Rust core of one sync pass: builds a [`PreloadedStore`] from
/// `peer_files`, runs [`crate::sync::sync_to`], and returns the JSON-ready
/// report plus whatever write it produced. It takes no `JsValue`, so the
/// WASM sync path runs under plain `cargo test`.
#[expect(clippy::too_many_arguments)]
pub(crate) fn run_sync_to(
    doc: &mut Document,
    own_copies: &mut crate::sync::OwnCopies,
    key_bytes: &[u8],
    device_id_bytes: &[u8],
    workspace: &str,
    peer_files: Vec<PathAndBytes>,
    now: f64,
    retention: Option<f64>,
    target: Target,
    clamp_from: Option<f64>,
) -> Result<(JsSyncReport, Option<PathAndBytes>), Failure> {
    let key = Key::from_bytes(key_bytes)?;
    let device = parse_device_id(device_id_bytes)?;
    let now = parse_timestamp(now)?;
    let retention = retention.map(parse_timestamp).transpose()?;
    let clamp_from = clamp_from.map(parse_timestamp).transpose()?;
    let store = PreloadedStore::new(peer_files);
    let report = crate::sync::sync_remembering(
        &store, &key, device, workspace, doc, now, retention, target, clamp_from, own_copies,
    )?;
    Ok((report.into(), store.into_written()))
}

/// What a host hands a sweep, as JSON (idle-tab archive spec §4.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(any(feature = "wasm", test))]
struct JsSweep {
    default: String,
    #[serde(default)]
    last_active: BTreeMap<String, f64>,
    #[serde(default)]
    exempt: Vec<String>,
}

/// Runs [`crate::archive::archive_idle`] on `tree` and `archive` for the
/// sweep `sweep_json` describes, and answers `{ tabs, entries }`.
#[cfg(any(feature = "wasm", test))]
pub(crate) fn run_archive_idle(
    tree: &mut Document,
    archive: &mut Document,
    sweep_json: &str,
    device_id: &[u8],
    now: f64,
) -> Result<String, Failure> {
    let sweep: JsSweep = serde_json::from_str(sweep_json)
        .map_err(|err| Invalid::new(Reason::BadSweep, format!("not a sweep: {err}")))?;
    let by = parse_device_id(device_id)?;
    let now = parse_timestamp(now)?;
    let mut last_active = BTreeMap::new();
    for (id, at) in sweep.last_active {
        last_active.insert(parse_id(&id)?, parse_timestamp(at)?);
    }
    let exempt = sweep
        .exempt
        .iter()
        .map(|id| parse_id(id))
        .collect::<Result<_, _>>()?;
    let swept = crate::archive::archive_idle(
        tree,
        archive,
        &crate::archive::Sweep {
            default: &sweep.default,
            last_active: &last_active,
            exempt: &exempt,
        },
        by,
        now,
    )?;
    Ok(swept_json(&swept))
}

/// A sweep's answer to the host: `{ tabs, entries }`.
#[cfg(any(feature = "wasm", test))]
fn swept_json(swept: &crate::archive::Swept) -> String {
    serde_json::json!({ "tabs": id_strings(&swept.tabs), "entries": id_strings(&swept.entries) })
        .to_string()
}

/// Runs [`crate::archive::archive_now`] on `tree` and `archive` for tab
/// `id`, and answers `{ tabs, entries }`, as a sweep does.
#[cfg(any(feature = "wasm", test))]
pub(crate) fn run_archive_now(
    tree: &mut Document,
    archive: &mut Document,
    id: &str,
    device_id: &[u8],
    now: f64,
) -> Result<String, Failure> {
    let id = parse_id(id)?;
    let by = parse_device_id(device_id)?;
    let now = parse_timestamp(now)?;
    let swept = crate::archive::archive_now(tree, archive, id, by, now)?;
    Ok(swept_json(&swept))
}

/// A tab another browser archived, as a host hands it to `importArchived`
/// (idle-tab archive spec §7.6).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(any(feature = "wasm", test))]
struct JsImported {
    tab: String,
    title: String,
    url: Option<String>,
    workspace: String,
    #[serde(default)]
    workspace_name: String,
    closed_at: f64,
}

/// Runs [`crate::archive::add_imported`] on `archive` for the entries
/// `entries_json` lists, and answers their ids.
#[cfg(any(feature = "wasm", test))]
pub(crate) fn run_import_archived(
    archive: &mut Document,
    entries_json: &str,
    device_id: &[u8],
    now: f64,
) -> Result<String, Failure> {
    let given: Vec<JsImported> = serde_json::from_str(entries_json).map_err(|err| {
        Invalid::new(
            Reason::BadArchivedTabs,
            format!("not a list of archived tabs: {err}"),
        )
    })?;
    let by = parse_device_id(device_id)?;
    let now = parse_timestamp(now)?;
    let entries = given
        .into_iter()
        .map(|e| {
            Ok(crate::archive::Imported {
                tab: parse_id(&e.tab)?,
                title: e.title,
                url: e.url,
                workspace: parse_id(&e.workspace)?,
                workspace_name: e.workspace_name,
                closed_at: parse_timestamp(e.closed_at)?,
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    let ids = crate::archive::add_imported(archive, &entries, by, now)?;
    Ok(serde_json::to_string(&id_strings(&ids))?)
}

/// Runs [`crate::archive::restore`] and answers `{ tabs, split, workspace }`.
#[cfg(any(feature = "wasm", test))]
pub(crate) fn run_restore(
    tree: &mut Document,
    archive: &mut Document,
    entry: &str,
    current: &str,
    ids: &[String],
    device_id: &[u8],
    now: f64,
) -> Result<String, Failure> {
    let entry = parse_id(entry)?;
    let current = parse_id(current)?;
    let ids = ids
        .iter()
        .map(|id| parse_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let by = parse_device_id(device_id)?;
    let now = parse_timestamp(now)?;
    let restored = crate::archive::restore(tree, archive, entry, current, &ids, by, now)?;
    Ok(serde_json::json!({
        "tabs": restored.tabs.iter().map(NodeId::to_string).collect::<Vec<_>>(),
        "split": restored.split.map(|id| id.to_string()),
        "workspace": restored.workspace.to_string(),
    })
    .to_string())
}

/// This device's own path within `sync_prefix`'s directory: the file a
/// host must treat as "stop the pass" when it exists but cannot be read (see
/// `SvalSync.worker.mjs`'s own-file guard). [`crate::store::device_path`]
/// decides the naming, so a host never reimplements it.
pub(crate) fn own_device_path(
    key_bytes: &[u8],
    workspace: &str,
    device_id_bytes: &[u8],
) -> Result<String, Failure> {
    let key = Key::from_bytes(key_bytes)?;
    let device = parse_device_id(device_id_bytes)?;
    Ok(crate::store::device_path(&key, workspace, device))
}

/// Formats a bare 12-character code (as [`crate::pairing::generate_code`]
/// produces) into the grouped display form a host shows the user: three
/// groups of four separated by dashes. The pure core of
/// `wasm::generate_pairing_code`, so it runs under plain `cargo test`.
///
/// Returns `None` if `code` is not exactly 12 ASCII characters, where the
/// byte slices would panic (`docs/host-contract.md` §8).
pub(crate) fn group_code_for_display(code: &str) -> Option<String> {
    if code.len() != 12 || !code.is_ascii() {
        return None;
    }
    Some([&code[0..4], &code[4..8], &code[8..12]].join("-"))
}

/// Validates `ttl_ms`: finite, and small enough that `now + ttl_ms` does not
/// exceed `MAX_SAFE_TIMESTAMP`, or `pairingExpiresAt` would return a value
/// that `parse_timestamp` refuses. A negative `ttl_ms` passes:
/// [`crate::pairing::seal`] clamps it to zero (an already-expired file), and
/// `now` is already in range.
fn parse_ttl_ms(ttl_ms: f64, now: Timestamp) -> Result<i64, Invalid> {
    if !ttl_ms.is_finite() {
        return Err(Invalid::new(
            Reason::TtlNotFinite,
            format!("ttlMs must be a finite number, got {ttl_ms}"),
        ));
    }
    let expiry = now as f64 + ttl_ms;
    if expiry > MAX_SAFE_TIMESTAMP {
        return Err(Invalid::new(
            Reason::ExpiryOutOfRange,
            format!(
                "now + ttlMs must not exceed {MAX_SAFE_TIMESTAMP} (JS's Number.MAX_SAFE_INTEGER): got {expiry}"
            ),
        ));
    }
    Ok(ttl_ms as i64)
}

/// The pure core of `sealPairing`, so its validation runs under plain
/// `cargo test`.
pub(crate) fn seal_pairing_core(
    key_bytes: &[u8],
    code: &str,
    now: f64,
    ttl_ms: f64,
) -> Result<Vec<u8>, Failure> {
    let key = Key::from_bytes(key_bytes)?;
    let now = parse_timestamp(now)?;
    let ttl_ms = parse_ttl_ms(ttl_ms, now)?;
    Ok(crate::pairing::seal(&key, code, now, ttl_ms)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::apply_batch;
    use crate::ops::test_support::{ALICE, BOB, apply, key_bytes};
    use crate::store::{DeviceId as StoreDeviceId, save_document};
    use crate::types::test_support::{test_device, uid};

    // --- PreloadedStore: a missing file is absent, never a thrown error -

    #[test]
    fn a_missing_own_file_is_not_found_not_a_thrown_protocol() {
        let store = PreloadedStore::new(vec![]);
        let err = store.read("sval/ws/x/dev.json").unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));
    }

    #[test]
    fn a_fresh_device_with_no_own_file_still_produces_a_write() {
        // A missing own file read as a failure would set `refuse_write` in
        // `sync`, and a fresh device would never publish.
        let mut doc = Document::new();
        doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            1,
        );
        let (_, write) = run_sync(&mut doc, &key_bytes(), &[0u8; 16], "ws-1", vec![], 0.0).unwrap();
        assert!(
            write.is_some(),
            "a fresh device with nothing to merge from must still publish its own file"
        );
    }

    #[test]
    fn the_hosts_own_file_is_folded_in_when_present_in_the_snapshot() {
        let key = Key::from_bytes(&key_bytes()).unwrap();
        let device = StoreDeviceId::from_bytes([7u8; 16]);
        let mut existing = Document::new();
        let ws_id = crate::types::test_support::test_id();
        existing.add_workspace("Existing", None, ws_id, test_device(), 5);
        let own_store = crate::store::MemoryStore::new();
        save_document(&own_store, &key, device, "ws-1", &existing).unwrap();
        let own_path = crate::store::device_path(&key, "ws-1", device);
        let own_bytes = own_store.read(&own_path).unwrap();

        let mut fresh_local = Document::new();
        let (report, write) = run_sync(
            &mut fresh_local,
            &key.to_bytes(),
            &[7u8; 16],
            "ws-1",
            vec![(own_path, own_bytes)],
            0.0,
        )
        .unwrap();

        assert_eq!(report.merged, 1);
        assert!(fresh_local.node(ws_id).is_some());
        assert!(write.is_none(), "unchanged content must not be rewritten");
    }

    #[test]
    fn a_preloaded_store_lists_the_paths_under_a_prefix() {
        let store = PreloadedStore::new(vec![
            ("sval/ws/a/1.json".into(), vec![1]),
            ("sval/ws/b/2.json".into(), vec![2]),
        ]);
        assert_eq!(store.list("sval/ws/a/").unwrap(), vec!["sval/ws/a/1.json"]);
        assert_eq!(store.list("sval/").unwrap().len(), 2);
    }

    // --- the sync timestamp is validated, not trusted ------------------

    #[test]
    fn run_sync_rejects_an_infinite_now_rather_than_stamping_u64_max() {
        // `run_sync` is the natively testable core of `SvalDocument::sync`.
        // `u64::MAX` as a `written_at` would tell every peer this device has
        // seen everything they will ever write, and so suppress every node
        // they have that it lacks (spec §5.4).
        let mut doc = Document::new();
        doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            1,
        );
        let result = run_sync(
            &mut doc,
            &key_bytes(),
            &[0u8; 16],
            "ws-1",
            vec![],
            f64::INFINITY,
        );
        let err = match result {
            Ok(_) => panic!("expected an error for an infinite now"),
            Err(err) => err,
        };
        assert_eq!(err.reason, Some(Reason::TimestampNotFinite), "{err:?}");
    }

    #[test]
    fn run_sync_rejects_a_nan_now_rather_than_silently_stamping_zero() {
        let mut doc = Document::new();
        doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            1,
        );
        let result = run_sync(&mut doc, &key_bytes(), &[0u8; 16], "ws-1", vec![], f64::NAN);
        let err = match result {
            Ok(_) => panic!("expected an error for a NaN now"),
            Err(err) => err,
        };
        assert_eq!(err.reason, Some(Reason::TimestampNotFinite), "{err:?}");
    }

    // --- serialised field names are the contract -----------------------

    #[test]
    fn sync_report_field_names_are_the_contracts_promise() {
        let report = SyncReport {
            merged: 1,
            errors: vec![FileProblem {
                path: "sval/ws/x/a.json".into(),
                own: true,
                device: crate::store::DeviceId::from_bytes([0xcd; 16]),
                reason: "r".into(),
            }],
            schema_too_new: vec![],
            refused_write: true,
            repaired: vec![],
            changed: vec![],
            removed: vec![],
            harmed_by_clock: vec![crate::store::DeviceId::from_bytes([0xab; 16])],
            own_watermark: 5,
        };
        let json: serde_json::Value = serde_json::to_value(JsSyncReport::from(report)).unwrap();
        for field in [
            "merged",
            "errors",
            "schemaTooNew",
            "refusedWrite",
            "repairedIds",
            "changedIds",
            "removedIds",
            "harmedByClock",
            "ownWatermark",
        ] {
            assert!(json.get(field).is_some(), "missing field {field} in {json}");
        }
        assert_eq!(
            json["errors"][0],
            serde_json::json!({
                "path": "sval/ws/x/a.json",
                "own": true,
                "device": "cd".repeat(16),
                "reason": "r",
            })
        );
        assert_eq!(json["harmedByClock"][0], "ab".repeat(16));
    }

    #[test]
    fn a_shared_pass_publishes_no_local_node_and_a_profile_pass_keeps_it() {
        let key = key_bytes();
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": "00000000-0000-0000-0000-000000000001" },
            { "kind": "addTab", "parent": "00000000-0000-0000-0000-000000000001",
              "name": "Notes", "url": "file:///notes.html",
              "id": "00000000-0000-0000-0000-000000000002", "local": true },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &[1; 16], 10.0).unwrap();
        let written = |target| {
            let mut copy = doc.clone();
            let (_, write) = run_sync_to(
                &mut copy,
                &mut crate::sync::OwnCopies::default(),
                &key,
                &[1; 16],
                "ws-1",
                vec![],
                20.0,
                None,
                target,
                None,
            )
            .unwrap();
            let (path, bytes) = write.unwrap();
            let k = Key::from_bytes(&key).unwrap();
            let json = crate::crypto::open(&k, path.as_bytes(), &bytes).unwrap();
            Document::from_json(std::str::from_utf8(&json).unwrap()).unwrap()
        };
        assert_eq!(written(Target::Profile).nodes.len(), 2);
        assert_eq!(written(Target::Shared).nodes.len(), 1);
    }

    #[test]
    fn sync_report_repaired_ids_survive_the_json_conversion() {
        let id = NodeId::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        let report = SyncReport {
            merged: 2,
            errors: vec![],
            schema_too_new: vec![],
            refused_write: false,
            repaired: vec![id],
            changed: vec![],
            removed: vec![],
            harmed_by_clock: vec![],
            own_watermark: 0,
        };
        let js_report: JsSyncReport = report.into();
        let json = serde_json::to_string(&js_report).unwrap();
        assert!(
            json.contains("00000000-0000-0000-0000-000000000001"),
            "repaired id must reach the JSON a host reads: {json}"
        );
    }

    // --- own_device_path agrees with store::device_path -----------------

    #[test]
    fn own_device_path_matches_store_device_path_for_the_same_inputs() {
        let key_bytes = key_bytes();
        let key = Key::from_bytes(&key_bytes).unwrap();
        let device_id_bytes = [9u8; 16];
        let device = StoreDeviceId::from_bytes(device_id_bytes);
        let workspace = "ws-1";

        let expected = crate::store::device_path(&key, workspace, device);
        let actual = own_device_path(&key_bytes, workspace, &device_id_bytes).unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn own_device_path_rejects_a_bad_device_id_length() {
        let err = own_device_path(&key_bytes(), "ws-1", &[0u8; 15]).unwrap_err();
        assert_eq!(err.reason, Some(Reason::BadDeviceId), "{err:?}");
    }

    /// A shared folder as a host sees it: every device's file, handed whole
    /// to [`run_sync`], with the write it answers put back.
    #[derive(Default)]
    struct Folder(Vec<PathAndBytes>);

    impl Folder {
        fn sync(&mut self, doc: &mut Document, key: &[u8], device: &[u8; 16], now: f64) {
            let (_, write) = run_sync(doc, key, device, "ws-1", self.0.clone(), now).unwrap();
            if let Some((path, bytes)) = write {
                self.0.retain(|(held, _)| *held != path);
                self.0.push((path, bytes));
            }
        }
    }

    fn open_tab(doc: &mut Document, device: &[u8; 16], parent: NodeId, id: NodeId, now: f64) {
        let op = serde_json::json!({
            "kind": "addTab", "parent": parent, "name": "t", "url": "https://t.example/", "id": id,
        });
        apply(doc, device, now, op);
    }

    /// A year past 1 000 ms: the reading of a clock that has run fast.
    const FAST: f64 = 1_000.0 + 365.0 * 24.0 * 3600.0 * 1000.0;

    /// Alice and Bob in sync on one workspace, then Alice, her clock a year
    /// fast, opens a tab and both sync. Returns the folder, the key, both
    /// documents, the workspace and the fast tab.
    fn alice_published_with_a_fast_clock() -> (Folder, Vec<u8>, Document, Document, NodeId, NodeId)
    {
        let key = key_bytes();
        let mut folder = Folder::default();
        let (mut alice, mut bob) = (Document::new(), Document::new());
        let ws = uid(1);
        let op = serde_json::json!({ "kind": "addWorkspace", "name": "W", "id": ws });
        apply(&mut alice, &ALICE, 1_000.0, op);
        folder.sync(&mut alice, &key, &ALICE, 1_000.0);
        folder.sync(&mut bob, &key, &BOB, 1_100.0);

        let fast_tab = uid(2);
        open_tab(&mut alice, &ALICE, ws, fast_tab, FAST);
        folder.sync(&mut alice, &key, &ALICE, FAST);
        folder.sync(&mut bob, &key, &BOB, 1_300.0);
        assert!(bob.node(fast_tab).is_some());
        (folder, key, alice, bob, ws, fast_tab)
    }

    /// Once Alice's clock is put right, a tab she opens is news to Bob, who
    /// read her fast write: it reaches him and stays with her (spec §5.3, on
    /// clocks).
    #[test]
    fn a_tab_opened_after_a_fast_clock_is_corrected_reaches_both_devices() {
        let (mut folder, key, mut alice, mut bob, ws, _) = alice_published_with_a_fast_clock();

        let after = uid(3);
        open_tab(&mut alice, &ALICE, ws, after, 2_000.0);
        folder.sync(&mut alice, &key, &ALICE, 2_000.0);
        folder.sync(&mut bob, &key, &BOB, 2_100.0);
        folder.sync(&mut alice, &key, &ALICE, 2_200.0);

        assert!(bob.node(after).is_some(), "the peer never adopted the tab");
        assert!(alice.node(after).is_some(), "the device lost its own tab");
    }

    /// The cost: a tab Alice opened while her clock was fast and closes once
    /// it is put right stays open on Bob until real time passes the fast
    /// reading and Alice writes again. Nothing is lost on the way.
    #[test]
    fn a_fast_stamped_tab_closed_after_the_correction_lingers_on_the_peer_until_real_time_catches_up()
     {
        let (mut folder, key, mut alice, mut bob, ws, fast_tab) =
            alice_published_with_a_fast_clock();

        let op = serde_json::json!({ "kind": "remove", "id": fast_tab });
        apply(&mut alice, &ALICE, 2_000.0, op);
        folder.sync(&mut alice, &key, &ALICE, 2_000.0);
        folder.sync(&mut bob, &key, &BOB, 2_100.0);
        folder.sync(&mut alice, &key, &ALICE, 2_200.0);
        assert!(bob.node(fast_tab).is_some(), "the close reached Bob early");
        assert!(
            alice.node(fast_tab).is_none(),
            "Bob's copy came back to Alice"
        );

        let later = uid(4);
        open_tab(&mut alice, &ALICE, ws, later, FAST + 100.0);
        folder.sync(&mut alice, &key, &ALICE, FAST + 100.0);
        folder.sync(&mut bob, &key, &BOB, FAST + 200.0);
        assert!(bob.node(fast_tab).is_none(), "the close never reached Bob");
        assert!(bob.node(later).is_some());
        assert!(bob.node(ws).is_some() && alice.node(ws).is_some());
    }
}

#[cfg(test)]
mod pairing_bindings_tests {
    use super::*;

    #[test]
    fn the_grouped_code_round_trips_through_the_bindings() {
        let code = crate::pairing::generate_code().unwrap();
        let display = group_code_for_display(&code).unwrap();
        assert_eq!(display.len(), 14, "three groups of four and two dashes");
        assert_eq!(crate::pairing::normalize_code(&display), Some(code));
    }

    #[test]
    fn group_code_for_display_rejects_the_wrong_length_instead_of_panicking() {
        assert_eq!(group_code_for_display("short"), None);
        assert_eq!(group_code_for_display(""), None);
        assert_eq!(group_code_for_display("THIRTEENCHARS"), None);
    }

    #[test]
    fn group_code_for_display_rejects_non_ascii_instead_of_panicking_on_a_char_boundary() {
        // A byte slice would panic if a multi-byte UTF-8 character straddled
        // one of its boundaries.
        let twelve_with_multibyte = "é23456789012"; // 12 chars, but not 12 bytes
        assert_eq!(twelve_with_multibyte.chars().count(), 12);
        assert_eq!(group_code_for_display(twelve_with_multibyte), None);
    }

    #[test]
    fn seal_and_open_round_trip_on_the_grouped_display_form() {
        let key = crate::types::test_support::test_key();
        let code = crate::pairing::generate_code().unwrap();
        let display = group_code_for_display(&code).unwrap();
        let normalized = crate::pairing::normalize_code(&display).unwrap();

        let file = crate::pairing::seal(&key, &normalized, 1_000, 3_600_000).unwrap();
        let opened = crate::pairing::open(&file, &normalized).unwrap();
        assert_eq!(opened.to_bytes(), key.to_bytes());
        assert_eq!(
            crate::pairing::expires_at(&file).unwrap(),
            1_000 + 3_600_000
        );
    }

    #[test]
    fn a_wrong_code_and_a_malformed_file_produce_distinct_codes() {
        let key = crate::types::test_support::test_key();
        let code = crate::pairing::generate_code().unwrap();
        let file = crate::pairing::seal(&key, &code, 1_000, 3_600_000).unwrap();

        let wrong = crate::pairing::normalize_code("K7Q4-8MTZ-3RJW").unwrap();
        let wrong_err = match crate::pairing::open(&file, &wrong) {
            Err(err) => Failure::from(err),
            Ok(_) => panic!("expected a wrong code to be rejected"),
        };
        assert_eq!(wrong_err.code, "bad_pairing_code");

        let malformed_err = match crate::pairing::open(b"not json", &code) {
            Err(err) => Failure::from(err),
            Ok(_) => panic!("expected a malformed file to be rejected"),
        };
        assert_eq!(malformed_err.code, "malformed_pairing_file");
    }

    #[test]
    fn a_core_error_keeps_its_code_across_the_boundary() {
        let result = run_sync(
            &mut Document::new(),
            &[0u8; 31],
            &[0u8; 16],
            "ws-1",
            vec![],
            0.0,
        );
        let Err(err) = result else {
            panic!("expected a 31-byte key to be rejected");
        };
        assert_eq!(err.code, "invalid_key_length");
    }

    // --- ttl_ms is range-checked like `now` ------------------------------

    #[test]
    fn seal_pairing_core_accepts_a_ttl_at_the_safe_integer_boundary() {
        let key = crate::types::test_support::test_key();
        let key_bytes = key.to_bytes();
        let code = crate::pairing::generate_code().unwrap();
        let now = 0.0;
        let ttl_ms = MAX_SAFE_TIMESTAMP;
        let file = seal_pairing_core(&key_bytes, &code, now, ttl_ms).unwrap();
        assert_eq!(
            crate::pairing::expires_at(&file).unwrap(),
            MAX_SAFE_TIMESTAMP as u64
        );
    }

    #[test]
    fn seal_pairing_core_rejects_an_expiry_past_the_safe_integer() {
        // An expiry past `Number.MAX_SAFE_INTEGER` would come back from
        // `pairingExpiresAt` as a number the host cannot hold exactly, and
        // that `parse_timestamp` refuses if handed back to this boundary.
        let key = crate::types::test_support::test_key();
        let key_bytes = key.to_bytes();
        let code = crate::pairing::generate_code().unwrap();
        for (now, ttl_ms) in [(0.0, MAX_SAFE_TIMESTAMP + 2.0), (1_000.0, 1e300)] {
            let err = seal_pairing_core(&key_bytes, &code, now, ttl_ms).unwrap_err();
            assert_eq!(
                err.reason,
                Some(Reason::ExpiryOutOfRange),
                "ttl {ttl_ms}: {err:?}"
            );
        }
    }

    #[test]
    fn seal_pairing_core_still_clamps_a_negative_ttl_to_an_already_expired_file() {
        let key = crate::types::test_support::test_key();
        let key_bytes = key.to_bytes();
        let code = crate::pairing::generate_code().unwrap();
        let file = seal_pairing_core(&key_bytes, &code, 1_000.0, -1.0).unwrap();
        assert_eq!(crate::pairing::expires_at(&file).unwrap(), 1_000);
    }
}

#[cfg(test)]
mod archive_bindings_tests {
    use super::*;
    use crate::ops::apply_batch;
    use crate::views::archived_json;

    const DEVICE: [u8; 16] = [0xa1; 16];
    const DAY: f64 = 86_400_000.0;
    const DAY_MS: Timestamp = 86_400_000;

    fn uid(n: u128) -> String {
        uuid::Uuid::from_u128(n).to_string()
    }

    /// A tree holding workspace 1 with tabs 10 and 11, opened at time 1.
    fn tree() -> Document {
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": uid(1) },
            { "kind": "addTab", "parent": uid(1), "name": "Ten", "url": "https://10.example/", "id": uid(10) },
            { "kind": "addTab", "parent": uid(1), "name": "Eleven", "url": "https://11.example/", "id": uid(11) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &DEVICE, 1.0).unwrap();
        doc
    }

    #[test]
    fn archiving_a_tab_now_answers_what_it_moved() {
        let (mut tree, mut archive) = (tree(), Document::new());

        let answer: serde_json::Value = serde_json::from_str(
            &run_archive_now(&mut tree, &mut archive, &uid(11), &DEVICE, DAY).unwrap(),
        )
        .unwrap();

        let entry = crate::types::archived_id(uuid::Uuid::from_u128(11)).to_string();
        assert_eq!(answer["tabs"], serde_json::json!([uid(11)]));
        assert_eq!(answer["entries"], serde_json::json!([entry]));
    }

    #[test]
    fn a_sweep_restore_and_listing_round_trip_as_json() {
        let (mut tree, mut archive) = (tree(), Document::new());
        let sweep = serde_json::json!({
            "default": "7d",
            "lastActive": { uid(11): 9.0 * DAY },
            "exempt": [],
        });
        let swept: serde_json::Value = serde_json::from_str(
            &run_archive_idle(
                &mut tree,
                &mut archive,
                &sweep.to_string(),
                &DEVICE,
                9.0 * DAY,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(swept["tabs"], serde_json::json!([uid(10)]));

        let listed: serde_json::Value =
            serde_json::from_str(&archived_json(&archive, 9 * DAY_MS).unwrap()).unwrap();
        let row = &listed[0];
        assert_eq!(row["title"], "Ten");
        assert_eq!(row["url"], "https://10.example/");
        assert_eq!(row["workspace"], uid(1));
        assert_eq!(row["workspaceName"], "W");
        assert_eq!(row["closedAt"], 9.0 * DAY as u64 as f64);
        assert_eq!(row["restored"], false);
        assert_eq!(row["restoreIds"], 1);
        assert_eq!(row["split"], serde_json::Value::Null);

        let entry = row["id"].as_str().unwrap();
        let done: serde_json::Value = serde_json::from_str(
            &run_restore(
                &mut tree,
                &mut archive,
                entry,
                &uid(1),
                &[uid(90)],
                &DEVICE,
                10.0 * DAY,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(done["tabs"], serde_json::json!([uid(90)]));
        assert_eq!(done["split"], serde_json::Value::Null);
        let listed: serde_json::Value =
            serde_json::from_str(&archived_json(&archive, 10 * DAY_MS).unwrap()).unwrap();
        assert_eq!(listed[0]["restored"], true);
    }

    #[test]
    fn imported_archived_tabs_round_trip_as_json() {
        let mut archive = Document::new();
        let entries = serde_json::json!([{
            "tab": uid(40),
            "title": "Forty",
            "url": "https://40.example/",
            "workspace": uid(1),
            "workspaceName": "Arc",
            "closedAt": 2.0 * DAY,
        }]);
        let ids: Vec<String> = serde_json::from_str(
            &run_import_archived(&mut archive, &entries.to_string(), &DEVICE, 3.0 * DAY).unwrap(),
        )
        .unwrap();
        let listed: serde_json::Value =
            serde_json::from_str(&archived_json(&archive, 3 * DAY_MS).unwrap()).unwrap();
        let row = &listed[0];
        assert_eq!(row["id"], ids[0]);
        assert_eq!(row["title"], "Forty");
        assert_eq!(row["workspace"], uid(1));
        assert_eq!(row["workspaceName"], "Arc");
        assert_eq!(row["closedAt"], 2.0 * DAY);
        assert_eq!(row["restoreIds"], 1);

        let again = run_import_archived(&mut archive, &entries.to_string(), &DEVICE, 3.0 * DAY);
        assert_eq!(again.unwrap_err().code, "id_in_use");
        let unknown = serde_json::json!([{ "tab": uid(41), "title": "", "url": null,
            "workspace": uid(1), "closedAt": 1.0, "pinned": true }]);
        assert!(
            run_import_archived(&mut archive, &unknown.to_string(), &DEVICE, 3.0 * DAY).is_err()
        );
    }

    #[test]
    fn the_listing_is_newest_first_and_no_later_than_the_clock() {
        let (mut tree, mut archive) = (tree(), Document::new());
        let sweep = |only: u128| {
            let other = if only == 10 { 11 } else { 10 };
            serde_json::json!({ "default": "24h", "exempt": [uid(other)] }).to_string()
        };
        run_archive_idle(&mut tree, &mut archive, &sweep(10), &DEVICE, 2.0 * DAY).unwrap();
        run_archive_idle(&mut tree, &mut archive, &sweep(11), &DEVICE, 900.0 * DAY).unwrap();
        let listed: serde_json::Value =
            serde_json::from_str(&archived_json(&archive, 5 * DAY_MS).unwrap()).unwrap();
        assert_eq!(
            listed[0]["title"], "Eleven",
            "closed in the future, so closed now"
        );
        assert_eq!(listed[0]["closedAt"], 5.0 * DAY as u64 as f64);
        assert_eq!(listed[1]["title"], "Ten");
    }

    #[test]
    fn a_workspace_choice_and_a_use_go_through_a_batch() {
        let mut doc = tree();
        let ops = serde_json::json!([
            { "kind": "setAutoArchive", "id": uid(1), "choice": "12h" },
            { "kind": "markUsed", "id": uid(10) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &DEVICE, 5.0 * DAY).unwrap();
        let ws = doc.node(uuid::Uuid::from_u128(1)).unwrap();
        assert_eq!(ws.lifecycle.auto_archive.as_deref(), Some("12h"));
        assert_eq!(
            doc.node(uuid::Uuid::from_u128(10)).unwrap().touched_at,
            5 * 86_400_000
        );

        let bad = serde_json::json!([{ "kind": "setAutoArchive", "id": uid(1), "choice": "1y" }]);
        let err = apply_batch(&mut doc, &bad.to_string(), &DEVICE, 6.0 * DAY).unwrap_err();
        assert_eq!(err.reason, Some(Reason::BadAutoArchiveChoice), "{err:?}");
        let tab = serde_json::json!([{ "kind": "setAutoArchive", "id": uid(10), "choice": null }]);
        let err = apply_batch(&mut doc, &tab.to_string(), &DEVICE, 6.0 * DAY).unwrap_err();
        assert_eq!(err.reason, Some(Reason::NotAWorkspace), "{err:?}");
    }

    #[test]
    fn a_pass_with_a_retention_period_expires_the_archive() {
        let key = crate::types::test_support::test_key().to_bytes().to_vec();
        let (mut tree, mut archive) = (tree(), Document::new());
        let sweep = serde_json::json!({ "default": "24h" }).to_string();
        run_archive_idle(&mut tree, &mut archive, &sweep, &DEVICE, 2.0 * DAY).unwrap();
        run_sync_expiring(
            &mut archive,
            &key,
            &DEVICE,
            "archive",
            vec![],
            3.0 * DAY,
            Some(30.0 * DAY),
        )
        .unwrap();
        assert_eq!(archive.nodes.len(), 2);
        let (report, _) = run_sync_expiring(
            &mut archive,
            &key,
            &DEVICE,
            "archive",
            vec![],
            32.0 * DAY,
            Some(30.0 * DAY),
        )
        .unwrap();
        assert!(archive.nodes.is_empty());
        let report = serde_json::to_value(&report).unwrap();
        assert_eq!(report["removedIds"].as_array().unwrap().len(), 2);
        let bad = run_sync_expiring(
            &mut archive,
            &key,
            &DEVICE,
            "archive",
            vec![],
            1.0,
            Some(f64::NAN),
        );
        assert!(matches!(
            bad,
            Err(Failure {
                reason: Some(Reason::TimestampNotFinite),
                ..
            })
        ));
    }
}
