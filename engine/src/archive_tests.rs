// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The Archive (idle-tab archive spec): the sweep, restore,
//! expiry, and how the Archive and the tree converge across devices.

use crate::archive::{
    ArchiveError, HOUR, Imported, Sweep, add_imported, archive_idle, archive_now, expire,
    mark_used, period, restore, set_auto_archive,
};
use crate::crypto::Key;
use crate::store::{DeviceId, MemoryStore};
use crate::sync::{sync, sync_expiring};
use crate::tree::children;
use crate::types::test_support::{TREE, dev_a, dev_b, read_both_ways, uid};
use crate::types::{ARCHIVE, Document, NodeId, NodeKind, Timestamp, archived_id};
use std::collections::{BTreeMap, BTreeSet};

const DAY: Timestamp = 24 * HOUR;

const WS: u128 = 1;

/// A workspace `W` holding loose tabs 10, 11 and 12, opened at time 1.
fn tree_with_tabs() -> Document {
    let mut doc = Document::new();
    doc.add_workspace("W", None, uid(WS), dev_a(), 1);
    for n in 10..=12 {
        doc.add_tab(
            uid(WS),
            format!("T{n}"),
            format!("https://{n}.example/"),
            uid(n),
            dev_a(),
            1,
        );
    }
    doc
}

fn sweep_at<'a>(
    default: &'a str,
    last_active: &'a BTreeMap<NodeId, Timestamp>,
    exempt: &'a BTreeSet<NodeId>,
) -> Sweep<'a> {
    Sweep {
        default,
        last_active,
        exempt,
    }
}

/// A sweep with the global choice `default`, no `lastActive` and no
/// exemptions.
fn sweep(
    tree: &mut Document,
    archive: &mut Document,
    default: &str,
    now: Timestamp,
) -> Vec<NodeId> {
    let (none, empty) = (BTreeMap::new(), BTreeSet::new());
    archive_idle(
        tree,
        archive,
        &sweep_at(default, &none, &empty),
        dev_a(),
        now,
    )
    .unwrap()
    .tabs
}

/// One sync pass of `doc` as `device` over the shared store.
fn pass(
    store: &MemoryStore,
    key: &Key,
    device: DeviceId,
    name: &str,
    doc: &mut Document,
    now: Timestamp,
) {
    sync(store, key, device, name, doc, now).unwrap();
}

/// One sync pass of an Archive, expiring at `retention`.
fn archive_pass(
    store: &MemoryStore,
    key: &Key,
    device: DeviceId,
    doc: &mut Document,
    now: Timestamp,
    retention: Timestamp,
) {
    sync_expiring(store, key, device, ARCHIVE, doc, now, Some(retention)).unwrap();
}

/// Both merge directions, each repaired as a device reads it. Asserts the two
/// agree and returns one.
#[test]
fn an_idle_tab_leaves_the_tree_and_its_entry_records_where_it_was() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    let (mut last_active, exempt) = (BTreeMap::new(), BTreeSet::new());
    last_active.insert(uid(10), 8 * DAY);
    last_active.insert(uid(12), 8 * DAY);
    let swept = archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("7d", &last_active, &exempt),
        dev_a(),
        8 * DAY + 1,
    )
    .unwrap();

    assert_eq!(swept.tabs, vec![uid(11)]);
    assert_eq!(swept.entries, vec![archived_id(uid(11))]);
    assert!(tree.node(uid(11)).is_none(), "the tab left the tree");
    let entry = archive.node(archived_id(uid(11))).unwrap();
    assert_eq!(entry.kind, NodeKind::Archived);
    assert_eq!(entry.placement.parent, None);
    assert_eq!(entry.content.url.as_deref(), Some("https://11.example/"));
    assert_eq!(entry.content.name, "T11");
    let record = entry.content.archived.as_ref().unwrap();
    assert_eq!(record.tab, uid(11));
    assert_eq!(record.workspace, uid(WS));
    assert_eq!(record.workspace_name, "W");
    assert_eq!(
        (record.before, record.after),
        (Some(uid(10)), Some(uid(12)))
    );
    assert_eq!(record.closed_at, 8 * DAY + 1);
    assert_eq!(record.device, dev_a());
    assert!(record.split.is_none());
}

#[test]
fn a_tab_opened_or_moved_within_the_period_is_not_idle() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    crate::tree::move_node(
        &mut tree,
        uid(10),
        uid(WS),
        Some(uid(12)),
        None,
        dev_a(),
        5 * DAY,
    )
    .unwrap();
    let swept = sweep(&mut tree, &mut archive, "7d", 8 * DAY);
    assert_eq!(swept, vec![uid(11), uid(12)]);
    assert!(
        tree.node(uid(10)).is_some(),
        "moved two days before the sweep"
    );
}

#[test]
fn never_groups_agents_and_exempt_tabs_are_never_archived() {
    let mut tree = tree_with_tabs();
    tree.add_group(uid(WS), "G", None, uid(20), dev_a(), 1);
    tree.add_tab(
        uid(20),
        "in group",
        "https://g.example/",
        uid(21),
        dev_a(),
        1,
    );
    tree.add_group(uid(20), "inner", None, uid(22), dev_a(), 1);
    tree.add_tab(uid(22), "deeper", "https://d.example/", uid(23), dev_a(), 1);
    tree.add_agent_workspace("Agent", "Claude", uid(30), dev_a(), 1);
    tree.add_tab(
        uid(30),
        "agent's",
        "https://a.example/",
        uid(31),
        dev_a(),
        1,
    );
    tree.add_workspace("Off", None, uid(40), dev_a(), 1);
    tree.add_tab(uid(40), "kept", "https://k.example/", uid(41), dev_a(), 1);
    set_auto_archive(&mut tree, uid(40), Some("never"), dev_a(), 1).unwrap();

    let mut archive = Document::new();
    let (none, exempt) = (BTreeMap::new(), BTreeSet::from([uid(12)]));
    let swept = archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("24h", &none, &exempt),
        dev_a(),
        30 * DAY,
    )
    .unwrap();
    assert_eq!(swept.tabs, vec![uid(10), uid(11)]);
    for kept in [12, 20, 21, 22, 23, 31, 41] {
        assert!(tree.node(uid(kept)).is_some(), "{kept} must stay");
    }
}

