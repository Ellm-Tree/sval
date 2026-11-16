// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The `favorites` document's behaviour (favorites-native spec): its kinds
//! and ids, the home-page pin, folder deletes, repair to Favorites, and two
//! collections meeting for the first time.

use crate::merge::merge;
use crate::store::DeviceId;
use crate::tree::repair_unreachable_ancestry;
use crate::types::test_support::{dev_a, dev_b, read_both_ways};
use crate::types::{
    Document, FAVORITE_ROOT_GUIDS, NodeId, NodeKind, PINS_GUID, STRANDED_FAVORITES_GUID, Timestamp,
    favorite_id, is_favorite_root, setting_id,
};

const TOOLBAR: &str = "toolbar_____";

/// A document holding the roots, as a profile's first start writes
/// them (favorites-native spec §5.1).
fn with_roots(by: DeviceId) -> Document {
    let mut doc = Document::new();
    for guid in FAVORITE_ROOT_GUIDS {
        doc.add_favorite(NodeKind::Folder, guid, None, None, None, "", None, by, 0);
    }
    doc
}

/// Two devices meeting in the `favorites` document for the first time:
/// neither has a watermark for the other yet, so everything each holds is
/// news to the other.
fn two_joining_peers() -> (Document, Document) {
    let (mut a, mut b) = (with_roots(dev_a()), with_roots(dev_b()));
    a.stamp_write(dev_a(), 1);
    b.stamp_write(dev_b(), 1);
    (a, b)
}

/// Two devices that have each seen the other up to `at`.
fn two_peers(at: Timestamp) -> (Document, Document) {
    let (mut a, mut b) = (with_roots(dev_a()), with_roots(dev_b()));
    a.stamp_write(dev_a(), at);
    b.stamp_write(dev_b(), at);
    a.seen.insert(dev_b(), at);
    b.seen.insert(dev_a(), at);
    (a, b)
}

fn favorite(
    doc: &mut Document,
    guid: &str,
    parent: &str,
    url: &str,
    by: DeviceId,
    now: Timestamp,
) -> NodeId {
    doc.add_favorite(
        NodeKind::Favorite,
        guid,
        Some(favorite_id(parent)),
        None,
        None,
        "Example",
        Some(url.into()),
        by,
        now,
    )
}

fn folder(
    doc: &mut Document,
    guid: &str,
    parent: &str,
    name: &str,
    by: DeviceId,
    now: Timestamp,
) -> NodeId {
    doc.add_favorite(
        NodeKind::Folder,
        guid,
        Some(favorite_id(parent)),
        None,
        None,
        name,
        None,
        by,
        now,
    )
}

/// Both merge directions, each then read as a device reads it: repaired. Asserts the two agree and returns one.
#[test]
fn favorite_ids_are_derived_from_the_guid_and_never_collide_with_a_setting() {
    assert_eq!(favorite_id("abcdefghijkl"), favorite_id("abcdefghijkl"));
    assert_ne!(favorite_id("abcdefghijkl"), favorite_id("abcdefghijkm"));
    assert_ne!(favorite_id(TOOLBAR), setting_id(TOOLBAR));
    assert!(is_favorite_root(favorite_id(STRANDED_FAVORITES_GUID)));
    assert!(!is_favorite_root(favorite_id("abcdefghijkl")));
}

#[test]
fn every_favorite_kind_and_its_guid_round_trip_through_json() {
    let mut doc = with_roots(dev_a());
    let f = folder(&mut doc, "folder000001", TOOLBAR, "Work", dev_a(), 5);
    let p = favorite(
        &mut doc,
        "page00000001",
        TOOLBAR,
        "https://e.example/",
        dev_a(),
        5,
    );
    let s = doc.add_favorite(
        NodeKind::Separator,
        "separator001",
        Some(favorite_id(TOOLBAR)),
        None,
        None,
        "",
        None,
        dev_a(),
        5,
    );

    let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
    assert_eq!(back.node(f).unwrap().kind, NodeKind::Folder);
    assert_eq!(back.node(p).unwrap().kind, NodeKind::Favorite);
    assert_eq!(back.node(s).unwrap().kind, NodeKind::Separator);
    assert_eq!(
        back.node(p).unwrap().content.guid.as_deref(),
        Some("page00000001")
    );
    let json: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
    assert_eq!(json["nodes"][s.to_string()]["kind"], "separator");
}

