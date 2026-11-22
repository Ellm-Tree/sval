// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The nested-workspace tree of tabs, ordered by fractional index.

use crate::store::DeviceId;
use crate::types::{Document, Node, NodeId, NodeKind, Placement, SPLIT_MAX_PANES, Timestamp};
use fractional_index::FractionalIndex;

/// Why [`move_node`] refused a move, or [`remove_keeping_children`] refused
/// to move a container's contents out.
///
/// These are the ways a *local* edit can ask for a parent relationship the
/// tree cannot draw. A caller handling them has nothing to do with the file,
/// crypto and host failures of [`crate::types::Error`], so they are an enum
/// of their own. Every variant names the id at fault, so a host can tell the
/// user which node it could not move and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MoveError {
    /// The node to move is not in the document. A peer can delete it between
    /// the host reading the tree and the user acting on it.
    #[error("no such node: {0}")]
    NoSuchNode(NodeId),
    /// The requested parent is not in the document. The link would leave the
    /// node reachable from nothing, and only [`repair_unreachable_ancestry`]
    /// could put it back, somewhere the user never chose.
    #[error("no such parent: {0}")]
    NoSuchParent(NodeId),
    /// Tabs are leaves (spec §5.2): nothing nests inside one.
    #[error("a tab cannot be a parent: {0}")]
    ParentIsATab(NodeId),
    /// The requested parent is the node itself or one of its own
    /// descendants, so the move would detach the whole subtree into a ring.
    #[error("moving {id} under {parent} would make it its own ancestor")]
    WouldCycle { id: NodeId, parent: NodeId },
    /// The node is a root, so there is no level above it to move its
    /// contents to. A workspace's tabs go with it (spec §5.4).
    #[error("nothing above {0} to move its contents to")]
    NoParent(NodeId),
    /// A split's panes are tabs (split-view spec §5.1): nothing else goes
    /// into one.
    #[error("only a tab goes into a split: {0}")]
    OnlyTabsInASplit(NodeId),
    /// The split already shows as many tabs side by side as one can.
    #[error("split {0} already holds {SPLIT_MAX_PANES} tabs")]
    SplitIsFull(NodeId),
    /// A split sits in a workspace or a group, where its row is drawn.
    #[error("a split goes only into a workspace or a group: {0}")]
    SplitOutsideAPlace(NodeId),
    /// [`move_workspace`] orders the workspaces at the top of the tree, and
    /// this node is not one of them.
    #[error("not a workspace at the top of the tree: {0}")]
    NotARootWorkspace(NodeId),
}

impl MoveError {
    /// A stable name for this kind of refusal, like [`crate::types::Error::code`].
    pub fn code(&self) -> &'static str {
        match self {
            MoveError::NoSuchNode(_) => "no_such_node",
            MoveError::NoSuchParent(_) => "no_such_parent",
            MoveError::ParentIsATab(_) => "parent_is_a_tab",
            MoveError::WouldCycle { .. } => "would_cycle",
            MoveError::NoParent(_) => "no_parent",
            MoveError::OnlyTabsInASplit(_) => "only_tabs_in_a_split",
            MoveError::SplitIsFull(_) => "split_is_full",
            MoveError::SplitOutsideAPlace(_) => "split_outside_a_place",
            MoveError::NotARootWorkspace(_) => "not_a_root_workspace",
        }
    }
}

/// Returns the ids of the children of `parent`, in sibling order.
///
/// Sorted by `(order, id)`: a merge can leave two siblings holding identical
/// fractional keys, and the id keeps the order total and stable between
/// reads. There is no
/// visibility filter: a node that is present is visible, because closing
/// removes the record (spec §5.1).
pub fn children(doc: &Document, parent: NodeId) -> Vec<NodeId> {
    let mut kids: Vec<(FractionalIndex, NodeId)> = doc
        .nodes
        .iter()
        .filter(|(_, node)| node.placement.parent == Some(parent))
        .map(|(id, node)| (node.placement.order.clone(), *id))
        .collect();
    kids.sort();
    kids.into_iter().map(|(_, id)| id).collect()
}

/// Every parent's children, each list in [`children`]'s order, read in one
/// pass over the document. A caller that walks many parents builds one per
/// call: it is never kept beside the document it was read from.
pub struct ChildIndex(std::collections::BTreeMap<NodeId, Vec<NodeId>>);

impl ChildIndex {
    pub fn build(doc: &Document) -> Self {
        let mut kids: std::collections::BTreeMap<NodeId, Vec<(&FractionalIndex, NodeId)>> =
            std::collections::BTreeMap::new();
        for (id, node) in &doc.nodes {
            if let Some(parent) = node.placement.parent {
                kids.entry(parent)
                    .or_default()
                    .push((&node.placement.order, *id));
            }
        }
        ChildIndex(
            kids.into_iter()
                .map(|(parent, mut list)| {
                    list.sort();
                    (parent, list.into_iter().map(|(_, id)| id).collect())
                })
                .collect(),
        )
    }

    /// The ids of the children of `parent`, as [`children`] lists them.
    pub fn children(&self, parent: NodeId) -> &[NodeId] {
        self.0.get(&parent).map_or(&[], Vec::as_slice)
    }
}

/// Inserts a new tab under `parent`, ordered between `before` and `after`.
///
/// The key comes from [`order_between`], so an insert never fails for want
/// of room between the bounds.
///
/// `id`, `by` and `now` come from the caller: see [`crate::types::Timestamp`]
/// for why this crate never mints any of them, and [`crate::types::Node`] for
/// what `by` is read for.
#[expect(clippy::too_many_arguments)]
pub fn insert_tab_between(
    doc: &mut Document,
    parent: NodeId,
    before: Option<NodeId>,
    after: Option<NodeId>,
    name: impl Into<String>,
    url: impl Into<String>,
    id: NodeId,
    by: DeviceId,
    now: Timestamp,
) -> NodeId {
    let order = order_between(doc, before, after);
    let id = doc.add_tab(parent, name, url, id, by, now);
    if let Some(node) = doc.node_mut(id) {
        node.placement.order = order;
    }
    id
}

/// An order key between the keys `before` and `after`. `FractionalIndex::new`
/// returns `None` when there is no room between the bounds (they are equal or
/// out of order), and then the key goes right after `before`, which is always
/// constructible; with no `before` either, `default()` is the key
/// `insert_node` gives a first child.
pub fn key_between(
    before: Option<&FractionalIndex>,
    after: Option<&FractionalIndex>,
) -> FractionalIndex {
    FractionalIndex::new(before, after).unwrap_or_else(|| match before {
        Some(before) => FractionalIndex::new_after(before),
        None => FractionalIndex::default(),
    })
}

/// An order key between the siblings `before` (the one this sorts after) and
/// `after` (the one this sorts before), by [`key_between`]. A neighbour
/// missing from the document is ignored.
pub fn order_between(
    doc: &Document,
    before: Option<NodeId>,
    after: Option<NodeId>,
) -> FractionalIndex {
    let key = |id: Option<NodeId>| {
        id.and_then(|id| doc.node(id))
            .map(|n| n.placement.order.clone())
    };
    key_between(key(before).as_ref(), key(after).as_ref())
}

/// Moves `id` to be a child of `new_parent`, ordered between `before` and
/// `after`, using the same fallback rule as [`insert_tab_between`].
///
/// `by` and `now` come from the caller (see [`crate::types::Timestamp`]).
/// This is a user move, so `now` is a clock reading and `by` this device's
/// id; [`repair_unreachable_ancestry`] writes neither.
///
/// # Refusals
///
/// A parent relationship no downward walk can draw is refused, and the
/// document is left byte-for-byte unchanged (see [`MoveError`]). It is an
/// error so that a host never shows the move as done when nothing moved,
/// which a user reads as lost data.
///
/// **This validation belongs to the local edit path only, and must never
/// become a filter inside [`crate::merge::merge`].** A peer on a different
/// build may hold any of these shapes, and merge keeps what it is given:
/// dropping such a node would delete another device's data.
/// [`repair_unreachable_ancestry`] on the read path makes a shape that
/// arrives by merge reachable again (spec §5.2).
pub fn move_node(
    doc: &mut Document,
    id: NodeId,
    new_parent: NodeId,
    before: Option<NodeId>,
    after: Option<NodeId>,
    by: DeviceId,
    now: Timestamp,
) -> Result<(), MoveError> {
    validate_move(doc, id, new_parent)?;
    let order = order_between(doc, before, after);

    let node = doc.node_mut(id).ok_or(MoveError::NoSuchNode(id))?;
    node.placement.parent = Some(new_parent);
    node.placement.order = order;
    node.placement_at = now;
    node.placement_by = Some(by);
    Ok(())
}

/// Puts the workspace `id` between the workspaces `before` and `after` in
/// the order every device lists them, by [`order_between`]. A workspace is a
/// root, so it keeps no parent, which [`move_node`] cannot place. The order
/// is a placement fact stamped as [`move_node`] stamps one, so it merges as
/// any move does (spec §5.3).
///
/// # Refusals
///
/// The document is left unchanged when `id` is absent, or is not a workspace
/// at the top of the tree.
pub fn move_workspace(
    doc: &mut Document,
    id: NodeId,
    before: Option<NodeId>,
    after: Option<NodeId>,
    by: DeviceId,
    now: Timestamp,
) -> Result<(), MoveError> {
    let node = doc.node(id).ok_or(MoveError::NoSuchNode(id))?;
    if node.kind != NodeKind::Workspace || node.placement.parent.is_some() {
        return Err(MoveError::NotARootWorkspace(id));
    }
    let order = order_between(doc, before, after);
    let node = doc.node_mut(id).ok_or(MoveError::NoSuchNode(id))?;
    node.placement.order = order;
    node.placement_at = now;
    node.placement_by = Some(by);
    Ok(())
}

