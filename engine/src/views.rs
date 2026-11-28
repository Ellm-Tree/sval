// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! What a host reads from a document: its visits, history shards,
//! settings, favorites and Archive entries as JSON, with the field names a
//! host is promised.

use crate::failure::Failure;
use crate::types::{Document, NodeKind, Timestamp};
use serde::Serialize;

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
pub(crate) fn visits_json(doc: &Document) -> Result<String, Failure> {
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
pub(crate) fn shards_json(doc: &Document) -> Result<String, Failure> {
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

/// [`Document::settings`] as a JSON object, `null` for a reset.
#[cfg(any(feature = "wasm", test))]
pub(crate) fn settings_json(doc: &Document) -> Result<String, Failure> {
    Ok(serde_json::to_string(&doc.settings())?)
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
    /// Whether its address stays on this device.
    local: bool,
}

/// Every favorite, folder and separator, ordered by parent and then by
/// order among siblings, so a host reads each folder's children in order.
pub(crate) fn favorites_json(doc: &Document) -> Result<String, Failure> {
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

/// One Archive entry, as a host reads it (idle-tab archive spec §6.2).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(any(feature = "wasm", test))]
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
    /// Whether its address stays on this device.
    local: bool,
}

/// Every entry in the Archive, newest first, a split's panes in their order.
#[cfg(any(feature = "wasm", test))]
pub(crate) fn archived_json(doc: &Document, now: Timestamp) -> Result<String, Failure> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::apply_batch;
    use crate::store::DeviceId as StoreDeviceId;
    use crate::types::NodeId;
    use crate::types::test_support::test_device;

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
}
