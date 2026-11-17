// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The mobile apps' boundary: the calls `crate::wasm` gives the desktop,
//! exported through UniFFI for Swift and Kotlin.
//!
//! Each export calls the same checked function its WASM twin calls, so a
//! phone and a desktop refuse the same input with the same `code` and
//! `reason`. Storage stays inverted as `docs/host-contract.md` §1 describes:
//! the app lists and reads the files, hands them to [`SvalDocument::sync`],
//! and writes back the one file it returns.

use crate::crypto::Key;
use crate::failure::Failure;
use crate::host::{JsSyncReport, own_device_path, run_sync_to};
use crate::ops::{apply_batch, parse_device_id, parse_timestamp};
use crate::sync::Target;
use crate::tree;
use crate::types::{Document, NodeId, NodeKind};
use crate::views::{favorites_json, shards_json, visits_json};
use std::sync::{Arc, Mutex, MutexGuard};

/// A refusal, as `docs/host-contract.md` §8 spells it for every host.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum EngineError {
    #[error("{code}: {message}")]
    Refused {
        code: String,
        reason: Option<String>,
        message: String,
    },
}

impl From<Failure> for EngineError {
    fn from(failure: Failure) -> Self {
        EngineError::Refused {
            code: failure.code.to_owned(),
            reason: failure.reason.map(|reason| reason.as_str().to_owned()),
            message: failure.message,
        }
    }
}

fn refused(err: impl Into<Failure>) -> EngineError {
    EngineError::from(err.into())
}

/// One file the app read from the directory [`sync_prefix`] names.
#[derive(Clone, uniffi::Record)]
pub struct PeerFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// What one sync pass produced: the report as the JSON every host reads
/// (`docs/host-contract.md` §7), and the file, if any, the app writes back
/// atomically.
#[derive(Debug, uniffi::Record)]
pub struct SyncResult {
    pub report_json: String,
    pub write_path: Option<String>,
    pub write_bytes: Option<Vec<u8>>,
}

/// One row of [`SvalDocument::outline`]: a node with its depth, in the order
/// a tree view draws it.
#[derive(uniffi::Record)]
pub struct OutlineRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub depth: u32,
    pub kind: String,
    pub name: String,
    pub url: Option<String>,
    /// The tab's icon as the content group holds it, which a host writing
    /// the group (`setContent`) sends back unchanged.
    pub icon: Option<String>,
    /// Whether the address stays on this device (decision 1372), sent back
    /// as `icon` is.
    pub local: bool,
    pub emoji: Option<String>,
    /// The name a user gave a tab, shown in place of its page's title
    /// (spec §5.1).
    pub label: Option<String>,
    /// The colour a Workspace or group carries: a preset's token, such as
    /// `blue`, or a custom colour's JSON (decision 0057).
    pub color: Option<String>,
    /// How see-through a Workspace's window is, 0...1, which a host that
    /// writes the appearance group back must carry (decision 0057).
    pub transparency: Option<f64>,
    pub pinned: bool,
    /// The label of the agent whose Workspace this is, which the switcher
    /// groups agent Workspaces under (agent-control spec §3.5). Empty for
    /// an agent with no label; absent for the user's own.
    pub agent: Option<String>,
    /// The device that paired the agent whose Workspace this is, as its 16
    /// bytes; absent for the user's own. Other devices name it after the
    /// agent's label (agent-control spec §3.5).
    pub agent_device: Option<Vec<u8>>,
    /// The device whose own Workspace this is (decision 2254), as its 16
    /// bytes; absent for every other Workspace.
    pub device: Option<Vec<u8>>,
    /// Whether this Workspace keeps a cookie jar of its own.
    pub isolated: bool,
    /// A split's pane widths, one percentage per pane in pane order
    /// (split-view spec §5.1); absent means equal widths.
    pub shares: Option<Vec<f64>>,
}

/// One pin or pinned folder of [`SvalDocument::pins`].
#[derive(uniffi::Record)]
pub struct PinRow {
    pub id: String,
    /// The favorite's guid, which keys its page (pins spec §13).
    pub guid: String,
    /// `favorite` or `folder`.
    pub kind: String,
    pub name: String,
    pub url: Option<String>,
    /// Whether the address stays on this device (decision 1372).
    pub local: bool,
    /// The pinned folder a pin sits in, at any depth; absent for a slot of
    /// the row itself.
    pub folder: Option<String>,
    /// The Workspaces a slot of the row shows in, absent for every one. A
    /// pin in a folder has none of its own (pins spec §7).
    pub scope: Option<Vec<String>>,
}

/// The node id of the visit device `device_id` made to `url` at
/// `visited_at` (history-sync spec §3), which a host names to set its title.
#[uniffi::export]
pub fn visit_id(device_id: Vec<u8>, url: String, visited_at: f64) -> Result<String, EngineError> {
    let device = parse_device_id(&device_id).map_err(refused)?;
    let at = parse_timestamp(visited_at).map_err(refused)?;
    Ok(crate::types::visit_id(device, &url, at).to_string())
}

/// The node id of the favorite whose guid is `guid` (favorites-native spec
/// §3), which a host adding one names in the same batch.
#[uniffi::export]
pub fn favorite_id(guid: String) -> String {
    crate::types::favorite_id(&guid).to_string()
}