#[test]
fn a_workspace_choice_overrides_the_global_one_both_ways() {
    let mut tree = tree_with_tabs();
    tree.add_workspace("Fast", None, uid(40), dev_a(), 1);
    tree.add_tab(uid(40), "t", "https://t.example/", uid(41), dev_a(), 1);
    set_auto_archive(&mut tree, uid(40), Some("12h"), dev_a(), 1).unwrap();

    let mut archive = Document::new();
    assert_eq!(
        sweep(&mut tree, &mut archive, "never", DAY),
        vec![uid(41)],
        "the workspace archives while the global choice is off"
    );
    set_auto_archive(&mut tree, uid(WS), Some("never"), dev_a(), DAY).unwrap();
    assert!(sweep(&mut tree, &mut archive, "12h", 30 * DAY).is_empty());
    set_auto_archive(&mut tree, uid(WS), None, dev_a(), DAY).unwrap();
    assert_eq!(sweep(&mut tree, &mut archive, "12h", 30 * DAY).len(), 3);
}

#[test]
fn a_workspace_choice_stamps_only_lifecycle_and_refuses_what_cannot_archive() {
    let mut tree = tree_with_tabs();
    tree.set_isolation(uid(WS), true, dev_a(), 2);
    let before = tree.node(uid(WS)).unwrap().clone();
    set_auto_archive(&mut tree, uid(WS), Some("30d"), dev_b(), 9).unwrap();
    let after = tree.node(uid(WS)).unwrap();
    assert_eq!(after.lifecycle.auto_archive.as_deref(), Some("30d"));
    assert!(
        after.lifecycle.isolated,
        "the rest of the group carries over"
    );
    assert_eq!((after.lifecycle_at, after.lifecycle_by), (9, Some(dev_b())));
    assert_eq!(after.content, before.content);
    assert_eq!(after.placement, before.placement);
    assert_eq!(after.content_at, before.content_at);

    tree.add_agent_workspace("A", "Claude", uid(30), dev_a(), 1);
    assert_eq!(
        set_auto_archive(&mut tree, uid(30), Some("7d"), dev_a(), 9),
        Err(ArchiveError::AgentWorkspace(uid(30)))
    );
    assert_eq!(
        set_auto_archive(&mut tree, uid(10), Some("7d"), dev_a(), 9),
        Err(ArchiveError::NotAWorkspace(uid(10)))
    );
    assert_eq!(
        set_auto_archive(&mut tree, uid(WS), Some("3d"), dev_a(), 9),
        Err(ArchiveError::BadChoice("3d".into()))
    );
}

#[test]
fn a_refused_sweep_changes_neither_document() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    let (t, a) = (tree.to_json().unwrap(), archive.to_json().unwrap());
    let (none, empty) = (BTreeMap::new(), BTreeSet::new());
    let refused = archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("3d", &none, &empty),
        dev_a(),
        30 * DAY,
    );
    assert_eq!(refused, Err(ArchiveError::BadChoice("3d".into())));
    assert_eq!(
        (tree.to_json().unwrap(), archive.to_json().unwrap()),
        (t, a)
    );
}

/// Workspace `W` with tab 10, then a split 50 of panes 51 and 52.
fn tree_with_split() -> Document {
    let mut doc = Document::new();
    doc.add_workspace("W", None, uid(WS), dev_a(), 1);
    doc.add_tab(uid(WS), "T10", "https://10.example/", uid(10), dev_a(), 1);
    doc.add_split(uid(WS), "", uid(50), dev_a(), 1);
    doc.add_tab(uid(50), "Left", "https://l.example/", uid(51), dev_a(), 1);
    doc.add_tab(uid(50), "Right", "https://r.example/", uid(52), dev_a(), 1);
    doc
}

#[test]
fn a_split_is_archived_whole_and_only_when_every_pane_is_idle() {
    let (mut tree, mut archive) = (tree_with_split(), Document::new());
    let (mut last_active, exempt) = (BTreeMap::new(), BTreeSet::new());
    last_active.insert(uid(52), 29 * DAY);
    let swept = archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("7d", &last_active, &exempt),
        dev_a(),
        30 * DAY,
    )
    .unwrap();
    assert_eq!(swept.tabs, vec![uid(10)], "one pane in use keeps the split");
    assert!(tree.node(uid(50)).is_some());

    let swept = sweep(&mut tree, &mut archive, "7d", 40 * DAY);
    assert_eq!(swept, vec![uid(51), uid(52)]);
    assert!(
        tree.node(uid(50)).is_none(),
        "the split left with its panes"
    );
    for (pane, tab) in [(0, 51), (1, 52)] {
        let record = archive
            .node(archived_id(uid(tab)))
            .unwrap()
            .content
            .archived
            .clone()
            .unwrap();
        let split = record.split.unwrap();
        assert_eq!((split.id, split.pane), (uid(50), pane));
        assert_eq!(
            (record.before, record.after),
            (None, None),
            "its neighbour left first"
        );
    }
}

