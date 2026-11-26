// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Moving a profile's pins into the pins root (pins-root spec §8).
//!
//! A profile written before the pins root marks a pin with
//! `Lifecycle::pinned` and orders the row by `Lifecycle::home_order`. The
//! pass moves each marked node into the pins root in that order and clears
//! both fields. Every device runs it, so it makes the same moves and the
//! same copies, at the same ids, from the same document: two devices that
//! run it at once merge to one result.

use std::collections::BTreeSet;

use uuid::Uuid;

use crate::store::DeviceId;
use crate::tree::{children, move_node};
use crate::types::{Document, FAVORITE_NAMESPACE, Node, NodeId, PINS_GUID, Timestamp, favorite_id};

/// The guid of the pins row's copy of the favorite or folder whose guid is
/// `guid`: twelve URL-safe base64 characters of a UUIDv5 of it, so every
/// device mints the same one and two copies merge to one node.
pub fn pin_copy_guid(guid: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let name = format!("pin-copy:{guid}");
    let bytes = Uuid::new_v5(&FAVORITE_NAMESPACE, name.as_bytes()).into_bytes();
    // Nine bytes are 72 bits, exactly twelve characters of six bits.
    let mut bits: u128 = 0;
    for b in &bytes[..9] {
        bits = (bits << 8) | u128::from(*b);
    }
    (0..12)
        .rev()
        .map(|i| char::from(ALPHABET[((bits >> (i * 6)) & 63) as usize]))
        .collect()
}

/// Moves every node marked `pinned` into the pins root, in `home_order`
/// order, at the end of the row, keeping its guid (pins-root spec §8). A
/// pinned folder moves with its contents. A node marked inside a pinned
/// folder stays there, and the row gets a copy of it at [`pin_copy_guid`].
/// `pinned` and `home_order` are cleared on every marked node, and the copy
/// takes the scope the marked node held, since a pin inside a folder has
/// none of its own (pins spec §7).
///
/// Each write is stamped one past the newest stamp of the node it rewrites,
/// never with the clock (an exception to the engine's rule 10). A device
/// can run the pass long after a peer did, on a copy older than the peer's.
/// A clock stamp would let that device's rewrite of the old state beat
/// every edit the peer made to its row since, and would make a copy the
/// peer deleted news again. Stamps read from the document also keep two
/// devices' passes alike.
///
/// Returns whether anything changed. A no-op with no node marked, or with
/// no pins root to move into.
pub fn move_pins_to_root(doc: &mut Document, by: DeviceId) -> bool {
    let root = favorite_id(PINS_GUID);
    if doc.node(root).is_none() {
        return false;
    }
    let mut marked: Vec<(Option<String>, NodeId)> = doc
        .nodes
        .iter()
        .filter(|(_, n)| n.kind.is_favorite_kind() && n.lifecycle.pinned)
        .map(|(id, n)| (n.lifecycle.home_order.clone(), *id))
        .collect();
    if marked.is_empty() {
        return false;
    }
    // A fractional index's string form sorts as the index does. A node with
    // no place in the row goes after those with one.
    marked.sort_by(|(a, x), (b, y)| (a.is_none(), a, x).cmp(&(b.is_none(), b, y)));
    let set: BTreeSet<NodeId> = marked.iter().map(|(_, id)| *id).collect();
    let inside: BTreeSet<NodeId> = set
        .iter()
        .copied()
        .filter(|&id| has_marked_ancestor(doc, id, &set))
        .collect();

    for (_, id) in &marked {
        let last = children(doc, root).last().copied();
        if inside.contains(id) {
            copy_into(doc, *id, root, last, by);
        } else if let Some(at) = doc.node(*id).map(after_newest) {
            // A refused move leaves the node where it is, still a favorite.
            let _ = move_node(doc, *id, root, last, None, by, at);
        }
    }
    for id in &set {
        let Some(at) = doc.node(*id).map(after_newest) else {
            continue;
        };
        if let Some(node) = doc.node_mut(*id) {
            node.lifecycle.pinned = false;
            node.lifecycle.home_order = None;
            if inside.contains(id) {
                node.lifecycle.pin_scope = None;
            }
            node.lifecycle_at = at;
            node.lifecycle_by = Some(by);
        }
    }
    true
}

/// One past the newest of `node`'s fact stamps, the stamp the pass writes
/// over that node with.
fn after_newest(node: &Node) -> Timestamp {
    [
        node.content_at,
        node.placement_at,
        node.lifecycle_at,
        node.appearance_at,
        node.touched_at,
    ]
    .into_iter()
    .max()
    .unwrap_or_default()
        + 1
}

/// Whether a strict ancestor of `id` is in `marked`. The walk stops at a
/// cycle a merge left.
fn has_marked_ancestor(doc: &Document, id: NodeId, marked: &BTreeSet<NodeId>) -> bool {
    let mut at = doc.node(id).and_then(|n| n.placement.parent);
    for _ in 0..doc.nodes.len() {
        match at {
            Some(p) if marked.contains(&p) => return true,
            Some(p) => at = doc.node(p).and_then(|n| n.placement.parent),
            None => return false,
        }
    }
    false
}

/// Copies `id` and everything in it under `parent`, after `before`, each
/// copy at the [`pin_copy_guid`] of what it copies, with its content and
/// the scope of the node it copies, stamped [`after_newest`] that node.
fn copy_into(doc: &mut Document, id: NodeId, parent: NodeId, before: Option<NodeId>, by: DeviceId) {
    let Some(node) = doc.node(id) else {
        return;
    };
    let now = after_newest(node);
    let Some(guid) = node.content.guid.clone() else {
        return;
    };
    let kind = node.kind.clone();
    let content = node.content.clone();
    let scope = node.lifecycle.pin_scope.clone();
    let copy_guid = pin_copy_guid(&guid);
    let copy = doc.add_favorite(
        kind,
        &copy_guid,
        Some(parent),
        before,
        None,
        content.name.clone(),
        content.url.clone(),
        by,
        now,
    );
    if let Some(n) = doc.node_mut(copy) {
        n.content = crate::types::Content {
            guid: Some(copy_guid),
            ..content
        };
        n.lifecycle.pin_scope = scope;
    }
    let mut last = None;
    for child in children(doc, id) {
        copy_into(doc, child, copy, last, by);
        last = children(doc, copy).last().copied();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NodeKind;
    use crate::types::test_support::dev_a;

    /// The pass's stamp is past every fact of the node it rewrites, so it
    /// never meets that node's own state in a tie.
    #[test]
    fn the_pass_stamps_past_the_nodes_newest_fact() {
        let mut doc = Document::new();
        let id = doc.add_favorite(
            NodeKind::Folder,
            PINS_GUID,
            None,
            None,
            None,
            "",
            None,
            dev_a(),
            5,
        );
        let node = doc.node_mut(id).unwrap();
        node.placement_at = 40;
        node.lifecycle_at = 30;
        assert_eq!(after_newest(doc.node(id).unwrap()), 41);
    }

    /// The copy's guid is a fixed function of the guid it copies, so every
    /// device mints the same one, and it is a guid a host accepts.
    #[test]
    fn a_copys_guid_is_pinned_and_a_valid_guid() {
        let copy = pin_copy_guid("pinXXXXXXXXX");
        assert_eq!(copy, "nscnDmyrWfC6");
        assert_eq!(copy.len(), 12);
        assert!(
            copy.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_ne!(pin_copy_guid("pinYYYYYYYYY"), copy);
    }
}