/// Appends every favorite under `folder`, depth first in folder order, each
/// naming `top`, the pinned folder: a pin in a subfolder is a pin as one in
/// the folder is (pins spec §6).
fn pins_inside(
    doc: &Document,
    folder: NodeId,
    top: NodeId,
    depth: usize,
    shown: &dyn Fn(&crate::types::Node) -> bool,
    row: &dyn Fn(NodeId, &crate::types::Node, Option<NodeId>) -> PinRow,
    out: &mut Vec<PinRow>,
) {
    if depth >= 32 {
        return;
    }
    let mut children: Vec<_> = doc
        .nodes
        .iter()
        .filter(|(_, n)| n.placement.parent == Some(folder) && shown(n))
        .collect();
    children.sort_by(|(a_id, a), (b_id, b)| {
        (&a.placement.order, a_id).cmp(&(&b.placement.order, b_id))
    });
    for (id, node) in children {
        if node.kind == NodeKind::Folder {
            pins_inside(doc, *id, top, depth + 1, shown, row, out);
        } else {
            out.push(row(*id, node, Some(top)));
        }
    }
}

/// The document a device holds, behind a lock because UniFFI objects are
/// shared across threads.
#[derive(uniffi::Object)]
pub struct SvalDocument(Mutex<Document>);

impl SvalDocument {
    fn doc(&self) -> MutexGuard<'_, Document> {
        // A panic while the lock is held is a bug already reported by the
        // panic itself; the document is still the last one written.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl SvalDocument {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(SvalDocument(Mutex::new(Document::new())))
    }

    #[uniffi::constructor]
    pub fn load_json(json: String) -> Result<Arc<Self>, EngineError> {
        let doc = Document::from_json(&json).map_err(refused)?;
        Ok(Arc::new(SvalDocument(Mutex::new(doc))))
    }

    pub fn to_json(&self) -> Result<String, EngineError> {
        self.doc().to_json().map_err(refused)
    }

    /// Every setting in a settings document, as a JSON object of key to
    /// value, `null` for one reset to its default (`Document::settings`).
    pub fn settings_json(&self) -> Result<String, EngineError> {
        serde_json::to_string(&self.doc().settings()).map_err(refused)
    }

    /// Every favorite, folder and separator of a favorites document, as the
    /// desktop's store reads them: a JSON array ordered by parent, then by
    /// place among siblings.
    pub fn favorites_json(&self) -> Result<String, EngineError> {
        favorites_json(&self.doc()).map_err(EngineError::from)
    }

    /// Every visit of a history week, as the desktop reads them: a JSON
    /// array of `{ id, url, title, visitedAt, transition, device,
    /// workspace }`, oldest first (history-sync spec §3).
    pub fn visits_json(&self) -> Result<String, EngineError> {
        visits_json(&self.doc()).map_err(EngineError::from)
    }

    /// Every week the history index lists, as `{ name, changedAt }`,
    /// newest first.
    pub fn shards_json(&self) -> Result<String, EngineError> {
        shards_json(&self.doc()).map_err(EngineError::from)
    }

    /// The pins a Workspace shows, in the row's order (pins spec §4, §7): each
    /// pinned favorite or folder whose scope holds `workspace`, or names no
    /// Workspace in `workspaces`, every Workspace the tree holds. A pinned
    /// folder is followed by every favorite inside it, depth first, each
    /// naming the folder. Separators and bookmarklets are left out.
    pub fn pins(&self, workspace: String, workspaces: Vec<String>) -> Vec<PinRow> {
        let doc = self.doc();
        let shown = |node: &crate::types::Node| match node.kind {
            NodeKind::Folder => true,
            NodeKind::Favorite => node.content.url.as_deref().is_some_and(|url| {
                !url.trim_start()
                    .to_ascii_lowercase()
                    .starts_with("javascript:")
            }),
            _ => false,
        };
        let row = |id: NodeId, node: &crate::types::Node, folder: Option<NodeId>| PinRow {
            id: id.to_string(),
            guid: node.content.guid.clone().unwrap_or_default(),
            kind: if node.kind == NodeKind::Folder {
                "folder"
            } else {
                "favorite"
            }
            .into(),
            name: node.content.name.clone(),
            url: node.content.url.clone(),
            local: node.content.local,
            folder: folder.map(|f| f.to_string()),
            scope: folder
                .is_none()
                .then(|| {
                    node.lifecycle
                        .pin_scope
                        .as_ref()
                        .map(|s| s.iter().cloned().collect())
                })
                .flatten(),
        };
        // The pins root's children, in the tree's order, are the row
        // (pins-root spec §3).
        let root = crate::types::favorite_id(crate::types::PINS_GUID);
        let mut slots: Vec<_> = doc
            .nodes
            .iter()
            .filter(|(_, n)| n.placement.parent == Some(root) && shown(n))
            .filter(|(_, n)| {
                let live: Vec<_> = n
                    .lifecycle
                    .pin_scope
                    .iter()
                    .flatten()
                    .filter(|id| workspaces.contains(id))
                    .collect();
                live.is_empty() || live.contains(&&workspace)
            })
            .collect();
        slots.sort_by(|(a_id, a), (b_id, b)| {
            (&a.placement.order, a_id).cmp(&(&b.placement.order, b_id))
        });
        let mut out = Vec::new();
        for (id, node) in slots {
            out.push(row(*id, node, None));
            if node.kind == NodeKind::Folder {
                pins_inside(&doc, *id, *id, 0, &shown, &row, &mut out);
            }
        }
        out
    }

    /// Applies a batch of operations in `SvalDocumentOps.mjs`'s shape, all or
    /// none (`crate::ops::apply_batch`).
    pub fn apply_batch(
        &self,
        ops_json: String,
        device_id: Vec<u8>,
        now: f64,
    ) -> Result<(), EngineError> {
        apply_batch(&mut self.doc(), &ops_json, &device_id, now).map_err(EngineError::from)
    }

    /// One pass against one location: the app's own copy when `shared` is
    /// false, the shared folder when it is true (`crate::sync::Target`).
    /// `files` is every file the app read under [`sync_prefix`], this
    /// device's own included (`docs/host-contract.md` §1).
    pub fn sync(
        &self,
        key: Vec<u8>,
        device_id: Vec<u8>,
        workspace: String,
        files: Vec<PeerFile>,
        now: f64,
        shared: bool,
    ) -> Result<SyncResult, EngineError> {
        let target = if shared {
            Target::Shared
        } else {
            Target::Profile
        };
        let files = files
            .into_iter()
            .map(|file| (file.path, file.bytes))
            .collect();
        let (report, write) = run_sync_to(
            &mut self.doc(),
            &key,
            &device_id,
            &workspace,
            files,
            now,
            None,
            target,
            None,
        )?;
        let report: JsSyncReport = report;
        Ok(SyncResult {
            report_json: serde_json::to_string(&report).map_err(refused)?,
            write_path: write.as_ref().map(|(path, _)| path.clone()),
            write_bytes: write.map(|(_, bytes)| bytes),
        })
    }

    /// Every workspace and what it holds, depth first in sibling order
    /// (`tree::children`). Workspaces come in their own order as roots.
    pub fn outline(&self) -> Vec<OutlineRow> {
        let doc = self.doc();
        let mut roots: Vec<_> = doc
            .workspaces()
            .filter(|(_, node)| node.placement.parent.is_none())
            .map(|(id, node)| (node.placement.order.clone(), *id))
            .collect();
        roots.sort();
        let mut rows = Vec::new();
        for (_, id) in roots {
            push_rows(&doc, id, None, 0, &mut rows);
        }
        rows
    }
}