#[test]
fn using_a_pane_touches_its_whole_split_at_most_once_an_hour() {
    let mut tree = tree_with_split();
    assert!(mark_used(&mut tree, uid(51), dev_b(), 10 * HOUR).unwrap());
    for id in [50, 51, 52] {
        assert_eq!(tree.node(uid(id)).unwrap().touched_at, 10 * HOUR, "{id}");
    }
    assert!(!mark_used(&mut tree, uid(51), dev_b(), 10 * HOUR + HOUR - 1).unwrap());
    assert_eq!(tree.node(uid(51)).unwrap().touched_at, 10 * HOUR);
    assert!(mark_used(&mut tree, uid(51), dev_b(), 11 * HOUR).unwrap());

    assert!(mark_used(&mut tree, uid(10), dev_b(), 11 * HOUR).unwrap());
    assert_eq!(tree.node(uid(50)).unwrap().touched_at, 11 * HOUR);
    assert_eq!(
        mark_used(&mut tree, uid(50), dev_b(), 12 * HOUR),
        Err(ArchiveError::NotATab(uid(50)))
    );
}

#[test]
fn a_touch_later_than_the_clock_counts_as_now() {
    let mut tree = tree_with_tabs();
    // A peer whose clock ran a year fast touched tab 10.
    tree.touch(uid(10), dev_b(), 400 * DAY);
    assert!(
        !mark_used(&mut tree, uid(10), dev_a(), 10 * DAY).unwrap(),
        "a future touch is a use now, so there is nothing to stamp"
    );
    let mut archive = Document::new();
    assert!(
        !sweep(&mut tree, &mut archive, "7d", 30 * DAY).contains(&uid(10)),
        "a use now is never idle"
    );
    assert!(!sweep(&mut tree, &mut archive, "7d", 406 * DAY).contains(&uid(10)));
    assert!(
        sweep(&mut tree, &mut archive, "7d", 407 * DAY).contains(&uid(10)),
        "once real time passes the stamp, the period runs out"
    );
}

#[test]
fn a_use_on_another_device_brings_back_a_tab_archived_without_seeing_it() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a_tree = tree_with_tabs();
    pass(&store, &key, dev_a(), TREE, &mut a_tree, 2);
    let mut b_tree = Document::new();
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 3);

    // B selects tab 11; A, which has not read B's file since, archives it.
    mark_used(&mut b_tree, uid(11), dev_b(), 10 * DAY).unwrap();
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 10 * DAY);
    let mut a_archive = Document::new();
    assert!(sweep(&mut a_tree, &mut a_archive, "7d", 10 * DAY + 1).contains(&uid(11)));

    pass(&store, &key, dev_a(), TREE, &mut a_tree, 10 * DAY + 2);
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 10 * DAY + 3);
    assert!(
        a_tree.node(uid(11)).is_some(),
        "the use wins over the stale archive"
    );
    assert!(b_tree.node(uid(11)).is_some());
    assert!(
        a_tree.node(uid(10)).is_none(),
        "an unused tab stays archived"
    );
    assert!(b_tree.node(uid(10)).is_none());
}

/// A tab the user browses in on one device, following links without
/// selecting another tab, is in use there (idle-tab archive spec §2:
/// idleness is the latest use on any device). Its shown tab is exempt only
/// on that device (§4.3), and a navigation writes `content`, which the sweep
/// does not read (§4.2). The host counts a click or key press in the page as
/// a use (§4.1), and that touch keeps another device's sweep off the tab.
#[test]
fn a_tab_browsed_on_one_device_is_not_archived_by_another() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a_tree = tree_with_tabs();
    pass(&store, &key, dev_a(), TREE, &mut a_tree, 2);
    let mut b_tree = Document::new();
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 3);

    // A selected tab 11 on day 1 and has clicked through pages in it every
    // day since.
    mark_used(&mut a_tree, uid(11), dev_a(), DAY).unwrap();
    for day in 2..=9 {
        a_tree.set_content(
            uid(11),
            format!("page {day}"),
            Some(format!("https://11.example/{day}")),
            None,
            None,
            false,
            dev_a(),
            day * DAY,
        );
        mark_used(&mut a_tree, uid(11), dev_a(), day * DAY).unwrap();
        pass(&store, &key, dev_a(), TREE, &mut a_tree, day * DAY + 1);
    }

    pass(&store, &key, dev_b(), TREE, &mut b_tree, 9 * DAY + 2);
    let mut b_archive = Document::new();
    let swept = sweep(&mut b_tree, &mut b_archive, "7d", 9 * DAY + 3);
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 9 * DAY + 4);
    pass(&store, &key, dev_a(), TREE, &mut a_tree, 9 * DAY + 5);

    assert!(
        !swept.contains(&uid(11)),
        "B archived the tab A is browsing in"
    );
    assert!(
        a_tree.node(uid(11)).is_some(),
        "the tab A shows left A's tree"
    );
}

#[test]
fn two_devices_converge_on_one_archive_in_both_orders() {
    let mut a_tree = tree_with_tabs();
    let mut b_tree = a_tree.clone();
    let (mut a, mut b) = (Document::new(), Document::new());
    let none = BTreeMap::new();
    let on = |ids: &[u128]| ids.iter().map(|n| uid(*n)).collect::<BTreeSet<_>>();
    let run = |tree: &mut Document, archive: &mut Document, exempt: &[u128], by, now| {
        archive_idle(tree, archive, &sweep_at("7d", &none, &on(exempt)), by, now)
            .unwrap()
            .tabs
    };
    assert_eq!(
        run(&mut a_tree, &mut a, &[11, 12], dev_a(), 9 * DAY),
        vec![uid(10)]
    );
    assert_eq!(
        run(&mut b_tree, &mut b, &[10, 11], dev_b(), 9 * DAY + 5),
        vec![uid(12)]
    );
    // Both archive tab 11, as two devices sweeping at once do.
    assert_eq!(
        run(&mut a_tree, &mut a, &[12], dev_a(), 20 * DAY),
        vec![uid(11)]
    );
    assert_eq!(
        run(&mut b_tree, &mut b, &[10], dev_b(), 20 * DAY + 7),
        vec![uid(11)]
    );

    let merged = read_both_ways(&a, &b);
    let ids: BTreeSet<NodeId> = merged.nodes.keys().copied().collect();
    let expected: BTreeSet<NodeId> = [10, 11, 12].map(|n| archived_id(uid(n))).into();
    assert_eq!(ids, expected, "one entry per tab, the shared one merged");
    read_both_ways(&a_tree, &b_tree);
}

