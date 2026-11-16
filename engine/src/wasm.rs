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
//! atomically, itself. `PreloadedStore` implements `StorageProvider` over
//! files already in memory, like [`crate::store::MemoryStore`], so it is
//! tested the same way, with plain `cargo test`. Only the
//! `#[wasm_bindgen]` wrappers at the bottom of this file touch a `JsValue`,
//! and they only copy bytes across the boundary.
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
use crate::store::{DeviceId, StorageProvider};
use crate::sync::{FileProblem, SyncReport, Target};
use crate::tree::MoveError;
use crate::types::{Document, Error, NodeId, NodeKind, Timestamp};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::BTreeMap;

/// A failure as a host receives it: a stable `code` to branch on, for an
/// `invalid_argument` a `reason` saying which check refused, and a `message`
/// for people (`docs/host-contract.md` §8). Kept free of `JsValue` so the pure
/// functions below can return it under plain `cargo test`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) reason: Option<Reason>,
    pub(crate) message: String,
}

impl Failure {
    /// A failure with a code of its own, which needs no reason.
    fn coded(code: &'static str, message: String) -> Self {
        Failure {
            code,
            reason: None,
            message,
        }
    }
}

/// Which check refused an argument no call could accept. A host and its tests
/// branch on [`Reason::as_str`], the `reason` property of the thrown error,
/// because the message may be reworded (`docs/host-contract.md` §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    TimestampNotFinite,
    TimestampOutOfRange,
    BadNodeId,
    BadDeviceId,
    EmptyAgentLabel,
    BadColor,
    NotAWorkspace,
    BadShardName,
    EmptySettingKey,
    SettingNotJson,
    BadFavoriteKind,
    BadFavoriteGuid,
    BadSweep,
    BadArchivedTabs,
    BadBatch,
    VisitWithoutUrl,
    SharesNotOnASplit,
    SharesCountMismatch,
    ShareNotPositive,
    SharesNotHundred,
    LocalWithoutUrl,
    TtlNotFinite,
    ExpiryOutOfRange,
    PathsFilesMismatch,
    FileNotBytes,
    BadAutoArchiveChoice,
    NotATab,
    NotArchivable,
    AgentWorkspace,
    NotAnEntry,
    WrongIdCount,
    NoTokensRequested,
}

impl Reason {
    /// The name a host reads in the error's `reason` property.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::TimestampNotFinite => "timestamp_not_finite",
            Reason::TimestampOutOfRange => "timestamp_out_of_range",
            Reason::BadNodeId => "bad_node_id",
            Reason::BadDeviceId => "bad_device_id",
            Reason::EmptyAgentLabel => "empty_agent_label",
            Reason::BadColor => "bad_color",
            Reason::NotAWorkspace => "not_a_workspace",
            Reason::BadShardName => "bad_shard_name",
            Reason::EmptySettingKey => "empty_setting_key",
            Reason::SettingNotJson => "setting_not_json",
            Reason::BadFavoriteKind => "bad_favorite_kind",
            Reason::BadFavoriteGuid => "bad_favorite_guid",
            Reason::BadSweep => "bad_sweep",
            Reason::BadArchivedTabs => "bad_archived_tabs",
            Reason::BadBatch => "bad_batch",
            Reason::VisitWithoutUrl => "visit_without_url",
            Reason::SharesNotOnASplit => "shares_not_on_a_split",
            Reason::SharesCountMismatch => "shares_count_mismatch",
            Reason::ShareNotPositive => "share_not_positive",
            Reason::SharesNotHundred => "shares_not_hundred",
            Reason::LocalWithoutUrl => "local_without_url",
            Reason::TtlNotFinite => "ttl_not_finite",
            Reason::ExpiryOutOfRange => "expiry_out_of_range",
            Reason::PathsFilesMismatch => "paths_files_mismatch",
            Reason::FileNotBytes => "file_not_bytes",
            Reason::BadAutoArchiveChoice => "bad_auto_archive_choice",
            Reason::NotATab => "not_a_tab",
            Reason::NotArchivable => "not_archivable",
            Reason::AgentWorkspace => "agent_workspace",
            Reason::NotAnEntry => "not_an_entry",
            Reason::WrongIdCount => "wrong_id_count",
            Reason::NoTokensRequested => "no_tokens_requested",
        }
    }
}

/// An argument a check refused, with why. Every one reaches the host as
/// `invalid_argument`: the host passed something no call could accept.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Invalid {
    pub(crate) reason: Reason,
    pub(crate) message: String,
}

impl Invalid {
    fn new(reason: Reason, message: impl Into<String>) -> Self {
        Invalid {
            reason,
            message: message.into(),
        }
    }
}

impl From<Invalid> for Failure {
    fn from(invalid: Invalid) -> Self {
        Failure {
            code: "invalid_argument",
            reason: Some(invalid.reason),
            message: invalid.message,
        }
    }
}

impl From<Error> for Failure {
    fn from(err: Error) -> Self {
        Failure::coded(err.code(), err.to_string())
    }
}

impl From<MoveError> for Failure {
    fn from(err: MoveError) -> Self {
        Failure::coded(err.code(), err.to_string())
    }
}

impl From<crate::archive::ArchiveError> for Failure {
    fn from(err: crate::archive::ArchiveError) -> Self {
        use crate::archive::ArchiveError as A;
        let reason = match err {
            A::BadChoice(_) => Reason::BadAutoArchiveChoice,
            A::NotATab(_) => Reason::NotATab,
            A::NotArchivable(_) => Reason::NotArchivable,
            A::NotAWorkspace(_) => Reason::NotAWorkspace,
            A::AgentWorkspace(_) => Reason::AgentWorkspace,
            A::NotAnEntry(_) => Reason::NotAnEntry,
            A::WrongIdCount { .. } => Reason::WrongIdCount,
            A::NoSuchNode(_) | A::NoWorkspace(_) | A::IdInUse(_) => {
                return Failure::coded(err.code(), err.to_string());
            }
        };
        Invalid::new(reason, err.to_string()).into()
    }
}

impl From<crate::privacy_pass::PrivacyPassError> for Failure {
    fn from(err: crate::privacy_pass::PrivacyPassError) -> Self {
        match err {
            crate::privacy_pass::PrivacyPassError::EmptyRequest => {
                Invalid::new(Reason::NoTokensRequested, err.to_string()).into()
            }
            _ => Failure::coded(err.code(), err.to_string()),
        }
    }
}

impl From<serde_json::Error> for Failure {
    fn from(err: serde_json::Error) -> Self {
        Error::from(err).into()
    }
}

/// JS's `Number.MAX_SAFE_INTEGER` (`2^53 - 1`): the largest integer an `f64`
/// represents exactly. A timestamp beyond it lost precision on the JS side,
/// so it is rejected.
const MAX_SAFE_TIMESTAMP: f64 = 9_007_199_254_740_991.0;

/// Validates and converts a host-supplied timestamp.
///
/// `as u64` saturates: `NaN` and negatives become `0`, and huge values
/// become `u64::MAX`. A host passing `undefined` (coerced to `NaN`) would
/// get timestamp `0`, and the edit would lose every last-writer-wins
/// comparison. `Infinity` would pin a node at `u64::MAX`, un-editable on
/// every device. Both are rejected.
fn parse_timestamp(now: f64) -> Result<Timestamp, Invalid> {
    if !now.is_finite() {
        return Err(Invalid::new(
            Reason::TimestampNotFinite,
            format!("timestamp must be a finite number, got {now}"),
        ));
    }
    if !(0.0..=MAX_SAFE_TIMESTAMP).contains(&now) {
        return Err(Invalid::new(
            Reason::TimestampOutOfRange,
            format!(
                "timestamp out of range 0..={MAX_SAFE_TIMESTAMP} (JS's Number.MAX_SAFE_INTEGER): got {now}"
            ),
        ));
    }
    Ok(now as u64)
}

fn parse_id(id: &str) -> Result<NodeId, Invalid> {
    NodeId::parse_str(id)
        .map_err(|_| Invalid::new(Reason::BadNodeId, format!("not a valid node id: {id}")))
}

/// The preset colour tokens Sval's palette draws
/// (`SvalPanelModel.COLOR_TOKENS`). A synced document holding a colour outside
/// [`parse_color`]'s shapes is a rendering bug on every device that reads it.
/// `Document::set_appearance` stores whatever it is given, because the palette
/// is a presentation concern, so this boundary refuses an invalid colour.
const COLOR_TOKENS: [&str; 10] = [
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray", "black",
];

/// The keys of a workspace's custom colour: OKLCH hue, chroma and lightness,
/// and the appearance it was picked in (decision 0057).
const WORKSPACE_COLOR_KEYS: [&str; 4] = ["c", "h", "l", "mode"];

/// The keys of a group's custom colour: OKLCH hue and chroma. Its window sets
/// its lightness (decision 0057).
const GROUP_COLOR_KEYS: [&str; 2] = ["c", "h"];

/// The largest chroma a custom colour may carry, past the most any sRGB
/// colour reaches in OKLCH.
const MAX_CHROMA: f64 = 0.4;
/// An agent label is shown on every device the document reaches, so an empty
/// one is refused.
fn parse_agent_label(label: &str) -> Result<String, Invalid> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(Invalid::new(
            Reason::EmptyAgentLabel,
            "an agent label must not be empty",
        ));
    }
    Ok(trimmed.to_owned())
}

/// Checks `color` for a node of `kind`: a preset token on any node, or a
/// custom colour object in the shape its kind takes (decision 0057). `None`
/// clears the colour and is always accepted.
///
/// A custom colour is rebuilt from its parsed numbers, so a whole number a
/// host sends as `200` is stored as `200.0` on every device, whichever way
/// that host's JSON writes it.
fn parse_color(
    kind: &NodeKind,
    color: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, Invalid> {
    let bad = |message: String| Invalid::new(Reason::BadColor, message);
    let fields = match color {
        None => return Ok(None),
        Some(serde_json::Value::String(token)) => {
            if COLOR_TOKENS.contains(&token.as_str()) {
                return Ok(Some(serde_json::Value::String(token)));
            }
            return Err(bad(format!(
                "not a valid colour token: {token} (expected one of {})",
                COLOR_TOKENS.join(", ")
            )));
        }
        Some(serde_json::Value::Object(fields)) => fields,
        Some(other) => {
            return Err(bad(format!(
                "a colour is a token or an object: got {other}"
            )));
        }
    };
    let keys: &[&str] = match kind {
        NodeKind::Workspace => &WORKSPACE_COLOR_KEYS,
        NodeKind::Group => &GROUP_COLOR_KEYS,
        _ => {
            return Err(bad(format!(
                "only a workspace or a group takes a custom colour: this is a {kind:?}"
            )));
        }
    };
    if !fields.keys().map(String::as_str).eq(keys.iter().copied()) {
        let got: Vec<&str> = fields.keys().map(String::as_str).collect();
        return Err(bad(format!(
            "a {kind:?}'s custom colour takes exactly the keys {}: got {}",
            keys.join(", "),
            got.join(", ")
        )));
    }
    let number = |key: &str, max: f64, max_included: bool| -> Result<f64, Invalid> {
        let value = &fields[key];
        match value.as_f64() {
            Some(n) if n >= 0.0 && (n < max || max_included && n == max) => Ok(n),
            _ => {
                let close = if max_included { "]" } else { ")" };
                Err(bad(format!(
                    "a custom colour's {key} must be a number in [0, {max}{close}: got {value}"
                )))
            }
        }
    };
    let h = number("h", 360.0, false)?;
    let c = number("c", MAX_CHROMA, true)?;
    if *kind == NodeKind::Group {
        return Ok(Some(serde_json::json!({ "h": h, "c": c })));
    }
    let l = number("l", 1.0, true)?;
    let mode = match fields["mode"].as_str() {
        Some(mode @ ("dark" | "light")) => mode,
        _ => {
            return Err(bad(format!(
                "a custom colour's mode must be \"dark\" or \"light\": got {}",
                fields["mode"]
            )));
        }
    };
    Ok(Some(
        serde_json::json!({ "h": h, "c": c, "l": l, "mode": mode }),
    ))
}

/// Reads the colour a host passed to `setAppearance`, as `JSON.stringify`
/// wrote it. `None` is a value `JSON.stringify` could not write, such as a
/// function.
fn color_from_json(json: Option<String>) -> Result<serde_json::Value, Invalid> {
    json.and_then(|json| serde_json::from_str(&json).ok())
        .ok_or_else(|| {
            Invalid::new(
                Reason::BadColor,
                "a colour must be a token or a plain object",
            )
        })
}

/// Checks a transparency for a node of `kind`: only a workspace's window
/// shows what is behind it (decision 0057). `None` is solid and always
/// accepted.
fn parse_transparency(kind: &NodeKind, transparency: Option<f64>) -> Result<Option<f64>, Invalid> {
    let Some(t) = transparency else {
        return Ok(None);
    };
    if *kind != NodeKind::Workspace {
        return Err(Invalid::new(
            Reason::BadColor,
            format!("only a workspace takes a transparency: this is a {kind:?}"),
        ));
    }
    if !(0.0..=1.0).contains(&t) {
        return Err(Invalid::new(
            Reason::BadColor,
            format!("transparency must be a number in [0, 1]: got {t}"),
        ));
    }
    Ok(Some(t))
}

/// Parses a host-supplied device id: exactly the 16 bytes the host generated
/// once and persists (`docs/host-contract.md` §3). Any other length is
/// rejected.
///
/// Every mutator that stamps a fact group takes this, because the group
/// records who last wrote it as well as when (spec §5.4), and the crate has no
/// identity of its own, as it has no clock. It must be the value the host
/// uses for its own file name, the same across the device's lifetime, or its
/// peers' watermarks name a device that never writes again.
fn parse_device_id(bytes: &[u8]) -> Result<DeviceId, Invalid> {
    let bytes: [u8; 16] = bytes.try_into().map_err(|_| {
        Invalid::new(
            Reason::BadDeviceId,
            format!("device id must be exactly 16 bytes, got {}", bytes.len()),
        )
    })?;
    Ok(DeviceId::from_bytes(bytes))
}

/// Confirms `id` names a node that exists, so a mutator either succeeds or
/// reports an error.
///
/// The `Document` methods no-op on a missing id, so without this a host's
/// `remove` or `rename` of an unknown id would report success. `addTab` under
/// a missing parent would create an orphan that
/// `tree::repair_unreachable_ancestry` later reparents somewhere the user
/// never put it.
fn require_node(doc: &Document, id: NodeId) -> Result<(), Failure> {
    node_kind(doc, id).map(|_| ())
}

/// The kind of `id`, refusing an id the document does not hold as
/// [`require_node`] does.
fn node_kind(doc: &Document, id: NodeId) -> Result<&NodeKind, Failure> {
    match doc.node(id) {
        Some(node) => Ok(&node.kind),
        None => Err(Failure::coded(
            "no_such_node",
            format!("no such node: {id}"),
        )),
    }
}

/// Refuses a node that is not a pin. [`Document::set_pin_scope`] leaves
/// any other node as it is, so without this the host would be told a scope
/// was set that was not.
fn require_pin(doc: &Document, id: NodeId) -> Result<(), Failure> {
    if doc.is_pin(id) {
        Ok(())
    } else {
        Err(Failure::coded("not_a_pin", format!("not a pin: {id}")))
    }
}

/// Refuses a node that is not a visit. [`Document::set_visit_title`] writes
/// the content name of whatever node it is given, which on a tab is the
/// tab's name.
fn require_visit(doc: &Document, id: NodeId) -> Result<(), Failure> {
    match doc.node(id) {
        Some(node) if node.kind == NodeKind::Visit => Ok(()),
        _ => Err(Failure::coded("not_a_visit", format!("not a visit: {id}"))),
    }
}

/// Refuses a node that is not a workspace, for a call only a workspace can
/// take. `id` is known to be in the document.
fn require_workspace(doc: &Document, id: NodeId) -> Result<(), Failure> {
    match doc.node(id) {
        Some(node) if node.kind == crate::types::NodeKind::Workspace => Ok(()),
        _ => Err(Invalid::new(Reason::NotAWorkspace, format!("not a workspace: {id}")).into()),
    }
}

/// Refuses an id a node already has. [`Document`]'s `add_*` methods replace
/// whatever is there, which is never what a host adding a node means.
fn require_unused(doc: &Document, id: NodeId) -> Result<(), Failure> {
    if doc.node(id).is_none() {
        return Ok(());
    }
    Err(Failure::coded(
        "id_in_use",
        format!("a node already has id {id}"),
    ))
}

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
    changed_ids: Vec<String>,
    removed_ids: Vec<String>,
    harmed_by_clock: Vec<String>,
    own_watermark: Timestamp,
}