#[test]
fn a_favorite_lands_between_the_siblings_it_is_given() {
    let mut doc = with_roots(dev_a());
    let first = favorite(
        &mut doc,
        "page00000001",
        TOOLBAR,
        "https://1.example/",
        dev_a(),
        5,
    );
    let last = favorite(
        &mut doc,
        "page00000003",
        TOOLBAR,
        "https://3.example/",
        dev_a(),
        5,
    );
    let middle = doc.add_favorite(
        NodeKind::Favorite,
        "page00000002",
        Some(favorite_id(TOOLBAR)),
        Some(first),
        Some(last),
        "Two",
        Some("https://2.example/".into()),
        dev_a(),
        5,
    );
    let order = |id| doc.node(id).unwrap().placement.order.clone();
    assert!(order(first) < order(middle) && order(middle) < order(last));
}

#[test]
fn a_favorite_given_one_neighbour_lands_beside_it() {
    let mut doc = with_roots(dev_a());
    let first = favorite(
        &mut doc,
        "page00000001",
        TOOLBAR,
        "https://1.example/",
        dev_a(),
        5,
    );
    let ahead = doc.add_favorite(
        NodeKind::Favorite,
        "page00000002",
        Some(favorite_id(TOOLBAR)),
        None,
        Some(first),
        "Ahead",
        Some("https://2.example/".into()),
        dev_a(),
        5,
    );
    let order = |id| doc.node(id).unwrap().placement.order.clone();
    assert!(order(ahead) < order(first));
}

#[test]
fn a_pin_is_a_node_under_the_pins_root_at_any_depth() {
    let mut doc = with_roots(dev_a());
    assert!(is_favorite_root(favorite_id(PINS_GUID)));
    let kept = favorite(
        &mut doc,
        "page00000001",
        TOOLBAR,
        "https://1.example/",
        dev_a(),
        5,
    );
    let work = folder(&mut doc, "folder000001", PINS_GUID, "Work", dev_a(), 5);
    let pin = favorite(
        &mut doc,
        "page00000002",
        "folder000001",
        "https://2.example/",
        dev_a(),
        5,
    );

    assert!(!doc.is_pin(kept));
    assert!(doc.is_pin(work));
    assert!(doc.is_pin(pin));
    assert!(!doc.is_pin(favorite_id(PINS_GUID)), "the root is no pin");
}

#[test]
fn deleting_a_folder_deletes_what_is_in_it_and_nothing_else() {
    let mut doc = with_roots(dev_a());
    let work = folder(&mut doc, "folder000001", TOOLBAR, "Work", dev_a(), 5);
    let inner = doc.add_favorite(
        NodeKind::Folder,
        "folder000002",
        Some(work),
        None,
        None,
        "Inner",
        None,
        dev_a(),
        5,
    );
    let deep = doc.add_favorite(
        NodeKind::Favorite,
        "page00000001",
        Some(inner),
        None,
        None,
        "Deep",
        Some("https://d.example/".into()),
        dev_a(),
        5,
    );
    let outside = favorite(
        &mut doc,
        "page00000002",
        TOOLBAR,
        "https://o.example/",
        dev_a(),
        5,
    );

    doc.remove(work);

    for gone in [work, inner, deep] {
        assert!(doc.node(gone).is_none());
    }
    assert!(doc.node(outside).is_some());
    assert!(doc.node(favorite_id(TOOLBAR)).is_some());
}

