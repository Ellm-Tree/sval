// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Merge: UUID match, per-fact-group timestamps, canonical-form tiebreak,
//! and a version vector that tells a deletion from a node never seen.

use crate::store::DeviceId;
use crate::types::{AgentMark, Document, Node, NodeId, Timestamp};
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// Whether `node` carries anything `seen` has not already incorporated. The
/// absence rule asks this of whichever side *lacks* the node (spec §5.4).
/// Every fact group is consulted, via [`Node::attributions`], so a node whose
/// only unseen fact is a recolour is still news.
///
/// A group is news unless the lacking side has incorporated a file from
/// **that group's own writer**, written at or after the group's timestamp.
/// Such a file carried the node, so a side that read it and lacks the node
/// deleted it. Judging by the writer's watermark keeps a node one device
/// created offline from reading as a deletion to a third device that never
/// saw it (decision 0015).
///
/// Any one group being news keeps the node, and a group with a timestamp but
/// no writer is news (decisions 0016, 0017). A wrongly kept node is a visible
/// nuisance; a wrongly dropped one is silent data loss.
///
/// **A group never written is skipped** (spec §5.4): it has no timestamp to
/// check a watermark against. Every node a build wrote before a group was
/// added to the model lacks that group, and reading it as unattributed would
/// make every such node undeletable.
///
/// **Never written means no timestamp *and* no writer.** `at == 0` with a
/// writer is a real fact, such as a seed, and its provenance is checkable.
///
/// **Skipping must never empty the test.** A node with every group unwritten
/// is one about which nothing is known, and nothing is deleted on a watermark
/// that cannot be checked, so it is news. A pre-attribution file can produce
/// this shape.
///
/// The predicate depends only on the node and the lacking side's vector, so
/// both halves of the absence rule compute the same answer and the merge
/// converges (spec §5.4).
///
/// `unheld`, a device and a time, marks that device's stamps before that time
/// as news to the lacking side whatever its watermark says: the side is a
/// copy that began then under that id, and has not held them (decision
/// 2232).
fn is_news_to(
    node: &Node,
    seen: &BTreeMap<DeviceId, Timestamp>,
    unheld: Option<(DeviceId, Timestamp)>,
) -> bool {
    let attributions = node.attributions();
    let mut written = attributions
        .iter()
        .filter(|&&(by, at)| !(at == 0 && by.is_none()))
        .peekable();
    if written.peek().is_none() {
        return true;
    }
    written.any(|&(by, at)| match by {
        None => true,
        Some(writer) => {
            unheld.is_some_and(|(device, began)| device == writer && at < began)
                || seen.get(&writer).is_none_or(|&watermark| watermark < at)
        }
    })
}

/// Canonical serialised bytes of a fact group, for the exact-timestamp-tie
/// fallback in [`remote_group_wins`].
///
/// Goes through `serde_json::Value`. Serialising a struct emits fields in
/// declaration order, then any flattened map, so a build that knows a field
/// and one that keeps it in `extra` would order the same record differently
/// and pick opposite tie-break winners. `Value`'s object map is a `BTreeMap`
/// (this crate does not enable serde_json's `preserve_order` feature), so
/// its keys come out in byte order on every build.
///
/// The bytes are written by [`write_canonical`], because serde_json's own
/// text is free to change between releases.
///
/// `to_value` fails on a map whose keys are not strings, and every type
/// passed here (the fact groups, `Value`, [`AgentMark`]) derives `Serialize`
/// and keys its maps by `String`.
fn canonical_bytes<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let value = serde_json::to_value(value).expect("a fact group serialises to a JSON value");
    let mut out = Vec::new();
    write_canonical(&value, &mut out);
    out
}

/// Writes `value` in Sval's canonical encoding (spec §5.3): JSON, except that
/// strings escape only `"`, `\` and control characters (as `\u00xx`), and a
/// number that is not an integer is `f` and the 16 hex digits of its IEEE 754
/// bits. Object keys are in byte order. Every rule is this function's own, so
/// the tie-break cannot move when a dependency changes how it prints floats.
fn write_canonical(value: &serde_json::Value, out: &mut Vec<u8>) {
    use serde_json::Value;
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(n) => {
            let text = if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(i) = n.as_i64() {
                i.to_string()
            } else {
                // Without `arbitrary_precision`, every other number is an f64.
                n.as_f64()
                    .map_or_else(|| n.to_string(), |f| format!("f{:016x}", f.to_bits()))
            };
            out.extend_from_slice(text.as_bytes());
        }
        Value::String(text) => write_canonical_string(text, out),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            out.push(b'{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical_string(key, out);
                out.push(b':');
                write_canonical(item, out);
            }
            out.push(b'}');
        }
    }
}

fn write_canonical_string(text: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for c in text.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            c if c < ' ' => out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes()),
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

/// Whether the remote side of one fact group should replace the local side.
/// A strictly later `at` wins. An exact tie compares the group's canonical
/// bytes (spec §5.3).
///
/// Call sites pass the group **paired with its writer**, so the total order is
/// `(at, canonical group bytes, writer)`. Two different JSON objects differ
/// before either ends, so the writer decides only between byte-identical
/// values. Without it, two devices holding the same value at the same
/// timestamp from different writers would each keep their own attribution
/// and never converge.
///
/// `None` serialises as `null` and a writer as a quoted string, and
/// `'n' > '"'`, so on a byte-identical tie an *unattributed* writer wins.
/// That is symmetric, so convergence holds, but merging an old file can strip
/// a group's attribution: one route to a group with neither timestamp nor
/// writer, which [`is_news_to`] keeps.
fn remote_group_wins<T: serde::Serialize>(
    remote_at: Timestamp,
    remote_value: &T,
    local_at: Timestamp,
    local_value: &T,
) -> bool {
    match remote_at.cmp(&local_at) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => canonical_bytes(remote_value) > canonical_bytes(local_value),
    }
}

/// Merges `remote`'s unknown fields into `local`'s, per key, for the two
/// levels that have no timestamp of their own: the document
/// ([`Document::extra`]) and the node ([`Node::extra`], where a fact group
/// this build does not know lands).
///
/// With no timestamp to break a conflict, the greater canonical bytes win.
/// That is a `max` over a total order, so it is commutative, associative and
/// idempotent, and both devices land on the same value whichever merged into
/// which.
fn merge_untimestamped_extra(
    local: &mut std::collections::BTreeMap<String, serde_json::Value>,
    remote: &std::collections::BTreeMap<String, serde_json::Value>,
) {
    for (key, remote_value) in remote {
        match local.get(key) {
            None => {
                local.insert(key.clone(), remote_value.clone());
            }
            Some(local_value) => {
                if canonical_bytes(remote_value) > canonical_bytes(local_value) {
                    local.insert(key.clone(), remote_value.clone());
                }
            }
        }
    }
}

/// The agent mark is set once and never edited, so the sides normally agree.
/// When one side lacks it, the mark is adopted. When both carry different marks,
/// the greater canonical bytes win, the same `max` over a total order as
/// `merge_untimestamped_extra`, so both devices land on one value.
fn merge_agent_mark(local: &mut Option<AgentMark>, remote: &Option<AgentMark>) {
    let Some(remote_mark) = remote else { return };
    let take = match local {
        None => true,
        Some(local_mark) => canonical_bytes(remote_mark) > canonical_bytes(local_mark),
    };
    if take {
        *local = Some(remote_mark.clone());
    }
}

/// Replaces one local fact group, with its timestamp and writer, by the
/// remote one when [`remote_group_wins`] says so.
pub(crate) fn merge_fact<T: Clone + serde::Serialize>(
    local: (&mut T, &mut Timestamp, &mut Option<DeviceId>),
    remote: (&T, Timestamp, Option<DeviceId>),
) {
    let (value, at, by) = local;
    let (remote_value, remote_at, remote_by) = remote;
    if remote_group_wins(remote_at, &(remote_value, remote_by), *at, &(&*value, *by)) {
        *value = remote_value.clone();
        *at = remote_at;
        *by = remote_by;
    }
}

/// Merge `remote` into `local`, per spec §5.3.
///
/// Objects are matched by UUID. **Each fact group is decided
/// independently**: the side with the strictly later timestamp for *that
/// group* wins it, and an exact tie goes by `remote_group_wins`. Groups are
/// never compared with each other, so a rename on one device survives an
/// unrelated pin, move or recolour on another (spec §5.1).
///
/// `kind` cannot change once a node exists, so it is not merged. Each group's
/// unrecognised-field bucket (`Content::extra` and its siblings) travels with
/// the group, because the whole group struct is replaced when it wins
/// (spec §5.1). Document-level `extra` and a node's own `Node::extra` have no
/// timestamp this build can read, so they merge by
/// `merge_untimestamped_extra`.
///
/// **A node present on one side only is kept exactly when it is news to the
/// side that lacks it** (`is_news_to`, spec §5.4). Closing a tab deletes the
/// record and no server holds tombstones, so the evidence is in the files:
/// [`Document::seen`] records the `written_at` of the newest file
/// incorporated from each peer, and each group records its last writer.
///
/// - **present in `remote`, absent locally: adopt iff it is news to us.**
///   Otherwise we had incorporated every group from its writer and do not
///   hold the node, so we deleted it.
/// - **present locally, absent from `remote`: drop iff it is not news to
///   them.** They had incorporated every group and do not hold it, so they
///   deleted it.
///
/// Both halves evaluate the same predicate about the lacking side, so both
/// devices agree on every single-sided node whichever way the merge runs.
///
/// **A missing watermark or attribution is not evidence**: the node is news
/// and stays. So a returning device that edited a node someone else has
/// since deleted brings it back with its edit, the one case where a delete
/// is undone (spec §5.4).
///
/// **Our own stored file is exempt from the drop half.** Merging it is how
/// [`crate::sync::sync_to`] recovers what this device wrote before a
/// restore-from-backup rolled its document back, and its `seen[me]` keeps it
/// from re-inserting what we deleted since. A node we hold and it lacks was
/// added since that write, so the drop half has nothing to conclude.
///
/// **Does not repair unreachable ancestry** (a cycle, or a node whose parent
/// has been deleted). [`crate::tree::repair_unreachable_ancestry`] does, on
/// the read path only.
pub fn merge(local: &mut Document, remote: &Document) {
    merge_unheld(local, remote, None);
}

