// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Local nodes (decision 1372): an address that stays on this device is held
//! in its profile copy and in no file of the shared folder, and a pass over
//! the shared folder neither deletes nor replaces it.

use crate::archive::{archive_now, expire, restore};
use crate::crypto::Key;
use crate::store::{self, DeviceId, MemoryStore, StorageProvider};
use crate::sync::{Target, sync_to};
use crate::types::test_support::{TREE, dev_a, dev_b, uid};
use crate::types::{
    ARCHIVE, Document, FAVORITE_ROOT_GUIDS, NodeId, NodeKind, STRANDED_FAVORITES_GUID, Timestamp,
    favorite_id,
};

const FAVORITES: &str = "favorites";

const WS: u128 = 1;

/// One pass of `doc` as `device` over `store`, against `target`.
fn pass(
    store: &MemoryStore,
    key: &Key,
    device: DeviceId,
    name: &str,
    doc: &mut Document,
    now: Timestamp,
    target: Target,
) -> crate::sync::SyncReport {
    sync_to(store, key, device, name, doc, now, None, target, None).unwrap()
}

/// What `device`'s own file in `store` holds.
fn file_of(store: &MemoryStore, key: &Key, device: DeviceId, name: &str) -> Document {
    store::load_document(store, key, device, name).unwrap()
}

/// Sets tab `id`'s address, keeping its name, as a host following a
/// navigation writes it.
fn navigate(doc: &mut Document, id: NodeId, url: &str, local: bool, by: DeviceId, now: Timestamp) {
    let name = doc.node(id).unwrap().content.name.clone();
    doc.set_content(id, name, Some(url.into()), None, None, local, by, now);
}

/// Device A with workspace `W` and tabs 10 and 11, and device B having
/// merged it through the shared folder.
fn two_devices(shared: &MemoryStore, key: &Key) -> (Document, Document) {
    let mut a = Document::new();
    a.add_workspace("W", None, uid(WS), dev_a(), 1);
    for n in [10, 11] {
        a.add_tab(
            uid(WS),
            format!("T{n}"),
            format!("https://{n}.example/"),
            uid(n),
            dev_a(),
            1,
        );
    }
    let mut b = Document::new();
    pass(shared, key, dev_a(), TREE, &mut a, 10, Target::Shared);
    pass(shared, key, dev_b(), TREE, &mut b, 20, Target::Shared);
    pass(shared, key, dev_a(), TREE, &mut a, 30, Target::Shared);
    assert!(b.node(uid(10)).is_some() && b.node(uid(11)).is_some());
    (a, b)
}

#[test]
fn a_local_tab_is_in_the_profile_copy_and_in_no_shared_file() {
    let (shared, profile, key) = (
        MemoryStore::new(),
        MemoryStore::new(),
        crate::types::test_support::test_key(),
    );
    let mut a = Document::new();
    a.add_workspace("W", None, uid(WS), dev_a(), 1);
    a.add_tab(uid(WS), "Notes", "file:///notes.html", uid(10), dev_a(), 1);
    a.node_mut(uid(10)).unwrap().content.local = true;

    pass(&profile, &key, dev_a(), TREE, &mut a, 10, Target::Profile);
    pass(&shared, &key, dev_a(), TREE, &mut a, 10, Target::Shared);

    let kept = file_of(&profile, &key, dev_a(), TREE);
    assert!(kept.node(uid(10)).unwrap().content.local);
    let published = file_of(&shared, &key, dev_a(), TREE);
    assert!(published.node(uid(WS)).is_some());
    assert!(published.node(uid(10)).is_none());
    assert!(
        a.node(uid(10)).unwrap().content.local,
        "the document keeps it"
    );
}

#[test]
fn a_shared_pass_never_deletes_a_local_node_that_no_file_holds() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut a, mut b) = two_devices(&shared, &key);
    a.add_tab(uid(WS), "Notes", "file:///notes.html", uid(12), dev_a(), 40);
    a.node_mut(uid(12)).unwrap().content.local = true;

    // B writes after A's tab exists, and A's own shared file predates it.
    // Neither holds it, and A has seen both writers past its stamp.
    pass(&shared, &key, dev_b(), TREE, &mut b, 50, Target::Shared);
    a.seen.insert(dev_a(), 60);
    let report = pass(&shared, &key, dev_a(), TREE, &mut a, 60, Target::Shared);

    assert!(a.node(uid(12)).unwrap().content.local);
    assert!(report.removed.is_empty() && report.changed.is_empty());
    pass(&shared, &key, dev_b(), TREE, &mut b, 70, Target::Shared);
    assert!(b.node(uid(12)).is_none());
}