/// One [`FileProblem`], as a host reads it.
#[derive(Serialize)]
pub(crate) struct JsFileProblem {
    path: String,
    own: bool,
    reason: String,
}

impl From<FileProblem> for JsFileProblem {
    fn from(problem: FileProblem) -> Self {
        JsFileProblem {
            path: problem.path,
            own: problem.own,
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

/// A history shard's name from the host: `history-YYYY-Www`, the ISO week
/// its visits fall in (history-sync spec §2).
fn parse_shard_name(name: &str) -> Result<&str, Invalid> {
    let b = name.as_bytes();
    let valid = b.len() == 16
        && name.starts_with("history-")
        && b[8..12].iter().all(u8::is_ascii_digit)
        && b[12] == b'-'
        && b[13] == b'W'
        && b[14..16].iter().all(u8::is_ascii_digit)
        && matches!(name[14..16].parse::<u8>(), Ok(1..=53));
    if valid {
        Ok(name)
    } else {
        Err(Invalid::new(
            Reason::BadShardName,
            format!("not a history shard name: {name} (expected history-YYYY-Www)"),
        ))
    }
}

/// One visit, as a host reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsVisit {
    id: String,
    url: Option<String>,
    title: String,
    visited_at: Timestamp,
    transition: u32,
    device: String,
    /// The workspace's id, or null for a visit made in none.
    workspace: Option<String>,
}

/// Every visit in a week's document, oldest first.
fn visits_json(doc: &Document) -> Result<String, Failure> {
    let mut rows: Vec<JsVisit> = doc
        .nodes
        .iter()
        .filter(|(_, n)| n.kind == NodeKind::Visit)
        .filter_map(|(id, n)| {
            let visit = n.content.visit.as_ref()?;
            Some(JsVisit {
                id: id.to_string(),
                url: n.content.url.clone(),
                title: n.content.name.clone(),
                visited_at: visit.at,
                transition: visit.transition,
                device: visit.device.to_string(),
                workspace: visit.workspace.map(|w| w.to_string()),
            })
        })
        .collect();
    rows.sort_by(|a, b| (a.visited_at, &a.id).cmp(&(b.visited_at, &b.id)));
    Ok(serde_json::to_string(&rows)?)
}

/// One shard's entry in the history index, as a host reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsShard {
    name: String,
    /// When any device last wrote to the shard: the later of the entry's
    /// creation and its touch.
    changed_at: Timestamp,
}

/// Every shard the history index lists, newest first.
fn shards_json(doc: &Document) -> Result<String, Failure> {
    let mut rows: Vec<JsShard> = doc
        .nodes
        .values()
        .filter(|n| n.kind == NodeKind::Shard)
        .map(|n| JsShard {
            name: n.content.name.clone(),
            changed_at: n.content_at.max(n.touched_at),
        })
        .collect();
    rows.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(serde_json::to_string(&rows)?)
}

/// A setting key from the host. Empty is refused: a nameless setting is a
/// host bug, and once synced it would sit on every device unreadable.
fn parse_setting_key(key: &str) -> Result<&str, Invalid> {
    if key.is_empty() {
        return Err(Invalid::new(
            Reason::EmptySettingKey,
            "a setting needs a key",
        ));
    }
    Ok(key)
}

/// A setting value from the host, as JSON text. Absent and JSON `null` both
/// mean "reset to default"; storing a JSON null would read back as a value.
fn parse_setting_value(json: Option<String>) -> Result<Option<serde_json::Value>, Invalid> {
    match json {
        None => Ok(None),
        Some(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Null) => Ok(None),
            Ok(value) => Ok(Some(value)),
            Err(err) => Err(Invalid::new(
                Reason::SettingNotJson,
                format!("a setting value must be JSON: {err}"),
            )),
        },
    }
}

/// [`Document::settings`] as a JSON object, `null` for a reset.
fn settings_json(doc: &Document) -> Result<String, Failure> {
    Ok(serde_json::to_string(&doc.settings())?)
}

/// A favorite-document node kind from the host: `favorite`, `folder` or
/// `separator`. Any other kind belongs to another document.
fn parse_favorite_kind(kind: &str) -> Result<NodeKind, Invalid> {
    match kind {
        "favorite" => Ok(NodeKind::Favorite),
        "folder" => Ok(NodeKind::Folder),
        "separator" => Ok(NodeKind::Separator),
        other => Err(Invalid::new(
            Reason::BadFavoriteKind,
            format!("not a Favorites kind: {other} (expected favorite, folder or separator)"),
        )),
    }
}

/// A favorite's guid from the host: twelve characters of the URL-safe base64
/// alphabet, the shape Places gives its own guids (`PlacesUtils.isValidGuid`),
/// which the host mints its guids with and the bookmarks HTML file and the
/// extensions' API still carry.
fn parse_favorite_guid(guid: &str) -> Result<&str, Invalid> {
    let valid = guid.len() == 12
        && guid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(guid)
    } else {
        Err(Invalid::new(
            Reason::BadFavoriteGuid,
            format!("not a favorite guid: {guid}"),
        ))
    }
}

/// One node of the `favorites` document, as a host reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsFavorite {
    id: String,
    kind: String,
    guid: Option<String>,
    parent: Option<String>,
    order: String,
    name: String,
    url: Option<String>,
    pinned: bool,
    /// The workspaces a pin shows in, or null for every workspace.
    pin_scope: Option<Vec<String>>,
    /// When the name and URL, and the place in the tree, were last written,
    /// so a host can tell how recent a favorite's name and place are.
    content_at: Timestamp,
    placement_at: Timestamp,
    /// When it was added, which no later write moves.
    added: Option<Timestamp>,
    /// Whether its address stays on this device (decision 1372).
    local: bool,
}

/// Every favorite, folder and separator, ordered by parent and then by
/// order among siblings, so a host reads each folder's children in order.
fn favorites_json(doc: &Document) -> Result<String, Failure> {
    let mut rows: Vec<JsFavorite> = doc
        .nodes
        .iter()
        .filter(|(_, n)| n.kind.is_favorite_kind())
        .map(|(id, n)| JsFavorite {
            id: id.to_string(),
            kind: match n.kind {
                NodeKind::Favorite => "favorite",
                NodeKind::Folder => "folder",
                _ => "separator",
            }
            .to_string(),
            guid: n.content.guid.clone(),
            parent: n.placement.parent.map(|p| p.to_string()),
            order: n.placement.order.to_string(),
            name: n.content.name.clone(),
            url: n.content.url.clone(),
            pinned: n.lifecycle.pinned,
            pin_scope: n
                .lifecycle
                .pin_scope
                .as_ref()
                .map(|s| s.iter().cloned().collect()),
            content_at: n.content_at,
            placement_at: n.placement_at,
            added: n.content.added,
            local: n.content.local,
        })
        .collect();
    rows.sort_by(|a, b| (&a.parent, &a.order, &a.id).cmp(&(&b.parent, &b.order, &b.id)));
    Ok(serde_json::to_string(&rows)?)
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
    let report = crate::sync::sync_to(
        &store, &key, device, workspace, doc, now, retention, target, clamp_from,
    )?;
    Ok((report.into(), store.into_written()))
}

/// One Archive entry, as a host reads it (idle-tab archive spec §6.2).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsArchived {
    id: String,
    url: Option<String>,
    title: String,
    icon: Option<String>,
    workspace: String,
    workspace_name: String,
    /// When it was archived, no later than the reader's clock (decision
    /// 0135).
    closed_at: Timestamp,
    device: String,
    restored: bool,
    split: Option<String>,
    pane: Option<u32>,
    /// How many ids `restore` takes for this entry.
    restore_ids: usize,
    /// Whether its address stays on this device (decision 1372).
    local: bool,
}

/// Every entry in the Archive, newest first, a split's panes in their order.
fn archived_json(doc: &Document, now: Timestamp) -> Result<String, Failure> {
    let mut rows = Vec::new();
    for (id, n) in &doc.nodes {
        let Some(record) = n
            .content
            .archived
            .as_ref()
            .filter(|_| n.kind == NodeKind::Archived)
        else {
            continue;
        };
        rows.push(JsArchived {
            id: id.to_string(),
            url: n.content.url.clone(),
            title: n.content.name.clone(),
            icon: n.content.icon.clone(),
            workspace: record.workspace.to_string(),
            workspace_name: record.workspace_name.clone(),
            closed_at: record.closed_at.min(now),
            device: record.device.to_string(),
            restored: n.lifecycle.restored,
            split: record.split.as_ref().map(|s| s.id.to_string()),
            pane: record.split.as_ref().map(|s| s.pane),
            restore_ids: crate::archive::ids_needed(doc, *id)?,
            local: n.content.local,
        });
    }
    rows.sort_by(|a, b| {
        (b.closed_at, &a.split, a.pane, &a.id).cmp(&(a.closed_at, &b.split, b.pane, &b.id))
    });
    Ok(serde_json::to_string(&rows)?)
}

/// What a host hands a sweep, as JSON (idle-tab archive spec §4.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsSweep {
    default: String,
    #[serde(default)]
    last_active: BTreeMap<String, f64>,
    #[serde(default)]
    exempt: Vec<String>,
}

/// Runs [`crate::archive::archive_idle`] on `tree` and `archive` for the
/// sweep `sweep_json` describes, and answers `{ tabs, entries }`.
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
fn swept_json(swept: &crate::archive::Swept) -> String {
    serde_json::json!({ "tabs": id_strings(&swept.tabs), "entries": id_strings(&swept.entries) })
        .to_string()
}

/// Runs [`crate::archive::archive_now`] on `tree` and `archive` for tab
/// `id`, and answers `{ tabs, entries }`, as a sweep does.
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

/// This device's own path within [`sync_prefix`]'s directory: the file a
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

/// One change to a document, as a host spells it: the shape
/// `SvalDocumentOps.mjs` sends, named by `kind`, with every node id as a
/// string. The device and the time are not part of it, because every change
/// in a batch shares them.
///
/// Each `#[wasm_bindgen]` mutator on [`SvalDocument`] builds one of these and
/// applies it through [`apply_op`], and a batch applies a list of them
/// through [`apply_batch`], so an operation is checked the same way alone and
/// inside a batch.
#[derive(Debug, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Op {
    AddWorkspace {
        name: String,
        icon: Option<String>,
        id: String,
        isolated: Option<bool>,
    },
    AddAgentWorkspace {
        name: String,
        agent_label: String,
        id: String,
        isolated: Option<bool>,
    },
    SetIsolation {
        id: String,
        #[serde(default)]
        isolated: bool,
    },
    AddGroup {
        parent: String,
        name: String,
        icon: Option<String>,
        id: String,
    },
    AddSplit {
        parent: String,
        #[serde(default)]
        name: String,
        id: String,
        before: Option<String>,
        after: Option<String>,
    },
    AddTab {
        parent: String,
        name: String,
        url: String,
        id: String,
        before: Option<String>,
        after: Option<String>,
        #[serde(default)]
        local: bool,
    },
    MoveNode {
        id: String,
        new_parent: String,
        before: Option<String>,
        after: Option<String>,
    },
    MoveWorkspace {
        id: String,
        before: Option<String>,
        after: Option<String>,
    },
    Rename {
        id: String,
        name: String,
    },
    SetContent {
        id: String,
        name: String,
        url: Option<String>,
        icon: Option<String>,
        shares: Option<Vec<f64>>,
        #[serde(default)]
        local: bool,
    },
    SetLocal {
        id: String,
        local: bool,
    },
    SetAppearance {
        id: String,
        color: Option<serde_json::Value>,
        emoji: Option<String>,
        transparency: Option<f64>,
    },
    SetLabel {
        id: String,
        label: Option<String>,
    },
    Touch {
        id: String,
    },
    SetSetting {
        key: String,
        value_json: Option<String>,
    },
    AddFavorite {
        favorite_kind: String,
        guid: String,
        parent: Option<String>,
        before: Option<String>,
        after: Option<String>,
        name: String,
        url: Option<String>,
        #[serde(default)]
        local: bool,
    },
    /// The pass that moves a profile's pins into the pins root (pins-root
    /// spec §8).
    MovePinsToRoot,
    SetPinScope {
        id: String,
        #[serde(default)]
        scope: Option<Vec<String>>,
    },
    RemoveKeepingChildren {
        id: String,
    },
    AddVisit {
        url: String,
        #[serde(default)]
        title: String,
        transition: u32,
        visited_at: f64,
        #[serde(default)]
        workspace: Option<String>,
    },
    SetVisitTitle {
        id: String,
        #[serde(default)]
        title: String,
    },
    TouchShard {
        name: String,
    },
    SetAutoArchive {
        id: String,
        choice: Option<String>,
    },
    MarkUsed {
        id: String,
    },
    Remove {
        id: String,
    },
}

