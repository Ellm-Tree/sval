// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The WASM boundary: a narrow JSON-in/JSON-out surface over an opaque
//! handle, with storage inverted so the engine never calls back into JS.
//!
//! Only compiled with the `wasm` feature, so native builds and `cargo test`
//! never carry `wasm-bindgen`, `js-sys` or `console_error_panic_hook`. The
//! surface is JSON-shaped: the fork's chrome is JavaScript on the other side
//! of this call regardless, so mirroring [`crate::types::Document`] in
//! `wasm_bindgen` attributes would be a second type system to keep in sync.
//!
//! # Why storage is a preloaded snapshot
//!
//! A privileged Firefox chrome script has no synchronous filesystem API
//! beyond a read-only, worker-only path (`IOUtils.openFileForSyncReading`),
//! and Firefox's `browser_startup_mainthreadio.js` catches main-thread I/O.
//! The WASM consumers in the Firefox tree (translations, the ML backends,
//! pdf.js) run in a worker with I/O inverted: the host does the I/O and hands
//! the engine plain bytes.
//!
//! So the host lists and reads everything under
//! [`sync_prefix`](crate::wasm::sync_prefix) itself, and calls
//! [`SvalDocument::sync`](crate::wasm::SvalDocument::sync) once with that
//! snapshot. The one file [`sync`] might produce comes back as plain bytes on
//! [`SyncOutcome`](crate::wasm::SyncOutcome) for the host to write,
//! atomically, itself. `host::PreloadedStore` implements `StorageProvider`
//! over files already in memory, like [`crate::store::MemoryStore`], so it
//! is tested the same way, with plain `cargo test`.
//!
//! # What this file holds
//!
//! The `wasm_bindgen`-attributed surface: glue that converts JS values to
//! plain Rust ones, delegates to the pure functions in `failure`, `ops`,
//! `views` and `host`, and converts the result back. Only this file touches
//! a `JsValue`. `binding_tests` drives the bindings natively on their
//! success paths. Anything that builds a `JsValue` aborts the process on a
//! non-wasm target, so each refusal is a pure function in those modules,
//! tested there.
//!
//! # Panics
//!
//! `wasm32` code traps rather than unwinds, and Firefox surfaces the trap to
//! its caller as a catchable `RuntimeError`. What is lost is this module
//! *instance*: its memory is left mid-panic, every later call into it is
//! undefined, and the host's in-memory `Document` is gone. [`init`](crate::wasm::init)
//! installs `console_error_panic_hook` so the console shows the panic's file,
//! line and message; it does not make a panic recoverable. So every method
//! returns `Result` on any input the host controls (a bad id string, an
//! out-of-range timestamp, a byte slice of the wrong length).
//!
//! See `docs/host-contract.md` for what a host must implement against this
//! module.

