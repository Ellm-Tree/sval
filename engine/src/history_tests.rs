// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! History's documents (history-sync spec): visits sharded by week, the
//! index that lists the weeks, and how both merge, delete and grow.

use crate::crypto::Key;
use crate::store::{DeviceId, MemoryStore};
use crate::sync::sync;
use crate::tree::repair_unreachable_ancestry;
use crate::types::test_support::{dev_a, dev_b, read_both_ways};
use crate::types::{Document, HISTORY_INDEX, NodeId, NodeKind, shard_id, visit_id};

const WEEK: &str = "history-2026-W42";
const LAST_WEEK: &str = "history-2026-W41";
const TYPED: u32 = 2;

fn work() -> NodeId {
    NodeId::from_u128(0x3c1d_9e2a_77b0_4f15_a8c6_5e0d_2b9f_1a47)
}

/// Both merge directions, each then repaired as a device reads it. Asserts
/// the two agree and returns one.
#[test]
fn a_visit_id_names_the_device_the_page_and_the_moment() {
    let id = visit_id(dev_a(), "https://e.example/", 1_000);
    assert_eq!(id, visit_id(dev_a(), "https://e.example/", 1_000));
    assert_ne!(id, visit_id(dev_b(), "https://e.example/", 1_000));
    assert_ne!(id, visit_id(dev_a(), "https://e.example/x", 1_000));
    assert_ne!(id, visit_id(dev_a(), "https://e.example/", 1_001));
    assert_ne!(shard_id(WEEK), shard_id(LAST_WEEK));
}

#[test]
fn a_visit_holds_its_url_title_time_transition_and_device() {
    let mut doc = Document::new();
    let id = doc.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );

    let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
    let node = back.node(id).unwrap();
    assert_eq!(node.kind, NodeKind::Visit);
    assert_eq!(node.content.url.as_deref(), Some("https://e.example/"));
    assert_eq!(node.content.name, "Example");
    let visit = node.content.visit.as_ref().unwrap();
    assert_eq!(
        (visit.at, visit.transition, visit.device),
        (1_000, TYPED, dev_a())
    );
    assert_eq!(node.placement.parent, None);
}

#[test]
fn a_visit_holds_the_workspace_it_was_made_in_and_none_writes_no_key() {
    let mut doc = Document::new();
    let inside = doc.add_visit_in(
        "https://e.example/",
        "E",
        TYPED,
        1_000,
        Some(work()),
        dev_a(),
        1_001,
    );
    let outside = doc.add_visit("https://f.example/", "F", TYPED, 1_000, dev_a(), 1_001);

    let json = doc.to_json().unwrap();
    let back = Document::from_json(&json).unwrap();
    let workspace_of = |id| {
        back.node(id)
            .unwrap()
            .content
            .visit
            .as_ref()
            .unwrap()
            .workspace
    };
    assert_eq!(workspace_of(inside), Some(work()));
    assert_eq!(workspace_of(outside), None);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let visit_json = |id: NodeId| value["nodes"][id.to_string()]["content"]["visit"].clone();
    assert_eq!(visit_json(inside)["workspace"], work().to_string());
    assert!(visit_json(outside).get("workspace").is_none(), "{json}");
}

#[test]
fn a_build_that_does_not_know_a_visits_workspace_writes_it_back_verbatim() {
    let mut doc = Document::new();
    doc.add_visit_in(
        "https://e.example/",
        "E",
        TYPED,
        1_000,
        Some(work()),
        dev_a(),
        1_001,
    );
    let json = doc.to_json().unwrap();
    // A 1.10 build has no name for the field, so holds it in the visit's
    // own bucket.
    let older = json.replace("\"workspace\"", "\"from-a-newer-build\"");
    assert_ne!(older, json);

    let rewritten = Document::from_json(&older).unwrap().to_json().unwrap();
    let as_value = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
    assert_eq!(as_value(&rewritten), as_value(&older));
}

#[test]
fn a_visits_workspace_reaches_the_other_device_through_a_sync() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a_week = Document::new();
    let inside = a_week.add_visit_in(
        "https://e.example/",
        "E",
        TYPED,
        2_000,
        Some(work()),
        dev_a(),
        2_001,
    );
    let outside = a_week.add_visit("https://f.example/", "F", TYPED, 2_100, dev_a(), 2_101);
    pass(&store, &key, dev_a(), WEEK, &mut a_week, 3_000);

    let mut b_week = Document::new();
    let report = pass(&store, &key, dev_b(), WEEK, &mut b_week, 4_000);
    let mut changed = report.changed.clone();
    changed.sort();
    let mut expected = vec![inside, outside];
    expected.sort();
    assert_eq!(changed, expected);
    let workspace_of = |id| {
        b_week
            .node(id)
            .unwrap()
            .content
            .visit
            .as_ref()
            .unwrap()
            .workspace
    };
    assert_eq!(workspace_of(inside), Some(work()));
    assert_eq!(workspace_of(outside), None);
}