#[test]
fn a_tab_that_goes_local_leaves_the_peer_and_comes_back_at_its_place() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut a, mut b) = two_devices(&shared, &key);
    let order = a.node(uid(10)).unwrap().placement.order.clone();

    navigate(&mut a, uid(10), "file:///report.pdf", true, dev_a(), 40);
    pass(&shared, &key, dev_a(), TREE, &mut a, 50, Target::Shared);
    let report = pass(&shared, &key, dev_b(), TREE, &mut b, 60, Target::Shared);
    assert!(b.node(uid(10)).is_none(), "gone from the peer as if closed");
    assert_eq!(report.removed, vec![uid(10)]);
    assert!(a.node(uid(10)).unwrap().content.local, "kept here");

    navigate(
        &mut a,
        uid(10),
        "https://10.example/back",
        false,
        dev_a(),
        70,
    );
    pass(&shared, &key, dev_a(), TREE, &mut a, 80, Target::Shared);
    pass(&shared, &key, dev_b(), TREE, &mut b, 90, Target::Shared);
    let back = b.node(uid(10)).expect("back on the peer");
    assert_eq!(back.content.url.as_deref(), Some("https://10.example/back"));
    assert_eq!(back.placement.order, order, "at its place");
    assert_eq!(back.placement.parent, Some(uid(WS)));
}

#[test]
fn a_peers_edit_to_a_tab_gone_local_here_converges_on_local_here_and_gone_there() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut a, mut b) = two_devices(&shared, &key);

    navigate(&mut a, uid(10), "file:///report.pdf", true, dev_a(), 40);
    navigate(&mut b, uid(10), "https://10.example/b", false, dev_b(), 45);
    for now in [50, 60, 70, 80, 90] {
        pass(&shared, &key, dev_b(), TREE, &mut b, now, Target::Shared);
        pass(
            &shared,
            &key,
            dev_a(),
            TREE,
            &mut a,
            now + 5,
            Target::Shared,
        );
    }

    let here = a.node(uid(10)).unwrap();
    assert!(here.content.local);
    assert_eq!(here.content.url.as_deref(), Some("file:///report.pdf"));
    assert!(b.node(uid(10)).is_none());
}

#[test]
fn a_local_mark_from_any_file_but_the_profile_copy_is_dropped() {
    let key = crate::types::test_support::test_key();
    let mut planted = Document::new();
    planted.add_workspace("W", None, uid(WS), dev_b(), 1);
    planted.add_tab(uid(WS), "Odd", "file:///etc/hosts", uid(10), dev_b(), 1);
    planted.node_mut(uid(10)).unwrap().content.local = true;
    planted.stamp_write(dev_b(), 10);

    // A store each, because a pass writes its own file, which the next
    // pass would merge first.
    for target in [Target::Shared, Target::Profile] {
        let shared = MemoryStore::new();
        store::save_document(&shared, &key, dev_b(), TREE, &planted).unwrap();
        let mut a = Document::new();
        pass(&shared, &key, dev_a(), TREE, &mut a, 20, target);
        let tab = a.node(uid(10)).expect("merged");
        assert!(!tab.content.local, "{target:?}: read as synced");
    }
}

#[test]
fn the_profile_copys_own_file_keeps_its_local_marks() {
    // A document rolled back to before a tab was made recovers it from its
    // own file in the profile, local as it was written.
    let (profile, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a = Document::new();
    a.add_workspace("W", None, uid(WS), dev_a(), 1);
    a.add_tab(uid(WS), "Doc", "file:///report.pdf", uid(10), dev_a(), 1);
    a.node_mut(uid(10)).unwrap().content.local = true;
    pass(&profile, &key, dev_a(), TREE, &mut a, 10, Target::Profile);

    let mut restored = Document::new();
    pass(
        &profile,
        &key,
        dev_a(),
        TREE,
        &mut restored,
        20,
        Target::Profile,
    );

    assert!(restored.node(uid(10)).expect("recovered").content.local);
}

#[test]
fn a_peers_node_never_replaces_a_local_node_of_the_same_id() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a = Document::new();
    a.add_workspace("W", None, uid(WS), dev_a(), 1);
    a.add_tab(uid(WS), "Mine", "file:///mine.html", uid(10), dev_a(), 1);
    a.node_mut(uid(10)).unwrap().content.local = true;
    let mut b = Document::new();
    b.add_workspace("W", None, uid(WS), dev_a(), 1);
    b.add_tab(
        uid(WS),
        "Theirs",
        "https://theirs.example/",
        uid(10),
        dev_b(),
        5,
    );
    b.stamp_write(dev_b(), 10);
    store::save_document(&shared, &key, dev_b(), TREE, &b).unwrap();

    pass(&shared, &key, dev_a(), TREE, &mut a, 20, Target::Shared);
    let tab = a.node(uid(10)).unwrap();
    assert!(tab.content.local);
    assert_eq!(tab.content.url.as_deref(), Some("file:///mine.html"));
}