#[test]
fn an_entry_older_than_the_retention_period_is_dropped_and_stays_dropped() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut tree, mut a) = (tree_with_tabs(), Document::new());
    sweep(&mut tree, &mut a, "7d", 10 * DAY);
    archive_pass(&store, &key, dev_a(), &mut a, 10 * DAY, 30 * DAY);
    let mut b = Document::new();
    archive_pass(&store, &key, dev_b(), &mut b, 10 * DAY + 1, 30 * DAY);
    assert_eq!(b.nodes.len(), 3);

    archive_pass(&store, &key, dev_a(), &mut a, 40 * DAY - 1, 30 * DAY);
    assert_eq!(a.nodes.len(), 3, "kept until the period has passed");
    archive_pass(&store, &key, dev_a(), &mut a, 40 * DAY, 30 * DAY);
    assert!(a.nodes.is_empty(), "dropped once it has");

    // B's file still holds the entries, and A never takes them back.
    archive_pass(&store, &key, dev_a(), &mut a, 40 * DAY + 1, 30 * DAY);
    assert!(a.nodes.is_empty());
    // B drops them on reading A's file, before its own period would.
    archive_pass(&store, &key, dev_b(), &mut b, 40 * DAY + 2, 90 * DAY);
    assert!(b.nodes.is_empty(), "A's drop reached B");
}

#[test]
fn an_expired_entry_a_peer_marked_restored_is_not_added_back() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut a_tree, mut a) = (tree_with_tabs(), Document::new());
    sweep(&mut a_tree, &mut a, "7d", 10 * DAY);
    archive_pass(&store, &key, dev_a(), &mut a, 10 * DAY, 30 * DAY);
    let (mut b_tree, mut b) = (tree_with_tabs(), Document::new());
    archive_pass(&store, &key, dev_b(), &mut b, 10 * DAY + 1, 30 * DAY);

    archive_pass(&store, &key, dev_a(), &mut a, 41 * DAY, 30 * DAY);
    assert!(a.nodes.is_empty());
    // B's clock is two days slow: it restores an entry A has expired, and
    // publishes the mark, news to A.
    let entry = archived_id(uid(10));
    restore(
        &mut b_tree,
        &mut b,
        entry,
        uid(WS),
        &[uid(90)],
        dev_b(),
        39 * DAY,
    )
    .unwrap();
    sync(&store, &key, dev_b(), ARCHIVE, &mut b, 39 * DAY).unwrap();

    let report = sync_expiring(
        &store,
        &key,
        dev_a(),
        ARCHIVE,
        &mut a,
        41 * DAY + 1,
        Some(30 * DAY),
    )
    .unwrap();
    assert!(
        a.nodes.is_empty(),
        "the restored mark did not bring it back"
    );
    assert!(report.changed.is_empty() && report.removed.is_empty());
}

#[test]
fn an_entry_closed_later_than_the_clock_is_kept() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    sweep(&mut tree, &mut archive, "7d", 400 * DAY);
    assert!(expire(&mut archive, 30 * DAY, 100 * DAY).is_empty());
    assert_eq!(archive.nodes.len(), 3);
    assert_eq!(expire(&mut archive, 30 * DAY, 430 * DAY).len(), 3);
}

#[test]
fn a_restore_puts_the_tab_back_between_its_neighbours() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    let (mut last_active, empty) = (BTreeMap::new(), BTreeSet::new());
    last_active.insert(uid(10), 9 * DAY);
    last_active.insert(uid(12), 9 * DAY);
    archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("7d", &last_active, &empty),
        dev_a(),
        9 * DAY,
    )
    .unwrap();
    tree.add_tab(
        uid(WS),
        "T13",
        "https://13.example/",
        uid(13),
        dev_a(),
        9 * DAY,
    );

    let done = restore(
        &mut tree,
        &mut archive,
        archived_id(uid(11)),
        uid(WS),
        &[uid(90)],
        dev_b(),
        10 * DAY,
    )
    .unwrap();
    assert_eq!(
        (done.tabs, done.split, done.workspace),
        (vec![uid(90)], None, uid(WS))
    );
    assert_eq!(children(&tree, uid(WS)), [10, 90, 12, 13].map(uid).to_vec());
    let tab = tree.node(uid(90)).unwrap();
    assert_eq!(tab.content.url.as_deref(), Some("https://11.example/"));
    assert_eq!(tab.content.name, "T11");
    let entry = archive.node(archived_id(uid(11))).unwrap();
    assert!(entry.lifecycle.restored);
    assert_eq!(
        (entry.lifecycle_at, entry.lifecycle_by),
        (10 * DAY, Some(dev_b()))
    );
}