#[test]
fn the_roots_are_roots_and_a_stranded_favorite_goes_to_favorites() {
    let mut doc = with_roots(dev_a());
    let lost = doc.add_favorite(
        NodeKind::Favorite,
        "page00000001",
        Some(favorite_id("gonefolder01")),
        None,
        None,
        "Lost",
        Some("https://l.example/".into()),
        dev_a(),
        5,
    );

    let repaired = repair_unreachable_ancestry(&mut doc);

    assert_eq!(repaired, vec![lost]);
    assert_eq!(
        doc.node(lost).unwrap().placement.parent,
        Some(favorite_id(STRANDED_FAVORITES_GUID))
    );
    for guid in FAVORITE_ROOT_GUIDS {
        assert_eq!(doc.node(favorite_id(guid)).unwrap().placement.parent, None);
    }
}

#[test]
fn without_favorites_a_stranded_favorite_goes_to_the_lowest_root() {
    let mut doc = with_roots(dev_a());
    doc.remove(favorite_id(STRANDED_FAVORITES_GUID));
    let lost = doc.add_favorite(
        NodeKind::Favorite,
        "page00000001",
        Some(favorite_id("gonefolder01")),
        None,
        None,
        "Lost",
        Some("https://l.example/".into()),
        dev_a(),
        5,
    );

    repair_unreachable_ancestry(&mut doc);

    let lowest = FAVORITE_ROOT_GUIDS
        .iter()
        .filter(|&&g| g != STRANDED_FAVORITES_GUID)
        .map(|g| favorite_id(g))
        .min();
    assert_eq!(doc.node(lost).unwrap().placement.parent, lowest);
}

#[test]
fn a_favorite_filed_under_a_tab_goes_to_favorites() {
    // A tab or a split holds no favorite, so one a merge put there is
    // stranded like one whose folder is gone.
    let mut doc = with_roots(dev_a());
    let ws = doc.add_workspace("W", None, NodeId::from_u128(1), dev_a(), 1);
    let tab = doc.add_tab(
        ws,
        "T",
        "https://t.example/",
        NodeId::from_u128(2),
        dev_a(),
        1,
    );
    let lost = favorite(
        &mut doc,
        "page00000001",
        TOOLBAR,
        "https://l.example/",
        dev_a(),
        5,
    );
    doc.node_mut(lost).unwrap().placement.parent = Some(tab);

    repair_unreachable_ancestry(&mut doc);

    assert_eq!(
        doc.node(lost).unwrap().placement.parent,
        Some(favorite_id(STRANDED_FAVORITES_GUID))
    );
}

#[test]
fn a_stranded_favorite_is_never_filed_under_a_workspace() {
    let mut doc = Document::new();
    let ws = doc.add_workspace("W", None, NodeId::from_u128(1), dev_a(), 1);
    let lost = doc.add_favorite(
        NodeKind::Favorite,
        "page00000001",
        Some(favorite_id("gonefolder01")),
        None,
        None,
        "Lost",
        Some("https://l.example/".into()),
        dev_a(),
        5,
    );

    repair_unreachable_ancestry(&mut doc);

    assert_ne!(doc.node(lost).unwrap().placement.parent, Some(ws));
}

#[test]
fn a_rename_on_one_device_and_a_move_on_the_other_both_survive() {
    let (mut a, mut b) = two_peers(100);
    let page = favorite(
        &mut a,
        "page00000001",
        TOOLBAR,
        "https://e.example/",
        dev_a(),
        10,
    );
    let work = folder(&mut a, "folder000001", TOOLBAR, "Work", dev_a(), 10);
    for id in [page, work] {
        b.nodes.insert(id, a.node(id).unwrap().clone());
    }

    a.rename(page, "Renamed", dev_a(), 200);
    a.stamp_write(dev_a(), 300);
    crate::tree::move_node(&mut b, page, work, None, None, dev_b(), 210).unwrap();
    b.stamp_write(dev_b(), 300);

    let doc = read_both_ways(&a, &b);
    let node = doc.node(page).unwrap();
    assert_eq!(node.content.name, "Renamed");
    assert_eq!(node.placement.parent, Some(work));
}