fn parse_optional_id(id: Option<String>) -> Result<Option<NodeId>, Invalid> {
    id.map(|id| parse_id(&id)).transpose()
}

/// Applies `op` to `doc`, stamped with `by` and `now`, and returns the id of
/// the node it added, where it added one.
///
/// Every check comes before the change, and the change itself cannot fail,
/// so a refused operation leaves `doc` exactly as it was.
pub(crate) fn apply_op(
    doc: &mut Document,
    op: Op,
    by: DeviceId,
    now: Timestamp,
) -> Result<Option<NodeId>, Failure> {
    match op {
        Op::AddWorkspace {
            name,
            icon,
            id,
            isolated,
        } => {
            let id = parse_id(&id)?;
            require_unused(doc, id)?;
            doc.add_workspace(name, icon, id, by, now);
            isolate_at_creation(doc, id, isolated);
            Ok(Some(id))
        }
        Op::AddAgentWorkspace {
            name,
            agent_label,
            id,
            isolated,
        } => {
            // An agent's workspace (agent-control spec §3.5). The device in
            // the mark is `by`, the device the agent paired with.
            let label = parse_agent_label(&agent_label)?;
            let id = parse_id(&id)?;
            require_unused(doc, id)?;
            doc.add_agent_workspace(name, label, id, by, now);
            isolate_at_creation(doc, id, isolated);
            Ok(Some(id))
        }
        Op::SetIsolation { id, isolated } => {
            // Only a workspace has a cookie jar to choose (isolated
            // workspaces spec §5).
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            require_workspace(doc, id)?;
            doc.set_isolation(id, isolated, by, now);
            Ok(None)
        }
        Op::AddGroup {
            parent,
            name,
            icon,
            id,
        } => {
            let parent = parse_id(&parent)?;
            let id = parse_id(&id)?;
            crate::tree::validate_parent(doc, None, &NodeKind::Group, parent)?;
            require_unused(doc, id)?;
            doc.add_group(parent, name, icon, id, by, now);
            Ok(Some(id))
        }
        Op::AddSplit {
            parent,
            name,
            id,
            before,
            after,
        } => {
            // An empty split, at the place the host names; the batch that
            // adds it moves its panes in (split-view spec §5.2).
            let parent = parse_id(&parent)?;
            let id = parse_id(&id)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            crate::tree::validate_parent(doc, None, &NodeKind::Split, parent)?;
            require_unused(doc, id)?;
            doc.add_split(parent, name, id, by, now);
            if before.is_some() || after.is_some() {
                let order = crate::tree::order_between(doc, before, after);
                if let Some(node) = doc.node_mut(id) {
                    node.placement.order = order;
                }
            }
            Ok(Some(id))
        }
        Op::AddTab {
            parent,
            name,
            url,
            id,
            before,
            after,
            local,
        } => {
            let parent = parse_id(&parent)?;
            let id = parse_id(&id)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            crate::tree::validate_parent(doc, None, &NodeKind::Tab, parent)?;
            require_unused(doc, id)?;
            // With neither neighbour the tab goes after the parent's last
            // child, as `add_tab` places it: where a tab opened at the end of
            // a strip belongs. With one, a tab opened mid-strip is filed where
            // it sits in a single placement fact.
            if before.is_none() && after.is_none() {
                doc.add_tab(parent, name, url, id, by, now);
            } else {
                crate::tree::insert_tab_between(doc, parent, before, after, name, url, id, by, now);
            }
            mark_local(doc, id, local);
            Ok(Some(id))
        }
        Op::MoveNode {
            id,
            new_parent,
            before,
            after,
        } => {
            let id = parse_id(&id)?;
            let new_parent = parse_id(&new_parent)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            // `tree::move_node` validates the node and its new parent itself,
            // so a native caller gets the same refusals a host does.
            crate::tree::move_node(doc, id, new_parent, before, after, by, now)?;
            Ok(None)
        }
        Op::MoveWorkspace { id, before, after } => {
            let id = parse_id(&id)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            crate::tree::move_workspace(doc, id, before, after, by, now)?;
            Ok(None)
        }
        Op::Rename { id, name } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            doc.rename(id, name, by, now);
            Ok(None)
        }
        Op::SetContent {
            id,
            name,
            url,
            icon,
            shares,
            local,
        } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            if let Some(shares) = &shares {
                check_shares(doc, id, shares)?;
            }
            require_address_if_local(url.as_deref(), local)?;
            // The mark follows the address (decision 1372): a write that sends
            // back the address the node holds keeps the node's mark, so one
            // another device wrote stays refused however it is re-sent.
            let local = match doc.node(id) {
                Some(node) if node.content.url == url => node.content.local,
                _ => local,
            };
            doc.set_content(id, name, url, icon, shares, local, by, now);
            Ok(None)
        }
        Op::SetLocal { id, local } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            let content = doc.node(id).map(|node| node.content.clone());
            if let Some(content) = content.filter(|content| content.local != local) {
                require_address_if_local(content.url.as_deref(), local)?;
                // Stamped now, so a node coming back is news to every peer,
                // as an address crossing back is (decision 1372).
                doc.set_content(
                    id,
                    content.name,
                    content.url,
                    content.icon,
                    content.shares,
                    local,
                    by,
                    now,
                );
            }
            Ok(None)
        }
        Op::SetAppearance {
            id,
            color,
            emoji,
            transparency,
        } => {
            let id = parse_id(&id)?;
            let kind = node_kind(doc, id)?;
            let color = parse_color(kind, color)?;
            let transparency = parse_transparency(kind, transparency)?;
            doc.set_appearance(id, color, emoji, transparency, by, now);
            Ok(None)
        }
        Op::SetLabel { id, label } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            doc.set_label(id, label, by, now);
            Ok(None)
        }
        Op::Touch { id } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            doc.touch(id, by, now);
            Ok(None)
        }
        Op::SetSetting { key, value_json } => {
            let key = parse_setting_key(&key)?;
            let value = parse_setting_value(value_json)?;
            doc.set_setting(key, value, by, now);
            Ok(None)
        }
        Op::AddFavorite {
            favorite_kind,
            guid,
            parent,
            before,
            after,
            name,
            url,
            local,
        } => {
            let kind = parse_favorite_kind(&favorite_kind)?;
            let guid = parse_favorite_guid(&guid)?;
            let parent = parse_optional_id(parent)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            if let Some(parent) = parent {
                crate::tree::validate_parent(doc, None, &kind, parent)?;
            }
            require_address_if_local(url.as_deref(), local)?;
            let id = doc.add_favorite(kind, guid, parent, before, after, name, url, by, now);
            mark_local(doc, id, local);
            Ok(Some(id))
        }
        Op::MovePinsToRoot => {
            crate::pins::move_pins_to_root(doc, by, now);
            Ok(None)
        }
        Op::SetPinScope { id, scope } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            require_pin(doc, id)?;
            doc.set_pin_scope(id, scope.map(|s| s.into_iter().collect()), by, now);
            Ok(None)
        }
        Op::RemoveKeepingChildren { id } => {
            let id = parse_id(&id)?;
            crate::tree::remove_keeping_children(doc, id, by, now)?;
            Ok(None)
        }
        Op::AddVisit {
            url,
            title,
            transition,
            visited_at,
            workspace,
        } => {
            let at = parse_timestamp(visited_at)?;
            if url.is_empty() {
                return Err(Invalid::new(Reason::VisitWithoutUrl, "a visit needs a URL").into());
            }
            let workspace = workspace.as_deref().map(parse_id).transpose()?;
            Ok(Some(doc.add_visit_in(
                &url, title, transition, at, workspace, by, now,
            )))
        }
        Op::SetVisitTitle { id, title } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            require_visit(doc, id)?;
            doc.set_visit_title(id, title, by, now);
            Ok(None)
        }
        Op::TouchShard { name } => {
            let name = parse_shard_name(&name)?;
            doc.touch_shard(name, by, now);
            Ok(None)
        }
        Op::SetAutoArchive { id, choice } => {
            let id = parse_id(&id)?;
            crate::archive::set_auto_archive(doc, id, choice.as_deref(), by, now)?;
            Ok(None)
        }
        Op::MarkUsed { id } => {
            let id = parse_id(&id)?;
            crate::archive::mark_used(doc, id, by, now)?;
            Ok(None)
        }
        Op::Remove { id } => remove(doc, &id).map(|_| None),
    }
}

/// Refuses `shares` unless `id` is a split and the list gives each of its
/// panes a positive width, in pane order, summing to 100 (split-view spec
/// §5.1). A list nothing can draw must not reach the synced document.
fn check_shares(doc: &Document, id: NodeId, shares: &[f64]) -> Result<(), Failure> {
    if doc.node(id).is_none_or(|n| n.kind != NodeKind::Split) {
        return Err(Invalid::new(
            Reason::SharesNotOnASplit,
            format!("only a split has shares: {id}"),
        )
        .into());
    }
    let panes = crate::tree::children(doc, id)
        .into_iter()
        .filter(|&pane| doc.node(pane).is_some_and(|n| n.kind == NodeKind::Tab))
        .count();
    if shares.len() != panes {
        return Err(Invalid::new(
            Reason::SharesCountMismatch,
            format!(
                "split {id} has {panes} panes, and shares gives {}",
                shares.len()
            ),
        )
        .into());
    }
    if shares
        .iter()
        .any(|share| !share.is_finite() || *share <= 0.0)
    {
        return Err(Invalid::new(
            Reason::ShareNotPositive,
            "each share must be a positive number",
        )
        .into());
    }
    let total: f64 = shares.iter().sum();
    if (total - 100.0).abs() > SHARES_TOLERANCE {
        return Err(Invalid::new(
            Reason::SharesNotHundred,
            format!("shares must sum to 100, got {total}"),
        )
        .into());
    }
    Ok(())
}

/// Refuses a `local` mark on a write that carries no address: only an
/// address can keep a node on this device (decision 1372), and a workspace
/// or folder held back from the shared folder would take its children's
/// parent from every peer.
fn require_address_if_local(url: Option<&str>, local: bool) -> Result<(), Failure> {
    if local && url.is_none() {
        return Err(Invalid::new(
            Reason::LocalWithoutUrl,
            "only a node with an address can be local",
        )
        .into());
    }
    Ok(())
}

/// Sets the [`crate::types::Content::local`] mark of node `id`, which an add
/// just made, under the add's own content stamp.
fn mark_local(doc: &mut Document, id: NodeId, local: bool) {
    if let Some(node) = doc.node_mut(id) {
        node.content.local = local;
    }
}

/// How far from 100 a host's shares may sum, for percentages it computed from
/// pixel widths and rounded.
const SHARES_TOLERANCE: f64 = 0.1;

/// Deletes `id` and everything beneath it, the one operation that stamps
/// nothing: a deletion leaves no record (spec §5.4).
fn remove(doc: &mut Document, id: &str) -> Result<(), Failure> {
    let id = parse_id(id)?;
    require_node(doc, id)?;
    doc.remove(id);
    Ok(())
}

/// The id a host is handed back for a node an operation added.
fn added(id: Option<NodeId>) -> String {
    id.map(|id| id.to_string()).unwrap_or_default()
}

/// Marks a workspace just added as isolated. The flag is part of the
/// lifecycle group the add already stamped, so it shares that stamp: a
/// second write at the same instant would be one write described twice.
fn isolate_at_creation(doc: &mut Document, id: NodeId, isolated: Option<bool>) {
    if isolated == Some(true)
        && let Some(node) = doc.node_mut(id)
    {
        node.lifecycle.isolated = true;
    }
}