#[test]
fn a_restore_without_its_neighbours_or_workspace_goes_at_the_end() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    let (mut last_active, empty) = (BTreeMap::new(), BTreeSet::new());
    last_active.insert(uid(10), 9 * DAY);
    archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("7d", &last_active, &empty),
        dev_a(),
        9 * DAY,
    )
    .unwrap();
    tree.remove(uid(10));
    tree.add_tab(
        uid(WS),
        "T13",
        "https://13.example/",
        uid(13),
        dev_a(),
        9 * DAY,
    );
    tree.add_tab(
        uid(WS),
        "T14",
        "https://14.example/",
        uid(14),
        dev_a(),
        9 * DAY,
    );
    restore(
        &mut tree,
        &mut archive,
        archived_id(uid(11)),
        uid(WS),
        &[uid(90)],
        dev_a(),
        10 * DAY,
    )
    .unwrap();
    // Tab 12 was archived too, so tab 11 has no neighbour left.
    assert_eq!(children(&tree, uid(WS)), [13, 14, 90].map(uid).to_vec());

    tree.add_workspace("Now", None, uid(2), dev_a(), 10 * DAY);
    tree.add_tab(
        uid(2),
        "here",
        "https://h.example/",
        uid(3),
        dev_a(),
        10 * DAY,
    );
    tree.remove(uid(WS));
    let done = restore(
        &mut tree,
        &mut archive,
        archived_id(uid(12)),
        uid(2),
        &[uid(91)],
        dev_a(),
        11 * DAY,
    )
    .unwrap();
    assert_eq!(done.workspace, uid(2));
    assert_eq!(children(&tree, uid(2)), vec![uid(3), uid(91)]);
}

#[test]
fn a_split_restores_as_a_split_in_pane_order() {
    let (mut tree, mut archive) = (tree_with_split(), Document::new());
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);
    assert_eq!(
        crate::archive::ids_needed(&archive, archived_id(uid(52))),
        Ok(3)
    );
    let refused = restore(
        &mut tree,
        &mut archive,
        archived_id(uid(52)),
        uid(WS),
        &[uid(80)],
        dev_a(),
        31 * DAY,
    );
    assert_eq!(
        refused,
        Err(ArchiveError::WrongIdCount {
            needed: 3,
            given: 1
        })
    );

    tree.add_tab(
        uid(WS),
        "after",
        "https://x.example/",
        uid(60),
        dev_a(),
        30 * DAY,
    );
    let done = restore(
        &mut tree,
        &mut archive,
        archived_id(uid(52)),
        uid(WS),
        &[uid(80), uid(81), uid(82)],
        dev_a(),
        31 * DAY,
    )
    .unwrap();
    assert_eq!(done.split, Some(uid(80)));
    assert_eq!(tree.node(uid(80)).unwrap().kind, NodeKind::Split);
    assert_eq!(children(&tree, uid(80)), vec![uid(81), uid(82)]);
    assert_eq!(tree.node(uid(81)).unwrap().content.name, "Left");
    assert_eq!(tree.node(uid(82)).unwrap().content.name, "Right");
    assert!(
        archive
            .node(archived_id(uid(51)))
            .unwrap()
            .lifecycle
            .restored
    );
    assert!(
        archive
            .node(archived_id(uid(52)))
            .unwrap()
            .lifecycle
            .restored
    );
}

#[test]
fn a_refused_restore_changes_neither_document() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);
    tree.add_tab(
        uid(WS),
        "taken",
        "https://x.example/",
        uid(90),
        dev_a(),
        30 * DAY,
    );
    let unchanged =
        |tree: &Document, archive: &Document| (tree.to_json().unwrap(), archive.to_json().unwrap());
    let before = unchanged(&tree, &archive);
    let entry = archived_id(uid(10));
    assert_eq!(
        restore(
            &mut tree,
            &mut archive,
            entry,
            uid(WS),
            &[uid(90)],
            dev_a(),
            31 * DAY
        ),
        Err(ArchiveError::IdInUse(uid(90)))
    );
    assert_eq!(unchanged(&tree, &archive), before);
    tree.remove(uid(WS));
    let before = unchanged(&tree, &archive);
    assert_eq!(
        restore(
            &mut tree,
            &mut archive,
            entry,
            uid(77),
            &[uid(91)],
            dev_a(),
            31 * DAY
        ),
        Err(ArchiveError::NoWorkspace(uid(77)))
    );
    assert_eq!(
        restore(
            &mut tree,
            &mut archive,
            uid(10),
            uid(WS),
            &[uid(91)],
            dev_a(),
            31 * DAY
        ),
        Err(ArchiveError::NotAnEntry(uid(10)))
    );
    assert_eq!(unchanged(&tree, &archive), before);
}

#[test]
fn a_restore_never_fights_the_original_delete() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a_tree = tree_with_tabs();
    pass(&store, &key, dev_a(), TREE, &mut a_tree, 2);
    let mut b_tree = Document::new();
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 3);

    let mut a_archive = Document::new();
    sweep(&mut a_tree, &mut a_archive, "7d", 10 * DAY);
    archive_pass(&store, &key, dev_a(), &mut a_archive, 10 * DAY, 30 * DAY);
    pass(&store, &key, dev_a(), TREE, &mut a_tree, 10 * DAY);

    // B gets the entry before the tree's delete, and restores tab 11 while
    // it still holds the original.
    let mut b_archive = Document::new();
    archive_pass(
        &store,
        &key,
        dev_b(),
        &mut b_archive,
        10 * DAY + 1,
        30 * DAY,
    );
    assert!(b_tree.node(uid(11)).is_some());
    restore(
        &mut b_tree,
        &mut b_archive,
        archived_id(uid(11)),
        uid(WS),
        &[uid(90)],
        dev_b(),
        10 * DAY + 2,
    )
    .unwrap();

    for _ in 0..2 {
        pass(&store, &key, dev_b(), TREE, &mut b_tree, 10 * DAY + 3);
        pass(&store, &key, dev_a(), TREE, &mut a_tree, 10 * DAY + 4);
        archive_pass(
            &store,
            &key,
            dev_b(),
            &mut b_archive,
            10 * DAY + 3,
            30 * DAY,
        );
        archive_pass(
            &store,
            &key,
            dev_a(),
            &mut a_archive,
            10 * DAY + 4,
            30 * DAY,
        );
    }
    for tree in [&a_tree, &b_tree] {
        assert!(tree.node(uid(11)).is_none(), "the original stays deleted");
        assert!(tree.node(uid(90)).is_some(), "the restored tab stays");
    }
    assert!(
        a_archive
            .node(archived_id(uid(11)))
            .unwrap()
            .lifecycle
            .restored,
        "the mark synced"
    );
}