use crate::crypto::Key;
use crate::failure::{Failure, Invalid, Reason};
use crate::host::{
    group_code_for_display, own_device_path, run_archive_idle, run_archive_now,
    run_import_archived, run_restore, run_sync_to, seal_pairing_core,
};
use crate::ops::{apply_json, parse_device_id, parse_favorite_guid, parse_timestamp, remove};
use crate::sync::{OwnCopies, Target};
use crate::types::Document;
use crate::views::{archived_json, favorites_json, settings_json, shards_json, visits_json};
use js_sys::{Array, Uint8Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

/// The node id of the favorite whose guid is `guid` (favorites-native spec
/// §3).
#[wasm_bindgen(js_name = favoriteId)]
pub fn favorite_id(guid: &str) -> Result<String, JsValue> {
    let guid = parse_favorite_guid(guid).map_err(to_js_err)?;
    Ok(crate::types::favorite_id(guid).to_string())
}

/// The node id of setting `key` (settings-sync spec §2), so a host can match
/// a node a pass reports as changed to the setting it holds.
#[wasm_bindgen(js_name = settingId)]
pub fn setting_id(key: &str) -> String {
    crate::types::setting_id(key).to_string()
}

/// The node id of the visit device `device_id` made to `url` at `visited_at`
/// (history-sync spec §3).
#[wasm_bindgen(js_name = visitId)]
pub fn visit_id(device_id: &[u8], url: &str, visited_at: f64) -> Result<String, JsValue> {
    let device = parse_device_id(device_id).map_err(to_js_err)?;
    let at = parse_timestamp(visited_at).map_err(to_js_err)?;
    Ok(crate::types::visit_id(device, url, at).to_string())
}

/// Installs a panic hook that prints a panic's file, line and message to
/// the host's console. Call once, before any other export. It does not make
/// a panic recoverable (see this module's doc comment).
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// What [`crate::ENGINE_VERSION`] reports (`docs/host-contract.md` §11).
/// Needs no prior call, not even [`init`].
#[wasm_bindgen(js_name = engineVersion)]
pub fn engine_version() -> String {
    crate::ENGINE_VERSION.to_owned()
}

/// A Kagi Privacy Pass token request: the issuance POST body and the client
/// state [`kagi_token_finalize`] needs (`crate::privacy_pass`).
#[wasm_bindgen]
pub struct KagiTokenRequest {
    body: String,
    state: String,
}

#[wasm_bindgen]
impl KagiTokenRequest {
    #[wasm_bindgen(getter)]
    pub fn body(&self) -> String {
        self.body.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn state(&self) -> String {
        self.state.clone()
    }
}

/// A request for `count` Kagi Privacy Pass tokens under the challenge in
/// `www_authenticate` ([`crate::privacy_pass::token_request`]).
#[wasm_bindgen(js_name = kagiTokenRequest)]
pub fn kagi_token_request(www_authenticate: &str, count: u16) -> Result<KagiTokenRequest, JsValue> {
    let request = crate::privacy_pass::token_request(www_authenticate, count).map_err(to_js_err)?;
    Ok(KagiTokenRequest {
        body: request.body,
        state: request.state,
    })
}

/// The tokens in Kagi's answer to a [`kagi_token_request`]
/// ([`crate::privacy_pass::finalize`]).
#[wasm_bindgen(js_name = kagiTokenFinalize)]
pub fn kagi_token_finalize(state: &str, response: &str) -> Result<Vec<String>, JsValue> {
    crate::privacy_pass::finalize(state, response).map_err(to_js_err)
}

/// Converts a failure to what a host catches: an `Error` whose `message` is
/// for people, whose `code` property is the [`Failure`] code and, where the
/// failure has one, whose `reason` property is its [`Reason`].
fn to_js_err(err: impl Into<Failure>) -> JsValue {
    let failure = err.into();
    let error = js_sys::Error::new(&failure.message);
    // Setting a property on a fresh, unfrozen `Error` cannot fail.
    let _ = js_sys::Reflect::set(
        &error,
        &JsValue::from_str("code"),
        &JsValue::from_str(failure.code),
    );
    if let Some(reason) = failure.reason {
        let _ = js_sys::Reflect::set(
            &error,
            &JsValue::from_str("reason"),
            &JsValue::from_str(reason.as_str()),
        );
    }
    error.into()
}

/// The directory in the shared folder that holds every file Sval keeps there
/// (`crate::store::TOP_DIR`).
#[wasm_bindgen(js_name = topDirName)]
pub fn top_dir_name() -> String {
    crate::store::TOP_DIR.to_owned()
}

/// Whether a folder named `name`, picked as the shared folder, is Sval's own
/// directory in it, so that the folder holding it is the shared folder
/// (`crate::store::is_top_dir_name`). A host splits its own paths, since only
/// it knows its platform's separators.
#[wasm_bindgen(js_name = isTopDirName)]
pub fn is_top_dir_name(name: &str) -> bool {
    crate::store::is_top_dir_name(name)
}

/// The one directory, without a trailing `/`, whose files a host must read
/// before calling [`SvalDocument::sync`]: the files directly in it, never a
/// sibling whose name starts the same (`docs/host-contract.md`).
#[wasm_bindgen(js_name = syncPrefix)]
pub fn sync_prefix(key_bytes: &[u8], workspace: &str) -> Result<String, JsValue> {
    let key = Key::from_bytes(key_bytes).map_err(to_js_err)?;
    Ok(crate::store::workspace_dir(&key, workspace))
}

/// Whether `path` is a device's file in [`sync_prefix`]'s directory, the
/// only files `sync` opens (`store::device_of`). A host asks before
/// reporting a file it could not read, so a cloud client's leftovers are no
/// more an error to it than they are to the engine.
#[wasm_bindgen(js_name = isDeviceFile)]
pub fn is_device_file(key_bytes: &[u8], workspace: &str, path: &str) -> Result<bool, JsValue> {
    let key = Key::from_bytes(key_bytes).map_err(to_js_err)?;
    Ok(crate::store::device_of(&crate::store::workspace_dir(&key, workspace), path).is_some())
}

/// This device's own path within [`sync_prefix`]'s directory
/// (`crate::host::own_device_path`).
#[wasm_bindgen(js_name = devicePath)]
pub fn device_path(key_bytes: &[u8], workspace: &str, device_id: &[u8]) -> Result<String, JsValue> {
    own_device_path(key_bytes, workspace, device_id).map_err(to_js_err)
}

/// What one call to [`SvalDocument::sync`] produced: the report as JSON
/// (field names per `docs/host-contract.md`), and the one path and bytes, if
/// any, the host must write back, atomically, itself.
#[wasm_bindgen]
pub struct SyncOutcome {
    report_json: String,
    write_path: Option<String>,
    write_bytes: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl SyncOutcome {
    #[wasm_bindgen(getter, js_name = reportJson)]
    pub fn report_json(&self) -> String {
        self.report_json.clone()
    }

    #[wasm_bindgen(getter, js_name = writePath)]
    pub fn write_path(&self) -> Option<String> {
        self.write_path.clone()
    }

    #[wasm_bindgen(getter, js_name = writeBytes)]
    pub fn write_bytes(&self) -> Option<Vec<u8>> {
        self.write_bytes.clone()
    }
}

/// The opaque handle the host holds. Every mutator takes the id and
/// timestamp it needs from the caller, because `wasm32-unknown-unknown` has
/// no ambient clock or entropy source (see [`crate::types::Timestamp`]).
#[wasm_bindgen]
pub struct SvalDocument(Document, OwnCopies);

#[wasm_bindgen]
impl SvalDocument {
    /// A fresh, empty document.
    #[wasm_bindgen(constructor)]
    pub fn new() -> SvalDocument {
        SvalDocument(Document::new(), OwnCopies::default())
    }

    /// Parses `json` as a full document.
    #[wasm_bindgen(js_name = loadJson)]
    pub fn load_json(json: &str) -> Result<SvalDocument, JsValue> {
        Document::from_json(json)
            .map(|doc| SvalDocument(doc, OwnCopies::default()))
            .map_err(to_js_err)
    }

    /// Serialises the current document to compact JSON, for the host to
    /// parse.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        self.0.to_json().map_err(to_js_err)
    }

    /// Applies the change `op_json` spells: one operation, an object named
    /// by `kind` as `crate::ops::Op` lists them, or `{ kind: "batch", ops }`,
    /// several applied all together or not at all. It is stamped with
    /// `device_id` and `now`, and a refusal leaves the document as it was
    /// (`docs/host-contract.md` §3).
    ///
    /// Answers `{ id, changed }` as JSON: `id` is the node an operation
    /// added, or null, and `changed` is present only from an operation that
    /// may leave the document as it was by design.
    pub fn apply(&mut self, op_json: &str, device_id: &[u8], now: f64) -> Result<String, JsValue> {
        let applied = apply_json(&mut self.0, op_json, device_id, now).map_err(to_js_err)?;
        serde_json::to_string(&applied).map_err(to_js_err)
    }

    /// The sweep (idle-tab archive spec §4.2), on this document as the tree
    /// and `archive` as the Archive, which must be another document.
    /// `sweep_json` is `{ default, lastActive: { id: ms }, exempt: [id] }`.
    /// Answers `{ tabs, entries }`: the tabs it removed and the entries it
    /// added. Both documents change together or neither does.
    #[wasm_bindgen(js_name = archiveIdle)]
    pub fn archive_idle(
        &mut self,
        archive: &mut SvalDocument,
        sweep_json: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<String, JsValue> {
        run_archive_idle(&mut self.0, &mut archive.0, sweep_json, device_id, now).map_err(to_js_err)
    }

    /// Archives tab `id` of this document into `archive` now, with its split
    /// when it is a pane (launcher spec §4). Answers `{ tabs, entries }`, as
    /// `archiveIdle` does. Both documents change together or neither does.
    #[wasm_bindgen(js_name = archiveNow)]
    pub fn archive_now(
        &mut self,
        archive: &mut SvalDocument,
        id: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<String, JsValue> {
        run_archive_now(&mut self.0, &mut archive.0, id, device_id, now).map_err(to_js_err)
    }

    /// Restores Archive entry `entry` from `archive` into this document, as
    /// a new tab or, with the rest of its split, a new split (idle-tab
    /// archive spec §2). `current` is the workspace it goes to when its own
    /// is gone. `ids` are the new nodes' ids: the split's first when there is
    /// one, then the tabs in pane order; an entry's `restoreIds` says how
    /// many. Answers `{ tabs, split, workspace }`. Both documents change
    /// together or neither does.
    pub fn restore(
        &mut self,
        archive: &mut SvalDocument,
        entry: &str,
        current: &str,
        ids: Vec<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<String, JsValue> {
        run_restore(
            &mut self.0,
            &mut archive.0,
            entry,
            current,
            &ids,
            device_id,
            now,
        )
        .map_err(to_js_err)
    }

    /// Adds an entry to this Archive document for each tab another browser
    /// archived (idle-tab archive spec §7.6). `entries_json` is `[{ tab,
    /// title, url, workspace, workspaceName, closedAt }]`, `tab` an id the
    /// host mints. Answers the entries' ids. A tab whose entry is already
    /// here, or that the list names twice, throws `id_in_use` and adds
    /// nothing.
    #[wasm_bindgen(js_name = importArchived)]
    pub fn import_archived(
        &mut self,
        entries_json: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<String, JsValue> {
        run_import_archived(&mut self.0, entries_json, device_id, now).map_err(to_js_err)
    }

    /// Every entry in this Archive document as a JSON array, newest first:
    /// `[{ id, url, title, icon, workspace, workspaceName, closedAt, device,
    /// restored, split, pane, restoreIds }]`. `closedAt` is no later than
    /// `now` (decision 0135).
    pub fn archived(&self, now: f64) -> Result<String, JsValue> {
        let now = parse_timestamp(now).map_err(to_js_err)?;
        archived_json(&self.0, now).map_err(to_js_err)
    }

    /// Every setting as a JSON object, `{ key: value | null }`.
    pub fn settings(&self) -> Result<String, JsValue> {
        settings_json(&self.0).map_err(to_js_err)
    }

    /// Every favorite, folder and separator as a JSON array of `{ id, kind,
    /// guid, parent, order, name, url, pinned, pinScope,
    /// contentAt, placementAt, added }`, ordered by parent and then by order
    /// among siblings.
    pub fn favorites(&self) -> Result<String, JsValue> {
        favorites_json(&self.0).map_err(to_js_err)
    }

    /// Every visit as a JSON array of `{ id, url, title, visitedAt,
    /// transition, device, workspace }`, oldest first. `device` is the hex id
    /// of the device that made the visit, and `workspace` the id of the
    /// workspace it was made in, or null.
    pub fn visits(&self) -> Result<String, JsValue> {
        visits_json(&self.0).map_err(to_js_err)
    }

    /// Every shard the history index lists as a JSON array of `{ name,
    /// changedAt }`, newest week first.
    pub fn shards(&self) -> Result<String, JsValue> {
        shards_json(&self.0).map_err(to_js_err)
    }

    /// Deletes `id` and everything beneath it ([`Document::remove`]). This is
    /// closing a tab, and deleting a group, a workspace or a Favorites folder
    /// with its contents: the records go, with no tombstone (spec §5.4), so
    /// there is nothing to stamp. Sval keeps no history of closed tabs;
    /// Firefox's own recently-closed list does, locally.
    pub fn remove(&mut self, id: &str) -> Result<(), JsValue> {
        remove(&mut self.0, id).map_err(to_js_err)
    }

    /// Runs one sync pass against a snapshot the host already fetched:
    /// `paths[i]` names `files[i]`'s bytes, and must include every file
    /// under [`sync_prefix`]'s result, **this device's own file included if
    /// it exists**. Omitting it can lose what this device wrote offline (see
    /// [`crate::sync::sync_to`] on reading its own file first).
    ///
    /// `archive_retention`, in milliseconds, is for the Archive's document
    /// only: entries closed at least that long ago are dropped after the
    /// merge (idle-tab archive spec §3.3). Leave it out for every other
    /// document.
    ///
    /// `shared` is true for a snapshot of the folder devices exchange files
    /// through, and false or absent for this device's copy in its profile
    /// ([`crate::sync::Target`]).
    ///
    /// `clamp_from`, the time this device's first time reading arrived,
    /// pulls back the stamps it took before then, as
    /// [`crate::sync::sync_to`] describes. Pass it on one pass of each
    /// document.
    #[expect(clippy::too_many_arguments)]
    pub fn sync(
        &mut self,
        key_bytes: &[u8],
        device_id: &[u8],
        workspace: &str,
        paths: Vec<String>,
        files: Array,
        now: f64,
        archive_retention: Option<f64>,
        shared: Option<bool>,
        clamp_from: Option<f64>,
    ) -> Result<SyncOutcome, JsValue> {
        if paths.len() != files.length() as usize {
            return Err(to_js_err(Invalid::new(
                Reason::PathsFilesMismatch,
                format!(
                    "paths and files must be the same length: {} paths, {} files",
                    paths.len(),
                    files.length()
                ),
            )));
        }
        let mut peer_files = Vec::with_capacity(paths.len());
        for (index, path) in paths.into_iter().enumerate() {
            let item = files.get(index as u32);
            let bytes: Uint8Array = item.dyn_into().map_err(|value| {
                to_js_err(Invalid::new(
                    Reason::FileNotBytes,
                    format!("file at index {index} is not a Uint8Array: {value:?}"),
                ))
            })?;
            peer_files.push((path, bytes.to_vec()));
        }
        let target = if shared == Some(true) {
            Target::Shared
        } else {
            Target::Profile
        };
        let (report, write) = run_sync_to(
            &mut self.0,
            &mut self.1,
            key_bytes,
            device_id,
            workspace,
            peer_files,
            now,
            archive_retention,
            target,
            clamp_from,
        )
        .map_err(to_js_err)?;
        let report_json = serde_json::to_string(&report).map_err(to_js_err)?;
        Ok(SyncOutcome {
            report_json,
            write_path: write.as_ref().map(|(path, _)| path.clone()),
            write_bytes: write.map(|(_, bytes)| bytes),
        })
    }

    /// Plaintext JSON export, independent of the encrypted sync path: the
    /// escape hatch spec §6.7 promises.
    #[wasm_bindgen(js_name = exportJson)]
    pub fn export_json(&self) -> Result<String, JsValue> {
        crate::sync::export_json(&self.0).map_err(to_js_err)
    }
}

impl Default for SvalDocument {
    fn default() -> Self {
        Self::new()
    }
}

/// A fresh pairing code, grouped for display (`"K7Q4-8MTZ-3RJW"`). A host UI
/// shows it exactly as returned, and `normalize_code` accepts it back as
/// typed.
///
/// Fallible: entropy comes from the host's `crypto.getRandomValues`
/// (`docs/host-contract.md` §2), which can fail, and a panic would take down
/// this module instance.
#[wasm_bindgen(js_name = generatePairingCode)]
pub fn generate_pairing_code() -> Result<String, JsValue> {
    let code = crate::pairing::generate_code().map_err(to_js_err)?;
    group_code_for_display(&code).ok_or_else(|| {
        to_js_err(Failure::coded(
            "internal_error",
            format!(
                "generate_code produced a code of the wrong shape ({} chars)",
                code.len()
            ),
        ))
    })
}

/// Seals `key_bytes` under `code` until `now + ttl_ms`
/// ([`crate::pairing::seal`]). `code` is used exactly as given: normalize
/// user-entered text (dashes, case, whitespace) with
/// [`crate::pairing::normalize_code`] first.
#[wasm_bindgen(js_name = sealPairing)]
pub fn seal_pairing(
    key_bytes: &[u8],
    code: &str,
    now: f64,
    ttl_ms: f64,
) -> Result<Vec<u8>, JsValue> {
    seal_pairing_core(key_bytes, code, now, ttl_ms).map_err(to_js_err)
}

/// Recovers the 32-byte document key from `bytes`, given the code it was
/// sealed under. A wrong code rejects with code `bad_pairing_code`
/// ([`crate::types::Error::BadPairingCode`]), and a file that is not a
/// well-formed pairing file with `malformed_pairing_file`
/// ([`crate::types::Error::MalformedPairingFile`]).
#[wasm_bindgen(js_name = openPairing)]
pub fn open_pairing(bytes: &[u8], code: &str) -> Result<Vec<u8>, JsValue> {
    let key = crate::pairing::open(bytes, code).map_err(to_js_err)?;
    Ok(key.to_bytes().to_vec())
}

/// Reads a pairing file's expiry without needing the code; see
/// [`crate::pairing::expires_at`].
#[wasm_bindgen(js_name = pairingExpiresAt)]
pub fn pairing_expires_at(bytes: &[u8]) -> Result<f64, JsValue> {
    let expires_at = crate::pairing::expires_at(bytes).map_err(to_js_err)?;
    Ok(expires_at as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{apply_batch, parse_id};
    use crate::store::DeviceId as StoreDeviceId;

    #[test]
    fn a_write_with_an_address_carries_its_local_mark_and_one_without_cannot() {
        let device = [1; 16];
        let ws = "00000000-0000-0000-0000-000000000001";
        let tab = "00000000-0000-0000-0000-000000000002";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": ws },
            { "kind": "addTab", "parent": ws, "name": "Notes",
              "url": "file:///notes.html", "id": tab, "local": true },
            { "kind": "addFavorite", "favoriteKind": "folder",
              "guid": "toolbar_____", "name": "" },
            { "kind": "addFavorite", "favoriteKind": "favorite",
              "guid": "notesfavor01", "parent": favorite_id("toolbar_____").unwrap(),
              "name": "Notes", "url": "file:///notes.html", "local": true },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 10.0).unwrap();
        let tab_id = parse_id(tab).unwrap();
        assert!(doc.node(tab_id).unwrap().content.local);
        let rows: serde_json::Value = serde_json::from_str(&favorites_json(&doc).unwrap()).unwrap();
        assert_eq!(rows[0]["local"], false);
        assert_eq!(rows[1]["local"], true);

        doc.rename(tab_id, "Renamed", StoreDeviceId::from_bytes(device), 20);
        assert!(doc.node(tab_id).unwrap().content.local, "a rename keeps it");
        let synced = serde_json::json!([
            { "kind": "setContent", "id": tab, "name": "Web", "url": "https://w.example/" },
        ]);
        apply_batch(&mut doc, &synced.to_string(), &device, 30.0).unwrap();
        assert!(!doc.node(tab_id).unwrap().content.local);

        let bare = serde_json::json!([
            { "kind": "setContent", "id": ws, "name": "W", "local": true },
        ]);
        let err = apply_batch(&mut doc, &bare.to_string(), &device, 40.0).unwrap_err();
        assert!(
            err.message.contains("only a node with an address"),
            "{err:?}"
        );
        assert!(!doc.node(parse_id(ws).unwrap()).unwrap().content.local);
    }
}

/// The bindings a host calls, driven natively on their success paths. A
/// refusal builds a `JsValue`, which only a wasm host can do, so each
/// refusal is tested on the pure check it calls instead.
#[cfg(test)]
mod binding_tests {
    use super::*;
    use crate::ops::parse_id;
    use crate::ops::require_workspace;
    use crate::store::DeviceId;
    use crate::types::NodeKind;
    use serde_json::json;
    use std::collections::BTreeMap;

    const DEVICE: [u8; 16] = [0xa; 16];

    fn id(n: u128) -> String {
        uuid::Uuid::from_u128(n).to_string()
    }

    /// Applies `op` through the binding and answers what it reports.
    fn apply(doc: &mut SvalDocument, op: serde_json::Value, now: f64) -> serde_json::Value {
        serde_json::from_str(&doc.apply(&op.to_string(), &DEVICE, now).unwrap()).unwrap()
    }

    /// A document holding workspace 1.
    fn one_workspace() -> SvalDocument {
        let mut doc = SvalDocument::new();
        apply(
            &mut doc,
            json!({ "kind": "addWorkspace", "name": "W", "id": id(1) }),
            1.0,
        );
        doc
    }

    fn add_tab(doc: &mut SvalDocument, n: u128, now: f64) {
        let op = json!({
            "kind": "addTab", "parent": id(1), "name": "T", "url": "https://t.example/", "id": id(n),
        });
        apply(doc, op, now);
    }

    fn node(doc: &SvalDocument, n: u128) -> Option<&crate::types::Node> {
        doc.0.node(uuid::Uuid::from_u128(n))
    }

    #[test]
    fn set_local_marks_a_tab_through_the_binding() {
        let mut doc = one_workspace();
        add_tab(&mut doc, 2, 2.0);
        apply(
            &mut doc,
            json!({ "kind": "setLocal", "id": id(2), "local": true }),
            3.0,
        );
        assert!(node(&doc, 2).unwrap().content.local);
        apply(
            &mut doc,
            json!({ "kind": "setLocal", "id": id(2), "local": false }),
            4.0,
        );
        assert!(!node(&doc, 2).unwrap().content.local);
    }

    #[test]
    fn move_workspace_puts_a_workspace_in_its_new_place() {
        let mut doc = one_workspace();
        apply(
            &mut doc,
            json!({ "kind": "addWorkspace", "name": "W", "id": id(2) }),
            1.0,
        );
        apply(
            &mut doc,
            json!({ "kind": "moveWorkspace", "id": id(2), "after": id(1) }),
            2.0,
        );
        let order = |n| node(&doc, n).unwrap().placement.order.clone();
        assert!(order(2) < order(1), "the second now sorts first");
        assert_eq!(node(&doc, 2).unwrap().placement_at, 2);
    }

    #[test]
    fn a_split_round_trips_through_to_json_and_load_json_with_its_name_and_shares() {
        let mut doc = one_workspace();
        for n in [2, 3] {
            add_tab(&mut doc, n, 2.0);
        }
        let split = json!({
            "kind": "addSplit", "parent": id(1), "name": "Docs", "id": id(4),
            "before": id(2), "after": id(3),
        });
        apply(&mut doc, split, 3.0);
        apply(
            &mut doc,
            json!({ "kind": "moveNode", "id": id(2), "newParent": id(4) }),
            4.0,
        );
        let second =
            json!({ "kind": "moveNode", "id": id(3), "newParent": id(4), "before": id(2) });
        apply(&mut doc, second, 4.0);
        let shares =
            json!({ "kind": "setContent", "id": id(4), "name": "Docs", "shares": [40.0, 60.0] });
        apply(&mut doc, shares, 5.0);

        let json = doc.to_json().unwrap();
        let back = SvalDocument::load_json(&json).unwrap();
        assert_eq!(back.to_json().unwrap(), json);
        let split = node(&back, 4).unwrap();
        assert_eq!(split.kind, crate::types::NodeKind::Split);
        assert_eq!(split.content.name, "Docs");
        assert_eq!(split.content.shares, Some(vec![40.0, 60.0]));
        let raw: serde_json::Value = serde_json::from_str(&json).unwrap();
        let on_disk = &raw["nodes"][id(4)];
        assert_eq!(on_disk["kind"], "split");
        assert_eq!(
            on_disk["content"]["shares"],
            serde_json::json!([40.0, 60.0])
        );
        assert_eq!(
            crate::tree::children(&back.0, uuid::Uuid::from_u128(4)),
            vec![uuid::Uuid::from_u128(2), uuid::Uuid::from_u128(3)]
        );
    }

    #[test]
    fn a_tab_added_between_two_siblings_is_drawn_between_them() {
        let mut doc = one_workspace();
        for n in [2, 3] {
            add_tab(&mut doc, n, 2.0);
        }
        let between = json!({
            "kind": "addTab", "parent": id(1), "name": "T", "url": "https://t.example/",
            "id": id(4), "before": id(2), "after": id(3),
        });
        apply(&mut doc, between, 3.0);
        let children: Vec<_> = crate::tree::children(&doc.0, uuid::Uuid::from_u128(1))
            .into_iter()
            .map(|n| n.as_u128())
            .collect();
        assert_eq!(children, vec![2, 4, 3]);
        let added = node(&doc, 4).unwrap();
        assert_eq!(added.placement_at, 3, "one placement fact, from the add");
    }

    #[test]
    fn parse_id_reads_a_uuid_and_refuses_anything_else() {
        assert_eq!(parse_id(&id(7)), Ok(uuid::Uuid::from_u128(7)));
        assert_eq!(
            parse_id("not-a-uuid").unwrap_err().reason,
            Reason::BadNodeId
        );
    }

    #[test]
    fn require_workspace_accepts_only_a_workspace() {
        let mut doc = Document::new();
        let ws = uuid::Uuid::from_u128(1);
        let group = uuid::Uuid::from_u128(2);
        doc.add_workspace("W", None, ws, DeviceId::from_bytes(DEVICE), 1);
        doc.add_group(ws, "G", None, group, DeviceId::from_bytes(DEVICE), 1);
        assert_eq!(require_workspace(&doc, ws), Ok(()));
        let err = require_workspace(&doc, group).unwrap_err();
        assert_eq!(
            (err.code, err.reason),
            ("invalid_argument", Some(Reason::NotAWorkspace))
        );
    }

    #[test]
    fn the_free_functions_answer_with_the_engines_own_values() {
        let key = crate::types::test_support::test_key();
        let key_bytes = key.to_bytes();
        assert_eq!(engine_version(), crate::ENGINE_VERSION);
        assert_eq!(
            favorite_id("toolbar_____").unwrap(),
            crate::types::favorite_id("toolbar_____").to_string()
        );
        assert_eq!(
            setting_id("browser.startup.homepage"),
            crate::types::setting_id("browser.startup.homepage").to_string()
        );
        assert_eq!(
            visit_id(&DEVICE, "https://e.example/", 1_000.0).unwrap(),
            crate::types::visit_id(DeviceId::from_bytes(DEVICE), "https://e.example/", 1_000)
                .to_string()
        );
        assert_eq!(
            sync_prefix(&key_bytes, "ws-1").unwrap(),
            crate::store::workspace_dir(&key, "ws-1")
        );
        assert_eq!(
            device_path(&key_bytes, "ws-1", &DEVICE).unwrap(),
            crate::store::device_path(&key, "ws-1", DeviceId::from_bytes(DEVICE))
        );
        let own = device_path(&key_bytes, "ws-1", &DEVICE).unwrap();
        assert!(is_device_file(&key_bytes, "ws-1", &own).unwrap());
        assert!(!is_device_file(&key_bytes, "ws-1", &own.replace(".json", " (1).json")).unwrap());
    }

    #[test]
    fn the_folder_layout_a_host_reads_is_the_engines() {
        assert_eq!(top_dir_name(), crate::store::TOP_DIR);
        assert!(is_top_dir_name("sval"));
        assert!(!is_top_dir_name("Sval"));
    }

    #[test]
    fn a_pairing_round_trips_through_the_bindings() {
        let key = crate::types::test_support::test_key();
        let code = generate_pairing_code().unwrap();
        assert!(crate::pairing::normalize_code(&code).is_some(), "{code}");
        let file =
            seal_pairing(&key.to_bytes(), &code.replace('-', ""), 1_000.0, 60_000.0).unwrap();
        assert_eq!(pairing_expires_at(&file).unwrap(), 61_000.0);
        assert_eq!(
            open_pairing(&file, &code.replace('-', "")).unwrap(),
            key.to_bytes().to_vec()
        );
    }

    #[test]
    fn kagi_tokens_are_issued_through_the_bindings() {
        let issuer = crate::privacy_pass::tests::Issuer::new(
            privacypass::TokenType::BatchedTokenRistretto255,
        );
        let request = kagi_token_request(&issuer.header, 2).unwrap();
        let tokens =
            kagi_token_finalize(&request.state(), &issuer.answer(&request.body())).unwrap();
        assert_eq!(tokens.len(), 2);
    }

    #[test]
    fn a_sync_outcome_hands_the_host_what_it_holds() {
        let outcome = SyncOutcome {
            report_json: "{}".into(),
            write_path: Some("sval/ws/a/1.json".into()),
            write_bytes: Some(vec![1, 2]),
        };
        assert_eq!(outcome.report_json(), "{}");
        assert_eq!(outcome.write_path().as_deref(), Some("sval/ws/a/1.json"));
        assert_eq!(outcome.write_bytes(), Some(vec![1, 2]));
    }

    #[test]
    fn the_archive_methods_change_both_documents_and_answer_what_they_did() {
        const HOUR: f64 = 3_600_000.0;
        let (mut tree, mut archive) = (SvalDocument::new(), SvalDocument::new());
        let ops = json!([
            { "kind": "addWorkspace", "name": "W", "id": id(1) },
            { "kind": "addTab", "parent": id(1), "name": "T", "url": "https://t.example/", "id": id(10) },
            { "kind": "addTab", "parent": id(1), "name": "U", "url": "https://u.example/", "id": id(11) },
        ]);
        let batch = apply(&mut tree, json!({ "kind": "batch", "ops": ops }), 1.0);
        assert_eq!(batch, json!({ "id": null }));
        assert!(node(&tree, 11).is_some());

        let choice = json!({ "kind": "setAutoArchive", "id": id(1), "choice": "12h" });
        apply(&mut tree, choice, 2.0);
        assert_eq!(
            node(&tree, 1).unwrap().lifecycle.auto_archive.as_deref(),
            Some("12h")
        );
        let used = json!({ "kind": "markUsed", "id": id(10) });
        assert_eq!(apply(&mut tree, used.clone(), HOUR)["changed"], true);
        assert_eq!(apply(&mut tree, used, HOUR + 1.0)["changed"], false);

        let now: serde_json::Value = serde_json::from_str(
            &tree
                .archive_now(&mut archive, &id(11), &DEVICE, 2.0 * HOUR)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(now["tabs"], serde_json::json!([id(11)]));
        let sweep = serde_json::json!({ "default": "7d", "lastActive": {}, "exempt": [] });
        let idle: serde_json::Value = serde_json::from_str(
            &tree
                .archive_idle(&mut archive, &sweep.to_string(), &DEVICE, 24.0 * HOUR)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(idle["tabs"], serde_json::json!([id(10)]));
        assert_eq!(
            archive.archived(24.0 * HOUR).unwrap(),
            archived_json(&archive.0, 24 * 3_600_000).unwrap()
        );

        let entry = crate::types::archived_id(uuid::Uuid::from_u128(11)).to_string();
        let restored: serde_json::Value = serde_json::from_str(
            &tree
                .restore(
                    &mut archive,
                    &entry,
                    &id(1),
                    vec![id(20)],
                    &DEVICE,
                    25.0 * HOUR,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(restored["tabs"], serde_json::json!([id(20)]));

        let imported = serde_json::json!([{
            "tab": id(30), "title": "Old", "url": "https://o.example/",
            "workspace": id(1), "workspaceName": "W", "closedAt": 5.0,
        }]);
        let ids: Vec<String> = serde_json::from_str(
            &archive
                .import_archived(&imported.to_string(), &DEVICE, 26.0 * HOUR)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(ids.len(), 1);
        assert!(
            archive
                .0
                .node(uuid::Uuid::parse_str(&ids[0]).unwrap())
                .is_some()
        );
    }

    #[test]
    fn the_history_and_pin_methods_change_the_node_they_name() {
        let mut doc = SvalDocument::new();
        let visit = json!({
            "kind": "addVisit", "url": "https://e.example/", "title": "E",
            "transition": 1, "visitedAt": 10.0,
        });
        let visit = apply(&mut doc, visit, 10.0)["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            visit,
            crate::types::visit_id(DeviceId::from_bytes(DEVICE), "https://e.example/", 10)
                .to_string()
        );
        let title = json!({ "kind": "setVisitTitle", "id": visit, "title": "Renamed" });
        apply(&mut doc, title, 11.0);
        let visit_id = uuid::Uuid::parse_str(&visit).unwrap();
        assert_eq!(doc.0.node(visit_id).unwrap().content.name, "Renamed");
        assert_eq!(doc.visits().unwrap(), visits_json(&doc.0).unwrap());
        apply(
            &mut doc,
            json!({ "kind": "touchShard", "name": "history-2026-W42" }),
            12.0,
        );
        let shard = doc
            .0
            .node(crate::types::shard_id("history-2026-W42"))
            .unwrap();
        assert_eq!(shard.content_at, 12);
        assert_eq!(doc.shards().unwrap(), shards_json(&doc.0).unwrap());

        let pins = json!({
            "kind": "addFavorite", "favoriteKind": "folder", "guid": crate::types::PINS_GUID,
            "name": "",
        });
        let pins = apply(&mut doc, pins, 1.0)["id"].clone();
        let pin = json!({
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": "page00000001",
            "parent": pins, "name": "P", "url": "https://p.example/",
        });
        let pin = apply(&mut doc, pin, 2.0)["id"].as_str().unwrap().to_owned();
        apply(
            &mut doc,
            json!({ "kind": "setPinScope", "id": pin, "scope": [id(1)] }),
            3.0,
        );
        assert_eq!(
            doc.0
                .node(parse_id(&pin).unwrap())
                .unwrap()
                .lifecycle
                .pin_scope,
            Some([id(1)].into_iter().collect())
        );
    }

    #[test]
    fn every_workspace_mutator_changes_the_node_it_names() {
        let mut doc = SvalDocument::new();
        let isolated =
            json!({ "kind": "addWorkspace", "name": "W", "id": id(1), "isolated": true });
        assert_eq!(apply(&mut doc, isolated, 1.0), json!({ "id": id(1) }));
        assert!(node(&doc, 1).unwrap().lifecycle.isolated);
        apply(
            &mut doc,
            json!({ "kind": "addWorkspace", "name": "Shared", "id": id(9) }),
            1.0,
        );
        assert!(!node(&doc, 9).unwrap().lifecycle.isolated);
        let agent = json!({
            "kind": "addAgentWorkspace", "name": "A", "agentLabel": "Claude Code",
            "id": id(2), "isolated": true,
        });
        apply(&mut doc, agent, 1.0);
        let agent = node(&doc, 2).unwrap();
        assert_eq!(agent.agent.as_ref().unwrap().label, "Claude Code");
        assert!(agent.lifecycle.isolated);

        let shared = json!({ "kind": "setIsolation", "id": id(1), "isolated": false });
        assert_eq!(apply(&mut doc, shared, 2.0), json!({ "id": null }));
        assert!(!node(&doc, 1).unwrap().lifecycle.isolated);

        let group = json!({ "kind": "addGroup", "parent": id(1), "name": "G", "id": id(3) });
        apply(&mut doc, group, 3.0);
        assert_eq!(node(&doc, 3).unwrap().kind, NodeKind::Group);
        add_tab(&mut doc, 4, 4.0);
        assert_eq!(node(&doc, 4).unwrap().kind, NodeKind::Tab);

        apply(
            &mut doc,
            json!({ "kind": "moveNode", "id": id(4), "newParent": id(3) }),
            5.0,
        );
        assert_eq!(
            node(&doc, 4).unwrap().placement.parent,
            Some(uuid::Uuid::from_u128(3))
        );
        apply(
            &mut doc,
            json!({ "kind": "rename", "id": id(4), "name": "Renamed" }),
            6.0,
        );
        assert_eq!(node(&doc, 4).unwrap().content.name, "Renamed");
        let content = json!({
            "kind": "setContent", "id": id(4), "name": "Content", "url": "https://c.example/",
        });
        apply(&mut doc, content, 7.0);
        assert_eq!(
            node(&doc, 4).unwrap().content.url.as_deref(),
            Some("https://c.example/")
        );
        apply(
            &mut doc,
            json!({ "kind": "setAppearance", "id": id(3), "color": "blue" }),
            8.0,
        );
        assert_eq!(node(&doc, 3).unwrap().appearance.color, Some(json!("blue")));
        apply(
            &mut doc,
            json!({ "kind": "setLabel", "id": id(4), "label": "Mine" }),
            8.5,
        );
        assert_eq!(
            node(&doc, 4).unwrap().appearance.label.as_deref(),
            Some("Mine")
        );
        apply(&mut doc, json!({ "kind": "touch", "id": id(3) }), 9.0);
        assert_eq!(node(&doc, 3).unwrap().touched_at, 9);

        apply(
            &mut doc,
            json!({ "kind": "removeKeepingChildren", "id": id(3) }),
            10.0,
        );
        assert!(node(&doc, 3).is_none());
        assert_eq!(
            node(&doc, 4).unwrap().placement.parent,
            Some(uuid::Uuid::from_u128(1))
        );
        doc.remove(&id(4)).unwrap();
        assert!(node(&doc, 4).is_none());

        // The host gets the whole document, compact; the export is the same
        // document, indented.
        let json = doc.to_json().unwrap();
        assert!(!json.contains('\n'), "{json}");
        let export = doc.export_json().unwrap();
        assert!(export.contains('\n'), "{export}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap(),
            serde_json::from_str::<serde_json::Value>(&export).unwrap()
        );
        let back = SvalDocument::load_json(&json).unwrap();
        assert_eq!(back.to_json().unwrap(), json);
    }

    #[test]
    fn settings_round_trip_through_the_bindings() {
        let mut doc = SvalDocument::new();
        let set = json!({ "kind": "setSetting", "key": "sval.search", "valueJson": "\"ddg\"" });
        apply(&mut doc, set, 1.0);
        let seed = json!({ "kind": "seedSetting", "key": "sval.search", "valueJson": "\"kagi\"" });
        assert_eq!(
            apply(&mut doc, seed, 2.0),
            json!({ "id": null, "changed": false })
        );
        let settings: serde_json::Value = serde_json::from_str(&doc.settings().unwrap()).unwrap();
        assert_eq!(settings, json!({"sval.search": "ddg"}));
    }

    #[test]
    fn every_favorites_mutator_changes_the_node_it_names() {
        let mut doc = SvalDocument::new();
        let mut add =
            |kind: &str, guid: &str, parent: Option<&str>, name: &str, url: Option<&str>| {
                let op = json!({
                    "kind": "addFavorite", "favoriteKind": kind, "guid": guid, "parent": parent,
                    "name": name, "url": url,
                });
                apply(&mut doc, op, 1.0)["id"].as_str().unwrap().to_owned()
            };
        let toolbar = add("folder", "toolbar_____", None, "", None);
        assert_eq!(
            toolbar,
            crate::types::favorite_id("toolbar_____").to_string()
        );
        let folder = add("folder", "folder000001", Some(&toolbar), "Work", None);
        let page = add(
            "favorite",
            "page00000001",
            Some(&folder),
            "Page",
            Some("https://p.example/"),
        );
        add("separator", "separator001", Some(&toolbar), "", None);

        let kinds: BTreeMap<String, String> =
            serde_json::from_str::<Vec<serde_json::Value>>(&doc.favorites().unwrap())
                .unwrap()
                .into_iter()
                .map(|row| {
                    (
                        row["guid"].as_str().unwrap().to_owned(),
                        row["kind"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
        assert_eq!(kinds["toolbar_____"], "folder");
        assert_eq!(kinds["folder000001"], "folder");
        assert_eq!(kinds["page00000001"], "favorite");
        assert_eq!(kinds["separator001"], "separator");

        let page_id = parse_id(&page).unwrap();

        doc.remove(&folder).unwrap();
        assert!(doc.0.node(page_id).is_none());
        assert!(doc.0.node(parse_id(&folder).unwrap()).is_none());
    }
}