/// Applies the JSON array of [`Op`]s `ops_json` to `doc`, all of them or none.
///
/// A batch is one act to the user, such as making a group of two tabs, so no
/// write may carry part of one. The operations are applied in order to a
/// copy of `doc`, so a later one can name a node an earlier one added, and
/// the copy replaces `doc` only once every one has been applied. A refusal
/// anywhere leaves `doc` as it was, its stamps and watermarks included, and
/// answers with the refused operation's own failure.
///
/// A single operation is applied to `doc` directly: [`apply_op`] refuses one
/// with the document untouched, so it needs no copy.
pub(crate) fn apply_batch(
    doc: &mut Document,
    ops_json: &str,
    device_id: &[u8],
    now: f64,
) -> Result<(), Failure> {
    let mut ops: Vec<Op> = serde_json::from_str(ops_json).map_err(|err| {
        Invalid::new(
            Reason::BadBatch,
            format!("not a batch of operations: {err}"),
        )
    })?;
    let by = parse_device_id(device_id)?;
    let now = parse_timestamp(now)?;
    if ops.len() == 1
        && let Some(op) = ops.pop()
    {
        return apply_op(doc, op, by, now).map(|_| ());
    }
    let mut candidate = doc.clone();
    for op in ops {
        apply_op(&mut candidate, op, by, now)?;
    }
    *doc = candidate;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{DeviceId as StoreDeviceId, save_document};
    use crate::types::test_support::{test_device, uid};

    fn key_bytes() -> Vec<u8> {
        crate::types::test_support::test_key().to_bytes().to_vec()
    }

    // --- typed reasons ------------------------------------------------

    /// A reason's name is its variant's, in snake case, so the names a host
    /// reads (`docs/host-contract.md` §8) follow from the enum.
    #[test]
    fn a_reason_is_named_for_its_variant() {
        use Reason::*;
        for reason in [
            TimestampNotFinite,
            TimestampOutOfRange,
            BadNodeId,
            BadDeviceId,
            EmptyAgentLabel,
            BadColor,
            NotAWorkspace,
            BadShardName,
            EmptySettingKey,
            SettingNotJson,
            BadFavoriteKind,
            BadFavoriteGuid,
            BadSweep,
            BadArchivedTabs,
            BadBatch,
            VisitWithoutUrl,
            SharesNotOnASplit,
            SharesCountMismatch,
            ShareNotPositive,
            SharesNotHundred,
            LocalWithoutUrl,
            TtlNotFinite,
            ExpiryOutOfRange,
            PathsFilesMismatch,
            FileNotBytes,
            BadAutoArchiveChoice,
            NotATab,
            NotArchivable,
            AgentWorkspace,
            NotAnEntry,
            WrongIdCount,
            NoTokensRequested,
        ] {
            let mut snake = String::new();
            for (i, c) in format!("{reason:?}").chars().enumerate() {
                if c.is_ascii_uppercase() && i > 0 {
                    snake.push('_');
                }
                snake.push(c.to_ascii_lowercase());
            }
            assert_eq!(reason.as_str(), snake);
        }
    }

    #[test]
    fn an_archive_refusal_of_an_argument_carries_its_reason() {
        use crate::archive::ArchiveError as A;
        let id = crate::types::test_support::test_id();
        for (err, reason) in [
            (A::BadChoice("1y".into()), Reason::BadAutoArchiveChoice),
            (A::NotATab(id), Reason::NotATab),
            (A::NotArchivable(id), Reason::NotArchivable),
            (A::NotAWorkspace(id), Reason::NotAWorkspace),
            (A::AgentWorkspace(id), Reason::AgentWorkspace),
            (A::NotAnEntry(id), Reason::NotAnEntry),
            (
                A::WrongIdCount {
                    needed: 2,
                    given: 1,
                },
                Reason::WrongIdCount,
            ),
        ] {
            let failure = Failure::from(err);
            assert_eq!(
                (failure.code, failure.reason),
                ("invalid_argument", Some(reason))
            );
        }
        for (err, code) in [
            (A::NoSuchNode(id), "no_such_node"),
            (A::NoWorkspace(id), "no_such_parent"),
            (A::IdInUse(id), "id_in_use"),
        ] {
            let failure = Failure::from(err);
            assert_eq!((failure.code, failure.reason), (code, None));
        }
    }

    #[test]
    fn a_token_request_for_no_tokens_carries_its_reason() {
        use crate::privacy_pass::PrivacyPassError as P;
        let failure = Failure::from(P::EmptyRequest);
        assert_eq!(
            (failure.code, failure.reason),
            ("invalid_argument", Some(Reason::NoTokensRequested))
        );
        let failure = Failure::from(P::InvalidState);
        assert_eq!((failure.code, failure.reason), ("invalid_state", None));
    }

    // --- timestamp validation ----------------------------------------

    #[test]
    fn parse_timestamp_accepts_zero_and_the_max_safe_integer() {
        assert_eq!(parse_timestamp(0.0), Ok(0));
        assert_eq!(
            parse_timestamp(MAX_SAFE_TIMESTAMP),
            Ok(MAX_SAFE_TIMESTAMP as u64)
        );
    }

    #[test]
    fn parse_timestamp_rejects_nan_rather_than_silently_becoming_zero() {
        assert_eq!(
            parse_timestamp(f64::NAN).unwrap_err().reason,
            Reason::TimestampNotFinite
        );
    }

    #[test]
    fn parse_timestamp_rejects_negative_values() {
        assert_eq!(
            parse_timestamp(-5.0).unwrap_err().reason,
            Reason::TimestampOutOfRange
        );
    }

    #[test]
    fn parse_timestamp_rejects_infinity_rather_than_pinning_to_u64_max() {
        assert_eq!(
            parse_timestamp(f64::INFINITY).unwrap_err().reason,
            Reason::TimestampNotFinite
        );
    }

    #[test]
    fn parse_timestamp_rejects_values_past_the_max_safe_integer() {
        assert_eq!(
            parse_timestamp(MAX_SAFE_TIMESTAMP + 2.0)
                .unwrap_err()
                .reason,
            Reason::TimestampOutOfRange
        );
    }

    // --- node existence ----------------------------------------------

    #[test]
    fn require_node_rejects_an_id_the_document_does_not_contain() {
        let doc = Document::new();
        let missing = crate::types::test_support::test_id();
        let err = require_node(&doc, missing).unwrap_err();
        assert_eq!((err.code, err.reason), ("no_such_node", None));
    }

    #[test]
    fn require_unused_refuses_an_id_already_in_the_document() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        assert_eq!(require_unused(&doc, id), Ok(()));
        doc.add_workspace("W", None, id, test_device(), 0);
        assert_eq!(require_unused(&doc, id).unwrap_err().code, "id_in_use");
    }

    #[test]
    fn require_node_accepts_an_id_the_document_contains() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 0);
        assert_eq!(require_node(&doc, id), Ok(()));
    }

    // --- appearance: colour is a token, validated at this boundary --------

    #[test]
    fn parse_agent_label_refuses_an_empty_or_blank_label() {
        for blank in ["", "   "] {
            assert_eq!(
                parse_agent_label(blank).unwrap_err().reason,
                Reason::EmptyAgentLabel,
                "{blank:?}"
            );
        }
    }

    #[test]
    fn parse_agent_label_trims() {
        assert_eq!(parse_agent_label("  Claude Code ").unwrap(), "Claude Code");
    }

    // --- appearance: preset tokens, custom colours, transparency ----------

    use serde_json::json;

    /// A document holding workspace 1, group 2 in it and tab 3 in the group.
    fn painted_tree() -> Document {
        let mut doc = Document::new();
        let ops = json!([
            { "kind": "addWorkspace", "name": "W", "id": uid(1) },
            { "kind": "addGroup", "parent": uid(1), "name": "G", "id": uid(2) },
            { "kind": "addTab", "parent": uid(2), "name": "T", "url": "https://t.example/", "id": uid(3) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 1.0).unwrap();
        doc
    }

    /// Applies one `setAppearance` to `doc` at time `now` from `device`.
    fn paint(
        doc: &mut Document,
        device: &[u8; 16],
        now: f64,
        id: NodeId,
        color: serde_json::Value,
        transparency: serde_json::Value,
    ) -> Result<(), Failure> {
        let op = json!({
            "kind": "setAppearance", "id": id, "color": color, "transparency": transparency,
        });
        apply_batch(doc, &json!([op]).to_string(), device, now)
    }

    /// Asserts that painting `id` with `color` and `transparency` is refused
    /// as a bad colour and leaves the document as it was.
    fn assert_refused(id: NodeId, color: serde_json::Value, transparency: serde_json::Value) {
        let mut doc = painted_tree();
        let before = doc.to_json().unwrap();
        let err = paint(
            &mut doc,
            &ALICE,
            2.0,
            id,
            color.clone(),
            transparency.clone(),
        )
        .unwrap_err();
        assert_eq!(
            (err.code, err.reason),
            ("invalid_argument", Some(Reason::BadColor)),
            "{color} {transparency}: {err:?}"
        );
        assert_eq!(doc.to_json().unwrap(), before, "{color} {transparency}");
    }

    fn workspace_color() -> serde_json::Value {
        json!({ "h": 200, "c": 0.12, "l": 0.3, "mode": "dark" })
    }

    #[test]
    fn every_palette_token_paints_a_workspace_a_group_and_a_tab() {
        for token in COLOR_TOKENS {
            for id in [uid(1), uid(2), uid(3)] {
                let mut doc = painted_tree();
                paint(&mut doc, &ALICE, 2.0, id, json!(token), json!(null)).unwrap();
                assert_eq!(doc.node(id).unwrap().appearance.color, Some(json!(token)));
            }
        }
    }

    #[test]
    fn a_null_colour_clears_the_colour() {
        let mut doc = painted_tree();
        paint(&mut doc, &ALICE, 2.0, uid(1), json!("blue"), json!(null)).unwrap();
        paint(&mut doc, &ALICE, 3.0, uid(1), json!(null), json!(null)).unwrap();
        assert_eq!(doc.node(uid(1)).unwrap().appearance.color, None);
    }

    #[test]
    fn a_workspace_custom_colour_and_transparency_round_trip_through_the_document() {
        let mut doc = painted_tree();
        paint(&mut doc, &ALICE, 2.0, uid(1), workspace_color(), json!(0.5)).unwrap();

        let reloaded = Document::from_json(&doc.to_json().unwrap()).unwrap();
        let appearance = &reloaded.node(uid(1)).unwrap().appearance;
        assert_eq!(
            appearance.color,
            Some(json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" }))
        );
        assert_eq!(appearance.transparency, Some(0.5));
        assert_eq!(reloaded.to_json().unwrap(), doc.to_json().unwrap());
    }

    #[test]
    fn a_custom_colour_is_stored_alike_however_its_numbers_are_written() {
        let mut whole = painted_tree();
        paint(
            &mut whole,
            &ALICE,
            2.0,
            uid(1),
            workspace_color(),
            json!(null),
        )
        .unwrap();
        let mut decimal = painted_tree();
        let color = json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" });
        paint(&mut decimal, &ALICE, 2.0, uid(1), color, json!(null)).unwrap();
        assert_eq!(whole.to_json().unwrap(), decimal.to_json().unwrap());
    }

    #[test]
    fn a_group_takes_a_custom_hue_and_chroma() {
        let mut doc = painted_tree();
        let color = json!({ "h": 30.5, "c": 0.08 });
        paint(&mut doc, &ALICE, 2.0, uid(2), color.clone(), json!(null)).unwrap();
        assert_eq!(doc.node(uid(2)).unwrap().appearance.color, Some(color));
    }

    #[test]
    fn a_custom_colour_takes_every_value_at_the_edges_of_its_ranges() {
        for (h, c, l, mode) in [(0.0, 0.0, 0.0, "light"), (359.999, MAX_CHROMA, 1.0, "dark")] {
            let mut doc = painted_tree();
            let color = json!({ "h": h, "c": c, "l": l, "mode": mode });
            paint(&mut doc, &ALICE, 2.0, uid(1), color.clone(), json!(null)).unwrap();
            assert_eq!(doc.node(uid(1)).unwrap().appearance.color, Some(color));
            let group = json!({ "h": h, "c": c });
            paint(&mut doc, &ALICE, 2.0, uid(2), group.clone(), json!(null)).unwrap();
            assert_eq!(doc.node(uid(2)).unwrap().appearance.color, Some(group));
        }
    }

    #[test]
    fn a_transparency_at_either_end_is_taken() {
        for t in [0.0, 1.0] {
            let mut doc = painted_tree();
            paint(&mut doc, &ALICE, 2.0, uid(1), json!("blue"), json!(t)).unwrap();
            assert_eq!(doc.node(uid(1)).unwrap().appearance.transparency, Some(t));
        }
    }

    #[test]
    fn a_colour_outside_the_tokens_and_shapes_is_refused() {
        let ws = |change: serde_json::Value| {
            let mut color = workspace_color();
            for (key, value) in change.as_object().unwrap() {
                color[key] = value.clone();
            }
            color
        };
        let mut no_mode = workspace_color();
        no_mode.as_object_mut().unwrap().remove("mode");
        for color in [
            json!("#ff00ff"),
            json!("turquoise"),
            json!(5),
            json!(["blue"]),
            json!(true),
            ws(json!({ "h": 360 })),
            ws(json!({ "h": -1 })),
            ws(json!({ "h": "200" })),
            // `JSON.stringify` writes NaN as `null`.
            ws(json!({ "h": null })),
            ws(json!({ "c": 0.41 })),
            ws(json!({ "c": -0.01 })),
            ws(json!({ "l": 1.01 })),
            ws(json!({ "l": -0.01 })),
            ws(json!({ "mode": "dim" })),
            ws(json!({ "mode": null })),
            ws(json!({ "extra": 1 })),
            no_mode,
            json!({ "h": 200, "c": 0.1 }),
        ] {
            assert_refused(uid(1), color, json!(null));
        }
        for color in [
            json!({ "h": 360, "c": 0.1 }),
            json!({ "h": 10, "c": 0.5 }),
            json!({ "h": 10 }),
            json!({ "h": 10, "c": 0.1, "x": 0 }),
            workspace_color(),
        ] {
            assert_refused(uid(2), color, json!(null));
        }
        for color in [workspace_color(), json!({ "h": 10, "c": 0.1 })] {
            assert_refused(uid(3), color, json!(null));
        }
    }

    #[test]
    fn a_transparency_out_of_range_or_off_a_workspace_is_refused() {
        for t in [json!(-0.01), json!(1.01)] {
            assert_refused(uid(1), json!("blue"), t);
        }
        for id in [uid(2), uid(3)] {
            assert_refused(id, json!("blue"), json!(0.5));
        }
    }

    #[test]
    fn a_nan_transparency_is_refused() {
        // JSON has no NaN, so this reaches the check as `setAppearance`
        // hands it over.
        let err = parse_transparency(&NodeKind::Workspace, Some(f64::NAN)).unwrap_err();
        assert_eq!(err.reason, Reason::BadColor);
    }

    #[test]
    fn color_from_json_reads_what_json_stringify_wrote() {
        assert_eq!(color_from_json(Some("\"blue\"".into())), Ok(json!("blue")));
        assert_eq!(
            color_from_json(Some(r#"{"h":1,"c":0}"#.into())),
            Ok(json!({ "h": 1, "c": 0 }))
        );
        for unwritable in [None, Some("{".into())] {
            assert_eq!(
                color_from_json(unwritable).unwrap_err().reason,
                Reason::BadColor
            );
        }
    }

    #[test]
    fn the_later_appearance_carries_its_colour_and_transparency_together() {
        // Alice picks a custom colour with a transparency, Bob a token with
        // an emoji. The appearance group merges whole (spec §5.3), so the
        // later write's every field wins and none of the earlier one's
        // survives beside it.
        let custom = json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" });
        for (alice_at, bob_at) in [(30.0, 20.0), (20.0, 30.0)] {
            let mut alice = painted_tree();
            let mut bob = painted_tree();
            paint(
                &mut alice,
                &ALICE,
                alice_at,
                uid(1),
                custom.clone(),
                json!(0.7),
            )
            .unwrap();
            let op =
                json!({ "kind": "setAppearance", "id": uid(1), "color": "blue", "emoji": "🌊" });
            apply(&mut bob, &BOB, bob_at, op);

            crate::merge::merge(&mut alice, &bob);
            crate::merge::merge(&mut bob, &alice);

            for doc in [&alice, &bob] {
                let appearance = &doc.node(uid(1)).unwrap().appearance;
                if alice_at > bob_at {
                    assert_eq!(appearance.color, Some(custom.clone()));
                    assert_eq!(appearance.transparency, Some(0.7));
                    assert_eq!(appearance.emoji, None);
                } else {
                    assert_eq!(appearance.color, Some(json!("blue")));
                    assert_eq!(appearance.transparency, None);
                    assert_eq!(appearance.emoji.as_deref(), Some("🌊"));
                }
            }
        }
    }

    #[test]
    fn parse_setting_value_treats_json_null_as_a_reset() {
        assert_eq!(parse_setting_value(None).unwrap(), None);
        assert_eq!(parse_setting_value(Some("null".into())).unwrap(), None);
        assert_eq!(
            parse_setting_value(Some("\"ddg\"".into())).unwrap(),
            Some(serde_json::json!("ddg"))
        );
        let err = parse_setting_value(Some("{not json".into())).unwrap_err();
        assert_eq!(err.reason, Reason::SettingNotJson);
    }

    #[test]
    fn parse_setting_key_refuses_an_empty_key() {
        assert_eq!(
            parse_setting_key("").unwrap_err().reason,
            Reason::EmptySettingKey
        );
        assert_eq!(
            parse_setting_key("sval.search.engine").unwrap(),
            "sval.search.engine"
        );
    }

    #[test]
    fn settings_json_lists_values_and_resets() {
        let mut doc = Document::new();
        doc.set_setting("a", Some(serde_json::json!(true)), test_device(), 1);
        doc.set_setting("b", None, test_device(), 2);
        let parsed: serde_json::Value =
            serde_json::from_str(&settings_json(&doc).unwrap()).unwrap();
        assert_eq!(parsed, serde_json::json!({"a": true, "b": null}));
    }

    #[test]
    fn a_set_label_op_sets_and_clears_a_tab_label_and_refuses_an_unknown_id() {
        let mut doc = two_groups();
        let set = serde_json::json!([{ "kind": "setLabel", "id": uid(11), "label": "Mine" }]);
        apply_batch(&mut doc, &set.to_string(), &ALICE, 200.0).unwrap();
        let node = doc.node(uid(11)).unwrap();
        assert_eq!(node.appearance.label.as_deref(), Some("Mine"));
        assert_eq!(node.appearance_at, 200);

        let clear = serde_json::json!([{ "kind": "setLabel", "id": uid(11), "label": null }]);
        apply_batch(&mut doc, &clear.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(doc.node(uid(11)).unwrap().appearance.label, None);

        let unknown = serde_json::json!([{ "kind": "setLabel", "id": uid(99), "label": "x" }]);
        let err = apply_batch(&mut doc, &unknown.to_string(), &ALICE, 400.0).unwrap_err();
        assert_eq!(err.code, "no_such_node");
    }

    #[test]
    fn set_appearance_clears_a_field_left_none_rather_than_leaving_it_alone() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 0);
        doc.set_appearance(
            id,
            Some("green".into()),
            Some("🐟".into()),
            None,
            test_device(),
            10,
        );
        // The group is the unit, so `None` clears the colour.
        doc.set_appearance(id, None, Some("🐟".into()), None, test_device(), 20);
        let node = doc.node(id).unwrap();
        assert_eq!(node.appearance.color, None);
        assert_eq!(node.appearance.emoji, Some("🐟".to_string()));
    }

    #[test]
    fn set_appearance_round_trips_a_flag_and_a_zwj_sequence_byte_identical() {
        // An emoji is a grapheme cluster: a flag is two regional-indicator
        // code points, and a family emoji is several scalar values joined by
        // zero-width joiners. This boundary must never truncate either.
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 0);

        let flag = "\u{1F1EF}\u{1F1F5}"; // 🇯🇵
        doc.set_appearance(
            id,
            Some("cyan".into()),
            Some(flag.to_string()),
            None,
            test_device(),
            10,
        );
        assert_eq!(
            doc.node(id).unwrap().appearance.emoji.as_deref(),
            Some(flag)
        );

        // family: man, woman, girl, boy joined by ZWJ
        let zwj_family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        doc.set_appearance(
            id,
            Some("orange".into()),
            Some(zwj_family.to_string()),
            None,
            test_device(),
            20,
        );
        assert_eq!(
            doc.node(id).unwrap().appearance.emoji.as_deref(),
            Some(zwj_family)
        );
    }

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
            serde_json::json!({ "path": "sval/ws/x/a.json", "own": true, "reason": "r" })
        );
        assert_eq!(json["harmedByClock"][0], "ab".repeat(16));
    }

    #[test]
    fn a_shard_name_is_a_history_iso_week() {
        assert!(parse_shard_name("history-2026-W42").is_ok());
        assert!(parse_shard_name("history-2026-W01").is_ok());
        for bad in [
            "",
            "history-2026-W00",
            "history-2026-W54",
            "history-2026-42",
            "history-26-W42",
            "favorites",
            "history-2026-W4x",
        ] {
            assert!(parse_shard_name(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn visits_and_shards_json_list_their_kind_only_in_order() {
        let by = StoreDeviceId::from_bytes([1; 16]);
        let mut doc = Document::new();
        doc.set_setting("k", None, by, 1);
        let late = doc.add_visit("https://2.example/", "Two", 1, 20, by, 21);
        let early = doc.add_visit("https://1.example/", "One", 2, 10, by, 11);
        doc.touch_shard("history-2026-W41", by, 5);
        doc.touch_shard("history-2026-W42", by, 6);
        doc.touch_shard("history-2026-W41", by, 30);

        let rows: serde_json::Value = serde_json::from_str(&visits_json(&doc).unwrap()).unwrap();
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0]["id"], early.to_string());
        assert_eq!(rows[1]["id"], late.to_string());
        assert_eq!(rows[0]["visitedAt"], 10);
        assert_eq!(rows[0]["transition"], 2);
        assert_eq!(rows[0]["title"], "One");
        assert_eq!(rows[0]["device"], by.to_string());

        let shards: serde_json::Value = serde_json::from_str(&shards_json(&doc).unwrap()).unwrap();
        assert_eq!(shards[0]["name"], "history-2026-W42");
        assert_eq!(shards[0]["changedAt"], 6);
        assert_eq!(shards[1]["changedAt"], 30);
        assert_eq!(shards.as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_visit_added_in_a_workspace_lists_it_and_one_in_none_lists_null() {
        let device = [1; 16];
        let workspace = "3c1d9e2a-77b0-4f15-a8c6-5e0d2b9f1a47";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addVisit", "url": "https://1.example/", "title": "One",
              "transition": 1, "visitedAt": 10.0, "workspace": workspace },
            { "kind": "addVisit", "url": "https://2.example/", "title": "Two",
              "transition": 1, "visitedAt": 20.0 },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 30.0).unwrap();

        let rows: serde_json::Value = serde_json::from_str(&visits_json(&doc).unwrap()).unwrap();
        assert_eq!(rows[0]["workspace"], workspace);
        assert_eq!(rows[1]["workspace"], serde_json::Value::Null);

        let bad = serde_json::json!([
            { "kind": "addVisit", "url": "https://3.example/", "transition": 1,
              "visitedAt": 40.0, "workspace": "not an id" },
        ]);
        assert!(apply_batch(&mut doc, &bad.to_string(), &device, 50.0).is_err());
        assert_eq!(doc.visit_ids().len(), 2);
    }

    #[test]
    fn a_pin_scope_on_a_node_that_is_not_a_pin_is_refused() {
        let by = StoreDeviceId::from_bytes([1; 16]);
        let mut doc = Document::new();
        let page = doc.add_favorite(
            NodeKind::Favorite,
            "page00000001",
            None,
            None,
            None,
            "One",
            Some("https://1.example/".into()),
            by,
            5,
        );
        let before = doc.to_json().unwrap();
        let op = Op::SetPinScope {
            id: page.to_string(),
            scope: Some(vec!["work".into()]),
        };

        let err = apply_op(&mut doc, op, by, 6).unwrap_err();

        assert_eq!(err.code, "not_a_pin");
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn a_visit_title_on_a_node_that_is_not_a_visit_is_refused() {
        let by = StoreDeviceId::from_bytes([1; 16]);
        let ws = NodeId::from_u128(1);
        let mut doc = Document::new();
        doc.add_workspace("W", None, ws, by, 1);
        let before = doc.to_json().unwrap();
        let op = Op::SetVisitTitle {
            id: ws.to_string(),
            title: "Elsewhere".into(),
        };

        let err = apply_op(&mut doc, op, by, 2).unwrap_err();

        assert_eq!(err.code, "not_a_visit");
        assert_eq!(doc.to_json().unwrap(), before);

        let visit = doc.add_visit("https://1.example/", "One", 1, 10, by, 11);
        let op = Op::SetVisitTitle {
            id: visit.to_string(),
            title: "Uno".into(),
        };
        apply_op(&mut doc, op, by, 12).unwrap();
        assert_eq!(doc.node(visit).unwrap().content.name, "Uno");
    }

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

    #[test]
    fn a_content_write_that_keeps_the_address_keeps_its_mark() {
        let device = [1; 16];
        let ws = "00000000-0000-0000-0000-000000000001";
        let tab = "00000000-0000-0000-0000-000000000002";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": ws },
            { "kind": "addTab", "parent": ws, "name": "Planted",
              "url": "chrome://browser/content/browser.xhtml", "id": tab },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 10.0).unwrap();
        let resent = serde_json::json!([
            { "kind": "setContent", "id": tab, "name": "Renamed",
              "url": "chrome://browser/content/browser.xhtml", "local": true },
        ]);
        apply_batch(&mut doc, &resent.to_string(), &device, 20.0).unwrap();
        let held = &doc.node(parse_id(tab).unwrap()).unwrap().content;
        assert_eq!(held.name, "Renamed");
        assert!(!held.local, "an unmarked address stays unmarked");

        let moved = serde_json::json!([
            { "kind": "setContent", "id": tab, "name": "Renamed",
              "url": "file:///notes.html", "local": true },
        ]);
        apply_batch(&mut doc, &moved.to_string(), &device, 30.0).unwrap();
        assert!(doc.node(parse_id(tab).unwrap()).unwrap().content.local);
    }

    #[test]
    fn set_local_moves_a_node_across_the_line_and_stamps_only_a_change() {
        let device = [1; 16];
        let ws = "00000000-0000-0000-0000-000000000001";
        let tab = "00000000-0000-0000-0000-000000000002";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": ws },
            { "kind": "addTab", "parent": ws, "name": "Call",
              "url": "https://meet.example/abc", "id": tab },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 10.0).unwrap();
        let tab_id = parse_id(tab).unwrap();

        let local = serde_json::json!([{ "kind": "setLocal", "id": tab, "local": true }]);
        apply_batch(&mut doc, &local.to_string(), &device, 20.0).unwrap();
        let held = doc.node(tab_id).unwrap();
        assert!(held.content.local);
        assert_eq!(
            held.content.url.as_deref(),
            Some("https://meet.example/abc")
        );
        assert_eq!(held.content.name, "Call");
        assert_eq!(held.content_at, 20);

        apply_batch(&mut doc, &local.to_string(), &device, 30.0).unwrap();
        assert_eq!(
            doc.node(tab_id).unwrap().content_at,
            20,
            "a mark already as asked writes nothing"
        );

        let back = serde_json::json!([{ "kind": "setLocal", "id": tab, "local": false }]);
        apply_batch(&mut doc, &back.to_string(), &device, 40.0).unwrap();
        let held = doc.node(tab_id).unwrap();
        assert!(!held.content.local);
        assert_eq!(held.content_at, 40);

        let bare = serde_json::json!([{ "kind": "setLocal", "id": ws, "local": true }]);
        let err = apply_batch(&mut doc, &bare.to_string(), &device, 50.0).unwrap_err();
        assert!(
            err.message.contains("only a node with an address"),
            "{err:?}"
        );
        assert!(!doc.node(parse_id(ws).unwrap()).unwrap().content.local);
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
    fn a_places_guid_is_twelve_url_safe_characters() {
        assert_eq!(parse_favorite_guid("toolbar_____"), Ok("toolbar_____"));
        assert_eq!(parse_favorite_guid("aB3-_xyz0912"), Ok("aB3-_xyz0912"));
        for bad in ["", "short", "thirteen_char", "has space 12", "slash/slash1"] {
            assert_eq!(
                parse_favorite_guid(bad).unwrap_err().reason,
                Reason::BadFavoriteGuid,
                "{bad} must be refused"
            );
        }
    }

    #[test]
    fn only_favorite_kinds_are_accepted_for_the_favorites_document() {
        assert_eq!(parse_favorite_kind("folder"), Ok(NodeKind::Folder));
        for other in ["tab", "workspace"] {
            let err = parse_favorite_kind(other).unwrap_err();
            assert_eq!(err.reason, Reason::BadFavoriteKind, "{other}");
        }
    }

    #[test]
    fn favorites_json_lists_favorite_kinds_only_in_tree_order() {
        let by = StoreDeviceId::from_bytes([1; 16]);
        let mut doc = Document::new();
        doc.add_workspace("W", None, NodeId::from_u128(1), by, 1);
        let root = doc.add_favorite(
            NodeKind::Folder,
            "toolbar_____",
            None,
            None,
            None,
            "",
            None,
            by,
            0,
        );
        let second = doc.add_favorite(
            NodeKind::Favorite,
            "page00000002",
            Some(root),
            None,
            None,
            "Two",
            Some("https://2.example/".into()),
            by,
            5,
        );
        doc.add_favorite(
            NodeKind::Favorite,
            "page00000001",
            Some(root),
            None,
            Some(second),
            "One",
            Some("https://1.example/".into()),
            by,
            5,
        );
        let pins = doc.add_favorite(
            NodeKind::Folder,
            crate::types::PINS_GUID,
            None,
            None,
            None,
            "",
            None,
            by,
            0,
        );
        let pin = doc.add_favorite(
            NodeKind::Favorite,
            "page00000003",
            Some(pins),
            None,
            None,
            "Three",
            Some("https://3.example/".into()),
            by,
            5,
        );
        doc.node_mut(second).unwrap().lifecycle.pinned = true;
        let scope = serde_json::json!([
            { "kind": "setPinScope", "id": pin, "scope": ["work", "home"] }
        ]);
        apply_batch(&mut doc, &scope.to_string(), &[1; 16], 7.0).unwrap();

        let rows: serde_json::Value = serde_json::from_str(&favorites_json(&doc).unwrap()).unwrap();
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 5, "the workspace is not a favorite: {rows:?}");
        let row = |guid: &str| rows.iter().find(|r| r["guid"] == guid).unwrap();
        let in_toolbar: Vec<_> = rows
            .iter()
            .filter(|r| r["parent"] == root.to_string())
            .map(|r| r["name"].as_str().unwrap())
            .collect();
        assert_eq!(in_toolbar, ["One", "Two"]);
        assert_eq!(row("page00000002")["pinned"], true);
        assert!(row("page00000002").get("homeOrder").is_none());
        assert_eq!(
            row("page00000003")["pinScope"],
            serde_json::json!(["home", "work"])
        );
        assert_eq!(row("page00000001")["pinScope"], serde_json::Value::Null);
        let rows: Vec<_> = vec![
            row("toolbar_____"),
            row("page00000001"),
            row("page00000002"),
        ];
        assert_eq!(rows[0]["parent"], serde_json::Value::Null);
        assert_eq!(rows[2]["contentAt"], 5);
        assert_eq!(rows[2]["added"], 5);
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
    // --- a batch lands whole or not at all -----------------------------

    const ALICE: [u8; 16] = [0xa1; 16];
    const BOB: [u8; 16] = [0xb0; 16];

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

    fn apply(doc: &mut Document, device: &[u8; 16], now: f64, op: serde_json::Value) {
        apply_batch(doc, &serde_json::json!([op]).to_string(), device, now).unwrap();
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

    /// A workspace holding two groups, A (tabs 11, 12) and B (tabs 21, 22),
    /// as Alice wrote and synced it: every group stamped, and `seen`
    /// carrying a watermark, so a batch that disturbed either would show.
    fn two_groups() -> Document {
        let by = DeviceId::from_bytes(ALICE);
        let mut doc = Document::new();
        doc.add_workspace("W", None, uid(1), by, 100);
        doc.add_group(uid(1), "A", None, uid(10), by, 110);
        doc.add_group(uid(1), "B", None, uid(20), by, 120);
        doc.add_tab(uid(10), "a1", "https://a1.example/", uid(11), by, 111);
        doc.add_tab(uid(10), "a2", "https://a2.example/", uid(12), by, 112);
        doc.add_tab(uid(20), "b1", "https://b1.example/", uid(21), by, 121);
        doc.add_tab(uid(20), "b2", "https://b2.example/", uid(22), by, 122);
        doc.stamp_write(by, 130);
        doc
    }

    /// Merging group B into group A, as the panel does: B's tabs move into
    /// A after A's own, and B goes.
    fn merge_b_into_a() -> serde_json::Value {
        serde_json::json!([
            { "kind": "moveNode", "id": uid(21), "newParent": uid(10), "before": uid(12) },
            { "kind": "moveNode", "id": uid(22), "newParent": uid(10), "before": uid(21) },
            { "kind": "remove", "id": uid(20) },
        ])
    }

    #[test]
    fn move_workspace_reorders_workspaces_and_refuses_anything_else() {
        let mut doc = two_groups();
        let by = DeviceId::from_bytes(ALICE);
        doc.add_workspace("V", None, uid(2), by, 101);
        let first = |doc: &Document| {
            doc.workspaces()
                .min_by_key(|(id, node)| (node.placement.order.clone(), **id))
                .map(|(id, _)| *id)
        };
        assert_eq!(first(&doc), Some(uid(1)), "test setup");

        let ops = serde_json::json!([{ "kind": "moveWorkspace", "id": uid(2), "after": uid(1) }]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();
        assert_eq!(first(&doc), Some(uid(2)));
        assert_eq!(doc.node(uid(2)).unwrap().placement_at, 200);

        let before = doc.to_json().unwrap();
        let ops = serde_json::json!([{ "kind": "moveWorkspace", "id": uid(10), "after": uid(1) }]);
        let err = apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap_err();
        assert_eq!(err.code, "not_a_root_workspace", "{err:?}");
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn a_merge_refused_halfway_leaves_both_groups_byte_identical() {
        let mut doc = two_groups();
        let before = doc.to_json().unwrap();
        let mut ops = merge_b_into_a();
        // Refused after every other step has been applied: A cannot go
        // inside its own tab.
        ops.as_array_mut().unwrap().push(serde_json::json!(
            { "kind": "moveNode", "id": uid(10), "newParent": uid(11) }
        ));
        let err = apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap_err();
        assert_eq!(err.code, "parent_is_a_tab", "{err:?}");
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn a_batch_refused_at_its_first_step_or_its_input_changes_nothing() {
        let mut doc = two_groups();
        let before = doc.to_json().unwrap();
        let refusals = [
            (
                serde_json::json!([{ "kind": "remove", "id": uid(99) }]).to_string(),
                &ALICE[..],
                200.0,
                ("no_such_node", None),
            ),
            (
                serde_json::json!([
                    { "kind": "rename", "id": uid(11), "name": "x" },
                    { "kind": "batch", "ops": [] },
                ])
                .to_string(),
                &ALICE[..],
                200.0,
                ("invalid_argument", Some(Reason::BadBatch)),
            ),
            (
                serde_json::json!([
                    { "kind": "addTab", "parent": uid(10), "name": "t", "url": "u" },
                ])
                .to_string(),
                &ALICE[..],
                200.0,
                ("invalid_argument", Some(Reason::BadBatch)),
            ),
            (
                merge_b_into_a().to_string(),
                &ALICE[..15],
                200.0,
                ("invalid_argument", Some(Reason::BadDeviceId)),
            ),
            (
                merge_b_into_a().to_string(),
                &ALICE[..],
                f64::NAN,
                ("invalid_argument", Some(Reason::TimestampNotFinite)),
            ),
        ];
        for (ops, device, now, expected) in refusals {
            let err = apply_batch(&mut doc, &ops, device, now).unwrap_err();
            assert_eq!((err.code, err.reason), expected, "{ops}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{ops}");
        }
    }

    #[test]
    fn a_batch_applies_in_order_and_a_peer_receives_it_in_one_write() {
        let mut alice = two_groups();
        let mut ops = merge_b_into_a();
        // A later step names a node an earlier one added.
        ops.as_array_mut().unwrap().extend([
            serde_json::json!({ "kind": "addGroup", "parent": uid(1), "name": "C", "id": uid(30) }),
            serde_json::json!({ "kind": "setAppearance", "id": uid(30), "color": "blue" }),
            serde_json::json!({ "kind": "moveNode", "id": uid(10), "newParent": uid(30) }),
        ]);
        apply_batch(&mut alice, &ops.to_string(), &ALICE, 200.0).unwrap();

        let key = key_bytes();
        let (_, write) = run_sync(&mut alice, &key, &ALICE, "ws-1", vec![], 300.0).unwrap();
        let mut bob = Document::new();
        run_sync(&mut bob, &key, &BOB, "ws-1", vec![write.unwrap()], 300.0).unwrap();

        assert!(bob.node(uid(20)).is_none(), "B is gone");
        assert_eq!(
            crate::tree::children(&bob, uid(10)),
            vec![uid(11), uid(12), uid(21), uid(22)]
        );
        let c = bob.node(uid(30)).unwrap();
        assert_eq!(
            c.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("blue")
        );
        assert_eq!(bob.node(uid(10)).unwrap().placement.parent, Some(uid(30)));
        for id in [21, 22, 10] {
            let node = bob.node(uid(id)).unwrap();
            assert_eq!(node.placement_at, 200, "{id} carries the batch's time");
            assert_eq!(node.placement_by, Some(DeviceId::from_bytes(ALICE)));
        }
    }

    // --- splits ----------------------------------------------------------

    /// Splitting tab 11 with tab 12 in group A, as the panel does: the split
    /// takes 11's place, and 11 then 12 move into it (split-view spec §5.2).
    fn split_11_with_12() -> serde_json::Value {
        serde_json::json!([
            { "kind": "addSplit", "parent": uid(10), "id": uid(40), "before": uid(11), "after": uid(12) },
            { "kind": "moveNode", "id": uid(11), "newParent": uid(40) },
            { "kind": "moveNode", "id": uid(12), "newParent": uid(40), "before": uid(11) },
        ])
    }

    #[test]
    fn a_tab_given_one_neighbour_lands_beside_it() {
        let mut doc = two_groups();
        let ops = serde_json::json!([
            { "kind": "addTab", "parent": uid(10), "name": "t", "url": "https://t.example/", "id": uid(40), "after": uid(11) },
        ]);

        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();

        assert_eq!(
            crate::tree::children(&doc, uid(10)),
            vec![uid(40), uid(11), uid(12)]
        );
    }

    #[test]
    fn a_split_given_one_neighbour_lands_beside_it() {
        let mut doc = two_groups();
        let ops = serde_json::json!([
            { "kind": "addSplit", "parent": uid(10), "id": uid(40), "after": uid(11) },
        ]);

        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();

        assert_eq!(
            crate::tree::children(&doc, uid(10)),
            vec![uid(40), uid(11), uid(12)]
        );
    }

    #[test]
    fn splitting_two_tabs_is_one_batch_that_leaves_one_split_in_their_place() {
        let mut doc = two_groups();
        apply_batch(&mut doc, &split_11_with_12().to_string(), &ALICE, 200.0).unwrap();

        assert_eq!(crate::tree::children(&doc, uid(10)), vec![uid(40)]);
        assert_eq!(crate::tree::children(&doc, uid(40)), vec![uid(11), uid(12)]);
        let split = doc.node(uid(40)).unwrap();
        assert_eq!(split.kind, NodeKind::Split);
        assert_eq!(split.content.name, "", "a split is unnamed by default");
        assert!(crate::tree::repair_unreachable_ancestry(&mut doc).is_empty());
    }

    #[test]
    fn moving_a_pane_left_within_a_full_split_is_allowed() {
        let mut doc = two_groups();
        let mut ops = split_11_with_12();
        ops.as_array_mut().unwrap().extend([
            serde_json::json!({ "kind": "moveNode", "id": uid(21), "newParent": uid(40), "before": uid(12) }),
            serde_json::json!({ "kind": "moveNode", "id": uid(22), "newParent": uid(40), "before": uid(21) }),
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();
        assert_eq!(crate::tree::children(&doc, uid(40)).len(), 4, "test setup");

        // The last pane moves to before the third.
        let left = serde_json::json!([
            { "kind": "moveNode", "id": uid(22), "newParent": uid(40), "before": uid(12), "after": uid(21) },
        ]);
        apply_batch(&mut doc, &left.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(
            crate::tree::children(&doc, uid(40)),
            vec![uid(11), uid(12), uid(22), uid(21)]
        );
    }

    #[test]
    fn a_pane_moves_within_a_split_a_merge_left_with_more_than_four() {
        let by = DeviceId::from_bytes(ALICE);
        let mut doc = two_groups();
        doc.add_split(uid(1), "", uid(40), by, 140);
        for n in 41..=45 {
            doc.add_tab(uid(40), "p", "https://p.example/", uid(n), by, 141);
        }
        let ops = serde_json::json!([
            { "kind": "moveNode", "id": uid(45), "newParent": uid(40), "after": uid(41) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(
            crate::tree::children(&doc, uid(40)),
            vec![uid(45), uid(41), uid(42), uid(43), uid(44)]
        );
    }

    #[test]
    fn every_shape_a_split_cannot_hold_is_refused_and_changes_nothing() {
        let mut doc = two_groups();
        let mut ops = split_11_with_12();
        ops.as_array_mut().unwrap().extend([
            serde_json::json!({ "kind": "addTab", "parent": uid(40), "name": "c", "url": "https://c.example/", "id": uid(13) }),
            serde_json::json!({ "kind": "addTab", "parent": uid(40), "name": "d", "url": "https://d.example/", "id": uid(14) }),
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();
        let before = doc.to_json().unwrap();

        let refusals = [
            // A fifth tab, moved or added.
            (
                serde_json::json!({ "kind": "moveNode", "id": uid(21), "newParent": uid(40) }),
                "split_is_full",
            ),
            (
                serde_json::json!({ "kind": "addTab", "parent": uid(40), "name": "e", "url": "https://e.example/", "id": uid(15) }),
                "split_is_full",
            ),
            // Anything but a tab, moved or added.
            (
                serde_json::json!({ "kind": "moveNode", "id": uid(20), "newParent": uid(40) }),
                "only_tabs_in_a_split",
            ),
            (
                serde_json::json!({ "kind": "addGroup", "parent": uid(40), "name": "G", "id": uid(50) }),
                "only_tabs_in_a_split",
            ),
            (
                serde_json::json!({ "kind": "addSplit", "parent": uid(40), "id": uid(50) }),
                "only_tabs_in_a_split",
            ),
            // A split anywhere but a workspace or a group.
            (
                serde_json::json!({ "kind": "moveNode", "id": uid(40), "newParent": uid(21) }),
                "parent_is_a_tab",
            ),
            (
                serde_json::json!({ "kind": "addSplit", "parent": uid(21), "id": uid(50) }),
                "parent_is_a_tab",
            ),
            (
                serde_json::json!({ "kind": "addSplit", "parent": uid(99), "id": uid(50) }),
                "no_such_parent",
            ),
        ];
        for (op, code) in refusals {
            let ops = serde_json::json!([op]).to_string();
            let err = apply_batch(&mut doc, &ops, &ALICE, 300.0).unwrap_err();
            assert_eq!(err.code, code, "{ops}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{ops}");
        }
    }

    #[test]
    fn a_split_is_refused_under_any_parent_but_a_workspace_or_a_group() {
        // A favorites folder is a container, but no split row is drawn in
        // it.
        let by = DeviceId::from_bytes(ALICE);
        let mut doc = two_groups();
        doc.add_split(uid(1), "", uid(40), by, 140);
        doc.add_favorite(
            NodeKind::Folder,
            "folder000001",
            None,
            None,
            None,
            "F",
            None,
            by,
            140,
        );
        let folder = crate::types::favorite_id("folder000001");
        let before = doc.to_json().unwrap();
        for op in [
            serde_json::json!({ "kind": "moveNode", "id": uid(40), "newParent": folder }),
            serde_json::json!({ "kind": "addSplit", "parent": folder, "id": uid(50) }),
        ] {
            let ops = serde_json::json!([op]).to_string();
            let err = apply_batch(&mut doc, &ops, &ALICE, 300.0).unwrap_err();
            assert_eq!(err.code, "split_outside_a_place", "{ops}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{ops}");
        }
        // Into a group it goes.
        let ops = serde_json::json!([{ "kind": "moveNode", "id": uid(40), "newParent": uid(20) }]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(doc.node(uid(40)).unwrap().placement.parent, Some(uid(20)));
    }

    #[test]
    fn a_split_s_shares_are_set_whole_and_checked_against_its_panes() {
        let mut doc = two_groups();
        apply_batch(&mut doc, &split_11_with_12().to_string(), &ALICE, 200.0).unwrap();
        let share = |shares: serde_json::Value| {
            serde_json::json!([{ "kind": "setContent", "id": uid(40), "name": "Docs", "shares": shares }])
                .to_string()
        };
        apply_batch(
            &mut doc,
            &share(serde_json::json!([30.5, 69.5])),
            &ALICE,
            300.0,
        )
        .unwrap();
        let split = doc.node(uid(40)).unwrap();
        assert_eq!(split.content.shares, Some(vec![30.5, 69.5]));
        assert_eq!((split.content_at, split.placement_at), (300, 200));

        let before = doc.to_json().unwrap();
        for (bad, reason) in [
            (serde_json::json!([50, 30, 20]), Reason::SharesCountMismatch),
            (serde_json::json!([60, 30]), Reason::SharesNotHundred),
            (serde_json::json!([100, 0]), Reason::ShareNotPositive),
            (serde_json::json!([-10, 110]), Reason::ShareNotPositive),
            (serde_json::json!([]), Reason::SharesCountMismatch),
        ] {
            let err = apply_batch(&mut doc, &share(bad.clone()), &ALICE, 400.0).unwrap_err();
            assert_eq!(err.reason, Some(reason), "{bad}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{bad}");
        }
        let on_a_tab = serde_json::json!([
            { "kind": "setContent", "id": uid(11), "name": "a1", "url": "https://a1.example/", "shares": [50, 50] }
        ]);
        let err = apply_batch(&mut doc, &on_a_tab.to_string(), &ALICE, 400.0).unwrap_err();
        assert_eq!(err.reason, Some(Reason::SharesNotOnASplit), "{err:?}");

        // A rename keeps the shares, and a setContent without them clears
        // them: the group is the unit.
        let rename = serde_json::json!([{ "kind": "rename", "id": uid(40), "name": "Reading" }]);
        apply_batch(&mut doc, &rename.to_string(), &ALICE, 500.0).unwrap();
        assert_eq!(
            doc.node(uid(40)).unwrap().content.shares,
            Some(vec![30.5, 69.5])
        );
        let clear = serde_json::json!([{ "kind": "setContent", "id": uid(40), "name": "Reading" }]);
        apply_batch(&mut doc, &clear.to_string(), &ALICE, 600.0).unwrap();
        assert_eq!(doc.node(uid(40)).unwrap().content.shares, None);
    }
}

// ---------------------------------------------------------------------
// The `wasm_bindgen`-attributed surface: glue that converts JS values to
// plain Rust ones, delegates to the pure functions above, and converts the
// result back. `binding_tests` drives the bindings natively on their success
// paths. Anything that builds a `JsValue` aborts the process on a non-wasm
// target, so each refusal is a pure function above, tested on its own.
// ---------------------------------------------------------------------

use js_sys::{Array, Uint8Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

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
/// (`own_device_path`).
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
pub struct SvalDocument(Document);

#[wasm_bindgen]
impl SvalDocument {
    /// A fresh, empty document.
    #[wasm_bindgen(constructor)]
    pub fn new() -> SvalDocument {
        SvalDocument(Document::new())
    }

    /// Parses `json` as a full document.
    #[wasm_bindgen(js_name = loadJson)]
    pub fn load_json(json: &str) -> Result<SvalDocument, JsValue> {
        Document::from_json(json)
            .map(SvalDocument)
            .map_err(to_js_err)
    }

    /// Serialises the current document to compact JSON, for the host to
    /// parse.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        self.0.to_json().map_err(to_js_err)
    }

    fn apply(&mut self, op: Op, device_id: &[u8], now: f64) -> Result<Option<NodeId>, JsValue> {
        let by = parse_device_id(device_id).map_err(to_js_err)?;
        let now = parse_timestamp(now).map_err(to_js_err)?;
        apply_op(&mut self.0, op, by, now).map_err(to_js_err)
    }

    /// Applies a batch: `ops_json` is a JSON array of operations, each shaped
    /// as `SvalDocumentOps.mjs` spells one alone, minus `deviceId`. Every one
    /// is stamped with `device_id` and `now`, and they land all together or
    /// not at all: a refusal leaves the document as it was and answers with
    /// the refused operation's own error (`docs/host-contract.md` §3).
    #[wasm_bindgen(js_name = applyBatch)]
    pub fn apply_batch(
        &mut self,
        ops_json: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        apply_batch(&mut self.0, ops_json, device_id, now).map_err(to_js_err)
    }

    /// `id` is a fresh id the host generated (e.g. `crypto.randomUUID()`);
    /// `now` is milliseconds since the epoch (e.g. `Date.now()`), rejected
    /// if it is not finite or exceeds `Number.MAX_SAFE_INTEGER`. `isolated`
    /// makes the workspace isolated from its creation (isolated workspaces
    /// spec §2); absent, it is shared.
    #[wasm_bindgen(js_name = addWorkspace)]
    pub fn add_workspace(
        &mut self,
        name: &str,
        icon: Option<String>,
        id: &str,
        device_id: &[u8],
        now: f64,
        isolated: Option<bool>,
    ) -> Result<(), JsValue> {
        let op = Op::AddWorkspace {
            name: name.into(),
            icon,
            id: id.into(),
            isolated,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// An agent's workspace (agent-control spec §3.5). `label` is the agent's
    /// name as the user accepted it; the device in the mark is `device_id`,
    /// the device the agent paired with.
    #[wasm_bindgen(js_name = addAgentWorkspace)]
    pub fn add_agent_workspace(
        &mut self,
        name: &str,
        label: &str,
        id: &str,
        device_id: &[u8],
        now: f64,
        isolated: Option<bool>,
    ) -> Result<(), JsValue> {
        let op = Op::AddAgentWorkspace {
            name: name.into(),
            agent_label: label.into(),
            id: id.into(),
            isolated,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Sets whether workspace `id` is isolated (isolated workspaces spec §5),
    /// stamping only `lifecycle_at`/`lifecycle_by`; `content`, `placement`
    /// and `appearance` survive byte-identical (spec §5.1). Rejects a node
    /// that is not a workspace: only a workspace has a cookie jar to choose.
    #[wasm_bindgen(js_name = setIsolation)]
    pub fn set_isolation(
        &mut self,
        id: &str,
        isolated: bool,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetIsolation {
            id: id.into(),
            isolated,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    #[wasm_bindgen(js_name = addGroup)]
    pub fn add_group(
        &mut self,
        parent: &str,
        name: &str,
        icon: Option<String>,
        id: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::AddGroup {
            parent: parent.into(),
            name: name.into(),
            icon,
            id: id.into(),
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// An empty split under `parent`, between `before` and `after` as in
    /// `addTab` (split-view spec §5.2). Its panes are moved in by the
    /// `moveNode`s that follow it in the same `applyBatch`. A parent that is
    /// not a workspace or a group is refused, with the codes
    /// `docs/host-contract.md` §8 lists.
    #[wasm_bindgen(js_name = addSplit)]
    #[expect(clippy::too_many_arguments)]
    pub fn add_split(
        &mut self,
        parent: &str,
        name: &str,
        id: &str,
        before: Option<String>,
        after: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::AddSplit {
            parent: parent.into(),
            name: name.into(),
            id: id.into(),
            before,
            after,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    #[wasm_bindgen(js_name = addTab)]
    #[expect(clippy::too_many_arguments)]
    pub fn add_tab(
        &mut self,
        parent: &str,
        name: &str,
        url: &str,
        id: &str,
        before: Option<String>,
        after: Option<String>,
        device_id: &[u8],
        now: f64,
        local: Option<bool>,
    ) -> Result<(), JsValue> {
        let op = Op::AddTab {
            parent: parent.into(),
            name: name.into(),
            url: url.into(),
            id: id.into(),
            before,
            after,
            local: local.unwrap_or(false),
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    #[wasm_bindgen(js_name = moveNode)]
    pub fn move_node(
        &mut self,
        id: &str,
        new_parent: &str,
        before: Option<String>,
        after: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::MoveNode {
            id: id.into(),
            new_parent: new_parent.into(),
            before,
            after,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Puts the workspace `id` between the workspaces `before` and `after`
    /// in the order every device lists them (`tree::move_workspace`).
    #[wasm_bindgen(js_name = moveWorkspace)]
    pub fn move_workspace(
        &mut self,
        id: &str,
        before: Option<String>,
        after: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::MoveWorkspace {
            id: id.into(),
            before,
            after,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Sets `id`'s name, stamping only the content group, so a rename never
    /// drags the node away from where a peer moved it (spec §5.1, §5.3).
    /// `remove` followed by an add would turn the edit into a deletion, which
    /// a peer's concurrent edit is allowed to beat (spec §5.4).
    pub fn rename(
        &mut self,
        id: &str,
        name: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::Rename {
            id: id.into(),
            name: name.into(),
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Sets `id`'s whole content group (name, url, icon, shares), stamping
    /// only `content_at` and `content_by` (spec §5.1, §5.3).
    ///
    /// **The group is the unit, so this is a read-modify-write.** Merge
    /// replaces a fact group entire, so whatever this call omits is
    /// overwritten: following a tab as it navigates means sending the name the
    /// document holds alongside the new url, or the write clobbers a rename
    /// made here or on a peer (`docs/host-contract.md` §3). `null` clears a
    /// field.
    ///
    /// `shares` is a split's pane widths. `local` marks an address that stays
    /// on this device (decision 1372), and only a write with an address can
    /// carry it.
    #[wasm_bindgen(js_name = setContent)]
    #[expect(clippy::too_many_arguments)]
    pub fn set_content(
        &mut self,
        id: &str,
        name: &str,
        url: Option<String>,
        icon: Option<String>,
        device_id: &[u8],
        now: f64,
        shares: Option<Vec<f64>>,
        local: Option<bool>,
    ) -> Result<(), JsValue> {
        let op = Op::SetContent {
            id: id.into(),
            name: name.into(),
            url,
            icon,
            shares,
            local: local.unwrap_or(false),
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Sets or clears `id`'s `local` mark with its address unchanged, for a
    /// node the host keeps on this device for a reason other than its
    /// address (decision 1372 as decision 2237 extends it). A change stamps
    /// the content group; a mark already as asked writes nothing. Only a
    /// node with an address can be local.
    #[wasm_bindgen(js_name = setLocal)]
    pub fn set_local(
        &mut self,
        id: &str,
        local: bool,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetLocal {
            id: id.into(),
            local,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Sets `id`'s whole appearance group (colour, emoji and transparency),
    /// stamping only `appearance_at`/`appearance_by` (spec §5.1, §5.3).
    ///
    /// **The group is the unit, as with [`Self::set_content`]**: `null` for
    /// any field clears it, so send the appearance the document holds
    /// alongside the one field changing.
    ///
    /// `color` is one of `COLOR_TOKENS`, or a plain object: `{h, c, l, mode}`
    /// on a workspace, `{h, c}` on a group (decision 0057, `parse_color`).
    /// `transparency` is a number in `[0, 1]`, on a workspace only. `emoji`
    /// is passed through unmodified: a flag or a ZWJ sequence is several
    /// Unicode scalar values long.
    #[wasm_bindgen(js_name = setAppearance)]
    pub fn set_appearance(
        &mut self,
        id: &str,
        color: JsValue,
        emoji: Option<String>,
        transparency: Option<f64>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        // `JSON.stringify` writes `NaN` and the infinities as `null`, so a
        // colour holding one is refused as a missing number.
        let color = if color.is_null() || color.is_undefined() {
            None
        } else {
            let json = js_sys::JSON::stringify(&color)
                .ok()
                .and_then(|json| json.as_string());
            Some(color_from_json(json).map_err(to_js_err)?)
        };
        let op = Op::SetAppearance {
            id: id.into(),
            color,
            emoji,
            transparency,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Sets the label a tab shows in place of its page's title, or clears it
    /// with `null`, stamping only `appearance_at`/`appearance_by`. The colour
    /// and emoji are kept, and the content group, which follows the page as
    /// it navigates, is left alone (spec §5.1).
    #[wasm_bindgen(js_name = setLabel)]
    pub fn set_label(
        &mut self,
        id: &str,
        label: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetLabel {
            id: id.into(),
            label,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Stamps `touched_at`/`touched_by` on `id` and nothing else: work was
    /// done inside it (decision 0106). Every fact group survives
    /// byte-identical, so the stamp competes with no edit made elsewhere; it
    /// is news to a peer that deleted the node without seeing it, which brings
    /// the node back (spec §5.4).
    #[wasm_bindgen(js_name = touch)]
    pub fn touch(&mut self, id: &str, device_id: &[u8], now: f64) -> Result<(), JsValue> {
        self.apply(Op::Touch { id: id.into() }, device_id, now)
            .map(|_| ())
    }

    /// Records that tab `id` was selected: touches it when its touch is an
    /// hour old or more, and answers whether it did (idle-tab archive spec
    /// §4.1).
    #[wasm_bindgen(js_name = markUsed)]
    pub fn mark_used(&mut self, id: &str, device_id: &[u8], now: f64) -> Result<bool, JsValue> {
        let id = parse_id(id).map_err(to_js_err)?;
        let by = parse_device_id(device_id).map_err(to_js_err)?;
        let now = parse_timestamp(now).map_err(to_js_err)?;
        crate::archive::mark_used(&mut self.0, id, by, now).map_err(to_js_err)
    }

    /// Sets workspace `id`'s own choice for archiving idle tabs, one of
    /// `12h`, `24h`, `7d`, `30d` and `never`, or clears it with `null` so it
    /// follows the global choice (idle-tab archive spec §5). Stamps only the
    /// lifecycle group.
    #[wasm_bindgen(js_name = setAutoArchive)]
    pub fn set_auto_archive(
        &mut self,
        id: &str,
        choice: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetAutoArchive {
            id: id.into(),
            choice,
        };
        self.apply(op, device_id, now).map(|_| ())
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

    /// Sets setting `key` to the JSON value `value_json`, or resets it to its
    /// default when `value_json` is absent or the JSON text `null`
    /// (settings-sync spec §3).
    #[wasm_bindgen(js_name = setSetting)]
    pub fn set_setting(
        &mut self,
        key: &str,
        value_json: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetSetting {
            key: key.into(),
            value_json,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Every setting as a JSON object, `{ key: value | null }`.
    pub fn settings(&self) -> Result<String, JsValue> {
        settings_json(&self.0).map_err(to_js_err)
    }

    /// Adds the favorite, folder or separator whose guid is `guid` at
    /// `favoriteId(guid)`, under `parent` between the siblings `before` and
    /// `after` (favorites-native spec §16). A Favorites root has no `parent`.
    #[wasm_bindgen(js_name = addFavorite)]
    #[expect(clippy::too_many_arguments)]
    pub fn add_favorite(
        &mut self,
        kind: &str,
        guid: &str,
        parent: Option<String>,
        before: Option<String>,
        after: Option<String>,
        name: &str,
        url: Option<String>,
        device_id: &[u8],
        now: f64,
        local: Option<bool>,
    ) -> Result<String, JsValue> {
        let op = Op::AddFavorite {
            favorite_kind: kind.into(),
            guid: guid.into(),
            parent,
            before,
            after,
            name: name.into(),
            url,
            local: local.unwrap_or(false),
        };
        self.apply(op, device_id, now).map(added)
    }

    /// Limits the pin `id` to the workspaces in `scope`, or shows it in
    /// every workspace for null (pins spec §7). Only the lifecycle group is
    /// stamped.
    #[wasm_bindgen(js_name = setPinScope)]
    pub fn set_pin_scope(
        &mut self,
        id: &str,
        scope: Option<Vec<String>>,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetPinScope {
            id: id.into(),
            scope,
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Every favorite, folder and separator as a JSON array of `{ id, kind,
    /// guid, parent, order, name, url, pinned, pinScope,
    /// contentAt, placementAt, added }`, ordered by parent and then by order
    /// among siblings.
    pub fn favorites(&self) -> Result<String, JsValue> {
        favorites_json(&self.0).map_err(to_js_err)
    }

    /// Adds the visit this device made to `url` at `visitedAt` in
    /// `workspace`, or in none when it is null, at `visitId(deviceId, url,
    /// visitedAt)`, and returns that id (history-sync spec §3, decision
    /// 1287). A visit already here is left as it is.
    #[wasm_bindgen(js_name = addVisit)]
    #[expect(clippy::too_many_arguments)]
    pub fn add_visit(
        &mut self,
        url: &str,
        title: &str,
        transition: u32,
        visited_at: f64,
        workspace: Option<String>,
        device_id: &[u8],
        now: f64,
    ) -> Result<String, JsValue> {
        let op = Op::AddVisit {
            url: url.into(),
            title: title.into(),
            transition,
            visited_at,
            workspace,
        };
        self.apply(op, device_id, now).map(added)
    }

    /// Sets visit `id`'s title, when it differs (history-sync spec §4.1).
    #[wasm_bindgen(js_name = setVisitTitle)]
    pub fn set_visit_title(
        &mut self,
        id: &str,
        title: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::SetVisitTitle {
            id: id.into(),
            title: title.into(),
        };
        self.apply(op, device_id, now).map(|_| ())
    }

    /// Every visit as a JSON array of `{ id, url, title, visitedAt,
    /// transition, device, workspace }`, oldest first. `device` is the hex id
    /// of the device that made the visit, and `workspace` the id of the
    /// workspace it was made in, or null.
    pub fn visits(&self) -> Result<String, JsValue> {
        visits_json(&self.0).map_err(to_js_err)
    }

    /// Records in the history index that this device wrote to shard `name`
    /// (history-sync spec §3).
    #[wasm_bindgen(js_name = touchShard)]
    pub fn touch_shard(&mut self, name: &str, device_id: &[u8], now: f64) -> Result<(), JsValue> {
        self.apply(Op::TouchShard { name: name.into() }, device_id, now)
            .map(|_| ())
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

    /// Deletes the container `id` and keeps what is in it: its children move
    /// to its parent, in their order, at the place it held
    /// ([`crate::tree::remove_keeping_children`]). "Delete group" when the
    /// user moves the contents out (spec §5.4).
    #[wasm_bindgen(js_name = removeKeepingChildren)]
    pub fn remove_keeping_children(
        &mut self,
        id: &str,
        device_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        let op = Op::RemoveKeepingChildren { id: id.into() };
        self.apply(op, device_id, now).map(|_| ())
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

/// Formats a bare 12-character code (as [`crate::pairing::generate_code`]
/// produces) into the grouped display form a host shows the user: three
/// groups of four separated by dashes. The pure core of
/// [`generate_pairing_code`], so it runs under plain `cargo test`.
///
/// Returns `None` if `code` is not exactly 12 ASCII characters, where the
/// byte slices would panic (`docs/host-contract.md` §8).
pub(crate) fn group_code_for_display(code: &str) -> Option<String> {
    if code.len() != 12 || !code.is_ascii() {
        return None;
    }
    Some([&code[0..4], &code[4..8], &code[8..12]].join("-"))
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

/// The bindings a host calls, driven natively on their success paths. A
/// refusal builds a `JsValue`, which only a wasm host can do, so each
/// refusal is tested on the pure check it calls instead.
#[cfg(test)]
mod binding_tests {
    use super::*;

    const DEVICE: [u8; 16] = [0xa; 16];

    fn id(n: u128) -> String {
        uuid::Uuid::from_u128(n).to_string()
    }

    fn node(doc: &SvalDocument, n: u128) -> Option<&crate::types::Node> {
        doc.0.node(uuid::Uuid::from_u128(n))
    }

    #[test]
    fn set_local_marks_a_tab_through_the_binding() {
        let mut doc = SvalDocument::new();
        doc.add_workspace("W", None, &id(1), &DEVICE, 1.0, None)
            .unwrap();
        doc.add_tab(
            &id(1),
            "Call",
            "https://meet.example/abc",
            &id(2),
            None,
            None,
            &DEVICE,
            2.0,
            None,
        )
        .unwrap();
        doc.set_local(&id(2), true, &DEVICE, 3.0).unwrap();
        assert!(node(&doc, 2).unwrap().content.local);
        doc.set_local(&id(2), false, &DEVICE, 4.0).unwrap();
        assert!(!node(&doc, 2).unwrap().content.local);
    }

    #[test]
    fn move_workspace_puts_a_workspace_in_its_new_place() {
        let mut doc = SvalDocument::new();
        for n in [1, 2] {
            doc.add_workspace("W", None, &id(n), &DEVICE, 1.0, None)
                .unwrap();
        }
        doc.move_workspace(&id(2), None, Some(id(1)), &DEVICE, 2.0)
            .unwrap();
        let order = |n| node(&doc, n).unwrap().placement.order.clone();
        assert!(order(2) < order(1), "the second now sorts first");
        assert_eq!(node(&doc, 2).unwrap().placement_at, 2);
    }

    #[test]
    fn a_split_round_trips_through_to_json_and_load_json_with_its_name_and_shares() {
        let mut doc = SvalDocument::new();
        doc.add_workspace("W", None, &id(1), &DEVICE, 1.0, None)
            .unwrap();
        for n in [2, 3] {
            doc.add_tab(
                &id(1),
                "T",
                "https://t.example/",
                &id(n),
                None,
                None,
                &DEVICE,
                2.0,
                None,
            )
            .unwrap();
        }
        doc.add_split(
            &id(1),
            "Docs",
            &id(4),
            Some(id(2)),
            Some(id(3)),
            &DEVICE,
            3.0,
        )
        .unwrap();
        doc.move_node(&id(2), &id(4), None, None, &DEVICE, 4.0)
            .unwrap();
        doc.move_node(&id(3), &id(4), Some(id(2)), None, &DEVICE, 4.0)
            .unwrap();
        doc.set_content(
            &id(4),
            "Docs",
            None,
            None,
            &DEVICE,
            5.0,
            Some(vec![40.0, 60.0]),
            None,
        )
        .unwrap();

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
        let mut doc = SvalDocument::new();
        doc.add_workspace("W", None, &id(1), &DEVICE, 1.0, None)
            .unwrap();
        for n in [2, 3] {
            doc.add_tab(
                &id(1),
                "T",
                "https://t.example/",
                &id(n),
                None,
                None,
                &DEVICE,
                2.0,
                None,
            )
            .unwrap();
        }
        doc.add_tab(
            &id(1),
            "T",
            "https://t.example/",
            &id(4),
            Some(id(2)),
            Some(id(3)),
            &DEVICE,
            3.0,
            None,
        )
        .unwrap();
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
    fn a_preloaded_store_lists_the_paths_under_a_prefix() {
        let store = PreloadedStore::new(vec![
            ("sval/ws/a/1.json".into(), vec![1]),
            ("sval/ws/b/2.json".into(), vec![2]),
        ]);
        assert_eq!(store.list("sval/ws/a/").unwrap(), vec!["sval/ws/a/1.json"]);
        assert_eq!(store.list("sval/").unwrap().len(), 2);
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
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": id(1) },
            { "kind": "addTab", "parent": id(1), "name": "T", "url": "https://t.example/", "id": id(10) },
            { "kind": "addTab", "parent": id(1), "name": "U", "url": "https://u.example/", "id": id(11) },
        ]);
        tree.apply_batch(&ops.to_string(), &DEVICE, 1.0).unwrap();
        assert!(node(&tree, 11).is_some());

        tree.set_auto_archive(&id(1), Some("12h".into()), &DEVICE, 2.0)
            .unwrap();
        assert_eq!(
            node(&tree, 1).unwrap().lifecycle.auto_archive.as_deref(),
            Some("12h")
        );
        assert!(tree.mark_used(&id(10), &DEVICE, HOUR).unwrap());
        assert!(!tree.mark_used(&id(10), &DEVICE, HOUR + 1.0).unwrap());

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
        let visit = doc
            .add_visit("https://e.example/", "E", 1, 10.0, None, &DEVICE, 10.0)
            .unwrap();
        assert_eq!(
            visit,
            crate::types::visit_id(DeviceId::from_bytes(DEVICE), "https://e.example/", 10)
                .to_string()
        );
        doc.set_visit_title(&visit, "Renamed", &DEVICE, 11.0)
            .unwrap();
        let visit_id = uuid::Uuid::parse_str(&visit).unwrap();
        assert_eq!(doc.0.node(visit_id).unwrap().content.name, "Renamed");
        assert_eq!(doc.visits().unwrap(), visits_json(&doc.0).unwrap());
        doc.touch_shard("history-2026-W42", &DEVICE, 12.0).unwrap();
        let shard = doc
            .0
            .node(crate::types::shard_id("history-2026-W42"))
            .unwrap();
        assert_eq!(shard.content_at, 12);
        assert_eq!(doc.shards().unwrap(), shards_json(&doc.0).unwrap());

        let pins = doc
            .add_favorite(
                "folder",
                crate::types::PINS_GUID,
                None,
                None,
                None,
                "",
                None,
                &DEVICE,
                1.0,
                None,
            )
            .unwrap();
        let pin = doc
            .add_favorite(
                "favorite",
                "page00000001",
                Some(pins),
                None,
                None,
                "P",
                Some("https://p.example/".into()),
                &DEVICE,
                2.0,
                None,
            )
            .unwrap();
        doc.set_pin_scope(&pin, Some(vec![id(1)]), &DEVICE, 3.0)
            .unwrap();
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
        doc.add_workspace("W", None, &id(1), &DEVICE, 1.0, Some(true))
            .unwrap();
        assert!(node(&doc, 1).unwrap().lifecycle.isolated);
        doc.add_workspace("Shared", None, &id(9), &DEVICE, 1.0, None)
            .unwrap();
        assert!(!node(&doc, 9).unwrap().lifecycle.isolated);
        doc.add_agent_workspace("A", "Claude Code", &id(2), &DEVICE, 1.0, Some(true))
            .unwrap();
        let agent = node(&doc, 2).unwrap();
        assert_eq!(agent.agent.as_ref().unwrap().label, "Claude Code");
        assert!(agent.lifecycle.isolated);

        doc.set_isolation(&id(1), false, &DEVICE, 2.0).unwrap();
        assert!(!node(&doc, 1).unwrap().lifecycle.isolated);

        doc.add_group(&id(1), "G", None, &id(3), &DEVICE, 3.0)
            .unwrap();
        assert_eq!(node(&doc, 3).unwrap().kind, NodeKind::Group);
        doc.add_tab(
            &id(1),
            "T",
            "https://t.example/",
            &id(4),
            None,
            None,
            &DEVICE,
            4.0,
            None,
        )
        .unwrap();
        assert_eq!(node(&doc, 4).unwrap().kind, NodeKind::Tab);

        doc.move_node(&id(4), &id(3), None, None, &DEVICE, 5.0)
            .unwrap();
        assert_eq!(
            node(&doc, 4).unwrap().placement.parent,
            Some(uuid::Uuid::from_u128(3))
        );
        doc.rename(&id(4), "Renamed", &DEVICE, 6.0).unwrap();
        assert_eq!(node(&doc, 4).unwrap().content.name, "Renamed");
        doc.set_content(
            &id(4),
            "Content",
            Some("https://c.example/".into()),
            None,
            &DEVICE,
            7.0,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            node(&doc, 4).unwrap().content.url.as_deref(),
            Some("https://c.example/")
        );
        doc.set_label(&id(4), Some("Mine".into()), &DEVICE, 8.5)
            .unwrap();
        assert_eq!(
            node(&doc, 4).unwrap().appearance.label.as_deref(),
            Some("Mine")
        );
        doc.touch(&id(3), &DEVICE, 9.0).unwrap();
        assert_eq!(node(&doc, 3).unwrap().touched_at, 9);

        doc.remove_keeping_children(&id(3), &DEVICE, 10.0).unwrap();
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
        doc.set_setting("sval.search", Some("\"ddg\"".into()), &DEVICE, 1.0)
            .unwrap();
        let settings: serde_json::Value = serde_json::from_str(&doc.settings().unwrap()).unwrap();
        assert_eq!(settings, serde_json::json!({"sval.search": "ddg"}));
    }

    #[test]
    fn every_favorites_mutator_changes_the_node_it_names() {
        let mut doc = SvalDocument::new();
        let toolbar = doc
            .add_favorite(
                "folder",
                "toolbar_____",
                None,
                None,
                None,
                "",
                None,
                &DEVICE,
                0.0,
                None,
            )
            .unwrap();
        assert_eq!(
            toolbar,
            crate::types::favorite_id("toolbar_____").to_string()
        );
        let folder = doc
            .add_favorite(
                "folder",
                "folder000001",
                Some(toolbar.clone()),
                None,
                None,
                "Work",
                None,
                &DEVICE,
                1.0,
                None,
            )
            .unwrap();
        let page = doc
            .add_favorite(
                "favorite",
                "page00000001",
                Some(folder.clone()),
                None,
                None,
                "Page",
                Some("https://p.example/".into()),
                &DEVICE,
                1.0,
                None,
            )
            .unwrap();
        doc.add_favorite(
            "separator",
            "separator001",
            Some(toolbar.clone()),
            None,
            None,
            "",
            None,
            &DEVICE,
            1.0,
            None,
        )
        .unwrap();

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

#[cfg(test)]
mod archive_bindings_tests {
    use super::*;

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