#[test]
fn an_entry_round_trips_through_an_older_build() {
    let (mut tree, mut archive) = (tree_with_split(), Document::new());
    set_auto_archive(&mut tree, uid(WS), Some("7d"), dev_a(), 2).unwrap();
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);
    restore(
        &mut tree,
        &mut archive,
        archived_id(uid(10)),
        uid(WS),
        &[uid(90)],
        dev_a(),
        31 * DAY,
    )
    .unwrap();
    for json in [archive.to_json().unwrap(), tree.to_json().unwrap()] {
        let older = json
            .replace("\"archived\"", "\"from-a-newer-build\"")
            .replace("\"auto_archive\"", "\"newer-choice\"")
            .replace("\"restored\"", "\"newer-mark\"");
        assert_ne!(
            older, json,
            "each document holds a field an older build lacks"
        );
        let rewritten = Document::from_json(&older).unwrap().to_json().unwrap();
        let as_value = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
        assert_eq!(as_value(&rewritten), as_value(&older));
    }
}

#[test]
fn an_entry_names_the_neighbours_that_stay_when_its_own_leave_with_it() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    tree.add_tab(uid(WS), "T13", "https://13.example/", uid(13), dev_a(), 1);
    let (mut last_active, empty) = (BTreeMap::new(), BTreeSet::new());
    last_active.insert(uid(13), 9 * DAY);
    let swept = archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("7d", &last_active, &empty),
        dev_a(),
        9 * DAY,
    )
    .unwrap();
    assert_eq!(swept.tabs, [10, 11, 12].map(uid).to_vec());
    let record = archive
        .node(archived_id(uid(11)))
        .unwrap()
        .content
        .archived
        .clone()
        .unwrap();
    assert_eq!((record.before, record.after), (None, Some(uid(13))));

    tree.add_tab(
        uid(WS),
        "T14",
        "https://14.example/",
        uid(14),
        dev_a(),
        9 * DAY,
    );
    restore(
        &mut tree,
        &mut archive,
        archived_id(uid(11)),
        uid(WS),
        &[uid(90)],
        dev_a(),
        10 * DAY,
    )
    .unwrap();
    assert_eq!(children(&tree, uid(WS)), [90, 13, 14].map(uid).to_vec());
}

#[test]
fn a_restore_refuses_the_archived_tabs_own_id() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);
    assert_eq!(
        restore(
            &mut tree,
            &mut archive,
            archived_id(uid(11)),
            uid(WS),
            &[uid(11)],
            dev_a(),
            31 * DAY
        ),
        Err(ArchiveError::IdInUse(uid(11)))
    );
}

#[test]
fn archiving_a_tab_again_keeps_what_a_newer_build_wrote_to_its_entry() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);
    let id = archived_id(uid(10));
    let node = archive.node_mut(id).unwrap();
    node.content
        .extra
        .insert("newer".into(), serde_json::json!(1));
    let record = node.content.archived.as_mut().unwrap();
    record
        .extra
        .insert("newer_too".into(), serde_json::json!(2));
    let mut again = record.clone();
    again.closed_at = 40 * DAY;
    again.extra.clear();

    archive.add_archived("T10", None, None, again, dev_b(), 40 * DAY);
    let node = archive.node(id).unwrap();
    assert_eq!(node.content.extra["newer"], 1);
    let record = node.content.archived.as_ref().unwrap();
    assert_eq!(record.extra["newer_too"], 2);
    assert_eq!(record.closed_at, 40 * DAY, "the rest is the newer record");
}

#[test]
fn a_split_restore_takes_only_the_panes_one_sweep_archived() {
    let (mut tree, mut archive) = (tree_with_split(), Document::new());
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);
    // An entry an earlier archiving of the same split left.
    let mut stale = archive
        .node(archived_id(uid(51)))
        .unwrap()
        .content
        .archived
        .clone()
        .unwrap();
    stale.tab = uid(53);
    stale.closed_at = 20 * DAY;
    archive.add_archived("Old", None, None, stale, dev_a(), 20 * DAY);

    assert_eq!(
        crate::archive::ids_needed(&archive, archived_id(uid(51))),
        Ok(3)
    );
    assert_eq!(
        crate::archive::ids_needed(&archive, archived_id(uid(53))),
        Ok(1)
    );
}

#[test]
fn a_split_a_peer_archived_without_seeing_a_pane_used_comes_back_whole() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a_tree = tree_with_split();
    pass(&store, &key, dev_a(), TREE, &mut a_tree, 2);
    let mut b_tree = Document::new();
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 3);

    mark_used(&mut b_tree, uid(51), dev_b(), 10 * DAY).unwrap();
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 10 * DAY);
    let mut a_archive = Document::new();
    assert!(sweep(&mut a_tree, &mut a_archive, "7d", 10 * DAY + 1).contains(&uid(51)));

    pass(&store, &key, dev_a(), TREE, &mut a_tree, 10 * DAY + 2);
    pass(&store, &key, dev_b(), TREE, &mut b_tree, 10 * DAY + 3);
    for tree in [&a_tree, &b_tree] {
        assert_eq!(
            children(tree, uid(50)),
            vec![uid(51), uid(52)],
            "the split is whole"
        );
        assert_eq!(tree.node(uid(50)).unwrap().placement.parent, Some(uid(WS)));
    }
}