/// Decides whether [`move_node`] may create the link `id` -> `new_parent`,
/// reading the document and changing nothing, so a refusal cannot leave a
/// half-applied move behind.
fn validate_move(doc: &Document, id: NodeId, new_parent: NodeId) -> Result<(), MoveError> {
    let node = doc.node(id).ok_or(MoveError::NoSuchNode(id))?;
    validate_parent(doc, Some(id), &node.kind, new_parent)?;
    // `walks_into` answers "is `id` on `new_parent`'s ancestry chain", which
    // covers `new_parent == id` as the zero-hop case, and stops on a cycle a
    // merge left elsewhere in the document.
    if walks_into(doc, new_parent, id) {
        return Err(MoveError::WouldCycle {
            id,
            parent: new_parent,
        });
    }
    Ok(())
}

/// Decides whether a node of `kind` may be placed under `parent` by a local
/// edit, a move or an add alike: `id` is the node being moved, or `None` for
/// one being added. The parent must exist and must not be a tab, a split
/// takes only tabs and at most [`SPLIT_MAX_PANES`] of them, and a split goes
/// only into a workspace or a group (split-view spec §5.2).
///
/// A local-edit rule only, like the rest of [`move_node`]'s refusals:
/// [`crate::merge::merge`] validates nothing (decision 0020).
pub fn validate_parent(
    doc: &Document,
    id: Option<NodeId>,
    kind: &NodeKind,
    parent: NodeId,
) -> Result<(), MoveError> {
    let holder = doc.node(parent).ok_or(MoveError::NoSuchParent(parent))?;
    match holder.kind {
        NodeKind::Tab => return Err(MoveError::ParentIsATab(parent)),
        NodeKind::Split if *kind != NodeKind::Tab => {
            return Err(MoveError::OnlyTabsInASplit(parent));
        }
        NodeKind::Split => {
            // A pane moved within its own split takes no new place, however
            // many panes a merge left in it.
            let within = id
                .and_then(|id| doc.node(id))
                .is_some_and(|n| n.placement.parent == Some(parent));
            let panes = doc
                .nodes
                .values()
                .filter(|n| n.placement.parent == Some(parent) && n.kind == NodeKind::Tab)
                .count();
            if !within && panes >= SPLIT_MAX_PANES {
                return Err(MoveError::SplitIsFull(parent));
            }
        }
        _ => {}
    }
    if *kind == NodeKind::Split && !matches!(holder.kind, NodeKind::Workspace | NodeKind::Group) {
        return Err(MoveError::SplitOutsideAPlace(parent));
    }
    Ok(())
}

/// Deletes `id` and keeps what is in it: its children move to its parent,
/// in their order, at the place `id` held among its siblings, and then `id`
/// is removed. "Delete group" when the user moves the contents out (spec
/// §5.4); a group inside comes out whole.
///
/// One call, so the children moved are the ones the document holds when it
/// runs, and nothing between the moves and the removal can strand one. Each move is a real placement fact, stamped
/// `by` at `now` like [`move_node`]'s.
///
/// # Refusals
///
/// The document is left unchanged when `id` is absent, when it has no parent
/// ([`MoveError::NoParent`]: a workspace is a root), and when its parent
/// could not hold the children for the reasons [`move_node`] refuses.
pub fn remove_keeping_children(
    doc: &mut Document,
    id: NodeId,
    by: DeviceId,
    now: Timestamp,
) -> Result<(), MoveError> {
    let parent = doc
        .node(id)
        .ok_or(MoveError::NoSuchNode(id))?
        .placement
        .parent
        .ok_or(MoveError::NoParent(id))?;
    validate_move(doc, id, parent)?;
    let siblings = children(doc, parent);
    let at = siblings.iter().position(|sibling| *sibling == id);
    let after = at.and_then(|at| siblings.get(at + 1)).copied();
    let mut before = at.and_then(|at| at.checked_sub(1)).map(|at| siblings[at]);
    for child in children(doc, id) {
        move_node(doc, child, parent, before, after, by, now)?;
        before = Some(child);
    }
    doc.remove(id);
    Ok(())
}

/// Where each group and split stood in the documents one sync pass read, so
/// that [`repair_unreachable_ancestry_knowing`] can file what a peer put in
/// one another device deleted at its place (spec §5.2, decision 0121,
/// split-view spec §5.3).
///
/// A deletion leaves no record (spec §5.4), but the file that brings in a
/// node under a deleted group was written by a device that still held the
/// group, so the group's placement travels in that same file. Only groups and
/// splits are kept: a workspace is a root, so a missing workspace leaves no
/// place to go back to. A group several documents hold keeps the placement
/// the merge would pick (spec §5.3), so every device that read the same files
/// knows the same places, in whatever order it read them.
#[derive(Debug, Default, Clone)]
pub struct KnownPlaces {
    places: std::collections::BTreeMap<NodeId, (Placement, Timestamp, Option<DeviceId>)>,
}

impl KnownPlaces {
    /// Records where every group and split in `doc` stands.
    pub fn note(&mut self, doc: &Document) {
        for (id, node) in &doc.nodes {
            if !matches!(node.kind, NodeKind::Group | NodeKind::Split) {
                continue;
            }
            let incoming = (&node.placement, node.placement_at, node.placement_by);
            match self.places.get_mut(id) {
                Some((placement, at, by)) => {
                    crate::merge::merge_fact((placement, at, by), incoming);
                }
                None => {
                    self.places.insert(
                        *id,
                        (node.placement.clone(), node.placement_at, node.placement_by),
                    );
                }
            }
        }
    }

    /// Where something filed under `missing`, which `doc` lacks, belongs:
    /// the first ancestor of `missing` that `doc` still holds, and the
    /// orders from the deleted group directly beneath that ancestor down to
    /// `missing`. `None` when no document placed one of the deleted groups,
    /// or the chain reaches a node that cannot hold `orphan`: a tab, a
    /// favorite, a kind this build does not know, a split when `orphan` is
    /// not a tab, or `orphan` itself or one of its descendants.
    fn place_for(
        &self,
        doc: &Document,
        missing: NodeId,
        orphan: NodeId,
    ) -> Option<(NodeId, Vec<FractionalIndex>)> {
        let mut orders = Vec::new();
        let mut current = missing;
        loop {
            // More steps than recorded groups means the placements form a
            // ring, which places nothing.
            if orders.len() > self.places.len() {
                return None;
            }
            let (placement, _, _) = self.places.get(&current)?;
            orders.push(placement.order.clone());
            let parent = placement.parent?;
            match doc.node(parent) {
                None => current = parent,
                Some(node) => {
                    let holds = match node.kind {
                        NodeKind::Workspace | NodeKind::Group => true,
                        NodeKind::Split => {
                            doc.node(orphan).is_some_and(|n| n.kind == NodeKind::Tab)
                        }
                        _ => false,
                    };
                    if !holds || walks_into(doc, parent, orphan) {
                        return None;
                    }
                    orders.reverse();
                    return Some((parent, orders));
                }
            }
        }
    }
}

/// Repairs every unreachable ancestry chain in `doc`, returning the ids it
/// reparented. A chain is unreachable when it holds:
///
/// - **a cycle**: two devices concurrently moved nodes into each other
///   (device A moves X into Y while device B moves Y into X), so walking up
///   `parent` from either never reaches a root;
/// - **a deleted parent**: a node's `parent` names an id not in `nodes`, as
///   when device A adds a tab into group G while device B deletes G. Nothing
///   walks into a node that isn't there, so the tab would be invisible for a
///   reason its owner cannot see. Deleting G removes G alone, so what a
///   concurrent edit put under it is repaired;
/// - **a parentless non-workspace**: a group, split or tab whose `parent` is
///   `None`. Only a workspace is a root. This crate never builds one, so it
///   arrives only in hand-edited or corrupted merge input, and `children()`
///   cannot see it any more than a node under a deleted parent;
/// - **a tab as parent**: a node filed under a tab. A tab is a leaf, so
///   nothing draws what is beneath it even when the chain above the tab
///   reaches a workspace. [`move_node`] refuses this shape as a local-edit
///   rule only, so a peer on another build or a hand-edited file can still
///   deliver one. The tab's place is known, so the node goes beside it once
///   the walk below has made every tab's own chain sound. A favorite, whose
///   tree is the Favorites roots, is a break like a deleted parent instead. A
///   node of a known kind other than a tab, filed under a split, goes beside
///   the split the same way: a split holds tabs only (split-view spec §5.3).
///
/// A walk that reaches a node of a kind this build does not know stops there
/// and repairs nothing: whether that kind may be a root, or what it may sit
/// under, is known only to the build that wrote it (see [`NodeKind`]).
///
/// Cycles, deleted parents and parentless non-workspaces are found by one
/// walk (follow `parent` with a visited set until it repeats, names a node
/// that does not exist, or ends with no parent on a non-workspace node) and
/// get one fix: reparent the node **directly beneath the break** to a
/// workspace. That is the lowest `NodeId` among a cycle's members, or the
/// single node whose parent is the problem. Moving that one node keeps the
/// subtree below it intact.
///
/// **This is read-time repair and never part of [`crate::merge::merge`]**
/// (spec §5.2). It is a pure function of the merged document and reads no
/// clock, so every device merging the same documents in any order computes
/// the identical repair. A clock-stamped repair would make merge output
/// depend on when the repair ran and let a fabricated "now" beat a newer
/// edit. Callers on the read path invoke this before treating the tree as
/// authoritative.
///
/// **The reparented node keeps its `placement_at` and `placement_by`**;
/// only its parent and order change. The placement it held is the one that
/// won the merge, a real write by a real device, and the repair is what that
/// write means once its parent is gone, so it carries the write's stamp and
/// reads no clock. That keeps two things the write had:
///
/// - **it outranks what it outranked.** A peer's older placement of the
///   node can be sound, such as where the node stood before it was moved
///   into a group another device deleted. It loses to the kept stamp, so it
///   cannot win the next merge where nothing would repair it, and every
///   device settles on the same tree whatever order they synced in
///   (decision 0121, split-view spec §5.3);
/// - **its news stays news.** A node a peer deleted without seeing this
///   write comes back, as it would without the repair (spec §5.4,
///   decision 0017).
///
/// An unrepaired peer holding the same write ties with the repaired copy on
/// time and writer, the canonical-bytes tie-break picks one, and if it picks
/// the unrepaired one every device repairs it again, identically, because
/// this is a pure function of the merged document. A later user move
/// outranks both.
///
/// **Reparent target: a workspace**, the lowest `NodeId` whose ancestry does
/// not lead back to the node being repaired. Every device computes it
/// identically from the merged document, whichever node broke or device
/// repaired first, and `children()` can surface it. This document alone does
/// not record where a deleted parent stood; [`repair_unreachable_ancestry_knowing`]
/// files the node at that place when a document read with this one does.
///
/// If every workspace's ancestry leads back to the node being repaired, the
/// lowest-id workspace is cut loose (its parent set to `None`, making it a
/// root), unless that workspace *is* the node being repaired, in which case
/// cutting it loose **is** the repair. Only a document with no workspace at
/// all leaves the reparented node detached (`parent = None`). That is
/// deterministic too, but the node is reachable only by walking `nodes`,
/// since a node with no parent is nobody's child.
pub fn repair_unreachable_ancestry(doc: &mut Document) -> Vec<NodeId> {
    repair_unreachable_ancestry_knowing(doc, &KnownPlaces::default())
}