#[test]
fn a_favorites_added_stamp_survives_a_rename_and_a_readdress_on_either_device() {
    let (mut a, mut b) = two_peers(100);
    let page = favorite(
        &mut a,
        "page00000001",
        TOOLBAR,
        "https://e.example/",
        dev_a(),
        10,
    );
    b.nodes.insert(page, a.node(page).unwrap().clone());
    assert_eq!(a.node(page).unwrap().content.added, Some(10));

    a.rename(page, "Renamed", dev_a(), 200);
    a.stamp_write(dev_a(), 300);
    b.set_content(
        page,
        "Example",
        Some("https://f.example/".into()),
        None,
        None,
        false,
        dev_b(),
        210,
    );
    b.stamp_write(dev_b(), 300);
    assert_eq!(b.node(page).unwrap().content.added, Some(10));

    let doc = read_both_ways(&a, &b);
    let node = doc.node(page).unwrap();
    assert_eq!(node.content.url.as_deref(), Some("https://f.example/"));
    assert_eq!(node.content_at, 210);
    assert_eq!(node.content.added, Some(10));
}

#[test]
fn a_favorite_added_to_a_folder_another_device_deleted_is_kept_in_favorites() {
    let (mut a, mut b) = two_peers(100);
    let work = folder(&mut a, "folder000001", TOOLBAR, "Work", dev_a(), 10);
    b.nodes.insert(work, a.node(work).unwrap().clone());

    let page = b.add_favorite(
        NodeKind::Favorite,
        "page00000001",
        Some(work),
        None,
        None,
        "New",
        Some("https://n.example/".into()),
        dev_b(),
        200,
    );
    b.stamp_write(dev_b(), 300);
    a.remove(work);
    a.stamp_write(dev_a(), 300);

    let doc = read_both_ways(&a, &b);
    assert!(doc.node(work).is_none(), "the folder stays deleted");
    assert_eq!(
        doc.node(page).unwrap().placement.parent,
        Some(favorite_id(STRANDED_FAVORITES_GUID)),
        "and the new favorite is kept"
    );
}

#[test]
fn two_devices_folders_of_one_name_both_stay() {
    let (mut a, mut b) = two_joining_peers();
    let fa = folder(&mut a, "folderAAAAAA", TOOLBAR, "Work", dev_a(), 200);
    let fb = folder(&mut b, "folderBBBBBB", TOOLBAR, "Work", dev_b(), 200);
    let pa = favorite(
        &mut a,
        "pageAAAAAAAA",
        TOOLBAR,
        "https://x.example/",
        dev_a(),
        200,
    );
    let pb = favorite(
        &mut b,
        "pageBBBBBBBB",
        TOOLBAR,
        "https://x.example/",
        dev_b(),
        200,
    );
    a.stamp_write(dev_a(), 300);
    b.stamp_write(dev_b(), 300);

    let doc = read_both_ways(&a, &b);

    for id in [fa, fb, pa, pb] {
        assert!(
            doc.node(id).is_some(),
            "{id} is kept, as both devices' tabs are"
        );
    }
}

#[test]
fn a_deleted_favorite_put_back_under_its_guid_reaches_a_device_that_saw_the_delete() {
    let (mut a, mut b) = two_peers(100);
    let page = favorite(
        &mut a,
        "page00000001",
        TOOLBAR,
        "https://e.example/",
        dev_a(),
        200,
    );
    a.stamp_write(dev_a(), 250);
    merge(&mut b, &a);
    assert!(b.node(page).is_some(), "B has the favorite");
    b.stamp_write(dev_b(), 260);

    a.remove(page);
    a.stamp_write(dev_a(), 300);
    merge(&mut b, &a);
    assert!(b.node(page).is_none(), "B takes the delete");
    b.stamp_write(dev_b(), 310);

    // Undo: the same guid, re-added at a later stamp.
    favorite(
        &mut a,
        "page00000001",
        TOOLBAR,
        "https://e.example/",
        dev_a(),
        400,
    );
    a.stamp_write(dev_a(), 450);

    let doc = read_both_ways(&a, &b);
    let node = doc
        .node(page)
        .expect("the favorite is back on both devices");
    assert_eq!(node.content.url.as_deref(), Some("https://e.example/"));
    assert_eq!(node.content.guid.as_deref(), Some("page00000001"));
}