#[test]
fn archive_now_takes_a_tab_in_use_under_never_and_restore_puts_it_back() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    set_auto_archive(&mut tree, uid(WS), Some("never"), dev_a(), 1).unwrap();
    let swept = archive_now(&mut tree, &mut archive, uid(11), dev_a(), 5).unwrap();
    assert_eq!(swept.tabs, vec![uid(11)]);
    assert_eq!(swept.entries, vec![archived_id(uid(11))]);
    assert!(tree.node(uid(11)).is_none(), "the tab left the tree");
    let record = archive
        .node(archived_id(uid(11)))
        .and_then(|n| n.content.archived.clone())
        .unwrap();
    assert_eq!(
        (record.before, record.after, record.closed_at),
        (Some(uid(10)), Some(uid(12)), 5)
    );

    let restored = restore(
        &mut tree,
        &mut archive,
        archived_id(uid(11)),
        uid(WS),
        &[uid(99)],
        dev_a(),
        6,
    )
    .unwrap();
    assert_eq!(restored.tabs, vec![uid(99)]);
    assert_eq!(
        children(&tree, uid(WS)),
        vec![uid(10), uid(99), uid(12)],
        "back between its neighbours"
    );
}

#[test]
fn archive_now_on_a_pane_takes_its_split_whole() {
    let (mut tree, mut archive) = (tree_with_split(), Document::new());
    let swept = archive_now(&mut tree, &mut archive, uid(52), dev_a(), 5).unwrap();
    assert_eq!(swept.tabs, vec![uid(51), uid(52)]);
    assert!(
        tree.node(uid(50)).is_none(),
        "the split left with its panes"
    );
    assert!(tree.node(uid(10)).is_some());
}

#[test]
fn archive_now_refuses_what_the_sweep_never_archives_and_changes_nothing() {
    let mut tree = tree_with_tabs();
    tree.add_group(uid(WS), "G", None, uid(20), dev_a(), 1);
    tree.add_tab(
        uid(20),
        "in group",
        "https://g.example/",
        uid(21),
        dev_a(),
        1,
    );
    tree.add_agent_workspace("Agent", "Claude", uid(30), dev_a(), 1);
    tree.add_tab(
        uid(30),
        "agent's",
        "https://a.example/",
        uid(31),
        dev_a(),
        1,
    );
    let mut archive = Document::new();
    let (t, a) = (tree.to_json().unwrap(), archive.to_json().unwrap());

    for (id, refusal) in [
        (uid(21), ArchiveError::NotArchivable(uid(21))),
        (uid(20), ArchiveError::NotATab(uid(20))),
        (uid(31), ArchiveError::AgentWorkspace(uid(30))),
        (uid(77), ArchiveError::NoSuchNode(uid(77))),
    ] {
        assert_eq!(
            archive_now(&mut tree, &mut archive, id, dev_a(), 5),
            Err(refusal)
        );
    }
    assert_eq!(
        (tree.to_json().unwrap(), archive.to_json().unwrap()),
        (t, a)
    );
}

/// A tab another browser archived at `closed_at`, minted as tab `n`, whose
/// workspace is `ws`.
fn imported(n: u128, ws: u128, closed_at: Timestamp) -> Imported {
    Imported {
        tab: uid(n),
        title: format!("I{n}"),
        url: Some(format!("https://{n}.example/")),
        workspace: uid(ws),
        workspace_name: "Arc".to_string(),
        closed_at,
    }
}

#[test]
fn an_imported_tab_keeps_its_closed_time_and_restores_into_its_workspace() {
    let (mut tree, mut archive) = (tree_with_tabs(), Document::new());
    let ids = add_imported(
        &mut archive,
        &[imported(40, WS, 2 * DAY), imported(41, 99, 3 * DAY)],
        dev_a(),
        5 * DAY,
    )
    .unwrap();
    assert_eq!(ids, vec![archived_id(uid(40)), archived_id(uid(41))]);
    let entry = archive.node(ids[0]).unwrap();
    assert_eq!(entry.content.name, "I40");
    let record = entry.content.archived.as_ref().unwrap();
    assert_eq!(
        (record.closed_at, record.workspace, record.split.is_none()),
        (2 * DAY, uid(WS), true)
    );

    restore(
        &mut tree,
        &mut archive,
        ids[0],
        uid(WS),
        &[uid(80)],
        dev_a(),
        6 * DAY,
    )
    .unwrap();
    assert_eq!(children(&tree, uid(WS)).last(), Some(&uid(80)));

    // Workspace 99 is in no tree, so the tab goes to the current one.
    tree.add_workspace("Now", None, uid(2), dev_a(), 6 * DAY);
    let done = restore(
        &mut tree,
        &mut archive,
        ids[1],
        uid(2),
        &[uid(81)],
        dev_a(),
        6 * DAY,
    )
    .unwrap();
    assert_eq!(done.workspace, uid(2));
    assert_eq!(children(&tree, uid(2)), vec![uid(81)]);
}

#[test]
fn an_imported_tab_closed_later_than_the_clock_counts_as_closed_now() {
    let mut archive = Document::new();
    let ids = add_imported(&mut archive, &[imported(40, WS, 9 * DAY)], dev_a(), 5 * DAY).unwrap();
    let record = archive
        .node(ids[0])
        .unwrap()
        .content
        .archived
        .clone()
        .unwrap();
    assert_eq!(record.closed_at, 5 * DAY);
}