/// [`repair_unreachable_ancestry`], filing a node whose parent is missing at
/// the place `known` records for that parent, when it records one.
///
/// The node goes under the first ancestor of its missing parent that the
/// document still holds, at the place of the deleted group directly beneath
/// that ancestor, with its subtree (spec §5.2). Nodes that land in one place
/// keep the order they held in the deleted groups. A favorite keeps the
/// Favorites rule (favorites-native spec §16), and a node whose missing
/// parent `known` cannot place still goes to the lowest-id workspace.
///
/// What `known` holds is the same on every device that read the same files,
/// and the result is a pure function of it and the merged document, so the
/// devices agree as they do for the rest of the repair.
pub fn repair_unreachable_ancestry_knowing(doc: &mut Document, known: &KnownPlaces) -> Vec<NodeId> {
    let ids: Vec<NodeId> = doc.nodes.keys().copied().collect();
    let mut known_good: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    let mut repaired = Vec::new();
    let mut refiled = Refiled::new();

    for start in ids {
        if known_good.contains(&start) {
            continue;
        }
        let mut visited = Vec::new();
        let mut current = start;
        let mut missing = None;
        // `Some(pos)` for a break: the unreachable segment is
        // `visited[pos..]`. A cycle repeats at `visited[pos]`; any other
        // break is at `visited.len()`, just past the end, so the segment is
        // the last node pushed, the one whose parent is the problem. `None`
        // means the chain reaches a known-good node or a root.
        let break_at = loop {
            match doc.node(current) {
                // The parent is not in the document: a peer deleted a group
                // while this device filed something under it.
                None => {
                    missing = Some(current);
                    break Some(visited.len());
                }
                Some(node) => {
                    if known_good.contains(&current) {
                        break None;
                    }
                    if matches!(node.kind, NodeKind::Unknown(_)) {
                        break None;
                    }
                    if let Some(pos) = visited.iter().position(|&v| v == current) {
                        break Some(pos);
                    }
                    visited.push(current);
                    match node.placement.parent {
                        // A favorite has no place beside a tab or a split:
                        // its tree is the Favorites roots, so one filed under
                        // either is a break like a missing parent. Anything
                        // else walks on up through it, and `lift_misfiled`
                        // files it beside that tab or split once the chain
                        // above is sound.
                        Some(parent)
                            if node.kind.is_favorite_kind()
                                && doc.node(parent).is_some_and(|p| {
                                    matches!(p.kind, NodeKind::Tab | NodeKind::Split)
                                }) =>
                        {
                            break Some(visited.len());
                        }
                        Some(parent) => current = parent,
                        // A parentless node is a root only for a kind meant
                        // to sit at the top (`is_a_root`); any other is a
                        // break.
                        None if !is_a_root(current, &node.kind) => break Some(visited.len()),
                        None => break None,
                    }
                }
            }
        };

        match break_at {
            Some(pos) => {
                let unreachable = &visited[pos.min(visited.len().saturating_sub(1))..];
                let Some(&lowest) = unreachable.iter().min() else {
                    // `start` is in `nodes`, so a push precedes every break
                    // and the segment is never empty.
                    known_good.insert(start);
                    continue;
                };

                // Moving `lowest`'s parent pointer alone is enough: every
                // other member of a cycle reaches a root through `lowest`.
                // The lowest id is one every device picks, so two devices
                // repairing the same ring make the same fix.
                let old_parent = doc.node(lowest).and_then(|n| n.placement.parent);
                let place = missing
                    .filter(|_| doc.node(lowest).is_some_and(|n| !n.kind.is_favorite_kind()))
                    .and_then(|m| known.place_for(doc, m, lowest));
                let target = match place {
                    Some((holder, mut orders)) => {
                        let own = doc.node(lowest).map(|n| n.placement.order.clone());
                        let slot = orders.remove(0);
                        orders.extend(own);
                        refiled
                            .entry((holder, slot))
                            .or_default()
                            .push((orders, lowest));
                        Some(holder)
                    }
                    None => pick_target(doc, lowest, &mut repaired),
                };
                // Report a repair only when `lowest`'s parent changes. A
                // parentless node with nothing safe to attach it to keeps
                // its shape, and a settled document must produce no further
                // changes.
                if target != old_parent {
                    if let Some(node) = doc.node_mut(lowest) {
                        node.placement.parent = target;
                    }
                    repaired.push(lowest);
                }

                // Every node on the walked path, the rest of the broken
                // chain included, reaches a root.
                known_good.extend(visited.iter().copied());
            }
            None => known_good.extend(visited.iter().copied()),
        }
    }

    order_refiled(doc, refiled);
    lift_misfiled(doc, &mut repaired);
    repaired
}

/// The nodes [`repair_unreachable_ancestry_knowing`] files at a deleted
/// group's place: by holder and the group's order, each node with the orders
/// down to it inside the deleted groups.
type Refiled =
    std::collections::BTreeMap<(NodeId, FractionalIndex), Vec<(Vec<FractionalIndex>, NodeId)>>;

/// Gives the nodes [`repair_unreachable_ancestry_knowing`] filed at a deleted
/// group's place their order keys: the first takes the group's own key, and
/// the rest follow it, before the next node in the holder, in the order they
/// held inside the deleted groups (ties by id).
fn order_refiled(doc: &mut Document, refiled: Refiled) {
    let moved: std::collections::HashSet<NodeId> = refiled
        .values()
        .flat_map(|nodes| nodes.iter().map(|(_, id)| *id))
        .collect();
    let slots: Vec<(NodeId, FractionalIndex)> = refiled.keys().cloned().collect();
    for ((holder, slot), mut nodes) in refiled {
        nodes.sort();
        let next = children(doc, holder)
            .into_iter()
            .filter(|id| !moved.contains(id))
            .filter_map(|id| doc.node(id).map(|n| n.placement.order.clone()))
            .chain(
                slots
                    .iter()
                    .filter(|(h, _)| *h == holder)
                    .map(|(_, other)| other.clone()),
            )
            .filter(|order| *order > slot)
            .min();
        let mut order = slot;
        for (i, (_, id)) in nodes.into_iter().enumerate() {
            if i > 0 {
                order = key_between(Some(&order), next.as_ref());
            }
            if let Some(node) = doc.node_mut(id) {
                node.placement.order = order.clone();
            }
        }
    }
}

/// Whether `node` sits where nothing draws it although its chain is sound:
/// under a tab, which is a leaf, or under a split when it is not a tab. A
/// kind this build does not know may belong in a split, so it is left there
/// (see [`NodeKind`]).
fn misfiled(doc: &Document, node: &Node) -> bool {
    match node.placement.parent.and_then(|parent| doc.node(parent)) {
        Some(parent) => match parent.kind {
            NodeKind::Tab => true,
            NodeKind::Split => !matches!(node.kind, NodeKind::Tab | NodeKind::Unknown(_)),
            _ => false,
        },
        None => false,
    }
}

/// Files every [`misfiled`] node beside the tab or split it sits under: under
/// that holder's own parent, immediately after it, in the order the nodes held
/// under it, each with its subtree. Unlike a missing parent, the holder's
/// place is known, so what a peer filed under it stays where the user last
/// saw it (spec §5.2, split-view spec §5.3).
///
/// It runs after the walk in [`repair_unreachable_ancestry`] has made every
/// chain sound. A holder that is itself misfiled is lifted first and its
/// misfiled children on the next round, so each round places nodes beside a
/// holder whose own place is already final, and the result is a pure
/// function of the document. A holder with no parent, which the walk leaves
/// only in a document without a workspace, keeps what is under it, as there
/// is nowhere beside it to file anything.
fn lift_misfiled(doc: &mut Document, repaired: &mut Vec<NodeId>) {
    loop {
        let holders: std::collections::BTreeSet<NodeId> = doc
            .nodes
            .values()
            .filter(|n| misfiled(doc, n))
            .filter_map(|n| n.placement.parent)
            .filter(|holder| doc.node(*holder).is_some_and(|h| !misfiled(doc, h)))
            .collect();
        let holders: Vec<(NodeId, NodeId)> = holders
            .into_iter()
            .filter_map(|holder| {
                doc.node(holder)
                    .and_then(|h| h.placement.parent)
                    .map(|parent| (holder, parent))
            })
            .collect();
        if holders.is_empty() {
            return;
        }
        for (holder, parent) in holders {
            let siblings = children(doc, parent);
            let next = siblings
                .iter()
                .position(|&s| s == holder)
                .and_then(|i| siblings.get(i + 1))
                .and_then(|&s| doc.node(s))
                .map(|n| n.placement.order.clone());
            let Some(mut prev) = doc.node(holder).map(|n| n.placement.order.clone()) else {
                continue;
            };
            let kids: Vec<NodeId> = children(doc, holder)
                .into_iter()
                .filter(|&kid| doc.node(kid).is_some_and(|n| misfiled(doc, n)))
                .collect();
            for kid in kids {
                let order = key_between(Some(&prev), next.as_ref());
                if let Some(node) = doc.node_mut(kid) {
                    node.placement.parent = Some(parent);
                    node.placement.order = order.clone();
                }
                repaired.push(kid);
                prev = order;
            }
        }
    }
}