fn scope(ids: &[&str]) -> Option<std::collections::BTreeSet<String>> {
    Some(ids.iter().map(|s| s.to_string()).collect())
}

#[test]
fn a_pins_scope_round_trips_and_goes_with_its_pin() {
    let mut doc = with_roots(dev_a());
    let page = favorite(
        &mut doc,
        "page00000001",
        TOOLBAR,
        "https://e.example/",
        dev_a(),
        5,
    );
    // Only a pin has a scope.
    doc.set_pin_scope(page, scope(&["work"]), dev_a(), 6);
    assert_eq!(doc.node(page).unwrap().lifecycle.pin_scope, None);

    crate::tree::move_node(
        &mut doc,
        page,
        favorite_id(PINS_GUID),
        None,
        None,
        dev_a(),
        7,
    )
    .unwrap();
    doc.set_pin_scope(page, scope(&["work", "home"]), dev_a(), 8);
    let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
    assert_eq!(
        back.node(page).unwrap().lifecycle.pin_scope,
        scope(&["home", "work"])
    );
    let json: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
    assert_eq!(
        json["nodes"][page.to_string()]["lifecycle"]["pin_scope"],
        serde_json::json!(["home", "work"]),
        "one sorted array, whatever order it was given in"
    );

    // Moving the pin along the row keeps where it shows.
    crate::tree::move_node(
        &mut doc,
        page,
        favorite_id(PINS_GUID),
        None,
        None,
        dev_a(),
        9,
    )
    .unwrap();
    assert_eq!(
        doc.node(page).unwrap().lifecycle.pin_scope,
        scope(&["home", "work"])
    );

    // An empty scope is every workspace, as no scope is.
    doc.set_pin_scope(page, scope(&[]), dev_a(), 10);
    assert_eq!(doc.node(page).unwrap().lifecycle.pin_scope, None);

    // Clearing the scope writes no field.
    let json: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
    assert!(
        json["nodes"][page.to_string()]["lifecycle"]
            .get("pin_scope")
            .is_none()
    );
}

#[test]
fn a_pin_on_one_device_and_its_scope_on_the_other_both_survive() {
    let (mut a, b) = two_peers(100);
    let page = favorite(
        &mut a,
        "page00000001",
        PINS_GUID,
        "https://e.example/",
        dev_a(),
        200,
    );
    a.stamp_write(dev_a(), 300);

    // B learns of the pin, then limits it.
    let mut b = read_both_ways(&b, &a);
    b.stamp_write(dev_b(), 310);
    b.seen.insert(dev_a(), 300);
    b.set_pin_scope(page, scope(&["work"]), dev_b(), 400);
    b.stamp_write(dev_b(), 500);
    a.seen.insert(dev_b(), 310);

    let doc = read_both_ways(&a, &b);
    let node = doc.node(page).unwrap();
    assert_eq!(node.placement.parent, Some(favorite_id(PINS_GUID)));
    assert_eq!(node.lifecycle.pin_scope, scope(&["work"]));
}

#[test]
fn a_scope_on_one_device_and_a_rename_or_move_on_the_other_both_survive() {
    let (mut a, mut b) = two_peers(100);
    let page = favorite(
        &mut a,
        "page00000001",
        PINS_GUID,
        "https://e.example/",
        dev_a(),
        10,
    );
    let work = folder(&mut a, "folder000001", PINS_GUID, "Work", dev_a(), 11);
    for id in [page, work] {
        b.nodes.insert(id, a.node(id).unwrap().clone());
    }

    a.set_pin_scope(page, scope(&["work"]), dev_a(), 200);
    a.stamp_write(dev_a(), 300);
    b.rename(page, "Renamed", dev_b(), 210);
    crate::tree::move_node(&mut b, page, work, None, None, dev_b(), 220).unwrap();
    b.stamp_write(dev_b(), 300);

    let doc = read_both_ways(&a, &b);
    let node = doc.node(page).unwrap();
    assert_eq!(node.lifecycle.pin_scope, scope(&["work"]));
    assert_eq!(node.content.name, "Renamed");
    assert_eq!(node.placement.parent, Some(work));
}