fn push_rows(
    doc: &Document,
    id: NodeId,
    parent: Option<NodeId>,
    depth: u32,
    rows: &mut Vec<OutlineRow>,
) {
    let Some(node) = doc.node(id) else {
        return;
    };
    rows.push(OutlineRow {
        id: id.to_string(),
        parent_id: parent.map(|parent| parent.to_string()),
        depth,
        kind: serde_json::to_value(&node.kind)
            .ok()
            .and_then(|kind| kind.as_str().map(str::to_owned))
            .unwrap_or_default(),
        name: node.content.name.clone(),
        url: node.content.url.clone(),
        icon: node.content.icon.clone(),
        local: node.content.local,
        emoji: node.appearance.emoji.clone(),
        label: node.appearance.label.clone(),
        // A preset's token as it is, and a custom colour, an object
        // (decision 0057), as its JSON, which the phone draws with the
        // desktop's own colour maths.
        color: node.appearance.color.as_ref().map(|color| match color {
            serde_json::Value::String(token) => token.clone(),
            other => other.to_string(),
        }),
        transparency: node.appearance.transparency,
        pinned: node.lifecycle.pinned,
        agent: node.agent.as_ref().map(|mark| mark.label.clone()),
        agent_device: node
            .agent
            .as_ref()
            .map(|mark| mark.device.as_bytes().to_vec()),
        device: node
            .device_home
            .as_ref()
            .map(|mark| mark.device.as_bytes().to_vec()),
        isolated: node.lifecycle.isolated,
        shares: node.content.shares.clone(),
    });
    if matches!(
        node.kind,
        NodeKind::Workspace | NodeKind::Group | NodeKind::Split
    ) {
        for child in tree::children(doc, id) {
            push_rows(doc, child, Some(id), depth + 1, rows);
        }
    }
}

/// The one directory whose files a pass reads (`crate::wasm::sync_prefix`).
#[uniffi::export]
pub fn sync_prefix(key: Vec<u8>, workspace: String) -> Result<String, EngineError> {
    let key = Key::from_bytes(&key).map_err(refused)?;
    Ok(crate::store::workspace_dir(&key, &workspace))
}

/// Whether `path` is a device's file in [`sync_prefix`]'s directory.
#[uniffi::export]
pub fn is_device_file(key: Vec<u8>, workspace: String, path: String) -> Result<bool, EngineError> {
    let key = Key::from_bytes(&key).map_err(refused)?;
    Ok(crate::store::device_of(&crate::store::workspace_dir(&key, &workspace), &path).is_some())
}

/// This device's own file within [`sync_prefix`]'s directory.
#[uniffi::export]
pub fn device_path(
    key: Vec<u8>,
    workspace: String,
    device_id: Vec<u8>,
) -> Result<String, EngineError> {
    own_device_path(&key, &workspace, &device_id).map_err(EngineError::from)
}

/// The sync key a pairing offer holds, given the code the other device shows
/// (`crate::pairing::open`). The app passes what the user typed. A desktop
/// seals its offer under the grouped form it shows (`generatePairingCode`),
/// so the typed code is normalized and grouped the same way before it is
/// tried.
#[uniffi::export]
pub fn open_pairing(bytes: Vec<u8>, code: String) -> Result<Vec<u8>, EngineError> {
    let code = crate::pairing::normalize_code(&code)
        .and_then(|code| crate::host::group_code_for_display(&code))
        .ok_or_else(|| EngineError::Refused {
            code: "bad_pairing_code".to_owned(),
            reason: None,
            message: "not a pairing code".to_owned(),
        })?;
    let key = crate::pairing::open(&bytes, &code).map_err(refused)?;
    Ok(key.to_bytes().to_vec())
}