/// Whether `start`, or any node on its **current** `parent` chain, is
/// `avoid`: whether setting `avoid`'s parent to `start` would make `avoid` its
/// own ancestor. [`validate_move`] asks it to refuse such a move, and
/// [`pick_target`] to skip a repair target that would close a new cycle. A
/// cycle elsewhere in the document ends the walk through `visited`.
fn walks_into(doc: &Document, start: NodeId, avoid: NodeId) -> bool {
    let mut visited = std::collections::HashSet::new();
    let mut current = start;
    loop {
        if current == avoid {
            return true;
        }
        if !visited.insert(current) {
            return false;
        }
        match doc.node(current).and_then(|n| n.placement.parent) {
            Some(parent) => current = parent,
            None => return false,
        }
    }
}

/// Picks where [`repair_unreachable_ancestry`] reparents `for_node`. A
/// workspace whose *own current* ancestry already reaches `for_node` would
/// make `for_node` its own ancestor, so it is skipped, and every workspace is
/// tried, lowest `NodeId` first.
///
/// If every workspace fails that check, the lowest-id one is cut loose: its
/// parent is set to `None` (recorded in `repaired`), the ordinary shape of a
/// workspace, and a node with no parent leads back to nothing. When that
/// workspace is `for_node` itself, `None` is returned and the caller's
/// assignment of `for_node`'s parent makes the same cut. With no workspace in
/// the document, `None` is returned too: nothing safe exists to attach to.
fn pick_target(doc: &mut Document, for_node: NodeId, repaired: &mut Vec<NodeId>) -> Option<NodeId> {
    if doc
        .node(for_node)
        .is_some_and(|n| n.kind.is_favorite_kind())
    {
        return pick_favorite_target(doc, for_node);
    }
    let workspaces: Vec<NodeId> = doc.workspaces().map(|(id, _)| *id).collect();
    if let Some(target) = workspaces
        .iter()
        .copied()
        .find(|&candidate| !walks_into(doc, candidate, for_node))
    {
        return Some(target);
    }

    let &lowest_ws = workspaces.iter().min()?;
    if lowest_ws == for_node {
        return None;
    }
    if let Some(node) = doc.node_mut(lowest_ws)
        && node.placement.parent.is_some()
    {
        node.placement.parent = None;
        repaired.push(lowest_ws);
    }
    Some(lowest_ws)
}

/// Whether a node of `kind` at `id` belongs at the top with no parent: a
/// workspace, a setting, a visit, a history shard, an Archive entry, or one
/// of the Favorites roots, which are folders at fixed ids (favorites-native
/// spec §16).
fn is_a_root(id: NodeId, kind: &NodeKind) -> bool {
    match kind {
        NodeKind::Workspace
        | NodeKind::Setting
        | NodeKind::Visit
        | NodeKind::Shard
        | NodeKind::Archived => true,
        NodeKind::Folder => crate::types::is_favorite_root(id),
        _ => false,
    }
}