#[test]
fn the_later_of_two_scopes_wins_on_both_devices() {
    let (mut a, mut b) = two_peers(100);
    let page = favorite(
        &mut a,
        "page00000001",
        PINS_GUID,
        "https://e.example/",
        dev_a(),
        12,
    );
    b.nodes.insert(page, a.node(page).unwrap().clone());

    a.set_pin_scope(page, scope(&["home"]), dev_a(), 200);
    a.stamp_write(dev_a(), 300);
    b.set_pin_scope(page, scope(&["work"]), dev_b(), 210);
    b.stamp_write(dev_b(), 300);

    let doc = read_both_ways(&a, &b);
    assert_eq!(
        doc.node(page).unwrap().lifecycle.pin_scope,
        scope(&["work"])
    );
}

/// Marks `id` pinned at `order` in the row, as a profile written before the
/// pins root holds a pin.
fn mark_pinned(doc: &mut Document, id: NodeId, order: &str, by: DeviceId, now: Timestamp) {
    let node = doc.node_mut(id).unwrap();
    node.lifecycle.pinned = true;
    node.lifecycle.home_order = Some(order.into());
    node.lifecycle_at = now;
    node.lifecycle_by = Some(by);
}

/// Row keys in order, as fractional indexes spell them.
fn row_keys() -> Vec<String> {
    let mut key = fractional_index::FractionalIndex::default();
    (0..4)
        .map(|_| {
            let out = key.to_string();
            key = fractional_index::FractionalIndex::new_after(&key);
            out
        })
        .collect()
}

/// The four cases of pins-root spec §8, in a row ordered X, F, B, A: a
/// favorite X pinned on its own inside the pinned folder F, F with X and
/// another favorite, B pinned inside an unpinned folder, and A pinned in
/// Favorites with a scope.
fn marked_profile(doc: &mut Document, by: DeviceId) {
    let keys = row_keys();
    let f = folder(doc, "folderFFFFFF", TOOLBAR, "F", by, 10);
    favorite(
        doc,
        "inFFFFFFFFFF",
        "folderFFFFFF",
        "https://f.example/",
        by,
        10,
    );
    let x = favorite(
        doc,
        "pinXXXXXXXXX",
        "folderFFFFFF",
        "https://x.example/",
        by,
        10,
    );
    folder(doc, "plainfolder1", TOOLBAR, "Plain", by, 10);
    let b = favorite(
        doc,
        "pinBBBBBBBBB",
        "plainfolder1",
        "https://b.example/",
        by,
        10,
    );
    let a = favorite(doc, "pinAAAAAAAAA", TOOLBAR, "https://a.example/", by, 10);
    mark_pinned(doc, x, &keys[0], by, 11);
    mark_pinned(doc, f, &keys[1], by, 11);
    mark_pinned(doc, b, &keys[2], by, 11);
    mark_pinned(doc, a, &keys[3], by, 11);
    doc.node_mut(a).unwrap().lifecycle.pin_scope = scope(&["work"]);
    doc.node_mut(x).unwrap().lifecycle.pin_scope = scope(&["home"]);
}

/// The guids under `parent`, in order.
fn guids_under(doc: &Document, parent: &str) -> Vec<String> {
    crate::tree::children(doc, favorite_id(parent))
        .into_iter()
        .map(|id| doc.node(id).unwrap().content.guid.clone().unwrap())
        .collect()
}