#[test]
fn a_local_only_edit_leaves_the_shared_file_unwritten() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let (mut a, _) = two_devices(&shared, &key);
    a.add_tab(uid(WS), "Notes", "file:///notes.html", uid(12), dev_a(), 40);
    a.node_mut(uid(12)).unwrap().content.local = true;
    pass(&shared, &key, dev_a(), TREE, &mut a, 50, Target::Shared);
    let path = store::device_path(&key, TREE, dev_a());
    let written = shared.read(&path).unwrap();

    navigate(&mut a, uid(12), "file:///other.html", true, dev_a(), 60);
    pass(&shared, &key, dev_a(), TREE, &mut a, 70, Target::Shared);
    assert_eq!(shared.read(&path).unwrap(), written);
}

#[test]
fn a_local_favorite_in_a_folder_a_peer_deleted_lands_in_favorites() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut a = Document::new();
    for guid in FAVORITE_ROOT_GUIDS {
        a.add_favorite(
            NodeKind::Folder,
            guid,
            None,
            None,
            None,
            "",
            None,
            dev_a(),
            0,
        );
    }
    let work = a.add_favorite(
        NodeKind::Folder,
        "workfolder01",
        Some(favorite_id("menu________")),
        None,
        None,
        "Work",
        None,
        dev_a(),
        1,
    );
    let notes = a.add_favorite(
        NodeKind::Favorite,
        "notesfavor01",
        Some(work),
        None,
        None,
        "Notes",
        Some("file:///notes.html".into()),
        dev_a(),
        2,
    );
    a.node_mut(notes).unwrap().content.local = true;
    let mut b = Document::new();
    pass(
        &shared,
        &key,
        dev_a(),
        FAVORITES,
        &mut a,
        10,
        Target::Shared,
    );
    pass(
        &shared,
        &key,
        dev_b(),
        FAVORITES,
        &mut b,
        20,
        Target::Shared,
    );
    pass(
        &shared,
        &key,
        dev_a(),
        FAVORITES,
        &mut a,
        30,
        Target::Shared,
    );
    assert!(b.node(work).is_some() && b.node(notes).is_none());

    b.remove(work);
    pass(
        &shared,
        &key,
        dev_b(),
        FAVORITES,
        &mut b,
        40,
        Target::Shared,
    );
    let report = pass(
        &shared,
        &key,
        dev_a(),
        FAVORITES,
        &mut a,
        50,
        Target::Shared,
    );

    assert!(a.node(work).is_none());
    let kept = a.node(notes).expect("kept");
    assert!(kept.content.local);
    assert_eq!(
        kept.placement.parent,
        Some(favorite_id(STRANDED_FAVORITES_GUID))
    );
    assert!(report.repaired.contains(&notes));
}

#[test]
fn a_local_tab_archives_to_a_local_entry_and_restores_to_a_local_tab() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut tree = Document::new();
    tree.add_workspace("W", None, uid(WS), dev_a(), 1);
    tree.add_tab(uid(WS), "Notes", "file:///notes.html", uid(10), dev_a(), 1);
    tree.node_mut(uid(10)).unwrap().content.local = true;
    tree.add_tab(uid(WS), "Web", "https://web.example/", uid(11), dev_a(), 1);
    let mut archive = Document::new();

    let local = archive_now(&mut tree, &mut archive, uid(10), dev_a(), 10)
        .unwrap()
        .entries[0];
    let synced = archive_now(&mut tree, &mut archive, uid(11), dev_a(), 10)
        .unwrap()
        .entries[0];
    assert!(archive.node(local).unwrap().content.local);
    assert!(!archive.node(synced).unwrap().content.local);

    pass(
        &shared,
        &key,
        dev_a(),
        ARCHIVE,
        &mut archive,
        20,
        Target::Shared,
    );
    let published = file_of(&shared, &key, dev_a(), ARCHIVE);
    assert!(published.node(local).is_none() && published.node(synced).is_some());

    let restored = restore(
        &mut tree,
        &mut archive,
        local,
        uid(WS),
        &[uid(20)],
        dev_a(),
        30,
    )
    .unwrap()
    .tabs;
    assert!(tree.node(restored[0]).unwrap().content.local);

    expire(&mut archive, 5, 100);
    assert!(archive.node(local).is_none() && archive.node(synced).is_none());
}

#[test]
fn a_shared_pass_expires_local_entries_too() {
    let (shared, key) = (MemoryStore::new(), crate::types::test_support::test_key());
    let mut tree = Document::new();
    tree.add_workspace("W", None, uid(WS), dev_a(), 1);
    tree.add_tab(uid(WS), "Notes", "file:///notes.html", uid(10), dev_a(), 1);
    tree.node_mut(uid(10)).unwrap().content.local = true;
    let mut archive = Document::new();
    let entry = archive_now(&mut tree, &mut archive, uid(10), dev_a(), 10)
        .unwrap()
        .entries[0];

    sync_to(
        &shared,
        &key,
        dev_a(),
        ARCHIVE,
        &mut archive,
        100,
        Some(50),
        Target::Shared,
        None,
    )
    .unwrap();
    assert!(archive.node(entry).is_none());
}