/// Where a stranded favorite, folder or separator goes: Favorites, the root
/// Sval shows (decision 0123), else another Favorites root, lowest id first. A
/// favorite is never filed under a workspace, nor a tab under a folder. A root
/// whose ancestry leads back to `for_node` is skipped, as [`pick_target`]
/// skips such a workspace. With no root to take it, the node stays detached.
fn pick_favorite_target(doc: &Document, for_node: NodeId) -> Option<NodeId> {
    let shown = crate::types::favorite_id(crate::types::STRANDED_FAVORITES_GUID);
    let mut roots: Vec<NodeId> = crate::types::FAVORITE_ROOT_GUIDS
        .iter()
        .map(|g| crate::types::favorite_id(g))
        .filter(|&r| r != shown)
        .collect();
    roots.sort();
    roots.insert(0, shown);
    roots
        .into_iter()
        .filter(|&r| r != for_node)
        .find(|&r| doc.node(r).is_some() && !walks_into(doc, r, for_node))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_error_codes_are_pinned() {
        let id = crate::types::test_support::test_id();
        assert_eq!(MoveError::NoSuchNode(id).code(), "no_such_node");
        assert_eq!(MoveError::NoSuchParent(id).code(), "no_such_parent");
        assert_eq!(MoveError::ParentIsATab(id).code(), "parent_is_a_tab");
        assert_eq!(
            MoveError::WouldCycle { id, parent: id }.code(),
            "would_cycle"
        );
        assert_eq!(MoveError::NoParent(id).code(), "no_parent");
        assert_eq!(
            MoveError::OnlyTabsInASplit(id).code(),
            "only_tabs_in_a_split"
        );
        assert_eq!(MoveError::SplitIsFull(id).code(), "split_is_full");
        assert_eq!(
            MoveError::SplitOutsideAPlace(id).code(),
            "split_outside_a_place"
        );
        assert_eq!(
            MoveError::NotARootWorkspace(id).code(),
            "not_a_root_workspace"
        );
    }

    /// The workspaces at the top of the tree, in the order devices list them.
    fn root_workspaces(doc: &Document) -> Vec<NodeId> {
        let mut roots: Vec<(FractionalIndex, NodeId)> = doc
            .workspaces()
            .filter(|(_, node)| node.placement.parent.is_none())
            .map(|(id, node)| (node.placement.order.clone(), *id))
            .collect();
        roots.sort();
        roots.into_iter().map(|(_, id)| id).collect()
    }

    #[test]
    fn move_workspace_reorders_the_roots_and_stamps_the_move() {
        let device = test_device();
        let mut doc = Document::new();
        let a = doc.add_workspace("A", None, NodeId::from_u128(1), device, 0);
        let b = doc.add_workspace("B", None, NodeId::from_u128(2), device, 0);
        let c = doc.add_workspace("C", None, NodeId::from_u128(3), device, 0);
        let other = crate::store::DeviceId::from_bytes([7u8; 16]);

        move_workspace(&mut doc, c, None, Some(a), other, 777).unwrap();
        assert_eq!(root_workspaces(&doc), vec![c, a, b], "to the front");
        let moved = doc.node(c).unwrap();
        assert_eq!(moved.placement.parent, None, "it stays a root");
        assert_eq!(moved.placement_at, 777);
        assert_eq!(moved.placement_by, Some(other));

        move_workspace(&mut doc, c, Some(a), Some(b), device, 778).unwrap();
        assert_eq!(root_workspaces(&doc), vec![a, c, b], "between two");

        move_workspace(&mut doc, a, Some(b), None, device, 779).unwrap();
        assert_eq!(root_workspaces(&doc), vec![c, b, a], "to the end");
    }

    #[test]
    fn move_workspace_refuses_what_is_not_a_root_workspace() {
        let device = test_device();
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, NodeId::from_u128(1), device, 0);
        let other = doc.add_workspace("O", None, NodeId::from_u128(2), device, 0);
        let g = doc.add_group(ws, "G", None, NodeId::from_u128(3), device, 0);
        let mut nested = node_at(NodeKind::Workspace, Some(ws));
        nested.placement_at = 5;
        let inner = NodeId::from_u128(4);
        doc.nodes.insert(inner, nested);
        let absent = NodeId::from_u128(9);
        let before = doc.to_json().unwrap();

        for id in [g, inner] {
            assert_eq!(
                move_workspace(&mut doc, id, None, Some(other), device, 500),
                Err(MoveError::NotARootWorkspace(id))
            );
        }
        assert_eq!(
            move_workspace(&mut doc, absent, None, Some(other), device, 500),
            Err(MoveError::NoSuchNode(absent))
        );
        assert_eq!(doc.to_json().unwrap(), before, "nothing changed");
    }

    #[test]
    fn a_workspace_moved_on_one_device_is_in_that_place_on_both() {
        let device = test_device();
        let peer = crate::store::DeviceId::from_bytes([7u8; 16]);
        let mut a = Document::new();
        let first = a.add_workspace("1", None, NodeId::from_u128(1), device, 0);
        let second = a.add_workspace("2", None, NodeId::from_u128(2), device, 0);
        let third = a.add_workspace("3", None, NodeId::from_u128(3), device, 0);
        let mut b = a.clone();

        move_workspace(&mut b, third, None, Some(first), peer, 900).unwrap();
        let mut a_then_b = a.clone();
        crate::merge::merge(&mut a_then_b, &b);
        let mut b_then_a = b.clone();
        crate::merge::merge(&mut b_then_a, &a);

        assert_eq!(root_workspaces(&a_then_b), vec![third, first, second]);
        assert_eq!(
            a_then_b.to_json().unwrap(),
            b_then_a.to_json().unwrap(),
            "both directions land on the same document"
        );
    }
    use crate::types::test_support::test_device;
    use crate::types::{Appearance, Content, Document, Lifecycle, Node, NodeKind, Placement};
    use proptest::prelude::*;

    #[test]
    fn repair_leaves_a_parentless_setting_where_it_is() {
        // A setting is a root by nature, like a workspace: it has no parent
        // and is never drawn. Treating it as stranded would reparent it under
        // a workspace and write that into synced data.
        let setting = NodeId::from_u128(7);
        let mut doc = Document::new();
        doc.nodes.insert(setting, node_at(NodeKind::Setting, None));

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert!(repaired.is_empty(), "nothing to repair: {repaired:?}");
        assert_eq!(doc.node(setting).unwrap().placement.parent, None);
    }

    /// A bare node of `kind` under `parent`, attributed to [`test_device`].
    /// Tests insert it under fixed ids ([`NodeId::from_u128`]) because
    /// `repair_unreachable_ancestry` iterates `nodes` in `NodeId` order, and a
    /// test that depends on one node being visited before another needs that
    /// order pinned.
    fn node_at(kind: NodeKind, parent: Option<NodeId>) -> Node {
        Node {
            kind,
            content: Content {
                name: "n".into(),
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
            },
            content_at: 0,
            content_by: Some(test_device()),
            placement: Placement {
                parent,
                order: FractionalIndex::default(),
                extra: Default::default(),
            },
            placement_at: 0,
            placement_by: Some(test_device()),
            lifecycle: Lifecycle {
                pinned: false,
                isolated: false,
                home_order: None,
                pin_scope: None,
                auto_archive: None,
                restored: false,
                extra: Default::default(),
            },
            lifecycle_at: 0,
            lifecycle_by: Some(test_device()),
            appearance: Appearance::default(),
            appearance_at: 0,
            appearance_by: Some(test_device()),
            touched_at: 0,
            touched_by: None,
            agent: None,
            device_home: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn children_come_back_in_sibling_order() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let a = doc.add_tab(
            ws,
            "A",
            "https://a.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let c = doc.add_tab(
            ws,
            "C",
            "https://c.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let b = insert_tab_between(
            &mut doc,
            ws,
            Some(a),
            Some(c),
            "B",
            "https://b.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        assert_eq!(children(&doc, ws), vec![a, b, c]);
    }

    #[test]
    fn a_removed_node_is_no_longer_a_child() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let a = doc.add_tab(
            ws,
            "A",
            "https://a.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let b = doc.add_tab(
            ws,
            "B",
            "https://b.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        doc.remove(a);

        assert_eq!(children(&doc, ws), vec![b]);
    }

    #[test]
    fn equal_order_keys_tiebreak_by_id_and_never_panic() {
        // A merge can leave two siblings with identical order keys. Ordering
        // must stay total and deterministic.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let a = doc.add_tab(
            ws,
            "A",
            "https://a.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let b = doc.add_tab(
            ws,
            "B",
            "https://b.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let key = doc.node(a).unwrap().placement.order.clone();
        doc.node_mut(b).unwrap().placement.order = key;

        let first = children(&doc, ws);
        let second = children(&doc, ws);
        assert_eq!(first, second, "ordering must be deterministic");
        assert_eq!(
            first,
            vec![a.min(b), a.max(b)],
            "tie must break by id, lower first"
        );
    }

    #[test]
    fn repair_leaves_a_chain_that_reaches_an_unknown_kind_alone() {
        // A newer build's kind may be a root, or may sit under something this
        // build cannot see. Only the build that knows the kind can tell, so
        // neither the node nor anything beneath it is repaired here.
        let ws = NodeId::from_u128(1);
        let root_note = NodeId::from_u128(2);
        let under_root_note = NodeId::from_u128(3);
        let stranded_note = NodeId::from_u128(4);
        let under_stranded_note = NodeId::from_u128(5);
        let missing = NodeId::from_u128(99);
        let note = || NodeKind::Unknown("note".into());
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(root_note, node_at(note(), None));
        doc.nodes
            .insert(under_root_note, node_at(NodeKind::Tab, Some(root_note)));
        doc.nodes
            .insert(stranded_note, node_at(note(), Some(missing)));
        doc.nodes.insert(
            under_stranded_note,
            node_at(NodeKind::Tab, Some(stranded_note)),
        );

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert!(repaired.is_empty(), "repaired {repaired:?}");
        assert_eq!(doc.node(root_note).unwrap().placement.parent, None);
        assert_eq!(
            doc.node(stranded_note).unwrap().placement.parent,
            Some(missing)
        );
        assert_eq!(
            doc.node(under_root_note).unwrap().placement.parent,
            Some(root_note)
        );
    }

    #[test]
    fn repair_reparents_the_lower_id_to_the_root_on_a_cycle() {
        // Device A moved X into Y while device B moved Y into X. Fixed ids
        // (x < y) pin down *which* one must move: an expectation computed
        // from the repair's own output would only assert that one moved.
        let ws = NodeId::from_u128(1);
        let x = NodeId::from_u128(2);
        let y = NodeId::from_u128(3);
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(x, node_at(NodeKind::Group, Some(y)));
        doc.nodes.insert(y, node_at(NodeKind::Group, Some(x)));

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert_eq!(
            repaired,
            vec![x.min(y)],
            "the lower id must be the one reparented"
        );
        assert_eq!(doc.node(x.min(y)).unwrap().placement.parent, Some(ws));
        assert_eq!(doc.node(x.max(y)).unwrap().placement.parent, Some(x.min(y)));
        assert!(children(&doc, ws).contains(&x.min(y)));
    }

    #[test]
    fn repair_reparents_a_node_whose_parent_was_deleted() {
        // Device A adds a tab into group G; device B deletes G. The tab is
        // in `nodes`, but its parent is gone, so nothing walks into it and
        // it is invisible for a reason its owner can't see (spec §5.2,
        // §5.4).
        //
        // Fixed ids with g < tab: `known_good` letting a walk skip a broken
        // link shows only in a particular visit order, and
        // `repair_unreachable_ancestry` iterates `nodes` in `NodeId` order.
        let ws = NodeId::from_u128(1);
        let g = NodeId::from_u128(2);
        let tab = NodeId::from_u128(3);
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(g, node_at(NodeKind::Group, Some(ws)));
        let mut tab_node = node_at(NodeKind::Tab, Some(g));
        tab_node.placement_at = 50;
        doc.nodes.insert(tab, tab_node);
        // What a merge leaves when a peer deleted G without having seen the tab.
        doc.nodes.remove(&g);
        assert!(
            !children(&doc, ws).contains(&tab),
            "test setup: the tab must start out unreachable"
        );

        let broken = repair_unreachable_ancestry(&mut doc);

        assert_eq!(broken, vec![tab]);
        assert_eq!(doc.node(tab).unwrap().placement.parent, Some(ws));
        assert_eq!(
            doc.node(tab).unwrap().placement_at,
            50,
            "the repair carries the stamp of the write it repairs"
        );
        assert!(
            children(&doc, ws).contains(&tab),
            "a node whose parent was deleted must be reachable again"
        );

        let before = doc.to_json().unwrap();
        assert!(
            repair_unreachable_ancestry(&mut doc).is_empty(),
            "repair must be idempotent"
        );
        assert_eq!(before, doc.to_json().unwrap());
    }

    #[test]
    fn a_stranded_child_lands_on_the_lowest_id_workspace() {
        // With nothing recording where the deleted group stood, the
        // fallback is the lowest-id workspace.
        let ws_low = NodeId::from_u128(1);
        let ws_high = NodeId::from_u128(2);
        let g = NodeId::from_u128(3);
        let tab = NodeId::from_u128(4);
        let mut doc = Document::new();
        doc.nodes.insert(ws_low, node_at(NodeKind::Workspace, None));
        doc.nodes
            .insert(ws_high, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(g, node_at(NodeKind::Group, Some(ws_high)));
        doc.nodes.insert(tab, node_at(NodeKind::Tab, Some(g)));

        // What a merge leaves when a peer deleted G without having seen the tab.
        doc.nodes.remove(&g);
        let repaired = repair_unreachable_ancestry(&mut doc);

        assert_eq!(repaired, vec![tab]);
        assert_eq!(doc.node(tab).unwrap().placement.parent, Some(ws_low));
    }

    /// `n` sibling orders, ascending, for nodes built with `node_at`.
    fn orders(n: usize) -> Vec<FractionalIndex> {
        let mut out = vec![FractionalIndex::default()];
        while out.len() < n {
            let next = FractionalIndex::new_after(out.last().unwrap());
            out.push(next);
        }
        out
    }

    #[test]
    fn a_group_filed_in_a_split_goes_beside_the_split_and_its_panes_stay() {
        // A hand-edited file puts group G, holding tab C, between the panes
        // of split P, which sits before tab S. A split holds tabs only, so G
        // is drawn nowhere until it is filed right after P, with C inside it.
        let [ws, p, a, g, b, c, s] = [1, 2, 3, 4, 5, 6, 7].map(NodeId::from_u128);
        let at = orders(3);
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(p, node_at(NodeKind::Split, Some(ws)));
        let mut s_node = node_at(NodeKind::Tab, Some(ws));
        s_node.placement.order = at[1].clone();
        doc.nodes.insert(s, s_node);
        for (id, kind, order) in [
            (a, NodeKind::Tab, 0),
            (g, NodeKind::Group, 1),
            (b, NodeKind::Tab, 2),
        ] {
            let mut node = node_at(kind, Some(p));
            node.placement.order = at[order].clone();
            doc.nodes.insert(id, node);
        }
        doc.nodes.insert(c, node_at(NodeKind::Tab, Some(g)));

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert_eq!(repaired, vec![g]);
        assert_eq!(children(&doc, ws), vec![p, g, s]);
        assert_eq!(children(&doc, p), vec![a, b]);
        assert_eq!(children(&doc, g), vec![c]);
        assert!(repair_unreachable_ancestry(&mut doc).is_empty());
    }

    #[test]
    fn a_split_with_no_parent_is_filed_in_a_workspace_with_its_panes() {
        let [ws, p, a] = [1, 2, 3].map(NodeId::from_u128);
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(p, node_at(NodeKind::Split, None));
        doc.nodes.insert(a, node_at(NodeKind::Tab, Some(p)));

        assert_eq!(repair_unreachable_ancestry(&mut doc), vec![p]);
        assert_eq!(children(&doc, ws), vec![p]);
        assert_eq!(children(&doc, p), vec![a]);
    }

    #[test]
    fn a_kind_this_build_does_not_know_stays_in_a_split() {
        // A newer build may put a kind of its own in a split; only it knows
        // whether one belongs there.
        let [ws, p, a, x] = [1, 2, 3, 4].map(NodeId::from_u128);
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(p, node_at(NodeKind::Split, Some(ws)));
        doc.nodes.insert(a, node_at(NodeKind::Tab, Some(p)));
        doc.nodes
            .insert(x, node_at(NodeKind::Unknown("pane".into()), Some(p)));

        assert!(repair_unreachable_ancestry(&mut doc).is_empty());
        assert_eq!(children(&doc, p), vec![a, x]);
    }

    #[test]
    fn a_node_filed_under_a_tab_moves_beside_that_tab_with_its_subtree() {
        // A peer on another build files group G under tab T, with tab C
        // inside G. T sits in the higher-id workspace, before tab S. A tab is
        // a leaf, so G and C are drawn nowhere until G is filed beside T, in
        // T's workspace, with C still inside it.
        let ws_low = NodeId::from_u128(1);
        let ws_high = NodeId::from_u128(2);
        let t = NodeId::from_u128(3);
        let g = NodeId::from_u128(4);
        let c = NodeId::from_u128(5);
        let s = NodeId::from_u128(6);
        let mut doc = Document::new();
        doc.nodes.insert(ws_low, node_at(NodeKind::Workspace, None));
        doc.nodes
            .insert(ws_high, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(t, node_at(NodeKind::Tab, Some(ws_high)));
        let mut s_node = node_at(NodeKind::Tab, Some(ws_high));
        s_node.placement.order = FractionalIndex::new_after(&FractionalIndex::default());
        doc.nodes.insert(s, s_node);
        let mut g_node = node_at(NodeKind::Group, Some(t));
        g_node.placement_at = 50;
        doc.nodes.insert(g, g_node);
        doc.nodes.insert(c, node_at(NodeKind::Tab, Some(g)));

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert_eq!(repaired, vec![g]);
        assert_eq!(children(&doc, ws_high), vec![t, g, s]);
        assert!(children(&doc, ws_low).is_empty());
        assert_eq!(doc.node(g).unwrap().placement_at, 50);
        assert_eq!(children(&doc, g), vec![c]);
        assert!(
            repair_unreachable_ancestry(&mut doc).is_empty(),
            "repair must be idempotent"
        );
    }

    #[test]
    fn nodes_under_a_tab_under_a_tab_land_beside_their_tabs_in_order() {
        // Tab T1 sits before tab S. T1 holds tab T2 and group G, in that
        // order, and T2 holds tab X. Each comes out beside the tab it was
        // under, keeping its order, all of them before S.
        let ws = NodeId::from_u128(1);
        let t1 = NodeId::from_u128(2);
        let t2 = NodeId::from_u128(3);
        let g = NodeId::from_u128(4);
        let x = NodeId::from_u128(5);
        let s = NodeId::from_u128(6);
        let first = FractionalIndex::default();
        let second = FractionalIndex::new_after(&first);
        let mut doc = Document::new();
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(t1, node_at(NodeKind::Tab, Some(ws)));
        let mut s_node = node_at(NodeKind::Tab, Some(ws));
        s_node.placement.order = second.clone();
        doc.nodes.insert(s, s_node);
        doc.nodes.insert(t2, node_at(NodeKind::Tab, Some(t1)));
        let mut g_node = node_at(NodeKind::Group, Some(t1));
        g_node.placement.order = FractionalIndex::new_after(&second);
        doc.nodes.insert(g, g_node);
        doc.nodes.insert(x, node_at(NodeKind::Tab, Some(t2)));

        repair_unreachable_ancestry(&mut doc);

        assert_eq!(children(&doc, ws), vec![t1, t2, x, g, s]);
        assert!(
            repair_unreachable_ancestry(&mut doc).is_empty(),
            "repair must be idempotent"
        );
    }

    #[test]
    fn repair_picks_the_lower_id_among_two_workspaces() {
        // Two workspaces to choose between, so root selection must pick the
        // *lowest* NodeId. `orphan` is its own parent, a one-node cycle,
        // forcing a repair to pick a root.
        let ws_low = NodeId::from_u128(1);
        let ws_high = NodeId::from_u128(2);
        let orphan = NodeId::from_u128(3);
        let mut doc = Document::new();
        doc.nodes.insert(ws_low, node_at(NodeKind::Workspace, None));
        doc.nodes
            .insert(ws_high, node_at(NodeKind::Workspace, None));
        doc.nodes
            .insert(orphan, node_at(NodeKind::Group, Some(orphan)));

        repair_unreachable_ancestry(&mut doc);

        assert_eq!(doc.node(orphan).unwrap().placement.parent, Some(ws_low));
    }

    #[test]
    fn repair_does_not_read_the_clock() {
        // The repair must be a pure function of the document: placement_at is
        // the stamp the broken placement already carried.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let x = doc.add_group(
            ws,
            "X",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let y = doc.add_group(
            ws,
            "Y",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.node_mut(x).unwrap().placement.parent = Some(y);
        doc.node_mut(y).unwrap().placement.parent = Some(x);

        let broken = repair_unreachable_ancestry(&mut doc);

        assert_eq!(
            doc.node(broken[0]).unwrap().placement_at,
            0,
            "repair must not touch the clock"
        );
    }

    #[test]
    fn repair_detaches_rather_than_self_parents_the_fallback_workspace() {
        // No API gives a workspace a parent, but merge accepts whatever a
        // peer's file says, so a hand-edited or future-build file can make
        // the only workspace W a member of a cycle with X. There is no other
        // workspace to cut loose on W's behalf, so W is cut loose itself
        // (its own parent set to `None`).
        let mut doc = Document::new();
        let w = NodeId::from_u128(1);
        let x = NodeId::from_u128(4);
        doc.nodes.insert(w, node_at(NodeKind::Workspace, Some(x)));
        doc.nodes.insert(x, node_at(NodeKind::Group, Some(w)));

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert!(
            !repaired.is_empty(),
            "w's cycle should have been reported as repaired"
        );
        assert_eq!(
            doc.node(w).unwrap().placement.parent,
            None,
            "the workspace must be cut loose (detached), not parented anywhere at all"
        );
        assert!(
            reachable_from(&doc, w, x),
            "x must be reachable from the workspace after repair"
        );

        let before = doc.to_json().unwrap();
        let second_pass = repair_unreachable_ancestry(&mut doc);
        assert!(
            second_pass.is_empty(),
            "repair must be idempotent: a second pass found more to fix"
        );
        assert_eq!(
            before,
            doc.to_json().unwrap(),
            "a no-op repair pass must not change any bytes"
        );
    }

    #[test]
    fn repair_uses_a_second_safe_workspace_rather_than_detaching_a_node() {
        // Workspace 1's own chain runs into node 3 (by way of node 3's
        // self-referential parent), so 1 is unsafe as node 3's target.
        // Workspace 2 is a root (`parent: None`) and safe, so the search
        // must go on past the first rejected candidate.
        let mut doc = Document::new();
        let w1 = NodeId::from_u128(1);
        let w2 = NodeId::from_u128(2);
        let g = NodeId::from_u128(3);
        doc.nodes.insert(w1, node_at(NodeKind::Workspace, Some(g)));
        doc.nodes.insert(w2, node_at(NodeKind::Workspace, None));
        doc.nodes.insert(g, node_at(NodeKind::Group, Some(g)));

        let repaired = repair_unreachable_ancestry(&mut doc);
        assert_eq!(repaired, vec![g], "only g should have been touched");

        // Reachability alone does not show that the *safe* workspace was
        // used and the *unsafe* one left untouched: cutting the lowest-id
        // workspace loose would also leave `g` reachable.
        assert_eq!(
            doc.node(g).unwrap().placement.parent,
            Some(w2),
            "g must attach to the safe workspace the search found"
        );
        assert_eq!(
            doc.node(w1).unwrap().placement.parent,
            Some(g),
            "the unsafe workspace must not be touched when a safe one exists"
        );

        let before = doc.to_json().unwrap();
        let second_pass = repair_unreachable_ancestry(&mut doc);
        assert!(second_pass.is_empty(), "repair must be idempotent");
        assert_eq!(before, doc.to_json().unwrap());
    }

    #[test]
    fn repair_cuts_the_entangled_workspace_loose_rather_than_orphaning_a_ring() {
        // Moving `lowest`'s one link reattaches a ring only if `lowest`'s new
        // parent is itself reachable. Here the only workspace's own chain
        // runs into the ring being repaired, so detaching `lowest` would
        // orphan every node chained through it. Cutting the workspace's own
        // parent makes it a root, and the ring reattaches whole.
        let mut doc = Document::new();
        let ws = NodeId::from_u128(1);
        let a = NodeId::from_u128(2);
        let b = NodeId::from_u128(3);
        doc.nodes.insert(ws, node_at(NodeKind::Workspace, Some(a)));
        doc.nodes.insert(a, node_at(NodeKind::Group, Some(b)));
        doc.nodes.insert(b, node_at(NodeKind::Group, Some(a)));

        let repaired = repair_unreachable_ancestry(&mut doc);

        assert!(!repaired.is_empty());
        assert_eq!(
            doc.node(ws).unwrap().placement.parent,
            None,
            "the workspace must become a genuine root"
        );
        // Only `lowest` (a) moves, to the freed workspace; b is untouched,
        // still chained through a.
        assert_eq!(
            doc.node(a).unwrap().placement.parent,
            Some(ws),
            "a (lowest) must be the one node reparented, directly to the freed workspace"
        );
        assert_eq!(
            doc.node(b).unwrap().placement.parent,
            Some(a),
            "b must stay chained through a, not independently reattached"
        );
        assert_eq!(
            crate::tree::children(&doc, ws),
            vec![a],
            "the workspace's own children() must be exactly the freed ring's entry point"
        );

        let before = doc.to_json().unwrap();
        let second_pass = repair_unreachable_ancestry(&mut doc);
        assert!(second_pass.is_empty(), "repair must be idempotent");
        assert_eq!(before, doc.to_json().unwrap());
    }

    #[test]
    fn two_devices_compute_the_same_repair_without_either_having_to_win_a_merge() {
        // Spec §5.2: the repaired placement keeps the stamp of the write it
        // repairs, so it ties with an unrepaired peer's copy of that write.
        // Whichever the tie-break picks, repair is a pure function of the
        // merged document, so each device computes the same fix after the
        // merge, whichever order the two ran in.
        let ws = NodeId::from_u128(1);
        let g = NodeId::from_u128(2);
        let tab = NodeId::from_u128(3);

        // Device A: had a tab under G, then G was deleted, and A repaired.
        let mut a = Document::new();
        a.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        let mut tab_node = node_at(NodeKind::Tab, Some(g));
        tab_node.placement_at = 50; // the tab's original, pre-repair placement.
        a.nodes.insert(tab, tab_node.clone());
        repair_unreachable_ancestry(&mut a);
        assert_eq!(a.node(tab).unwrap().placement.parent, Some(ws));

        // Device B never saw the deletion or the repair: it still has G, and
        // the tab's pre-repair placement.
        let mut b = Document::new();
        b.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        b.nodes.insert(g, node_at(NodeKind::Group, Some(ws)));
        b.nodes.insert(tab, tab_node);

        let mut a_then_b = a.clone();
        crate::merge::merge(&mut a_then_b, &b);
        repair_unreachable_ancestry(&mut a_then_b);
        let mut b_then_a = b.clone();
        crate::merge::merge(&mut b_then_a, &a);
        repair_unreachable_ancestry(&mut b_then_a);

        assert_eq!(
            a_then_b.to_json().unwrap(),
            b_then_a.to_json().unwrap(),
            "both directions must land on the same repaired document"
        );
    }

    #[test]
    fn a_genuinely_later_move_still_beats_a_repaired_placement() {
        // Spec §5.4: a later user move on another device beats the repair's
        // derived placement on the next merge.
        let ws = NodeId::from_u128(1);
        let other_ws = NodeId::from_u128(2);
        let g = NodeId::from_u128(3);
        let tab = NodeId::from_u128(4);

        let mut a = Document::new();
        a.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        a.nodes.insert(g, node_at(NodeKind::Group, Some(ws)));
        a.nodes.insert(tab, node_at(NodeKind::Tab, Some(g)));
        // What a merge leaves when a peer deleted G without having seen the tab.
        a.nodes.remove(&g);
        repair_unreachable_ancestry(&mut a);
        assert_eq!(a.node(tab).unwrap().placement_at, 0, "test setup");

        // Device B moved the tab, later, to a different workspace.
        let mut b = Document::new();
        b.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        b.nodes.insert(other_ws, node_at(NodeKind::Workspace, None));
        let mut moved_tab = node_at(NodeKind::Tab, Some(other_ws));
        moved_tab.placement_at = 900; // later than the write the repair kept.
        b.nodes.insert(tab, moved_tab);

        crate::merge::merge(&mut a, &b);
        assert_eq!(
            a.node(tab).unwrap().placement.parent,
            Some(other_ws),
            "a genuinely later move must still win"
        );
        assert_eq!(a.node(tab).unwrap().placement_at, 900);
    }

    #[test]
    fn a_group_deleted_with_its_contents_kept_leaves_them_where_it_was() {
        // "Delete group", "move them out": the contents come out one level
        // up, in their order, at the group's place, and a group inside comes
        // out whole. The workspace with the lower id is where repair would
        // put a child left behind.
        let device = test_device();
        let mut doc = Document::new();
        let lower = doc.add_workspace("Lower", None, NodeId::from_u128(1), device, 0);
        let ws = doc.add_workspace("W", None, NodeId::from_u128(2), device, 0);
        let tab = |doc: &mut Document, parent, name: &str| {
            doc.add_tab(
                parent,
                name,
                "https://e.example",
                crate::types::test_support::test_id(),
                device,
                0,
            )
        };
        let a = tab(&mut doc, ws, "a");
        let group = doc.add_group(
            ws,
            "G",
            None,
            crate::types::test_support::test_id(),
            device,
            0,
        );
        let b = tab(&mut doc, ws, "b");
        let x = tab(&mut doc, group, "x");
        let inner = doc.add_group(
            group,
            "Inner",
            None,
            crate::types::test_support::test_id(),
            device,
            0,
        );
        let y = tab(&mut doc, inner, "y");
        assert_eq!(children(&doc, ws), vec![a, group, b], "test setup");
        assert_eq!(children(&doc, group), vec![x, inner], "test setup");

        remove_keeping_children(&mut doc, group, device, 500).unwrap();

        assert!(doc.node(group).is_none());
        assert_eq!(children(&doc, ws), vec![a, x, inner, b]);
        assert_eq!(children(&doc, inner), vec![y]);
        assert!(children(&doc, lower).is_empty());
        assert!(repair_unreachable_ancestry(&mut doc).is_empty());
        let moved = doc.node(x).unwrap();
        assert_eq!(
            (moved.placement_at, moved.placement_by),
            (500, Some(device))
        );
    }

    #[test]
    fn a_first_group_removed_keeping_its_children_leaves_them_first() {
        let device = test_device();
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, NodeId::from_u128(1), device, 0);
        let group = doc.add_group(ws, "G", None, NodeId::from_u128(2), device, 0);
        let a = doc.add_tab(
            ws,
            "a",
            "https://a.example",
            NodeId::from_u128(3),
            device,
            0,
        );
        let b = doc.add_tab(
            ws,
            "b",
            "https://b.example",
            NodeId::from_u128(4),
            device,
            0,
        );
        let x = doc.add_tab(
            group,
            "x",
            "https://x.example",
            NodeId::from_u128(5),
            device,
            0,
        );
        let y = doc.add_tab(
            group,
            "y",
            "https://y.example",
            NodeId::from_u128(6),
            device,
            0,
        );

        remove_keeping_children(&mut doc, group, device, 500).unwrap();

        assert_eq!(children(&doc, ws), vec![x, y, a, b]);
    }

    #[test]
    fn a_split_takes_back_a_tab_from_a_group_deleted_inside_it_and_no_group() {
        // A group inside a split is a shape only a merge brings; the tab and
        // the group filed in it are what a device that still held it added.
        let device = test_device();
        let id = NodeId::from_u128;
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, id(1), device, 0);
        let split = doc.add_split(ws, "", id(2), device, 0);
        doc.add_tab(split, "pane", "https://p.example", id(3), device, 0);
        let gone = doc.add_group(split, "G", None, id(4), device, 0);
        let tab = doc.add_tab(gone, "t", "https://t.example", id(5), device, 0);
        let group = doc.add_group(gone, "Inner", None, id(6), device, 0);
        let mut known = KnownPlaces::default();
        known.note(&doc);
        doc.nodes.remove(&gone);

        repair_unreachable_ancestry_knowing(&mut doc, &known);

        assert_eq!(doc.node(tab).unwrap().placement.parent, Some(split));
        assert_eq!(doc.node(group).unwrap().placement.parent, Some(ws));
    }

    #[test]
    fn tabs_filed_in_a_deleted_group_land_together_before_its_next_sibling() {
        let device = test_device();
        let id = NodeId::from_u128;
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, id(1), device, 0);
        let a = doc.add_tab(ws, "a", "https://a.example", id(10), device, 0);
        let gone = doc.add_group(ws, "G", None, id(20), device, 0);
        let b = doc.add_tab(ws, "b", "https://b.example", id(11), device, 0);
        let x = doc.add_tab(gone, "x", "https://x.example", id(31), device, 0);
        let y = doc.add_tab(gone, "y", "https://y.example", id(30), device, 0);
        // x is first in the group and has the higher id, so only the keys
        // keep it first.
        let mut known = KnownPlaces::default();
        known.note(&doc);
        doc.nodes.remove(&gone);

        repair_unreachable_ancestry_knowing(&mut doc, &known);

        assert_eq!(children(&doc, ws), vec![a, x, y, b]);
    }

    #[test]
    fn tabs_from_two_deleted_neighbour_groups_keep_the_groups_order() {
        let device = test_device();
        let id = NodeId::from_u128;
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, id(1), device, 0);
        let a = doc.add_tab(ws, "a", "https://a.example", id(10), device, 0);
        let first = doc.add_group(ws, "G1", None, id(20), device, 0);
        let second = doc.add_group(ws, "G2", None, id(21), device, 0);
        let b = doc.add_tab(ws, "b", "https://b.example", id(11), device, 0);
        let x = doc.add_tab(first, "x", "https://x.example", id(30), device, 0);
        let y = doc.add_tab(first, "y", "https://y.example", id(31), device, 0);
        let z = doc.add_tab(second, "z", "https://z.example", id(29), device, 0);
        let mut known = KnownPlaces::default();
        known.note(&doc);
        doc.nodes.remove(&first);
        doc.nodes.remove(&second);

        repair_unreachable_ancestry_knowing(&mut doc, &known);

        assert_eq!(children(&doc, ws), vec![a, x, y, z, b]);
    }

    #[test]
    fn a_workspace_has_nowhere_to_move_its_contents_and_is_left_alone() {
        let device = test_device();
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), device, 0);
        doc.add_tab(
            ws,
            "t",
            "https://e.example",
            crate::types::test_support::test_id(),
            device,
            0,
        );
        let before = doc.to_json().unwrap();

        assert_eq!(
            remove_keeping_children(&mut doc, ws, device, 500),
            Err(MoveError::NoParent(ws))
        );
        assert_eq!(doc.to_json().unwrap(), before);
        let absent = crate::types::test_support::test_id();
        assert_eq!(
            remove_keeping_children(&mut doc, absent, device, 500),
            Err(MoveError::NoSuchNode(absent))
        );
    }

    #[test]
    fn move_node_reparents_and_reorders() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let other = doc.add_group(
            ws,
            "other",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let a = doc.add_tab(
            other,
            "A",
            "https://a.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let c = doc.add_tab(
            other,
            "C",
            "https://c.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "moved",
            "https://moved.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        move_node(&mut doc, tab, other, Some(a), Some(c), test_device(), 777).unwrap();

        assert_eq!(doc.node(tab).unwrap().placement.parent, Some(other));
        assert_eq!(children(&doc, other), vec![a, tab, c]);
        assert!(!children(&doc, ws).contains(&tab));
        assert_eq!(
            doc.node(tab).unwrap().placement_at,
            777,
            "placement_at must be exactly the caller-supplied timestamp, not a clock reading"
        );
    }

    #[test]
    fn move_node_to_a_workspace_works() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let g = doc.add_group(
            ws,
            "G",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            g,
            "T",
            "https://t.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        move_node(&mut doc, tab, ws, None, None, test_device(), 500).unwrap();

        assert_eq!(doc.node(tab).unwrap().placement.parent, Some(ws));
        assert!(children(&doc, ws).contains(&tab));
    }

    #[test]
    fn move_under_a_tab_is_refused_and_changes_nothing() {
        // Tabs are leaves (spec §5.2). The panel draws a node parented under
        // one as stranded so it stays reachable (spec §10.7), but the engine
        // must not create the shape in the first place.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let leaf = doc.add_tab(
            ws,
            "leaf",
            "https://leaf.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "T",
            "https://t.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = doc.to_json().unwrap();

        assert_eq!(
            move_node(&mut doc, tab, leaf, None, None, test_device(), 500),
            Err(MoveError::ParentIsATab(leaf))
        );
        assert_eq!(
            doc.to_json().unwrap(),
            before,
            "a refused move must leave the document byte-for-byte unchanged"
        );
    }

    #[test]
    fn move_under_an_absent_parent_is_refused_and_changes_nothing() {
        // The shape a peer's deletion leaves: the parent the user dropped
        // onto is gone. Creating the link would strand the node until
        // `repair_unreachable_ancestry` put it somewhere nobody chose.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "T",
            "https://t.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let absent = NodeId::from_u128(999);
        let before = doc.to_json().unwrap();

        assert_eq!(
            move_node(&mut doc, tab, absent, None, None, test_device(), 500),
            Err(MoveError::NoSuchParent(absent))
        );
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn moving_an_absent_node_is_refused_rather_than_silently_doing_nothing() {
        // A host that got "ok" here would redraw a move that never happened.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let absent = NodeId::from_u128(999);
        let before = doc.to_json().unwrap();

        assert_eq!(
            move_node(&mut doc, absent, ws, None, None, test_device(), 500),
            Err(MoveError::NoSuchNode(absent))
        );
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn move_under_itself_is_refused_and_changes_nothing() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let g = doc.add_group(
            ws,
            "G",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = doc.to_json().unwrap();

        assert_eq!(
            move_node(&mut doc, g, g, None, None, test_device(), 500),
            Err(MoveError::WouldCycle { id: g, parent: g })
        );
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn move_under_a_descendant_is_refused_and_changes_nothing() {
        // Dropping a group onto its own grandchild detaches the whole chain
        // into a ring. One hop of ancestry does not see it, so the check
        // walks the chain.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let outer = doc.add_group(
            ws,
            "outer",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let middle = doc.add_group(
            outer,
            "middle",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let inner = doc.add_group(
            middle,
            "inner",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = doc.to_json().unwrap();

        assert_eq!(
            move_node(&mut doc, outer, inner, None, None, test_device(), 500),
            Err(MoveError::WouldCycle {
                id: outer,
                parent: inner
            })
        );
        assert_eq!(doc.to_json().unwrap(), before);
        assert!(
            repair_unreachable_ancestry(&mut doc).is_empty(),
            "nothing was broken, so there is nothing to repair"
        );
        assert_eq!(doc.node(middle).unwrap().placement.parent, Some(outer));
    }

    #[test]
    fn a_merge_keeps_a_tab_parented_node_a_peer_sent() {
        // `move_node`'s validation is a local-edit rule, never a merge
        // filter: a peer on a different build may hold a shape this build
        // refuses to create, and merge keeps what it is given (spec §5.3).
        // Dropping the node would delete that device's data.
        let ws = NodeId::from_u128(1);
        let leaf = NodeId::from_u128(2);
        let stranded = NodeId::from_u128(3);

        let mut ours = Document::new();
        ours.nodes.insert(ws, node_at(NodeKind::Workspace, None));
        ours.nodes.insert(leaf, node_at(NodeKind::Tab, Some(ws)));

        let mut theirs = ours.clone();
        theirs
            .nodes
            .insert(stranded, node_at(NodeKind::Tab, Some(leaf)));

        crate::merge::merge(&mut ours, &theirs);

        assert!(
            ours.node(stranded).is_some(),
            "merge must keep a node whose parent is a tab, not filter it out"
        );
        assert_eq!(ours.node(stranded).unwrap().placement.parent, Some(leaf));

        // Read-time repair does not delete it either.
        repair_unreachable_ancestry(&mut ours);
        assert!(ours.node(stranded).is_some());
    }

    #[test]
    fn deep_tree_has_no_cycles_to_break() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let mut parent = ws;
        for i in 0..50 {
            parent = doc.add_group(
                parent,
                format!("g{i}"),
                None,
                crate::types::test_support::test_id(),
                test_device(),
                0,
            );
        }
        assert!(repair_unreachable_ancestry(&mut doc).is_empty());
    }

    /// Whether `id`'s ancestry chain (following `parent`) ever revisits a
    /// node.
    fn has_cycle_from(doc: &Document, id: NodeId) -> bool {
        let mut seen = std::collections::HashSet::new();
        let mut current = id;
        loop {
            if !seen.insert(current) {
                return true;
            }
            match doc.node(current).and_then(|n| n.placement.parent) {
                Some(parent) => current = parent,
                None => return false,
            }
        }
    }

    /// Whether `target` is reachable from `root` by repeatedly calling
    /// [`children`], the read-time notion of "in the tree". A node with an
    /// acyclic parent chain can still never turn up under `root`, when
    /// nothing on the path down to it calls it a child.
    fn reachable_from(doc: &Document, root: NodeId, target: NodeId) -> bool {
        let mut stack = vec![root];
        let mut seen = std::collections::HashSet::new();
        while let Some(current) = stack.pop() {
            if !seen.insert(current) {
                continue;
            }
            if current == target {
                return true;
            }
            stack.extend(children(doc, current));
        }
        false
    }

    proptest! {
        // Threads 2n groups (n >= 3) into one big cycle, gives each segment
        // a hanger-on child, and asserts the pass terminates, leaves every
        // node's ancestry acyclic, and leaves every node reachable from the
        // workspace via `children()`. Acyclic alone allows a repair that
        // detaches a node into an orphaned island.
        #[test]
        fn repair_terminates_with_multiple_interlocking_cycles(n in 3usize..8) {
            let mut doc = Document::new();
            let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), test_device(), 0);

            let cycle_ids: Vec<NodeId> = (0..2 * n).map(|i| doc.add_group(ws, format!("c{i}"), None, crate::types::test_support::test_id(), test_device(), 0)).collect();
            for i in 0..cycle_ids.len() {
                let next = cycle_ids[(i + 1) % cycle_ids.len()];
                doc.node_mut(cycle_ids[i]).unwrap().placement.parent = Some(next);
            }

            let mut all_ids = cycle_ids.clone();
            for (i, &id) in cycle_ids.iter().enumerate() {
                let hanger = doc.add_group(ws, format!("h{i}"), None, crate::types::test_support::test_id(), test_device(), 0);
                doc.node_mut(hanger).unwrap().placement.parent = Some(id);
                all_ids.push(hanger);
            }

            repair_unreachable_ancestry(&mut doc);

            for &id in &all_ids {
                prop_assert!(!has_cycle_from(&doc, id), "node {id} still has a cyclic ancestry after repair_unreachable_ancestry");
                prop_assert!(reachable_from(&doc, ws, id), "node {id} not reachable from the workspace after repair_unreachable_ancestry");
            }

            // `sync` runs repair on every call, so a settled document must
            // see an empty `Vec` and no byte changes the second time.
            let settled = doc.to_json().unwrap();
            let second_pass = repair_unreachable_ancestry(&mut doc);
            prop_assert!(second_pass.is_empty(), "a second repair pass found more to fix");
            prop_assert_eq!(settled, doc.to_json().unwrap(), "a no-op repair pass changed bytes");
        }

        // Arbitrary parent graphs over more than one workspace, including
        // parents that name a node not present, which is what a peer's
        // deletion leaves. The generators behind the convergence and
        // sync-level reachability checks produce neither, so a node left
        // detached or a ring left unreachable shows only here.
        #[test]
        fn every_node_reaches_a_workspace_whenever_one_exists(
            parents in proptest::collection::vec(proptest::option::of(0usize..8), 2..6),
        ) {
            let n = parents.len();
            let ids: Vec<NodeId> = (0..n).map(|i| NodeId::from_u128(i as u128 + 1)).collect();
            let mut doc = Document::new();
            for i in 0..n {
                // The first two ids are always workspaces, whichever random
                // parents land on them; the rest are groups. A `parents`
                // entry of `n` or more names no node: a deleted parent.
                let kind = if i < 2 { NodeKind::Workspace } else { NodeKind::Group };
                let parent = parents[i].map(|p| NodeId::from_u128(p as u128 + 1));
                doc.nodes.insert(ids[i], node_at(kind, parent));
            }

            repair_unreachable_ancestry(&mut doc);

            for &id in &ids {
                let Some(_) = doc.node(id) else { continue };
                let mut current = id;
                let mut hops = 0;
                let root = loop {
                    let current_node = doc.node(current).unwrap();
                    match current_node.placement.parent {
                        None => break current,
                        Some(parent) => {
                            prop_assert!(doc.node(parent).is_some(), "node {} has a parent {} that is not in the document", id, parent);
                            current = parent;
                        }
                    }
                    hops += 1;
                    prop_assert!(hops <= n, "cycle found walking up from {}", id);
                };
                prop_assert_eq!(
                    &doc.node(root).unwrap().kind,
                    &NodeKind::Workspace,
                    "node {} resolves to a non-workspace root {}", id, root
                );
            }

            let before = doc.to_json().unwrap();
            let second_pass = repair_unreachable_ancestry(&mut doc);
            prop_assert!(second_pass.is_empty(), "a second repair pass found more to fix");
            prop_assert_eq!(before, doc.to_json().unwrap(), "a no-op repair pass changed bytes");
        }

        /// The index lists every parent's children as the scan does, for
        /// every node and for the missing parents the tree names.
        #[test]
        fn the_child_index_lists_what_children_lists(seed in proptest::num::u64::ANY, count in 1usize..60) {
            let doc = crate::types::test_support::random_tree(seed, count);
            let index = ChildIndex::build(&doc);
            let parents = doc.nodes.keys().copied()
                .chain(doc.nodes.values().filter_map(|node| node.placement.parent));
            for parent in parents {
                prop_assert_eq!(index.children(parent).to_vec(), children(&doc, parent));
            }
        }

        #[test]
        fn children_ordering_is_a_total_order(n in 1usize..40) {
            let mut doc = Document::new();
            let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), test_device(), 0);
            let ids: Vec<_> = (0..n).map(|i| doc.add_tab(ws, format!("t{i}"), "https://e.example", crate::types::test_support::test_id(), test_device(), 0)).collect();
            let ordered = children(&doc, ws);
            // Each add_tab is placed after every existing sibling, so the
            // only correct order is insertion order.
            prop_assert_eq!(ordered, ids);
        }
    }
}