/// A fresh pairing code, grouped as a device shows it
/// (`generatePairingCode`), for this device to offer its sync key under.
#[uniffi::export]
pub fn generate_pairing_code() -> Result<String, EngineError> {
    let code = crate::pairing::generate_code().map_err(refused)?;
    crate::host::group_code_for_display(&code).ok_or_else(|| EngineError::Refused {
        code: "internal_error".to_owned(),
        reason: None,
        message: "a generated pairing code had the wrong shape".to_owned(),
    })
}

/// `key` sealed under `code`, the code exactly as
/// [`generate_pairing_code`] gave it, until `now + ttl_ms` (`sealPairing`):
/// the offer another device opens with [`open_pairing`].
#[uniffi::export]
pub fn seal_pairing(
    key: Vec<u8>,
    code: String,
    now: f64,
    ttl_ms: f64,
) -> Result<Vec<u8>, EngineError> {
    crate::host::seal_pairing_core(&key, &code, now, ttl_ms).map_err(EngineError::from)
}

/// When a pairing offer expires, read without the code.
#[uniffi::export]
pub fn pairing_expires_at(bytes: Vec<u8>) -> Result<f64, EngineError> {
    let expires_at = crate::pairing::expires_at(&bytes).map_err(refused)?;
    Ok(expires_at as f64)
}