#[test]
fn an_import_naming_a_held_or_repeated_tab_adds_nothing() {
    let mut archive = Document::new();
    add_imported(&mut archive, &[imported(40, WS, DAY)], dev_a(), 2 * DAY).unwrap();
    let before = archive.to_json().unwrap();
    assert_eq!(
        add_imported(
            &mut archive,
            &[imported(41, WS, DAY), imported(40, WS, DAY)],
            dev_a(),
            2 * DAY
        ),
        Err(ArchiveError::IdInUse(uid(40)))
    );
    assert_eq!(
        add_imported(
            &mut archive,
            &[imported(42, WS, DAY), imported(42, WS, DAY)],
            dev_a(),
            2 * DAY
        ),
        Err(ArchiveError::IdInUse(uid(42)))
    );
    assert_eq!(archive.to_json().unwrap(), before);
}

#[test]
fn an_imported_tab_expires_by_its_own_closed_time() {
    let (store, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut archive = Document::new();
    add_imported(
        &mut archive,
        &[imported(40, WS, DAY), imported(41, WS, 20 * DAY)],
        dev_a(),
        25 * DAY,
    )
    .unwrap();
    archive_pass(&store, &key, dev_a(), &mut archive, 31 * DAY, 30 * DAY);
    assert_eq!(
        archive.nodes.keys().copied().collect::<Vec<_>>(),
        vec![archived_id(uid(41))],
        "the one closed 30 days before the pass is dropped"
    );
}

#[test]
fn each_period_choice_is_its_length() {
    assert_eq!(period("12h"), Ok(Some(12 * HOUR)));
    assert_eq!(period("24h"), Ok(Some(DAY)));
    assert_eq!(period("7d"), Ok(Some(7 * DAY)));
    assert_eq!(period("30d"), Ok(Some(30 * DAY)));
    assert_eq!(period("never"), Ok(None));
    assert!(period("1h").is_err());
}

#[test]
fn each_refusal_has_the_code_the_host_contract_names() {
    // `docs/host-contract.md` §8 lists the codes a host branches on.
    let id = uid(WS);
    assert_eq!(ArchiveError::NoSuchNode(id).code(), "no_such_node");
    assert_eq!(ArchiveError::NoWorkspace(id).code(), "no_such_parent");
    assert_eq!(ArchiveError::IdInUse(id).code(), "id_in_use");
    assert_eq!(ArchiveError::NotAnEntry(id).code(), "invalid_argument");
}

#[test]
fn a_split_of_three_panes_takes_an_id_for_each_and_one_for_itself() {
    let (mut tree, mut archive) = (tree_with_split(), Document::new());
    tree.add_tab(uid(50), "Third", "https://3.example/", uid(53), dev_a(), 1);
    sweep(&mut tree, &mut archive, "7d", 30 * DAY);

    assert_eq!(
        crate::archive::ids_needed(&archive, archived_id(uid(53))),
        Ok(4)
    );
}

#[test]
fn a_split_holding_anything_but_tabs_or_nothing_is_never_archived() {
    let mut tree = Document::new();
    tree.add_workspace("W", None, uid(WS), dev_a(), 1);
    tree.add_split(uid(WS), "", uid(50), dev_a(), 1);
    tree.add_split(uid(WS), "", uid(60), dev_a(), 1);
    tree.add_tab(uid(60), "Pane", "https://p.example/", uid(61), dev_a(), 1);
    tree.add_group(uid(60), "Odd", None, uid(62), dev_a(), 1);
    let mut archive = Document::new();

    let swept = sweep(&mut tree, &mut archive, "7d", 30 * DAY);

    assert!(swept.is_empty(), "{swept:?}");
    assert!(tree.node(uid(50)).is_some() && tree.node(uid(61)).is_some());
}

#[test]
fn a_tab_restores_between_the_neighbours_it_left() {
    // Tab 14 sits between 10 and 13, whose keys are closer together than a
    // key made after 10 alone, so only a key between both lands it there.
    let mut tree = Document::new();
    tree.add_workspace("W", None, uid(WS), dev_a(), 1);
    for n in [10, 11, 13, 14] {
        tree.add_tab(
            uid(WS),
            format!("T{n}"),
            "https://t.example/",
            uid(n),
            dev_a(),
            1,
        );
    }
    crate::tree::move_node(
        &mut tree,
        uid(13),
        uid(WS),
        Some(uid(10)),
        Some(uid(11)),
        dev_a(),
        1,
    )
    .unwrap();
    crate::tree::move_node(
        &mut tree,
        uid(14),
        uid(WS),
        Some(uid(10)),
        Some(uid(13)),
        dev_a(),
        1,
    )
    .unwrap();
    assert_eq!(
        children(&tree, uid(WS)),
        vec![uid(10), uid(14), uid(13), uid(11)]
    );
    let mut archive = Document::new();
    let (mut last_active, exempt) = (BTreeMap::new(), BTreeSet::new());
    for n in [10, 11, 13] {
        last_active.insert(uid(n), 29 * DAY);
    }
    let swept = archive_idle(
        &mut tree,
        &mut archive,
        &sweep_at("7d", &last_active, &exempt),
        dev_a(),
        30 * DAY,
    )
    .unwrap();
    assert_eq!(swept.tabs, vec![uid(14)]);

    restore(
        &mut tree,
        &mut archive,
        archived_id(uid(14)),
        uid(WS),
        &[uid(90)],
        dev_a(),
        31 * DAY,
    )
    .unwrap();

    assert_eq!(
        children(&tree, uid(WS)),
        vec![uid(10), uid(90), uid(13), uid(11)]
    );
}