/// Asserts `doc` holds the four cases moved as pins-root spec §8 says.
fn assert_moved(doc: &Document) {
    let copy = crate::pins::pin_copy_guid("pinXXXXXXXXX");
    assert_eq!(
        guids_under(doc, PINS_GUID),
        [
            copy.as_str(),
            "folderFFFFFF",
            "pinBBBBBBBBB",
            "pinAAAAAAAAA"
        ],
        "the row's order, the guids kept and X copied"
    );
    assert_eq!(
        guids_under(doc, "folderFFFFFF"),
        ["inFFFFFFFFFF", "pinXXXXXXXXX"],
        "F moves whole, X stays in it"
    );
    assert!(guids_under(doc, "plainfolder1").is_empty());
    let copied = doc.node(favorite_id(&copy)).unwrap();
    assert_eq!(copied.content.url.as_deref(), Some("https://x.example/"));
    assert_eq!(copied.lifecycle.pin_scope, scope(&["home"]));
    let a = doc.node(favorite_id("pinAAAAAAAAA")).unwrap();
    assert_eq!(a.lifecycle.pin_scope, scope(&["work"]), "a scope stays");
    assert_eq!(a.content.name, "Example");
    for guid in [
        "pinXXXXXXXXX",
        "folderFFFFFF",
        "pinBBBBBBBBB",
        "pinAAAAAAAAA",
    ] {
        let node = doc.node(favorite_id(guid)).unwrap();
        assert!(!node.lifecycle.pinned, "{guid} keeps no mark");
        assert_eq!(node.lifecycle.home_order, None, "{guid} keeps no row key");
    }
    assert_eq!(
        doc.node(favorite_id("pinXXXXXXXXX"))
            .unwrap()
            .lifecycle
            .pin_scope,
        None,
        "a pin inside a folder has no scope of its own"
    );
}

#[test]
fn the_pass_moves_each_kind_of_pin_into_the_pins_root_in_row_order() {
    let mut doc = with_roots(dev_a());
    marked_profile(&mut doc, dev_a());

    assert!(crate::pins::move_pins_to_root(&mut doc, dev_a(), 20));

    assert_moved(&doc);
}

#[test]
fn a_second_pass_changes_nothing() {
    let mut doc = with_roots(dev_a());
    marked_profile(&mut doc, dev_a());
    crate::pins::move_pins_to_root(&mut doc, dev_a(), 20);
    let once = doc.to_json().unwrap();

    assert!(!crate::pins::move_pins_to_root(&mut doc, dev_a(), 30));

    assert_eq!(doc.to_json().unwrap(), once);
}

#[test]
fn without_a_pins_root_the_pass_changes_nothing() {
    let mut doc = Document::new();
    doc.add_favorite(
        NodeKind::Folder,
        TOOLBAR,
        None,
        None,
        None,
        "",
        None,
        dev_a(),
        0,
    );
    let a = favorite(
        &mut doc,
        "pinAAAAAAAAA",
        TOOLBAR,
        "https://a.example/",
        dev_a(),
        10,
    );
    mark_pinned(&mut doc, a, &row_keys()[0], dev_a(), 11);
    let before = doc.to_json().unwrap();

    assert!(!crate::pins::move_pins_to_root(&mut doc, dev_a(), 20));

    assert_eq!(doc.to_json().unwrap(), before);
}

#[test]
fn two_devices_running_the_pass_at_once_merge_to_one_row() {
    let (mut a, b) = two_peers(5);
    marked_profile(&mut a, dev_a());
    a.stamp_write(dev_a(), 12);
    // B holds the same profile, as a device does once it has synced.
    let mut b = read_both_ways(&b, &a);
    b.stamp_write(dev_b(), 13);
    b.seen.insert(dev_a(), 12);
    a.seen.insert(dev_b(), 13);

    crate::pins::move_pins_to_root(&mut a, dev_a(), 100);
    a.stamp_write(dev_a(), 101);
    crate::pins::move_pins_to_root(&mut b, dev_b(), 110);
    b.stamp_write(dev_b(), 111);

    let doc = read_both_ways(&a, &b);
    assert_moved(&doc);
}