/// [`merge`], with `unheld` naming a device whose stamps before a time
/// `local` never held, though its watermark covers them: `local` began then,
/// empty, under that device's id, and `remote` holds that id's earlier
/// writes (decision 2232). Those stamps are news to `local`, so what `remote`
/// holds of them is kept. Only the half that asks what is news to `local`
/// reads it; what is news to `remote` is decided as in [`merge`].
pub fn merge_unheld(
    local: &mut Document,
    remote: &Document,
    unheld: Option<(DeviceId, Timestamp)>,
) {
    merge_untimestamped_extra(&mut local.extra, &remote.extra);

    // `local.seen` is read below before it is advanced: this merge's verdicts
    // are about what each side knew coming in.
    let own_file = remote.written_by.is_some() && remote.written_by == local.written_by;

    if !own_file {
        let deleted_by_the_peer: Vec<NodeId> = local
            .nodes
            .iter()
            .filter(|(id, node)| {
                !remote.nodes.contains_key(*id) && !is_news_to(node, &remote.seen, None)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in deleted_by_the_peer {
            local.nodes.remove(&id);
        }
    }

    for (id, remote_node) in &remote.nodes {
        match local.nodes.get_mut(id) {
            None => {
                if is_news_to(remote_node, &local.seen, unheld) {
                    local.nodes.insert(*id, remote_node.clone());
                }
            }
            Some(local_node) => {
                // Every field is named and there is no `..`, so a field added
                // to `Node` stops this compiling until it has a merge rule.
                let Node {
                    kind: _,
                    content,
                    content_at,
                    content_by,
                    placement,
                    placement_at,
                    placement_by,
                    lifecycle,
                    lifecycle_at,
                    lifecycle_by,
                    appearance,
                    appearance_at,
                    appearance_by,
                    touched_at,
                    touched_by,
                    agent,
                    extra,
                } = local_node;
                merge_fact(
                    (content, content_at, content_by),
                    (
                        &remote_node.content,
                        remote_node.content_at,
                        remote_node.content_by,
                    ),
                );
                merge_fact(
                    (placement, placement_at, placement_by),
                    (
                        &remote_node.placement,
                        remote_node.placement_at,
                        remote_node.placement_by,
                    ),
                );
                merge_fact(
                    (lifecycle, lifecycle_at, lifecycle_by),
                    (
                        &remote_node.lifecycle,
                        remote_node.lifecycle_at,
                        remote_node.lifecycle_by,
                    ),
                );
                merge_fact(
                    (appearance, appearance_at, appearance_by),
                    (
                        &remote_node.appearance,
                        remote_node.appearance_at,
                        remote_node.appearance_by,
                    ),
                );

                // The touch stamp holds no value, so it merges as a group
                // whose content is always equal: the later stamp wins, and a
                // tie is settled by the writer.
                merge_fact(
                    (&mut (), touched_at, touched_by),
                    (&(), remote_node.touched_at, remote_node.touched_by),
                );

                merge_agent_mark(agent, &remote_node.agent);
                merge_untimestamped_extra(extra, &remote_node.extra);
            }
        }
    }

    // The version vector merges per peer by taking the greater, so knowledge
    // travels transitively: a phone learns from the desktop that the laptop's
    // older file is already incorporated. Then this file's own write, which
    // this merge incorporates.
    for (device, at) in &remote.seen {
        let entry = local.seen.entry(*device).or_insert(*at);
        *entry = (*entry).max(*at);
    }
    if let Some(peer) = remote.written_by {
        let entry = local.seen.entry(peer).or_insert(remote.written_at);
        *entry = (*entry).max(remote.written_at);
    }
}

#[cfg(test)]
mod tests {
    use super::merge;
    use crate::store::DeviceId;
    use crate::tree;
    use crate::types::test_support::{
        base_doc, other_peer, peer_with_changes, shared_state, test_device, ws_of,
    };
    use crate::types::{Document, Timestamp};

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 16])
    }

    #[test]
    fn two_devices_first_setting_one_key_converge_on_one_node() {
        let (a_dev, b_dev) = (device(0xa), device(0xb));
        let mut a = Document::new();
        a.set_setting("k", Some(serde_json::json!("from-a")), a_dev, 100);
        let mut b = Document::new();
        b.set_setting("k", Some(serde_json::json!("from-b")), b_dev, 100);

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(forward.nodes.len(), 1);
        assert_eq!(shared_state(&forward), shared_state(&backward));
    }

    #[test]
    fn a_reset_beats_an_older_value_and_loses_to_a_newer_one() {
        let (a_dev, b_dev) = (device(0xa), device(0xb));
        let mut older = Document::new();
        older.set_setting("k", Some(serde_json::json!(1)), a_dev, 100);
        let mut reset = Document::new();
        reset.set_setting("k", None, b_dev, 200);
        let mut newer = Document::new();
        newer.set_setting("k", Some(serde_json::json!(3)), a_dev, 300);

        let mut x = older.clone();
        merge(&mut x, &reset);
        assert_eq!(x.settings()["k"], None);

        let mut y = reset.clone();
        merge(&mut y, &newer);
        assert_eq!(y.settings()["k"], Some(serde_json::json!(3)));
    }

    #[test]
    fn a_seed_at_zero_loses_to_any_real_change() {
        let (a_dev, b_dev) = (device(0xa), device(0xb));
        let mut seeded = Document::new();
        seeded.set_setting("k", Some(serde_json::json!("seed")), a_dev, 0);
        let mut changed = Document::new();
        changed.set_setting("k", Some(serde_json::json!("real")), b_dev, 1);

        merge(&mut seeded, &changed);
        assert_eq!(seeded.settings()["k"], Some(serde_json::json!("real")));
    }

    /// Sides whose marks differ still agree on one value.
    #[test]
    fn differing_agent_marks_converge_either_direction() {
        let id = crate::types::test_support::test_id();
        let by = test_device();
        let mut a = Document::new();
        a.add_agent_workspace("W", "Claude Code", id, by, 10);
        let mut b = Document::new();
        b.add_agent_workspace("W", "Codex", id, by, 10);

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().agent,
            backward.node(id).unwrap().agent
        );
        assert_eq!(shared_state(&forward), shared_state(&backward));
        // The winner is pinned so every build agrees on it: the greater
        // canonical bytes, and "Codex" sorts after "Claude Code".
        assert_eq!(
            forward.node(id).unwrap().agent.as_ref().unwrap().label,
            "Codex"
        );
    }

    #[test]
    fn a_side_without_the_mark_adopts_it() {
        let id = crate::types::test_support::test_id();
        let by = test_device();
        let mut marked = Document::new();
        marked.add_agent_workspace("W", "Claude Code", id, by, 10);
        let mut plain = marked.clone();
        plain.nodes.get_mut(&id).unwrap().agent = None;

        merge(&mut plain, &marked);
        assert_eq!(
            plain.node(id).unwrap().agent,
            marked.node(id).unwrap().agent
        );
    }

    /// Two peers of [`base_doc`] that have each published once at `at` and
    /// incorporated the other's write. Absence means something only from this
    /// state (spec §5.4).
    fn two_current_peers(at: Timestamp) -> (Document, Document, DeviceId, DeviceId) {
        let (dev_a, dev_b) = (
            DeviceId::from_bytes([0xa; 16]),
            DeviceId::from_bytes([0xb; 16]),
        );
        let (mut a, mut b) = (base_doc(), base_doc());
        a.stamp_write(dev_a, at);
        b.stamp_write(dev_b, at);
        a.seen.insert(dev_b, at);
        b.seen.insert(dev_a, at);
        (a, b, dev_a, dev_b)
    }

    #[test]
    fn adds_from_both_sides_survive() {
        let (mut a, mut b) = (base_doc(), base_doc());
        let ta = a.add_tab(
            ws_of(&a),
            "from A",
            "https://a.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tb = b.add_tab(
            ws_of(&b),
            "from B",
            "https://b.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        merge(&mut a, &b);

        assert!(a.node(ta).is_some(), "local add lost");
        assert!(a.node(tb).is_some(), "remote add lost");
    }

    #[test]
    fn newer_timestamp_wins_per_node() {
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        a.node_mut(id).unwrap().content.name = "older".into();
        a.node_mut(id).unwrap().content_at = 100;
        b.node_mut(id).unwrap().content.name = "newer".into();
        b.node_mut(id).unwrap().content_at = 200;

        merge(&mut a, &b);

        assert_eq!(a.node(id).unwrap().content.name, "newer");
    }

    #[test]
    fn older_remote_does_not_clobber_newer_local() {
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        a.node_mut(id).unwrap().content.name = "newer".into();
        a.node_mut(id).unwrap().content_at = 200;
        b.node_mut(id).unwrap().content.name = "older".into();
        b.node_mut(id).unwrap().content_at = 100;

        merge(&mut a, &b);

        assert_eq!(a.node(id).unwrap().content.name, "newer");
    }

    #[test]
    fn equal_content_at_breaks_on_content_not_arrival_order() {
        // Two edits within one clock tick. Neither is later, so both merge
        // directions must pick the same winner.
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        a.node_mut(id).unwrap().content.name = "A".into();
        a.node_mut(id).unwrap().content_at = 1_000;
        b.node_mut(id).unwrap().content.name = "B".into();
        b.node_mut(id).unwrap().content_at = 1_000;

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().content.name,
            backward.node(id).unwrap().content.name,
            "a tie must resolve to the same winner regardless of merge direction"
        );
    }

    #[test]
    fn a_per_group_tie_resolves_identically_in_both_merge_directions() {
        // Every group ties at once, on different values each side. Both merge
        // directions must agree on every winner (spec §5.3).
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);

        a.node_mut(id).unwrap().content.name = "Alpha".into();
        a.node_mut(id).unwrap().content_at = 1_000;
        b.node_mut(id).unwrap().content.name = "Bravo".into();
        b.node_mut(id).unwrap().content_at = 1_000;

        let other_parent_a = a.add_group(
            id,
            "shelf a",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let other_parent_b = b.add_group(
            id,
            "shelf b",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        a.node_mut(id).unwrap().placement.parent = Some(other_parent_a);
        a.node_mut(id).unwrap().placement_at = 1_000;
        b.node_mut(id).unwrap().placement.parent = Some(other_parent_b);
        b.node_mut(id).unwrap().placement_at = 1_000;

        a.node_mut(id).unwrap().lifecycle.pinned = true;
        a.node_mut(id).unwrap().lifecycle_at = 1_000;
        // b's workspace stays unpinned at the same lifecycle_at, so lifecycle
        // ties on different values.

        a.set_appearance(id, Some("blue".into()), None, None, test_device(), 1_000);
        b.set_appearance(
            id,
            Some("pink".into()),
            Some("🌸".into()),
            None,
            test_device(),
            1_000,
        );

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        let forward_node = forward.node(id).unwrap();
        let backward_node = backward.node(id).unwrap();
        assert_eq!(
            backward_node.content.name, forward_node.content.name,
            "content tie must agree"
        );
        assert_eq!(
            backward_node.placement.parent, forward_node.placement.parent,
            "placement tie must agree"
        );
        assert_eq!(
            backward_node.lifecycle, forward_node.lifecycle,
            "lifecycle tie must agree"
        );
        assert_eq!(
            backward_node.appearance, forward_node.appearance,
            "appearance tie must agree"
        );
    }

    #[test]
    fn a_rename_on_one_device_survives_a_pin_on_another() {
        // Two unrelated acts on one node, a rename (content) and a pin
        // (lifecycle), must both land, whichever is later (spec §5.1).
        let (mut a, mut b) = (base_doc(), base_doc());
        let ws = ws_of(&a);
        let tab = a.add_tab(
            ws,
            "original",
            "https://e.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        a.node_mut(tab).unwrap().content_at = 10;
        a.node_mut(tab).unwrap().placement_at = 10;
        a.node_mut(tab).unwrap().lifecycle_at = 10;
        b.nodes.insert(tab, a.node(tab).unwrap().clone());

        a.node_mut(tab).unwrap().content.name = "renamed on A".into();
        a.node_mut(tab).unwrap().content_at = 100;

        b.node_mut(tab).unwrap().lifecycle.pinned = true;
        b.node_mut(tab).unwrap().lifecycle_at = 200; // later than the rename

        let mut a_sees_b = a.clone();
        merge(&mut a_sees_b, &b);
        let mut b_sees_a = b.clone();
        merge(&mut b_sees_a, &a);

        for (label, doc) in [("a merges b", &a_sees_b), ("b merges a", &b_sees_a)] {
            let merged = doc.node(tab).unwrap();
            assert_eq!(
                merged.content.name, "renamed on A",
                "{label}: the rename must survive an unrelated pin"
            );
            assert!(merged.lifecycle.pinned, "{label}: the pin must land too");
            assert!(tree::children(doc, ws).contains(&tab));
        }
    }

    #[test]
    fn a_tab_label_on_one_device_survives_a_navigation_on_another() {
        // Why a tab's label is appearance (spec §5.1): A renames the tab, and
        // B, which has not seen the label, navigates it later, rewriting its
        // title and address. The label and the navigation must both land.
        let (mut a, mut b) = (base_doc(), base_doc());
        let ws = ws_of(&a);
        let tab = a.add_tab(
            ws,
            "Old page",
            "https://e.example/old",
            crate::types::test_support::test_id(),
            test_device(),
            10,
        );
        b.nodes.insert(tab, a.node(tab).unwrap().clone());
        let other = crate::store::DeviceId::from_bytes([9u8; 16]);

        a.set_label(tab, Some("Mine".into()), test_device(), 100);
        b.set_content(
            tab,
            "New page",
            Some("https://e.example/new".into()),
            None,
            None,
            false,
            other,
            200,
        );

        let mut a_sees_b = a.clone();
        merge(&mut a_sees_b, &b);
        let mut b_sees_a = b.clone();
        merge(&mut b_sees_a, &a);

        for (label, doc) in [("a merges b", &a_sees_b), ("b merges a", &b_sees_a)] {
            let merged = doc.node(tab).unwrap();
            assert_eq!(
                merged.appearance.label.as_deref(),
                Some("Mine"),
                "{label}: the label must survive a later navigation"
            );
            assert_eq!(merged.content.name, "New page", "{label}");
            assert_eq!(
                merged.content.url.as_deref(),
                Some("https://e.example/new"),
                "{label}"
            );
        }
    }

    #[test]
    fn a_recolour_on_one_device_does_not_lose_a_rename_on_another() {
        // Why appearance is its own group (spec §5.1): A renames the workspace,
        // and B, which has not seen the rename, recolours it later. Both acts
        // must land.
        let (mut a, mut b) = (base_doc(), base_doc());
        let ws = ws_of(&a);

        a.node_mut(ws).unwrap().content.name = "renamed on A".into();
        a.node_mut(ws).unwrap().content_at = 100;

        b.set_appearance(
            ws,
            Some("purple".into()),
            Some("🌳".into()),
            None,
            test_device(),
            200, // later than the rename
        );

        let mut a_sees_b = a.clone();
        merge(&mut a_sees_b, &b);
        let mut b_sees_a = b.clone();
        merge(&mut b_sees_a, &a);

        for (label, doc) in [("a merges b", &a_sees_b), ("b merges a", &b_sees_a)] {
            let merged = doc.node(ws).unwrap();
            assert_eq!(
                merged.content.name, "renamed on A",
                "{label}: the rename must survive an unrelated recolour"
            );
            assert_eq!(
                merged
                    .appearance
                    .color
                    .as_ref()
                    .and_then(serde_json::Value::as_str),
                Some("purple"),
                "{label}: the recolour must land too"
            );
            assert_eq!(merged.appearance.emoji.as_deref(), Some("🌳"), "{label}");
        }
    }

    #[test]
    fn appearance_merges_independently_of_placement_and_lifecycle() {
        // A recolours; later, B moves the node and pins it. All three acts must
        // land in both merge directions.
        let (mut a, mut b) = (base_doc(), base_doc());
        let ws = ws_of(&a);
        let shelf = a.add_group(
            ws,
            "shelf",
            None,
            uuid::Uuid::from_u128(60),
            test_device(),
            0,
        );
        let tab = a.add_tab(
            ws,
            "t",
            "https://e.example",
            uuid::Uuid::from_u128(61),
            test_device(),
            10,
        );
        b.nodes.insert(shelf, a.node(shelf).unwrap().clone());
        b.nodes.insert(tab, a.node(tab).unwrap().clone());

        a.set_appearance(
            tab,
            Some("cyan".into()),
            Some("🐟".into()),
            None,
            test_device(),
            100,
        );

        crate::tree::move_node(&mut b, tab, shelf, None, None, test_device(), 200).unwrap();
        b.node_mut(tab).unwrap().lifecycle.pinned = true;
        b.node_mut(tab).unwrap().lifecycle_at = 200;

        let mut a_sees_b = a.clone();
        merge(&mut a_sees_b, &b);
        let mut b_sees_a = b.clone();
        merge(&mut b_sees_a, &a);

        for (label, doc) in [("a merges b", &a_sees_b), ("b merges a", &b_sees_a)] {
            let merged = doc.node(tab).unwrap();
            assert_eq!(
                merged
                    .appearance
                    .color
                    .as_ref()
                    .and_then(serde_json::Value::as_str),
                Some("cyan"),
                "{label}: a later move and pin must not overwrite the recolour"
            );
            assert_eq!(
                merged.placement.parent,
                Some(shelf),
                "{label}: the move must hold"
            );
            assert!(merged.lifecycle.pinned, "{label}: the pin must hold");
        }
    }

    #[test]
    fn an_equal_appearance_timestamp_tiebreaks_on_canonical_bytes() {
        // Two devices recolour within one tick. The tie must resolve the same
        // way in both directions, to the greater canonical bytes of the group:
        // `{"color":"purple"}` > `{"color":"blue"}`.
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        a.set_appearance(id, Some("blue".into()), None, None, test_device(), 1_000);
        b.set_appearance(id, Some("purple".into()), None, None, test_device(), 1_000);

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().appearance,
            backward.node(id).unwrap().appearance,
            "an appearance tie must resolve to the same winner in either direction"
        );
        assert_eq!(
            forward
                .node(id)
                .unwrap()
                .appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("purple"),
            "greater canonical bytes must win the tie"
        );

        // The tie-break compares the group's canonical bytes before the writer:
        // the writer settles only byte-identical values.
        use crate::types::Appearance;
        let blue = Appearance {
            color: Some("blue".into()),
            transparency: None,
            emoji: None,
            label: None,
            extra: Default::default(),
        };
        let purple = Appearance {
            color: Some("purple".into()),
            transparency: None,
            emoji: None,
            label: None,
            extra: Default::default(),
        };
        let low = DeviceId::from_bytes([1u8; 16]);
        let high = DeviceId::from_bytes([2u8; 16]);
        assert!(
            super::remote_group_wins(100, &(&purple, Some(low)), 100, &(&blue, Some(high))),
            "the group's bytes must outrank the writer"
        );
        assert!(
            super::remote_group_wins(100, &(&blue, Some(high)), 100, &(&blue, Some(low))),
            "byte-identical groups must then be settled by the writer"
        );
    }

    #[test]
    fn a_byte_identical_appearance_tie_is_settled_by_the_writer() {
        // The writer leg of `(at, canonical bytes, writer)`. Two devices set
        // the same appearance at the same timestamp. `appearance_by` is shared
        // state, so without the writer in the order each side would keep its
        // own attribution and the documents would never converge.
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        let (low, high) = (
            DeviceId::from_bytes([1u8; 16]),
            DeviceId::from_bytes([2u8; 16]),
        );
        a.set_appearance(id, Some("green".into()), None, None, low, 1_000);
        b.set_appearance(id, Some("green".into()), None, None, high, 1_000);

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().appearance_by,
            backward.node(id).unwrap().appearance_by,
            "a byte-identical appearance tie must settle on one writer in either direction"
        );
        assert_eq!(shared_state(&forward), shared_state(&backward));
    }

    #[test]
    fn a_node_whose_only_news_is_its_appearance_is_still_news() {
        // `is_news_to` reads every group (spec §5.4). The peer has incorporated
        // this node's content, placement and lifecycle, but not its
        // appearance's writer, so the node is news and is adopted.
        let (mut a, mut b, dev_a, _) = two_current_peers(100);
        let painter = DeviceId::from_bytes([0xc; 16]);
        let ws = ws_of(&b);
        let tab = b.add_tab(
            ws,
            "painted",
            "https://e.example",
            uuid::Uuid::from_u128(62),
            dev_a,
            50,
        );
        // A's watermark covers every group but the recolour, whose writer
        // `painter` A has never heard from.
        b.set_appearance(tab, Some("orange".into()), None, None, painter, 50);

        merge(&mut a, &b);

        let adopted = a
            .node(tab)
            .expect("a node whose appearance is news must be adopted");
        assert_eq!(
            adopted
                .appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("orange")
        );

        // The drop half: A holds the node and must not drop it against a peer
        // that cannot account for the recolour's writer either.
        let mut lacking_peer = base_doc();
        lacking_peer.written_by = Some(DeviceId::from_bytes([0xd; 16]));
        lacking_peer.written_at = 400;
        lacking_peer.seen.insert(dev_a, 1_000);
        let mut holder = a.clone();
        merge(&mut holder, &lacking_peer);
        assert!(
            holder.node(tab).is_some(),
            "a node must not be dropped for a peer that cannot account for its \
             appearance's writer"
        );
    }

    #[test]
    fn a_move_on_one_device_survives_a_rename_on_another() {
        // Placement and content are unrelated acts: a later rename must not
        // undo an earlier move.
        let (mut a, mut b) = (base_doc(), base_doc());
        let ws = ws_of(&a);
        let shelf = a.add_group(
            ws,
            "shelf",
            None,
            uuid::Uuid::from_u128(30),
            test_device(),
            0,
        );
        let tab = a.add_tab(
            ws,
            "original",
            "https://e.example",
            uuid::Uuid::from_u128(31),
            test_device(),
            0,
        );
        b.nodes.insert(shelf, a.node(shelf).unwrap().clone());
        b.nodes.insert(tab, a.node(tab).unwrap().clone());

        crate::tree::move_node(&mut a, tab, shelf, None, None, test_device(), 100).unwrap();

        b.node_mut(tab).unwrap().content.name = "renamed on B".into();
        b.node_mut(tab).unwrap().content_at = 200; // later than the move

        merge(&mut a, &b);

        let merged = a.node(tab).unwrap();
        assert_eq!(merged.placement.parent, Some(shelf), "the move must hold");
        assert_eq!(merged.content.name, "renamed on B", "the rename must land");
    }

    // --- the absence rule (spec §5.4) ---------------------------------
    //
    // Each half in isolation. The end-to-end scenarios live in `sync::tests`,
    // driven through the whole sync loop.

    #[test]
    fn a_node_the_peer_deleted_is_dropped_from_our_document() {
        let (mut a, mut b, dev_a, _) = two_current_peers(100);
        let ws = ws_of(&a);
        let tab = a.add_tab(
            ws,
            "t",
            "https://e.example",
            uuid::Uuid::from_u128(40),
            dev_a,
            50,
        );
        b.nodes.insert(tab, a.node(tab).unwrap().clone());

        // B deletes it. B's file records A's state as incorporated at 100,
        // after the tab last changed at 50, so B lacking it is a deletion.
        b.remove(tab);
        merge(&mut a, &b);

        assert!(a.node(tab).is_none(), "the peer's deletion must propagate");
    }

    #[test]
    fn a_watermark_equal_to_the_write_has_seen_it() {
        // The peer's watermark for us reads exactly the instant the tab was
        // written, so the peer had it and lacking it is a deletion.
        let (mut a, b, dev_a, _) = two_current_peers(100);
        let ws = ws_of(&a);
        let tab = a.add_tab(
            ws,
            "t",
            "https://e.example",
            uuid::Uuid::from_u128(42),
            dev_a,
            100,
        );

        merge(&mut a, &b);

        assert!(a.node(tab).is_none(), "the peer's deletion must propagate");
    }

    #[test]
    fn our_own_node_the_peer_has_never_seen_is_kept() {
        let (mut a, b, dev_a, _) = two_current_peers(100);
        let ws = ws_of(&a);
        // Created after B last heard from us, so B's file lacking it is no
        // evidence of a deletion.
        let tab = a.add_tab(
            ws,
            "offline",
            "https://e.example",
            uuid::Uuid::from_u128(41),
            dev_a,
            190,
        );

        merge(&mut a, &b);

        assert!(a.node(tab).is_some(), "our own unsynced node was deleted");
    }

    #[test]
    fn a_node_we_deleted_is_not_re_adopted_from_a_stale_peer() {
        let (mut a, mut b, _, dev_b) = two_current_peers(100);
        let ws = ws_of(&a);
        let tab = b.add_tab(
            ws,
            "t",
            "https://e.example",
            uuid::Uuid::from_u128(42),
            dev_b,
            50,
        );
        a.nodes.insert(tab, b.node(tab).unwrap().clone());

        // We delete it. B's file, which we have incorporated up to its write at
        // 100, still holds it.
        a.remove(tab);
        merge(&mut a, &b);

        assert!(
            a.node(tab).is_none(),
            "a peer file we have already incorporated must not resurrect our deletion"
        );
    }

    #[test]
    fn a_node_the_peer_created_while_we_were_apart_is_adopted() {
        let (mut a, mut b, _, dev_b) = two_current_peers(100);
        let ws = ws_of(&b);
        let tab = b.add_tab(
            ws,
            "theirs",
            "https://e.example",
            uuid::Uuid::from_u128(43),
            dev_b,
            190,
        );

        merge(&mut a, &b);

        assert!(
            a.node(tab).is_some(),
            "a node stamped after our last knowledge of that peer is news, not a deletion"
        );
    }

    #[test]
    fn an_unattributed_node_is_never_dropped() {
        // A file from a build without attribution names no writer, so no
        // watermark can be checked against it. Unattributed is news (spec
        // §5.4).
        let (mut a, mut b, ..) = two_current_peers(100);
        let ws = ws_of(&a);
        let tab = a.add_tab(
            ws,
            "unattributed",
            "https://e.example",
            uuid::Uuid::from_u128(48),
            test_device(),
            10,
        );
        for group in [&mut a, &mut b] {
            if let Some(node) = group.node_mut(tab) {
                node.content_by = None;
                node.placement_by = None;
                node.lifecycle_by = None;
            }
        }
        // The peer's file lacks it and its watermarks cover everything. With
        // attribution this would be a deletion; without it, it must not be.
        b.remove(tab);
        b.seen.insert(test_device(), 1_000);

        merge(&mut a, &b);

        assert!(
            a.node(tab).is_some(),
            "a node with no attribution must never be deleted on a watermark's word"
        );
    }

    #[test]
    fn a_node_from_a_file_without_appearance_is_still_droppable() {
        // Every node a build wrote before the appearance group existed has
        // `appearance_at` 0 and `appearance_by` None. Read as unattributed,
        // such a node would be news to everyone forever and no deletion could
        // propagate. A group nobody has written is skipped, so the groups that
        // carry facts decide (spec §5.4).
        let writer = DeviceId::from_bytes([0xa; 16]);
        let pre_upgrade = r#"{
            "schema": { "major": 1, "minor": 1 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "tab",
                    "content": { "name": "written before colour existed" },
                    "content_at": 50,
                    "content_by": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
                    "placement": { "order": "80" },
                    "placement_at": 50,
                    "placement_by": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
                    "lifecycle": {},
                    "lifecycle_at": 50,
                    "lifecycle_by": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"
                }
            }
        }"#;
        let mut local = Document::from_json(pre_upgrade).expect("a 1.1 file must load");
        let tab = uuid::Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        assert_eq!(
            local.node(tab).unwrap().appearance_at,
            0,
            "test setup: the node must carry no appearance at all"
        );
        assert_eq!(local.node(tab).unwrap().appearance_by, None);

        // A peer that has incorporated everything that writer wrote, and does
        // not have the node: that is a deletion, and it must propagate.
        let mut peer = base_doc();
        peer.written_by = Some(DeviceId::from_bytes([0xb; 16]));
        peer.written_at = 400;
        peer.seen.insert(writer, 300);

        merge(&mut local, &peer);

        assert!(
            local.node(tab).is_none(),
            "a node whose appearance was never written must stay as droppable as \
             it was before the group existed — otherwise every pre-upgrade node \
             is immortal"
        );
    }

    #[test]
    fn an_appearance_written_by_an_unknown_device_is_still_news() {
        // The counterpart of the test above (spec §5.4): a written group is a
        // fact, and if its provenance cannot be checked against a watermark the
        // node stays. Both shapes are asserted: a writer nobody has heard from,
        // and a file that records no writer.
        let checkable = DeviceId::from_bytes([0xa; 16]);
        let painter = DeviceId::from_bytes([0xc; 16]);

        for (label, painted_by) in [("an unknown device", Some(painter)), ("no writer", None)] {
            let mut local = base_doc();
            let ws = ws_of(&local);
            let tab = local.add_tab(
                ws,
                "painted",
                "https://e.example",
                uuid::Uuid::from_u128(63),
                checkable,
                50,
            );
            let node = local.node_mut(tab).unwrap();
            node.appearance.color = Some("orange".into());
            node.appearance_at = 50;
            node.appearance_by = painted_by;

            let mut peer = base_doc();
            peer.written_by = Some(DeviceId::from_bytes([0xb; 16]));
            peer.written_at = 400;
            // Everything `checkable` wrote is accounted for; the recolour is
            // not, because its writer cannot be checked.
            peer.seen.insert(checkable, 300);

            merge(&mut local, &peer);

            assert!(
                local.node(tab).is_some(),
                "{label}: a written appearance whose provenance cannot be checked \
                 must keep the node"
            );
        }
    }

    #[test]
    fn a_node_with_no_written_group_at_all_is_kept() {
        // Skipping unwritten groups must not empty the test (spec §5.4). A
        // schema-1.0 file carries no `_by`, and with zero `_at` values too
        // nothing is known about the node. Nothing is deleted on a watermark
        // that cannot be checked, so the node stays.
        let raw = r#"{
            "schema": { "major": 1, "minor": 0 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "tab",
                    "content": { "name": "nothing is known about me" },
                    "content_at": 0,
                    "placement": { "order": "80" },
                    "placement_at": 0,
                    "lifecycle": {},
                    "lifecycle_at": 0
                }
            }
        }"#;
        let local = Document::from_json(raw).expect("a 1.0 file must load");
        let tab = uuid::Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        for (by, at) in local.node(tab).unwrap().attributions() {
            assert_eq!((by, at), (None, 0), "test setup: every group unwritten");
        }

        // The peer lacks the node and its watermarks cover everything. Under
        // the skip alone the node would have no group left to judge and would
        // be dropped.
        let mut peer = base_doc();
        peer.written_by = Some(DeviceId::from_bytes([0xb; 16]));
        peer.written_at = 400;
        peer.seen.insert(test_device(), 300);

        let mut forward = local.clone();
        merge(&mut forward, &peer);
        assert!(
            forward.node(tab).is_some(),
            "a node nothing is known about must never be dropped on a watermark's word"
        );

        // The adopt half agrees, so the two sides converge.
        let mut adopting = peer.clone();
        merge(&mut adopting, &local);
        assert!(
            adopting.node(tab).is_some(),
            "the side lacking it must adopt what the side holding it keeps"
        );
    }

    #[test]
    fn a_byte_identical_content_tie_is_settled_by_the_writer() {
        // The content group's writer leg. Two devices write the same name at
        // the same timestamp, so only the writer separates them, and
        // `content_by` is shared state: without the writer each side keeps its
        // own attribution.
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        let (low, high) = (
            DeviceId::from_bytes([1u8; 16]),
            DeviceId::from_bytes([2u8; 16]),
        );
        a.set_content(id, "Same", None, None, None, false, low, 1_000);
        b.set_content(id, "Same", None, None, None, false, high, 1_000);

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().content_by,
            backward.node(id).unwrap().content_by,
            "a byte-identical content tie must settle on one writer in either direction"
        );
        assert_eq!(shared_state(&forward), shared_state(&backward));

        // The direction of that leg: `None` serialises as `null`, a writer as a
        // quoted string, and `'n' > '"'`, so an unattributed writer wins a
        // byte-identical tie. Merging an old file can therefore strip a group's
        // attribution. That is symmetric, so convergence holds, and
        // `is_news_to` keeps a node whose groups all end up that way.
        let same = crate::types::Content {
            name: "Same".into(),
            icon: None,
            url: None,
            value: None,
            guid: None,
            added: None,
            visit: None,
            archived: None,
            shares: None,
            local: false,
            extra: Default::default(),
        };
        assert!(
            super::remote_group_wins(100, &(&same, None), 100, &(&same, Some(low))),
            "an unattributed writer wins a byte-identical tie"
        );
        assert!(
            !super::remote_group_wins(100, &(&same, Some(high)), 100, &(&same, None)),
            "and the same verdict holds with the sides swapped"
        );
    }

    #[test]
    fn a_byte_identical_placement_tie_is_settled_by_the_writer() {
        // Placement's writer leg. The generator reassigns `parent` among shared
        // ids and never touches `order`, so it reaches this case only by
        // chance.
        let (mut a, mut b) = (base_doc(), base_doc());
        let ws = ws_of(&a);
        let shelf = uuid::Uuid::from_u128(70);
        let tab = uuid::Uuid::from_u128(71);
        for doc in [&mut a, &mut b] {
            doc.add_group(ws, "shelf", None, shelf, test_device(), 0);
            doc.add_tab(ws, "t", "https://e.example", tab, test_device(), 0);
        }
        let (low, high) = (
            DeviceId::from_bytes([1u8; 16]),
            DeviceId::from_bytes([2u8; 16]),
        );
        crate::tree::move_node(&mut a, tab, shelf, None, None, low, 1_000).unwrap();
        crate::tree::move_node(&mut b, tab, shelf, None, None, high, 1_000).unwrap();
        assert_eq!(
            serde_json::to_value(&a.node(tab).unwrap().placement).unwrap(),
            serde_json::to_value(&b.node(tab).unwrap().placement).unwrap(),
            "test setup: the two placements must be byte-identical"
        );

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(tab).unwrap().placement_by,
            backward.node(tab).unwrap().placement_by,
            "a byte-identical placement tie must settle on one writer in either direction"
        );
        assert_eq!(shared_state(&forward), shared_state(&backward));
    }

    #[test]
    fn a_single_sided_node_gets_the_same_verdict_in_both_merge_directions() {
        // Both halves compare the same quantity, so the side lacking the node
        // and the side holding it reach the same conclusion. Otherwise one
        // device would adopt what the other dropped.
        for stamped_at in [50u64, 100, 150] {
            let (a, mut b, _, dev_b) = two_current_peers(100);
            let ws = ws_of(&b);
            let tab = b.add_tab(
                ws,
                "x",
                "https://e.example",
                uuid::Uuid::from_u128(44),
                dev_b,
                stamped_at,
            );

            let mut a_sees_b = a.clone();
            merge(&mut a_sees_b, &b);
            let mut b_sees_a = b.clone();
            merge(&mut b_sees_a, &a);

            assert_eq!(
                a_sees_b.node(tab).is_some(),
                b_sees_a.node(tab).is_some(),
                "the two sides disagreed about a node stamped at {stamped_at}"
            );
        }
    }

    #[test]
    fn merging_advances_the_version_vector_transitively() {
        // Knowledge has to travel: if the desktop has seen the laptop's 3pm
        // write, the phone learns that from the desktop and stops treating
        // the laptop's older file as news.
        let laptop = DeviceId::from_bytes([1u8; 16]);
        let desktop = DeviceId::from_bytes([2u8; 16]);
        let mut phone = base_doc();
        let mut desktop_file = base_doc();
        desktop_file.stamp_write(desktop, 400);
        desktop_file.seen.insert(laptop, 300);

        merge(&mut phone, &desktop_file);

        assert_eq!(
            phone.seen.get(&desktop),
            Some(&400),
            "the file's own write must be recorded"
        );
        assert_eq!(
            phone.seen.get(&laptop),
            Some(&300),
            "what the desktop had incorporated from the laptop must travel too"
        );

        // And never backwards: an older file must not un-see a newer one.
        let mut older = base_doc();
        older.stamp_write(desktop, 100);
        older.seen.insert(laptop, 50);
        merge(&mut phone, &older);
        assert_eq!(phone.seen.get(&desktop), Some(&400));
        assert_eq!(phone.seen.get(&laptop), Some(&300));
    }

    #[test]
    fn our_own_stored_file_does_not_drop_what_we_added_since_writing_it() {
        // `sync` merges this device's own file first, and that file is older
        // than what we have done since. A node we hold and it lacks is our own
        // new work, so only the adopt half applies to our own file.
        let me = DeviceId::from_bytes([7u8; 16]);
        let mut doc = base_doc();
        doc.stamp_write(me, 100);
        let own_file = doc.clone();

        let ws = ws_of(&doc);
        // Stamped at exactly the last write: the tightest case, and the one a
        // coarsened clock produces.
        let tab = doc.add_tab(
            ws,
            "new",
            "https://e.example",
            uuid::Uuid::from_u128(45),
            me,
            100,
        );

        merge(&mut doc, &own_file);

        assert!(
            doc.node(tab).is_some(),
            "our own earlier file deleted a node we added after writing it"
        );
    }

    #[test]
    fn our_own_stored_file_does_not_resurrect_what_we_deleted_since_writing_it() {
        let me = DeviceId::from_bytes([7u8; 16]);
        let mut doc = base_doc();
        let ws = ws_of(&doc);
        let tab = doc.add_tab(
            ws,
            "doomed",
            "https://e.example",
            uuid::Uuid::from_u128(46),
            me,
            50,
        );
        doc.stamp_write(me, 100);
        let own_file = doc.clone();

        doc.remove(tab);
        merge(&mut doc, &own_file);

        assert!(
            doc.node(tab).is_none(),
            "our own earlier file resurrected a node we deleted after writing it"
        );
    }

    #[test]
    fn a_restored_device_recovers_its_own_writes_from_its_own_file() {
        // The mirror of the test above: a document rolled back by a
        // restore-from-backup carries a rolled-back `seen[me]`, so its own
        // stored file is news and its contents come back.
        let me = DeviceId::from_bytes([7u8; 16]);
        let mut written = base_doc();
        let ws = ws_of(&written);
        let tab = written.add_tab(
            ws,
            "offline",
            "https://e.example",
            uuid::Uuid::from_u128(47),
            me,
            50,
        );
        written.stamp_write(me, 100);

        let mut restored = base_doc(); // rolled back: no `seen`, no tab.
        merge(&mut restored, &written);

        assert!(
            restored.node(tab).is_some(),
            "a restored device must recover its own file's contents"
        );
    }

    /// Both merge directions of `a` and `b`, as `(a after merging b, b after
    /// merging a)`, checked to agree on every node.
    fn merged_both_ways(a: &Document, b: &Document) -> (Document, Document) {
        let (mut ab, mut ba) = (a.clone(), b.clone());
        merge(&mut ab, b);
        merge(&mut ba, a);
        assert_eq!(
            serde_json::to_value(&ab.nodes).unwrap(),
            serde_json::to_value(&ba.nodes).unwrap(),
            "both directions must converge"
        );
        (ab, ba)
    }

    /// A has a workspace W holding one tab. B, apart, files a tab under W and
    /// touches W. A, not having seen that, deletes W with its tab. The touch is
    /// news to A, so W comes back with B's tab under it, on both devices
    /// (decisions 0106, 0017).
    #[test]
    fn a_touch_the_deleter_never_saw_brings_the_node_back() {
        let (mut a, mut b, dev_a, dev_b) = two_current_peers(100);
        let w = a.add_workspace("", None, uuid::Uuid::from_u128(60), dev_a, 10);
        let home = a.add_tab(
            w,
            "Home",
            "about:home",
            uuid::Uuid::from_u128(61),
            dev_a,
            10,
        );
        for id in [w, home] {
            b.nodes.insert(id, a.node(id).unwrap().clone());
        }

        let t = b.add_tab(
            w,
            "Example",
            "https://e.example",
            uuid::Uuid::from_u128(62),
            dev_b,
            200,
        );
        b.touch(w, dev_b, 200);
        b.stamp_write(dev_b, 300);

        a.remove(home);
        a.remove(w);
        a.stamp_write(dev_a, 300);

        let (ab, _) = merged_both_ways(&a, &b);
        let back = ab.node(w).expect("the touched workspace comes back");
        assert_eq!(back.touched_by, Some(dev_b));
        assert_eq!(
            ab.node(t).unwrap().placement.parent,
            Some(w),
            "and the tab filed under it is still there"
        );
        assert!(
            ab.node(home).is_none(),
            "the tab the deleter removed, which nobody touched, stays deleted"
        );
    }

    /// The same shape without the touch: tabs under a node are not edits to
    /// it, so the delete wins, as spec §5.2 describes.
    #[test]
    fn without_a_touch_the_delete_wins_over_work_inside_the_node() {
        let (mut a, mut b, dev_a, dev_b) = two_current_peers(100);
        let w = a.add_workspace("", None, uuid::Uuid::from_u128(60), dev_a, 10);
        b.nodes.insert(w, a.node(w).unwrap().clone());
        let t = b.add_tab(
            w,
            "Example",
            "https://e.example",
            uuid::Uuid::from_u128(62),
            dev_b,
            200,
        );
        b.stamp_write(dev_b, 300);
        a.remove(w);
        a.stamp_write(dev_a, 300);

        let (ab, _) = merged_both_ways(&a, &b);
        assert!(ab.node(w).is_none());
        assert!(ab.node(t).is_some(), "the tab itself survives, for repair");
    }

    /// A deleter that had already merged the touch deleted the node knowing
    /// of it, so the delete propagates like any other.
    #[test]
    fn a_delete_made_after_seeing_the_touch_wins() {
        let (mut a, mut b, dev_a, dev_b) = two_current_peers(100);
        let w = a.add_workspace("", None, uuid::Uuid::from_u128(60), dev_a, 10);
        b.nodes.insert(w, a.node(w).unwrap().clone());
        b.touch(w, dev_b, 200);
        b.stamp_write(dev_b, 300);

        merge(&mut a, &b);
        assert_eq!(
            a.node(w).unwrap().touched_by,
            Some(dev_b),
            "A saw the touch"
        );
        a.remove(w);
        a.stamp_write(dev_a, 400);

        let (ab, ba) = merged_both_ways(&a, &b);
        assert!(ab.node(w).is_none(), "the delete stands on A");
        assert!(ba.node(w).is_none(), "and reaches B");
    }

    /// The touch holds no value, so an edit made elsewhere before it, and not
    /// yet seen by the device touching, survives it: here a recolour.
    #[test]
    fn a_touch_loses_no_edit_made_elsewhere() {
        let (mut a, mut b, dev_a, dev_b) = two_current_peers(100);
        let ws = ws_of(&a);
        a.set_appearance(ws, Some("blue".into()), Some("🌊".into()), None, dev_a, 150);
        a.stamp_write(dev_a, 160);
        b.touch(ws, dev_b, 200);
        b.stamp_write(dev_b, 300);

        let (ab, _) = merged_both_ways(&a, &b);
        let node = ab.node(ws).unwrap();
        assert_eq!(
            node.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("blue")
        );
        assert_eq!(node.appearance.emoji.as_deref(), Some("🌊"));
        assert_eq!(node.appearance_by, Some(dev_a));
        assert_eq!((node.touched_by, node.touched_at), (Some(dev_b), 200));
    }

    /// Two touches at one instant are settled by the writer, the same in
    /// both directions.
    #[test]
    fn a_touch_tie_is_settled_by_the_writer() {
        let (mut a, mut b, dev_a, dev_b) = two_current_peers(100);
        let ws = ws_of(&a);
        a.touch(ws, dev_a, 200);
        b.touch(ws, dev_b, 200);
        let (ab, _) = merged_both_ways(&a, &b);
        assert_eq!(ab.node(ws).unwrap().touched_at, 200);
    }

    #[test]
    fn a_node_under_a_group_the_peer_deleted_survives_but_needs_read_time_repair() {
        // Device A adds a tab into group G while device B deletes G. The tab is
        // A's new work, so it survives with its parent gone. merge leaves it
        // unreachable; `tree::repair_unreachable_ancestry` repairs it on the
        // read path.
        let (mut a, mut b, dev_a, _) = two_current_peers(100);
        let ws = ws_of(&a);
        let g = a.add_group(ws, "G", None, uuid::Uuid::from_u128(50), dev_a, 10);
        b.nodes.insert(g, a.node(g).unwrap().clone());
        let t = a.add_tab(
            g,
            "inside",
            "https://e.example",
            uuid::Uuid::from_u128(51),
            dev_a,
            200,
        );
        b.remove(g);

        merge(&mut a, &b);

        assert!(a.node(g).is_none(), "the group's deletion must propagate");
        assert!(
            a.node(t).is_some(),
            "our own tab must survive the peer's deletion of its parent"
        );
        assert!(
            !tree::children(&a, ws).contains(&t),
            "not yet reachable without the read-time repair"
        );

        tree::repair_unreachable_ancestry(&mut a);
        assert!(
            tree::children(&a, ws).contains(&t),
            "a node whose parent was deleted must be reachable again after the read-time repair"
        );
    }

    #[test]
    fn merge_unions_top_level_extra_fields_and_breaks_conflicts_by_canonical_bytes() {
        // A document has no timestamp, so a conflicting top-level key goes to
        // the greater canonical JSON bytes (`merge_untimestamped_extra`).
        // `"remote"` > `"local"`, so remote wins on both fields.
        let local = r#"{"schema":{"major":1,"minor":0},"nodes":{},
            "mine":"local"}"#;
        let remote = r#"{"schema":{"major":1,"minor":7},"nodes":{},
            "device_settings":{"from_the_future":true},"mine":"remote"}"#;
        let mut l = Document::from_json(local).unwrap();
        let r = Document::from_json(remote).unwrap();

        merge(&mut l, &r);

        let out = l.to_json().unwrap();
        assert!(
            out.contains("device_settings"),
            "remote's unknown top-level field was dropped"
        );
        assert!(out.contains("from_the_future"));
        assert!(
            out.contains("\"mine\":\"remote\""),
            "greater canonical bytes must win a top-level key conflict"
        );
    }

    #[test]
    fn document_extra_conflict_resolves_identically_in_both_merge_directions() {
        // Whichever value wins, both merge directions agree.
        let a = r#"{"schema":{"major":1,"minor":0},"nodes":{},"mine":"aaa"}"#;
        let b = r#"{"schema":{"major":1,"minor":0},"nodes":{},"mine":"zzz"}"#;
        let mut forward = Document::from_json(a).unwrap();
        merge(&mut forward, &Document::from_json(b).unwrap());
        let mut backward = Document::from_json(b).unwrap();
        merge(&mut backward, &Document::from_json(a).unwrap());

        assert_eq!(forward.extra.get("mine"), backward.extra.get("mine"));
        assert_eq!(forward.extra.get("mine").unwrap(), "zzz");
    }

    #[test]
    fn an_extra_conflict_is_decided_by_canonical_bytes_in_both_directions() {
        // serde_json writes `2` before `1.5`; the canonical encoding writes
        // the float as `f` and its bits, so `1.5` is the greater. Ordering
        // by serde_json's text would let two builds that print floats
        // differently each keep their own value.
        let a = r#"{"schema":{"major":1,"minor":0},"nodes":{},"mine":2}"#;
        let b = r#"{"schema":{"major":1,"minor":0},"nodes":{},"mine":1.5}"#;
        let mut forward = Document::from_json(a).unwrap();
        merge(&mut forward, &Document::from_json(b).unwrap());
        let mut backward = Document::from_json(b).unwrap();
        merge(&mut backward, &Document::from_json(a).unwrap());

        assert_eq!(forward.extra.get("mine"), Some(&serde_json::json!(1.5)));
        assert_eq!(backward.extra.get("mine"), Some(&serde_json::json!(1.5)));
    }

    #[test]
    fn canonical_bytes_is_independent_of_field_declaration_order() {
        // Two struct shapes for the same data with fields declared in different
        // orders, standing in for two builds that declare a field at different
        // positions. Without the `serde_json::Value` hop in `canonical_bytes`
        // they would give different bytes, and two builds would pick opposite
        // tie-break winners.
        #[derive(serde::Serialize)]
        struct DeclaredNameFirst {
            name: String,
            icon: Option<String>,
            url: Option<String>,
        }
        #[derive(serde::Serialize)]
        struct DeclaredUrlFirst {
            url: Option<String>,
            icon: Option<String>,
            name: String,
        }

        let a = DeclaredNameFirst {
            name: "Shared".into(),
            icon: Some("📁".into()),
            url: None,
        };
        let b = DeclaredUrlFirst {
            url: None,
            icon: Some("📁".into()),
            name: "Shared".into(),
        };

        assert_ne!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap(),
            "test setup: raw struct serialisation must actually differ by field order"
        );
        assert_eq!(
            super::canonical_bytes(&a),
            super::canonical_bytes(&b),
            "canonical_bytes must agree regardless of field declaration order"
        );
    }

    #[test]
    fn canonical_bytes_are_pinned_for_every_json_kind() {
        let value = serde_json::json!({
            "z": [null, true, false],
            "int": -7,
            "big": 18_446_744_073_709_551_615u64,
            "float": 1.5,
            "s": "q\"b\\\n\u{1}\u{1f} é",
            "": {}
        });
        assert_eq!(
            String::from_utf8(super::canonical_bytes(&value)).unwrap(),
            concat!(
                r#"{"":{},"big":18446744073709551615,"float":f3ff8000000000000,"#,
                r#""int":-7,"s":"q\"b\\\u000a\u0001\u001f é","z":[null,true,false]}"#
            )
        );
    }

    #[test]
    fn canonical_bytes_of_a_float_do_not_depend_on_serde_json_formatting() {
        // serde_json's text for `1e16` differs between releases (`1e16`,
        // `1e+16`), so a tie-break over its text would pick different winners
        // across builds.
        assert_eq!(
            super::canonical_bytes(&serde_json::json!(1e16)),
            b"f4341c37937e08000"
        );
    }

    #[test]
    fn canonical_tie_break_winner_is_pinned() {
        // Fixes the tie-break direction. The other tie-break tests check only
        // that both merge directions agree, not which value wins.
        use crate::types::Content;
        let a = Content {
            name: "Alpha".into(),
            icon: None,
            url: None,
            value: None,
            guid: None,
            added: None,
            visit: None,
            archived: None,
            shares: None,
            local: false,
            extra: Default::default(),
        };
        let b = Content {
            name: "Bravo".into(),
            icon: None,
            url: None,
            value: None,
            guid: None,
            added: None,
            visit: None,
            archived: None,
            shares: None,
            local: false,
            extra: Default::default(),
        };

        // Canonical bytes compare alphabetically-keyed JSON objects, so this
        // reduces to comparing the JSON text `{"name":"Alpha"}` against
        // `{"name":"Bravo"}` byte-for-byte: "Bravo" > "Alpha", so b wins.
        assert!(
            super::remote_group_wins(100, &b, 100, &a),
            "b must win this pinned tie"
        );
        assert!(
            !super::remote_group_wins(100, &a, 100, &b),
            "a must not win this pinned tie"
        );
    }

    #[test]
    fn two_peers_conflicting_on_the_same_unknown_key_in_one_group_converge_either_direction() {
        // An unrecognised field in one group, different on each side. It takes
        // its group's timestamp and canonical-bytes rule, so both directions
        // land on the same winner.
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        a.node_mut(id)
            .unwrap()
            .content
            .extra
            .insert("future_field".into(), serde_json::json!("from-a"));
        a.node_mut(id).unwrap().content_at = 1_000;
        b.node_mut(id)
            .unwrap()
            .content
            .extra
            .insert("future_field".into(), serde_json::json!("from-b"));
        b.node_mut(id).unwrap().content_at = 1_000;

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().content.extra.get("future_field"),
            backward.node(id).unwrap().content.extra.get("future_field"),
            "a tie on an unrecognised field must resolve to the same winner regardless of merge direction"
        );
    }

    #[test]
    fn an_unknown_content_field_travels_with_name_when_content_is_replaced() {
        // A field that belongs to a group (an unrecognised one here, standing
        // in for a field a newer build added) moves with the rest of its
        // group when that group is replaced.
        let (mut a, mut b) = (base_doc(), base_doc());
        let id = ws_of(&a);
        a.node_mut(id).unwrap().content.name = "renamed on A".into();
        a.node_mut(id)
            .unwrap()
            .content
            .extra
            .insert("future_field".into(), serde_json::json!("carried along"));
        a.node_mut(id).unwrap().content_at = 1_000; // later than b's untouched content_at 0.

        merge(&mut b, &a);

        let merged = b.node(id).unwrap();
        assert_eq!(
            merged.content.name, "renamed on A",
            "content group must be replaced"
        );
        assert_eq!(
            merged.content.extra.get("future_field"),
            Some(&serde_json::json!("carried along")),
            "the unrecognised field must travel with the rest of the content group it belongs to"
        );
    }

    #[test]
    fn an_unknown_fact_group_at_the_node_level_converges_either_direction() {
        // A group this build cannot name has no bucket and no readable
        // timestamp, so it merges per key by greater canonical bytes, as at the
        // document level. Both merge directions must land on the same value.
        let with = |value: &str| {
            format!(
                r#"{{"schema":{{"major":1,"minor":9}},"nodes":{{
                    "018f0000-0000-7000-8000-000000000001": {{
                        "kind": "tab",
                        "content": {{"name": "t"}}, "content_at": 10,
                        "placement": {{"order": "80"}}, "placement_at": 10,
                        "lifecycle": {{}}, "lifecycle_at": 10,
                        "sound": {{"chime": "{value}"}}, "sound_at": 20
                    }}
                }}}}"#
            )
        };
        let id = uuid::Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let a = Document::from_json(&with("soft")).unwrap();
        let b = Document::from_json(&with("loud")).unwrap();

        let mut forward = a.clone();
        merge(&mut forward, &b);
        let mut backward = b.clone();
        merge(&mut backward, &a);

        assert_eq!(
            forward.node(id).unwrap().extra,
            backward.node(id).unwrap().extra,
            "an unknown group must resolve to the same value in either direction"
        );
        assert_eq!(
            forward.node(id).unwrap().extra["sound"],
            serde_json::json!({ "chime": "soft" }),
            "greater canonical bytes must win: \"soft\" > \"loud\""
        );
        assert_eq!(shared_state(&forward), shared_state(&backward));
    }

    #[test]
    fn an_unknown_fact_group_travels_when_a_node_is_adopted() {
        // The adopt half carries the whole node, bucket included, so a build
        // relaying a node does not strip a newer build's group.
        let (mut a, _, _, dev_b) = two_current_peers(100);
        let mut b = base_doc();
        b.stamp_write(dev_b, 100);
        let tab = uuid::Uuid::from_u128(72);
        b.add_tab(ws_of(&b), "theirs", "https://e.example", tab, dev_b, 190);
        b.node_mut(tab)
            .unwrap()
            .extra
            .insert("sound".into(), serde_json::json!({ "chime": "soft" }));

        merge(&mut a, &b);

        assert_eq!(
            a.node(tab).expect("the node must be adopted").extra["sound"],
            serde_json::json!({ "chime": "soft" }),
            "an adopted node must keep the group this build cannot name"
        );
    }

    #[test]
    fn merge_is_idempotent() {
        let (mut a, b) = (base_doc(), peer_with_changes());
        merge(&mut a, &b);
        let once = a.to_json().unwrap();
        merge(&mut a, &b);
        assert_eq!(
            once,
            a.to_json().unwrap(),
            "second merge changed the document"
        );
    }

    #[test]
    fn merge_converges_regardless_of_order() {
        // Any two devices that have seen the same documents end up identical,
        // whatever order they arrived in.
        let (base, p1, p2) = (base_doc(), peer_with_changes(), other_peer());

        let mut left = base.clone();
        merge(&mut left, &p1);
        merge(&mut left, &p2);

        let mut right = base.clone();
        merge(&mut right, &p2);
        merge(&mut right, &p1);

        assert_eq!(shared_state(&left), shared_state(&right));
    }

    proptest::proptest! {
        // `generate_peers` gives every peer a shared pool of node ids to edit,
        // remove, pin and reparent, with timestamps from a small range, so ids
        // are contended, ties are reachable in every group, and
        // `tree::repair_unreachable_ancestry` has work to do.
        //
        // n devices, each starting from one generated peer, gossip pairwise in
        // a schedule derived from `seed`, then finish with an all-pairs merge,
        // standing in for every device having seen every other's file, which
        // the sync loop reaches over enough rounds. They must land on
        // byte-identical documents. Forward-versus-reverse over one accumulator
        // misses divergence that needs more than two participants or a
        // non-trivial schedule.
        //
        // Repair runs after every merge, because a cycle or an unreachable
        // ancestor can arise after any single merge. Repair fixes only
        // reachability, so byte-identity is still the right assertion.
        //
        // `any_gossip_schedule_converges_has_teeth_against_whole_record_merge`
        // shows that a whole-record merge fails these checks.
        #[test]
        fn any_gossip_schedule_converges(seed in 0u64..500) {
            let n = 4;
            let peers: Vec<Document> = crate::types::test_support::generate_peers(seed, n);
            let mut devices = peers.clone();

            // A pseudo-random pairwise schedule: pick (i, j) and merge j into
            // i, in an order derived from the seed.
            let mut state = seed ^ 0xD1B54A32D192ED03;
            let mut rand = || {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (state >> 33) as usize
            };
            for _ in 0..(n * n * 3) {
                let i = rand() % n;
                let j = rand() % n;
                if i != j {
                    let src = devices[j].clone();
                    merge(&mut devices[i], &src);
                    tree::repair_unreachable_ancestry(&mut devices[i]);
                }
            }

            // Finish with an all-pairs merge so every device has seen every
            // other directly.
            // Indexes `devices` mutably and `snapshot` immutably, so this
            // cannot be one `.iter_mut().enumerate()`.
            #[allow(clippy::needless_range_loop)]
            {
                let snapshot = devices.clone();
                for i in 0..n {
                    for j in 0..n {
                        if i != j {
                            merge(&mut devices[i], &snapshot[j]);
                            tree::repair_unreachable_ancestry(&mut devices[i]);
                        }
                    }
                }
            }

            // The tree and the document-level fields. `written_at`,
            // `written_by` and `seen` describe each device's own relation to
            // the files, so converged devices differ there (see
            // `shared_state`).
            let reference = shared_state(&devices[0]);
            for device in &devices[1..] {
                proptest::prop_assert_eq!(shared_state(device), reference.clone());
            }

            // Convergence alone is satisfied by any deterministic
            // last-writer-wins register, a whole-record one included, which
            // converges while being wrong about which group's fact won. So each
            // pool node's content, lifecycle and appearance are also checked
            // against every peer's value for that group folded on its own.
            // Placement is excluded: repair can move a node away from every
            // peer's parent, so it has no group-only ground truth.
            for i in 1..=6u128 {
                let id = uuid::Uuid::from_u128(i);
                // A pool node any peer removed must be gone everywhere:
                // every peer's version vector claims everything up to
                // `PUBLISHED_AT` is incorporated and every edit is stamped
                // below it, so the removal is unambiguous evidence to all of
                // them (spec §5.4) and no holder may keep or re-publish it.
                if peers.iter().any(|p| p.node(id).is_none()) {
                    proptest::prop_assert!(
                        devices[0].node(id).is_none(),
                        "node {} survived a peer's deletion", id
                    );
                    continue;
                }
                if let Some(expected) = pool_expected_content(&peers, id) {
                    proptest::prop_assert_eq!(&devices[0].node(id).unwrap().content, &expected.0);
                }
                if let Some(expected) = pool_expected_lifecycle(&peers, id) {
                    proptest::prop_assert_eq!(&devices[0].node(id).unwrap().lifecycle, &expected.0);
                }
                if let Some(expected) = pool_expected_appearance(&peers, id) {
                    proptest::prop_assert_eq!(&devices[0].node(id).unwrap().appearance, &expected.0);
                }
            }

            // And the other half of the absence rule: each peer's own node,
            // stamped above `PUBLISHED_AT`, is news to everyone else and must
            // have reached every device rather than being read as a deletion.
            for i in 0..n {
                let own = uuid::Uuid::from_u128(100 + i as u128);
                proptest::prop_assert!(
                    devices[0].node(own).is_some(),
                    "peer {}'s own node never propagated", i
                );
            }
        }
    }

    /// The ground truth for a pool node's `content`: every peer's content
    /// folded with [`remote_group_wins`], ignoring the other groups. The fold
    /// is commutative and associative, as `merge` is, so it need not replay the
    /// gossip schedule.
    fn pool_expected_content(
        peers: &[Document],
        id: crate::types::NodeId,
    ) -> Option<(crate::types::Content, Option<DeviceId>)> {
        let mut iter = peers.iter().filter_map(|p| p.node(id));
        let first = iter.next()?;
        let mut acc_at = first.content_at;
        let mut acc = (first.content.clone(), first.content_by);
        for node in iter {
            if super::remote_group_wins(
                node.content_at,
                &(&node.content, node.content_by),
                acc_at,
                &(&acc.0, acc.1),
            ) {
                acc_at = node.content_at;
                acc = (node.content.clone(), node.content_by);
            }
        }
        Some(acc)
    }

    /// Ground truth for a pool node's `appearance`, by the same method as
    /// [`pool_expected_content`].
    fn pool_expected_appearance(
        peers: &[Document],
        id: crate::types::NodeId,
    ) -> Option<(crate::types::Appearance, Option<DeviceId>)> {
        let mut iter = peers.iter().filter_map(|p| p.node(id));
        let first = iter.next()?;
        let mut acc_at = first.appearance_at;
        let mut acc = (first.appearance.clone(), first.appearance_by);
        for node in iter {
            if super::remote_group_wins(
                node.appearance_at,
                &(&node.appearance, node.appearance_by),
                acc_at,
                &(&acc.0, acc.1),
            ) {
                acc_at = node.appearance_at;
                acc = (node.appearance.clone(), node.appearance_by);
            }
        }
        Some(acc)
    }

    /// Ground truth for a pool node's `lifecycle`, same method as
    /// [`pool_expected_content`].
    fn pool_expected_lifecycle(
        peers: &[Document],
        id: crate::types::NodeId,
    ) -> Option<(crate::types::Lifecycle, Option<DeviceId>)> {
        let mut iter = peers.iter().filter_map(|p| p.node(id));
        let first = iter.next()?;
        let mut acc_at = first.lifecycle_at;
        let mut acc = (first.lifecycle.clone(), first.lifecycle_by);
        for node in iter {
            if super::remote_group_wins(
                node.lifecycle_at,
                &(&node.lifecycle, node.lifecycle_by),
                acc_at,
                &(&acc.0, acc.1),
            ) {
                acc_at = node.lifecycle_at;
                acc = (node.lifecycle.clone(), node.lifecycle_by);
            }
        }
        Some(acc)
    }

    /// A whole-record merge, the mutation oracle for
    /// `any_gossip_schedule_converges`: the side whose node has the later
    /// `content_at` wins the entire node, tied on canonical bytes of the whole
    /// node. See
    /// `any_gossip_schedule_converges_has_teeth_against_whole_record_merge`.
    fn whole_record_merge(local: &mut Document, remote: &Document) {
        for (key, value) in &remote.extra {
            local
                .extra
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
        for (id, remote_node) in &remote.nodes {
            match local.nodes.get(id) {
                None => {
                    local.nodes.insert(*id, remote_node.clone());
                }
                Some(local_node) => {
                    let take_remote = super::remote_group_wins(
                        remote_node.content_at,
                        remote_node,
                        local_node.content_at,
                        local_node,
                    );
                    if take_remote {
                        local.nodes.insert(*id, remote_node.clone());
                    }
                }
            }
        }
    }

    /// A check on the checker. Runs the schedule and ground-truth checks of
    /// `any_gossip_schedule_converges` at a fixed seed through
    /// [`whole_record_merge`] instead of `merge`, and asserts that at least one
    /// pool node ends up with the wrong content or lifecycle. A whole-record
    /// merge still converges, so convergence alone cannot tell the two apart;
    /// what it gets wrong is which group's fact wins. If no such node turned
    /// up, the ground-truth checks would be too weak to catch whole-record
    /// merging.
    ///
    /// Seed 7 is arbitrary. It reproduces a content/lifecycle collision in
    /// `generate_peers`'s small timestamp range; the seed only needs to be
    /// fixed.
    #[test]
    fn any_gossip_schedule_converges_has_teeth_against_whole_record_merge() {
        let seed: u64 = 7;
        let n = 4;
        let peers: Vec<Document> = crate::types::test_support::generate_peers(seed, n);
        let mut devices = peers.clone();

        let mut state = seed ^ 0xD1B54A32D192ED03;
        let mut rand = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as usize
        };
        for _ in 0..(n * n * 3) {
            let i = rand() % n;
            let j = rand() % n;
            if i != j {
                let src = devices[j].clone();
                whole_record_merge(&mut devices[i], &src);
                tree::repair_unreachable_ancestry(&mut devices[i]);
            }
        }
        #[allow(clippy::needless_range_loop)]
        {
            let snapshot = devices.clone();
            for i in 0..n {
                for j in 0..n {
                    if i != j {
                        whole_record_merge(&mut devices[i], &snapshot[j]);
                        tree::repair_unreachable_ancestry(&mut devices[i]);
                    }
                }
            }
        }

        let mut mismatch = false;
        for i in 1..=6u128 {
            let id = uuid::Uuid::from_u128(i);
            if let (Some(expected), Some(actual)) = (
                pool_expected_content(&peers, id),
                devices[0].node(id).map(|n| n.content.clone()),
            ) && expected.0 != actual
            {
                mismatch = true;
            }
            if let (Some(expected), Some(actual)) = (
                pool_expected_lifecycle(&peers, id),
                devices[0].node(id).map(|n| n.lifecycle.clone()),
            ) && expected.0 != actual
            {
                mismatch = true;
            }
            if let (Some(expected), Some(actual)) = (
                pool_expected_appearance(&peers, id),
                devices[0].node(id).map(|n| n.appearance.clone()),
            ) && expected.0 != actual
            {
                mismatch = true;
            }
        }

        assert!(
            mismatch,
            "expected whole-record merge to disagree with the ground truth on at \
             least one pool node's content, lifecycle or appearance at seed \
             {seed} (that's the \
             point of this test) — if it now matches, pick a new seed that still \
             reproduces the mismatch"
        );
    }
    #[test]
    fn a_stale_published_watermark_keeps_the_node_where_a_current_one_drops_it() {
        // `sync` decides whether to write from the shared state alone, so a
        // published `seen` can lag what its writer has incorporated (spec §5.4,
        // decision 0018). The drop half reads the lacking side's watermark, and
        // a lower watermark makes the node news, which keeps it. The two merges
        // below differ only in that watermark.
        let writer = DeviceId::from_bytes([1u8; 16]);
        let mut local = base_doc();
        let tab = local.add_tab(
            ws_of(&local),
            "U",
            "https://u.example",
            uuid::Uuid::from_u128(31),
            writer,
            200,
        );

        let mut peer = base_doc();
        peer.written_by = Some(DeviceId::from_bytes([2u8; 16]));
        peer.written_at = 400;

        peer.seen.insert(writer, 300);
        let mut against_current = local.clone();
        merge(&mut against_current, &peer);
        assert!(
            against_current.node(tab).is_none(),
            "a watermark covering the node's own writer is what makes a drop \
             legitimate; without this half the merge can never delete anything"
        );

        peer.seen.insert(writer, 100);
        let mut against_stale = local.clone();
        merge(&mut against_stale, &peer);
        assert!(
            against_stale.node(tab).is_some(),
            "a stale published watermark must make the node news and keep it — \
             if staleness could drop a node instead, excluding `seen` from \
             sync's write decision would lose data"
        );
    }
}