/// What [`crate::ENGINE_VERSION`] reports (`docs/host-contract.md` §11).
#[uniffi::export]
pub fn engine_version() -> String {
    crate::ENGINE_VERSION.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];
    const PHONE: [u8; 16] = [1; 16];
    const DESKTOP: [u8; 16] = [2; 16];
    const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
    const GROUP: &str = "22222222-2222-4222-8222-222222222222";
    const TAB: &str = "33333333-3333-4333-8333-333333333333";

    fn desktop_publish() -> PeerFile {
        let desktop = SvalDocument::new();
        let ops = format!(
            r#"[{{"kind":"addWorkspace","name":"Work","id":"{WORKSPACE}"}},
               {{"kind":"addGroup","parent":"{WORKSPACE}","name":"Docs","id":"{GROUP}"}},
               {{"kind":"addTab","parent":"{GROUP}","name":"Example","url":"https://example.com/","id":"{TAB}"}},
               {{"kind":"setAppearance","id":"{WORKSPACE}","color":"blue","emoji":"💼"}},
               {{"kind":"setLabel","id":"{TAB}","label":"Mine"}}]"#
        );
        desktop.apply_batch(ops, DESKTOP.to_vec(), 1_000.0).unwrap();
        let result = desktop
            .sync(
                KEY.to_vec(),
                DESKTOP.to_vec(),
                "workspaces".into(),
                vec![],
                2_000.0,
                true,
            )
            .unwrap();
        PeerFile {
            path: result.write_path.unwrap(),
            bytes: result.write_bytes.unwrap(),
        }
    }

    #[test]
    fn an_agent_workspace_row_names_the_device_that_paired_the_agent() {
        let desktop = SvalDocument::new();
        let ops = r#"[{"kind":"addAgentWorkspace","name":"Fix the build","agentLabel":"Claude Code","id":"00000000-0000-0000-0000-000000000030"}]"#;
        desktop
            .apply_batch(ops.into(), DESKTOP.to_vec(), 1_000.0)
            .unwrap();
        let row = &desktop.outline()[0];
        assert_eq!(row.agent.as_deref(), Some("Claude Code"));
        assert_eq!(row.agent_device.as_deref(), Some(&DESKTOP[..]));
    }

    #[test]
    fn a_workspace_row_carries_a_preset_as_its_token_and_a_custom_colour_as_json() {
        let desktop = SvalDocument::new();
        let ops = r#"[{"kind":"addWorkspace","name":"Work","id":"00000000-0000-0000-0000-000000000040"},
                      {"kind":"addWorkspace","name":"Home","id":"00000000-0000-0000-0000-000000000041"},
                      {"kind":"setAppearance","id":"00000000-0000-0000-0000-000000000040","color":"blue"},
                      {"kind":"setAppearance","id":"00000000-0000-0000-0000-000000000041","color":{"h":200,"c":0.12,"l":0.3,"mode":"dark"}}]"#;
        desktop
            .apply_batch(ops.into(), DESKTOP.to_vec(), 1_000.0)
            .unwrap();
        let rows = desktop.outline();
        let color = |name: &str| {
            rows.iter()
                .find(|row| row.name == name)
                .unwrap()
                .color
                .clone()
                .unwrap()
        };
        assert_eq!(color("Work"), "blue");
        let custom: serde_json::Value = serde_json::from_str(&color("Home")).unwrap();
        assert_eq!(
            custom,
            serde_json::json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" })
        );
    }

    #[test]
    fn a_phone_reads_a_desktops_settings() {
        let desktop = SvalDocument::new();
        let ops = r#"[{"kind":"setSetting","key":"browser.sval.javascript.site.example.com","valueJson":"\"block\""},
                      {"kind":"setSetting","key":"javascript.enabled","valueJson":"true"}]"#;
        desktop
            .apply_batch(ops.into(), DESKTOP.to_vec(), 1_000.0)
            .unwrap();
        let published = desktop
            .sync(
                KEY.to_vec(),
                DESKTOP.to_vec(),
                "settings".into(),
                vec![],
                2_000.0,
                true,
            )
            .unwrap();
        let phone = SvalDocument::new();
        phone
            .sync(
                KEY.to_vec(),
                PHONE.to_vec(),
                "settings".into(),
                vec![PeerFile {
                    path: published.write_path.unwrap(),
                    bytes: published.write_bytes.unwrap(),
                }],
                3_000.0,
                true,
            )
            .unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(&phone.settings_json().unwrap()).unwrap();
        assert_eq!(
            settings["browser.sval.javascript.site.example.com"],
            "block"
        );
        assert_eq!(settings["javascript.enabled"], true);
    }

    #[test]
    fn a_phone_reads_what_a_desktop_published_as_an_ordered_outline() {
        let file = desktop_publish();
        let phone = SvalDocument::new();
        let result = phone
            .sync(
                KEY.to_vec(),
                PHONE.to_vec(),
                "workspaces".into(),
                vec![file],
                3_000.0,
                true,
            )
            .unwrap();
        assert_eq!(
            result.write_path.unwrap(),
            device_path(KEY.to_vec(), "workspaces".into(), PHONE.to_vec()).unwrap()
        );
        let rows: Vec<_> = phone
            .outline()
            .into_iter()
            .map(|row| (row.depth, row.kind, row.name, row.url, row.parent_id))
            .collect();
        let workspace = &phone.outline()[0];
        assert_eq!(workspace.color.as_deref(), Some("blue"));
        assert_eq!(workspace.emoji.as_deref(), Some("💼"));
        assert!(workspace.agent.is_none() && !workspace.isolated);
        let tab = phone
            .outline()
            .into_iter()
            .find(|row| row.id == TAB)
            .unwrap();
        assert_eq!(tab.label.as_deref(), Some("Mine"));
        assert_eq!(tab.name, "Example");
        assert_eq!(
            rows,
            vec![
                (0, "workspace".into(), "Work".into(), None, None),
                (
                    1,
                    "group".into(),
                    "Docs".into(),
                    None,
                    Some(WORKSPACE.into())
                ),
                (
                    2,
                    "tab".into(),
                    "Example".into(),
                    Some("https://example.com/".into()),
                    Some(GROUP.into())
                ),
            ]
        );
    }

    #[test]
    fn the_published_file_sits_where_the_prefix_names_it() {
        let file = desktop_publish();
        let prefix = sync_prefix(KEY.to_vec(), "workspaces".into()).unwrap();
        assert!(file.path.starts_with(&format!("{prefix}/")));
        assert!(is_device_file(KEY.to_vec(), "workspaces".into(), file.path).unwrap());
    }

    #[test]
    fn an_offer_this_device_seals_opens_with_its_code_typed_bare() {
        let shown = generate_pairing_code().unwrap();
        assert_eq!(shown.len(), 14, "three groups of four, with two dashes");
        let offer = seal_pairing(KEY.to_vec(), shown.clone(), 1_000.0, 60_000.0).unwrap();
        let typed = shown.replace('-', "").to_lowercase();
        assert_eq!(open_pairing(offer.clone(), typed).unwrap(), KEY.to_vec());
        assert_eq!(pairing_expires_at(offer).unwrap(), 61_000.0);
    }

    #[test]
    fn a_pairing_offer_opens_with_the_typed_code_and_refuses_another() {
        // Sealed as a desktop seals it: under the grouped code it shows.
        let code = crate::pairing::generate_code().unwrap();
        let shown = crate::host::group_code_for_display(&code).unwrap();
        let offer = crate::host::seal_pairing_core(&KEY, &shown, 1_000.0, 60_000.0).unwrap();
        let typed = format!("{}{} {}", &code[..4], &code[4..8], code[8..].to_lowercase());
        assert_eq!(open_pairing(offer.clone(), typed).unwrap(), KEY.to_vec());
        assert_eq!(pairing_expires_at(offer.clone()).unwrap(), 61_000.0);
        let other = crate::pairing::generate_code().unwrap();
        assert!(matches!(
            open_pairing(offer, other),
            Err(EngineError::Refused { code, .. }) if code == "bad_pairing_code"
        ));
    }

    #[test]
    fn a_refusal_carries_the_hosts_code_and_reason() {
        let phone = SvalDocument::new();
        let err = phone
            .sync(
                KEY.to_vec(),
                vec![1; 3],
                "workspaces".into(),
                vec![],
                1.0,
                true,
            )
            .unwrap_err();
        assert!(matches!(
            err,
            EngineError::Refused { code, reason: Some(reason), .. }
                if code == "invalid_argument" && reason == "bad_device_id"
        ));
    }

    #[test]
    fn a_desktop_receives_the_edits_a_phone_makes() {
        let first = desktop_publish();
        let phone = SvalDocument::new();
        phone
            .sync(
                KEY.to_vec(),
                PHONE.to_vec(),
                "workspaces".into(),
                vec![first.clone()],
                3_000.0,
                true,
            )
            .unwrap();
        const ADDED: &str = "44444444-4444-4444-8444-444444444444";
        // The operations as the iPhone app spells them.
        for op in [
            format!(r#"[{{"kind":"rename","id":"{WORKSPACE}","name":"Home"}}]"#),
            format!(r#"[{{"kind":"remove","id":"{TAB}"}}]"#),
            format!(
                r#"[{{"kind":"addTab","parent":"{GROUP}","name":"https://sval.app/","url":"https://sval.app/","id":"{ADDED}"}}]"#
            ),
        ] {
            phone.apply_batch(op, PHONE.to_vec(), 4_000.0).unwrap();
        }
        let published = phone
            .sync(
                KEY.to_vec(),
                PHONE.to_vec(),
                "workspaces".into(),
                vec![first.clone()],
                5_000.0,
                true,
            )
            .unwrap();
        let phone_file = PeerFile {
            path: published.write_path.unwrap(),
            bytes: published.write_bytes.unwrap(),
        };
        let desktop = SvalDocument::new();
        desktop
            .sync(
                KEY.to_vec(),
                DESKTOP.to_vec(),
                "workspaces".into(),
                vec![first, phone_file],
                6_000.0,
                true,
            )
            .unwrap();
        let rows: Vec<_> = desktop
            .outline()
            .into_iter()
            .map(|row| (row.id, row.name))
            .collect();
        assert_eq!(
            rows,
            vec![
                (WORKSPACE.into(), "Home".into()),
                (GROUP.into(), "Docs".into()),
                (ADDED.into(), "https://sval.app/".into()),
            ]
        );
    }

    /// A phone whose own copy starts empty, after leaving the folder or a
    /// reinstall, takes a new device id (`Secrets.newDeviceId` on iOS,
    /// `docs/host-contract.md` §5), and gets back what it made.
    #[test]
    fn a_phone_that_starts_again_under_a_new_id_keeps_what_it_made() {
        use std::collections::BTreeMap;
        const NEWS: &str = "44444444-4444-4444-8444-444444444444";
        let mut folder: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let pass = |doc: &SvalDocument,
                    device: &[u8],
                    folder: &mut BTreeMap<String, Vec<u8>>,
                    key: &[u8],
                    shared: bool,
                    now: f64| {
            let files = folder
                .iter()
                .map(|(path, bytes)| PeerFile {
                    path: path.clone(),
                    bytes: bytes.clone(),
                })
                .collect();
            let result = doc
                .sync(
                    key.to_vec(),
                    device.to_vec(),
                    "workspaces".into(),
                    files,
                    now,
                    shared,
                )
                .unwrap();
            if let (Some(path), Some(bytes)) = (result.write_path, result.write_bytes) {
                folder.insert(path, bytes);
            }
        };
        let names = |doc: &SvalDocument| -> Vec<String> {
            doc.outline()
                .into_iter()
                .filter(|row| row.depth == 0)
                .map(|row| row.name)
                .collect()
        };
        let desktop = SvalDocument::new();
        desktop
            .apply_batch(
                format!(r#"[{{"kind":"addWorkspace","name":"Work","id":"{WORKSPACE}"}}]"#),
                DESKTOP.to_vec(),
                1_000.0,
            )
            .unwrap();
        pass(&desktop, &DESKTOP, &mut folder, &KEY, true, 2_000.0);
        let phone = SvalDocument::new();
        pass(&phone, &PHONE, &mut folder, &KEY, true, 3_000.0);
        phone
            .apply_batch(
                format!(r#"[{{"kind":"addWorkspace","name":"News","id":"{NEWS}"}}]"#),
                PHONE.to_vec(),
                4_000.0,
            )
            .unwrap();
        pass(&phone, &PHONE, &mut folder, &KEY, true, 5_000.0);
        pass(&desktop, &DESKTOP, &mut folder, &KEY, true, 6_000.0);
        assert_eq!(names(&desktop), ["Work", "News"]);

        // The phone starts again: an empty copy, saved to its own storage
        // before it joins, as the app saves it, under a new id.
        let again: [u8; 16] = [3; 16];
        let fresh = SvalDocument::new();
        pass(
            &fresh,
            &again,
            &mut BTreeMap::new(),
            &[9; 32],
            false,
            6_500.0,
        );
        pass(&fresh, &again, &mut folder, &KEY, true, 7_000.0);
        assert_eq!(
            names(&fresh),
            ["Work", "News"],
            "the phone gets back what it made"
        );
        pass(&desktop, &DESKTOP, &mut folder, &KEY, true, 8_000.0);
        assert_eq!(names(&desktop), ["Work", "News"], "the desktop keeps it");
    }

    /// A phone that starts again under its old id gets back what it made
    /// too: the engine takes the id's earlier writes back (decision 2232).
    #[test]
    fn a_phone_that_starts_again_under_its_old_id_keeps_what_it_made() {
        use std::collections::BTreeMap;
        const NEWS: &str = "44444444-4444-4444-8444-444444444444";
        let mut folder: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let pass = |doc: &SvalDocument,
                    device: &[u8],
                    folder: &mut BTreeMap<String, Vec<u8>>,
                    key: &[u8],
                    shared: bool,
                    now: f64| {
            let files = folder
                .iter()
                .map(|(path, bytes)| PeerFile {
                    path: path.clone(),
                    bytes: bytes.clone(),
                })
                .collect();
            let result = doc
                .sync(
                    key.to_vec(),
                    device.to_vec(),
                    "workspaces".into(),
                    files,
                    now,
                    shared,
                )
                .unwrap();
            if let (Some(path), Some(bytes)) = (result.write_path, result.write_bytes) {
                folder.insert(path, bytes);
            }
        };
        let names = |doc: &SvalDocument| -> Vec<String> {
            doc.outline()
                .into_iter()
                .filter(|row| row.depth == 0)
                .map(|row| row.name)
                .collect()
        };
        let desktop = SvalDocument::new();
        desktop
            .apply_batch(
                format!(r#"[{{"kind":"addWorkspace","name":"Work","id":"{WORKSPACE}"}}]"#),
                DESKTOP.to_vec(),
                1_000.0,
            )
            .unwrap();
        pass(&desktop, &DESKTOP, &mut folder, &KEY, true, 2_000.0);
        let phone = SvalDocument::new();
        pass(&phone, &PHONE, &mut folder, &KEY, true, 3_000.0);
        phone
            .apply_batch(
                format!(r#"[{{"kind":"addWorkspace","name":"News","id":"{NEWS}"}}]"#),
                PHONE.to_vec(),
                4_000.0,
            )
            .unwrap();
        pass(&phone, &PHONE, &mut folder, &KEY, true, 5_000.0);
        pass(&desktop, &DESKTOP, &mut folder, &KEY, true, 6_000.0);
        assert_eq!(names(&desktop), ["Work", "News"]);

        // The phone starts again under the id it synced under: an empty
        // copy, saved to its own storage before it joins.
        let again = PHONE;
        let fresh = SvalDocument::new();
        pass(
            &fresh,
            &again,
            &mut BTreeMap::new(),
            &[9; 32],
            false,
            6_500.0,
        );
        pass(&fresh, &again, &mut folder, &KEY, true, 7_000.0);
        assert_eq!(
            names(&fresh),
            ["Work", "News"],
            "the phone gets back what it made"
        );
        pass(&desktop, &DESKTOP, &mut folder, &KEY, true, 8_000.0);
        assert_eq!(names(&desktop), ["Work", "News"], "the desktop keeps it");
    }

    /// A Workspace's pins come in the pins root's order, limited by scope, with a
    /// pinned folder followed by the favorites inside it, at any depth.
    #[test]
    fn pins_list_a_workspaces_row_in_order_with_folder_contents() {
        use crate::store::DeviceId;
        let by = DeviceId::from_bytes([1; 16]);
        let mut doc = Document::new();
        let add = |doc: &mut Document, kind, guid: &str, parent, name: &str, url: Option<&str>| {
            doc.add_favorite(
                kind,
                guid,
                parent,
                None,
                None,
                name,
                url.map(Into::into),
                by,
                1,
            )
        };
        let favorites = add(&mut doc, NodeKind::Folder, "toolbar_____", None, "", None);
        let root = add(&mut doc, NodeKind::Folder, "pins________", None, "", None);
        add(
            &mut doc,
            NodeKind::Favorite,
            "mail00000000",
            Some(root),
            "Mail",
            Some("https://mail.example/"),
        );
        let tools = add(
            &mut doc,
            NodeKind::Folder,
            "tools0000000",
            Some(root),
            "Tools",
            None,
        );
        let inner = add(
            &mut doc,
            NodeKind::Folder,
            "inner0000000",
            Some(tools),
            "Inner",
            None,
        );
        add(
            &mut doc,
            NodeKind::Favorite,
            "deep00000000",
            Some(inner),
            "Deep",
            Some("https://deep.example/"),
        );
        add(
            &mut doc,
            NodeKind::Favorite,
            "first0000000",
            Some(tools),
            "First",
            Some("https://first.example/"),
        );
        let work = add(
            &mut doc,
            NodeKind::Favorite,
            "work00000000",
            Some(root),
            "Work",
            Some("https://work.example/"),
        );
        add(
            &mut doc,
            NodeKind::Favorite,
            "script000000",
            Some(root),
            "Script",
            Some("javascript:alert(1)"),
        );
        add(
            &mut doc,
            NodeKind::Favorite,
            "plain0000000",
            Some(favorites),
            "Plain",
            Some("https://plain.example/"),
        );
        doc.set_pin_scope(
            work,
            Some(["work".to_string()].into_iter().collect()),
            by,
            6,
        );
        let pins = SvalDocument(Mutex::new(doc));
        let names = |workspace: &str| -> Vec<(String, Option<String>)> {
            pins.pins(workspace.into(), vec!["work".into(), "home".into()])
                .into_iter()
                .map(|pin| (pin.name, pin.folder))
                .collect()
        };
        let tools_id = Some(tools.to_string());
        assert_eq!(
            names("home"),
            [
                ("Mail".into(), None),
                ("Tools".into(), None),
                ("Deep".into(), tools_id.clone()),
                ("First".into(), tools_id.clone()),
            ],
            "Inner sits before First, so Deep comes first; Work is limited to work, \
             the bookmarklet has no tile, and a favorite outside the pins root is no pin"
        );
        assert_eq!(names("work").len(), 5, "Work shows in work");
        let kinds: Vec<_> = pins
            .pins("home".into(), vec![])
            .into_iter()
            .map(|pin| (pin.name, pin.kind))
            .collect();
        assert_eq!(kinds[0], ("Mail".into(), "favorite".into()));
        assert_eq!(kinds[1], ("Tools".into(), "folder".into()));
    }

    /// A pinned folder's favorites are listed down to the depth the walk
    /// stops at, and no deeper.
    #[test]
    fn pins_stop_at_the_folder_depth_limit() {
        use crate::store::DeviceId;
        let by = DeviceId::from_bytes([1; 16]);
        let mut doc = Document::new();
        let root = doc.add_favorite(
            NodeKind::Folder,
            crate::types::PINS_GUID,
            None,
            None,
            None,
            "",
            None,
            by,
            1,
        );
        let mut folder = doc.add_favorite(
            NodeKind::Folder,
            "top000000000",
            Some(root),
            None,
            None,
            "Top",
            None,
            by,
            1,
        );
        for depth in 1..=32 {
            folder = doc.add_favorite(
                NodeKind::Folder,
                &format!("fold{depth:08}"),
                Some(folder),
                None,
                None,
                format!("Folder {depth}"),
                None,
                by,
                1,
            );
            doc.add_favorite(
                NodeKind::Favorite,
                &format!("page{depth:08}"),
                Some(folder),
                None,
                None,
                format!("Page {depth}"),
                Some(format!("https://{depth}.example/")),
                by,
                1,
            );
        }
        let pins = SvalDocument(Mutex::new(doc));
        let names: Vec<_> = pins
            .pins("home".into(), vec![])
            .into_iter()
            .map(|pin| pin.name)
            .collect();
        assert!(names.contains(&"Page 31".to_string()), "{names:?}");
        assert!(!names.contains(&"Page 32".to_string()), "{names:?}");
    }

    #[test]
    fn a_saved_copy_loads_back_as_it_was() {
        let phone = SvalDocument::new();
        phone
            .sync(
                KEY.to_vec(),
                PHONE.to_vec(),
                "workspaces".into(),
                vec![desktop_publish()],
                3_000.0,
                true,
            )
            .unwrap();
        let saved = phone.to_json().unwrap();
        let loaded = SvalDocument::load_json(saved.clone()).unwrap();
        assert_eq!(loaded.to_json().unwrap(), saved);
        let names: Vec<_> = loaded.outline().into_iter().map(|row| row.name).collect();
        assert_eq!(names, ["Work", "Docs", "Example"]);
    }

    /// A phone names a visit it added by `visit_id` to give it the title its
    /// page loads later.
    #[test]
    fn a_visit_named_by_its_id_takes_a_title() {
        let phone = SvalDocument::new();
        let add =
            r#"[{"kind":"addVisit","url":"https://a.example/","transition":1,"visitedAt":10.0}]"#;
        phone.apply_batch(add.into(), PHONE.to_vec(), 20.0).unwrap();
        let id = visit_id(PHONE.to_vec(), "https://a.example/".into(), 10.0).unwrap();
        let title = format!(r#"[{{"kind":"setVisitTitle","id":"{id}","title":"A page"}}]"#);
        phone.apply_batch(title, PHONE.to_vec(), 30.0).unwrap();
        let visits: serde_json::Value =
            serde_json::from_str(&phone.visits_json().unwrap()).unwrap();
        assert_eq!(visits[0]["id"], id);
        assert_eq!(visits[0]["title"], "A page");
        assert_eq!(visits[0]["url"], "https://a.example/");
    }

    #[test]
    fn a_phone_lists_the_history_weeks_newest_first() {
        let phone = SvalDocument::new();
        let ops = r#"[{"kind":"touchShard","name":"history-2026-W41"},
                      {"kind":"touchShard","name":"history-2026-W42"}]"#;
        phone.apply_batch(ops.into(), PHONE.to_vec(), 20.0).unwrap();
        let shards: serde_json::Value =
            serde_json::from_str(&phone.shards_json().unwrap()).unwrap();
        assert_eq!(shards[0]["name"], "history-2026-W42");
        assert_eq!(shards[1]["name"], "history-2026-W41");
        assert_eq!(shards[1]["changedAt"], 20);
    }

    /// A phone adding a favorite to a folder it adds in the same batch names
    /// the folder by `favorite_id`.
    #[test]
    fn a_favorite_added_under_a_folder_named_by_its_guid_lands_in_it() {
        let phone = SvalDocument::new();
        let toolbar = favorite_id("toolbar_____".into());
        let ops = format!(
            r#"[{{"kind":"addFavorite","favoriteKind":"folder","guid":"toolbar_____","name":""}},
               {{"kind":"addFavorite","favoriteKind":"favorite","guid":"mail00000000",
                 "parent":"{toolbar}","name":"Mail","url":"https://mail.example/"}}]"#
        );
        phone.apply_batch(ops, PHONE.to_vec(), 20.0).unwrap();
        let rows: serde_json::Value =
            serde_json::from_str(&phone.favorites_json().unwrap()).unwrap();
        assert_eq!(rows[0]["id"], toolbar);
        assert_eq!(rows[1]["name"], "Mail");
        assert_eq!(rows[1]["parent"], toolbar);
    }

    /// The folder holds what cloud clients write beside a device's file, and
    /// none of it is a device's state.
    #[test]
    fn only_a_devices_own_file_is_a_device_file() {
        let file = desktop_publish();
        let prefix = sync_prefix(KEY.to_vec(), "workspaces".into()).unwrap();
        let conflict = file.path.replace(".json", " (1).json");
        for path in [
            conflict,
            format!("{prefix}/.DS_Store"),
            format!("{prefix} (1)/{}", file.path.rsplit('/').next().unwrap()),
        ] {
            assert!(
                !is_device_file(KEY.to_vec(), "workspaces".into(), path.clone()).unwrap(),
                "{path}"
            );
        }
    }

    #[test]
    fn the_engine_version_is_the_engines_own() {
        assert_eq!(engine_version(), crate::ENGINE_VERSION);
    }
}