#[test]
fn the_same_moment_in_another_workspace_is_the_same_visit() {
    let mut doc = Document::new();
    let id = doc.add_visit_in(
        "https://e.example/",
        "E",
        TYPED,
        1_000,
        Some(work()),
        dev_a(),
        1_001,
    );
    let before = doc.shared_state_json().unwrap();
    assert_eq!(
        doc.add_visit("https://e.example/", "E", TYPED, 1_000, dev_a(), 9_999),
        id
    );
    assert_eq!(doc.shared_state_json().unwrap(), before);
}

#[test]
fn a_build_that_does_not_know_visits_writes_them_back_verbatim() {
    let mut doc = Document::new();
    doc.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );
    doc.touch_shard(WEEK, dev_a(), 1_001);
    let json = doc.to_json().unwrap();
    // An older build sees a kind and a content field it has no name for.
    let older = json
        .replace("\"visit\"", "\"from-a-newer-build\"")
        .replace("\"shard\"", "\"also-newer\"");
    assert_ne!(older, json);

    let rewritten = Document::from_json(&older).unwrap().to_json().unwrap();
    let as_value = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
    assert_eq!(as_value(&rewritten), as_value(&older));
}

#[test]
fn adding_a_visit_twice_changes_nothing() {
    let mut doc = Document::new();
    let id = doc.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );
    let before = doc.shared_state_json().unwrap();
    assert_eq!(
        doc.add_visit("https://e.example/", "Other", TYPED, 1_000, dev_a(), 9_999),
        id
    );
    assert_eq!(doc.shared_state_json().unwrap(), before);
}

#[test]
fn a_title_change_stamps_content_only_and_only_when_it_differs() {
    let mut doc = Document::new();
    let id = doc.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );
    doc.set_visit_title(id, "Example", dev_b(), 2_000);
    assert_eq!(doc.node(id).unwrap().content_at, 1_001);

    doc.set_visit_title(id, "Renamed", dev_b(), 2_000);
    let node = doc.node(id).unwrap();
    assert_eq!(node.content.name, "Renamed");
    assert_eq!((node.content_at, node.content_by), (2_000, Some(dev_b())));
    assert_eq!(node.placement_at, 1_001);
    assert_eq!(node.content.visit.as_ref().unwrap().device, dev_a());
}

#[test]
fn visits_and_shards_are_roots_that_repair_leaves_alone() {
    let mut doc = Document::new();
    let v = doc.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );
    let s = doc.touch_shard(WEEK, dev_a(), 1_001);
    assert!(repair_unreachable_ancestry(&mut doc).is_empty());
    assert_eq!(doc.node(v).unwrap().placement.parent, None);
    assert_eq!(doc.node(s).unwrap().placement.parent, None);
}

#[test]
fn two_devices_holding_the_same_visit_converge_on_one_node() {
    let mut a = Document::new();
    let id = a.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );
    a.stamp_write(dev_a(), 1_002);
    // B holds A's visit from an earlier merge, and a visit of its own.
    let mut b = a.clone();
    b.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_500,
        dev_b(),
        1_501,
    );
    b.stamp_write(dev_b(), 1_502);

    let merged = read_both_ways(&a, &b);
    assert_eq!(merged.visit_ids().len(), 2);
    assert!(merged.node(id).is_some());
}

#[test]
fn a_visit_deleted_on_any_device_is_deleted_everywhere() {
    let mut a = Document::new();
    let mine = a.add_visit(
        "https://e.example/",
        "Example",
        TYPED,
        1_000,
        dev_a(),
        1_001,
    );
    a.stamp_write(dev_a(), 1_002);
    let mut b = Document::new();
    let theirs = b.add_visit("https://f.example/", "F", TYPED, 1_100, dev_b(), 1_101);
    b.stamp_write(dev_b(), 1_102);
    let both = read_both_ways(&a, &b);
    let (mut a, mut b) = (both.clone(), both);
    a.stamp_write(dev_a(), 2_000);
    b.stamp_write(dev_b(), 2_000);

    // B deletes A's visit; A deletes B's.
    b.remove(mine);
    a.remove(theirs);
    let merged = read_both_ways(&a, &b);
    assert!(merged.visit_ids().is_empty(), "{:?}", merged.visit_ids());
}

#[test]
fn a_shard_touched_on_two_devices_converges_and_reports_the_latest_write() {
    let mut a = Document::new();
    a.touch_shard(WEEK, dev_a(), 1_000);
    a.stamp_write(dev_a(), 1_001);
    let mut b = a.clone();
    b.touch_shard(WEEK, dev_b(), 3_000);
    b.touch_shard(LAST_WEEK, dev_b(), 3_000);
    b.stamp_write(dev_b(), 3_001);
    a.touch_shard(WEEK, dev_a(), 2_000);

    let merged = read_both_ways(&a, &b);
    let week = merged.node(shard_id(WEEK)).unwrap();
    assert_eq!((week.touched_at, week.touched_by), (3_000, Some(dev_b())));
    assert!(merged.node(shard_id(LAST_WEEK)).is_some());
}

/// One sync pass of `doc` as `device` over the shared store.
fn pass(
    store: &MemoryStore,
    key: &Key,
    device: DeviceId,
    name: &str,
    doc: &mut Document,
    now: u64,
) -> crate::sync::SyncReport {
    sync(store, key, device, name, doc, now).unwrap()
}

#[test]
fn a_new_device_finds_every_week_through_the_index_and_is_told_what_arrived() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut index, mut week, mut last) = (Document::new(), Document::new(), Document::new());
    let now_visit = week.add_visit("https://e.example/", "E", TYPED, 2_000, dev_a(), 2_001);
    let old_visit = last.add_visit("https://f.example/", "F", TYPED, 1_000, dev_a(), 1_001);
    index.touch_shard(WEEK, dev_a(), 2_001);
    index.touch_shard(LAST_WEEK, dev_a(), 1_001);
    pass(&store, &key, dev_a(), WEEK, &mut week, 3_000);
    pass(&store, &key, dev_a(), LAST_WEEK, &mut last, 3_000);
    pass(&store, &key, dev_a(), HISTORY_INDEX, &mut index, 3_000);

    let mut b_index = Document::new();
    pass(&store, &key, dev_b(), HISTORY_INDEX, &mut b_index, 4_000);
    let mut names: Vec<String> = b_index
        .nodes
        .values()
        .filter(|n| n.kind == NodeKind::Shard)
        .map(|n| n.content.name.clone())
        .collect();
    names.sort();
    assert_eq!(names, [LAST_WEEK, WEEK]);

    let mut b_week = Document::new();
    let report = pass(&store, &key, dev_b(), WEEK, &mut b_week, 4_000);
    assert_eq!(report.changed, [now_visit]);
    assert!(report.removed.is_empty());
    let mut b_last = Document::new();
    let report = pass(&store, &key, dev_b(), LAST_WEEK, &mut b_last, 4_000);
    assert_eq!(report.changed, [old_visit]);

    // A deletes its visit; B's next pass reports the removal.
    week.remove(now_visit);
    pass(&store, &key, dev_a(), WEEK, &mut week, 5_000);
    let report = pass(&store, &key, dev_b(), WEEK, &mut b_week, 6_000);
    assert_eq!(report.removed, [now_visit]);
    assert!(report.changed.is_empty());
}

#[test]
fn a_visit_this_device_adds_is_not_reported_as_arriving() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut week = Document::new();
    week.add_visit("https://e.example/", "E", TYPED, 2_000, dev_a(), 2_001);
    let report = pass(&store, &key, dev_a(), WEEK, &mut week, 3_000);
    assert!(report.changed.is_empty());
    assert!(report.removed.is_empty());
}

/// The browser's sync helper refuses a file larger than this
/// (`MAX_FILE_BYTES` in the fork's `BackgroundTask_svalSharedFolder`).
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

#[test]
fn a_heavy_week_stays_under_the_helpers_file_limit() {
    let mut doc = Document::new();
    let url_tail = "a".repeat(90);
    let title = "t".repeat(60);
    // 3,000 visits a day for a week (history-sync spec §5).
    // Every visit records a workspace, the larger case.
    for i in 0..21_000u64 {
        doc.add_visit_in(
            &format!("https://site{}.example/{url_tail}/{i}", i % 500),
            title.clone(),
            1,
            1_760_000_000_000 + i * 28_800,
            Some(work()),
            if i % 2 == 0 { dev_a() } else { dev_b() },
            1_760_000_000_000 + i * 28_800,
        );
    }
    doc.stamp_write(dev_a(), 1_770_000_000_000);
    let sealed = crate::crypto::seal(
        &crate::types::test_support::test_key(),
        b"path",
        doc.to_json().unwrap().as_bytes(),
    )
    .unwrap();
    assert!(
        sealed.len() < MAX_FILE_BYTES,
        "a heavy week is {} bytes, over {MAX_FILE_BYTES}",
        sealed.len()
    );
}
