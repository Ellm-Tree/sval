// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Archiving idle tabs (idle-tab archive spec).
//!
//! A tab nobody has used for the period its workspace sets leaves the tree
//! and gains an entry in the Archive, a document of its own
//! ([`crate::types::ARCHIVE`]). The tree keeps no closed record (decision
//! 0013): an entry is a node of the [`NodeKind::Archived`] kind in another
//! document, so no merge can turn it back into a tab. A restore makes a new
//! tab with a new id, which no device ever deleted.
//!
//! Each call here that changes both documents checks everything first and
//! then makes changes that cannot fail, so it changes both or neither.

use crate::store::DeviceId;
use crate::tree::{children, order_between};
use crate::types::{Archived, ArchivedSplit, Document, NodeId, NodeKind, Timestamp, archived_id};
use std::collections::{BTreeMap, BTreeSet};

/// The choices for archiving idle tabs, globally and per workspace
/// (idle-tab archive spec §5).
pub const CHOICES: [&str; 5] = ["12h", "24h", "7d", "30d", "never"];

/// An hour in milliseconds: the most often selecting a tab stamps its touch.
pub const HOUR: Timestamp = 3_600_000;

const DAY: Timestamp = 24 * HOUR;

/// Why a call here refused, the document or documents left unchanged.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ArchiveError {
    #[error("not an auto-archive choice: {0} (expected 12h, 24h, 7d, 30d or never)")]
    BadChoice(String),
    #[error("no such node: {0}")]
    NoSuchNode(NodeId),
    #[error("not a tab: {0}")]
    NotATab(NodeId),
    /// A tab the sweep never archives: one in a group, or a pane of a split
    /// that holds anything but tabs.
    #[error("this tab is never archived: {0}")]
    NotArchivable(NodeId),
    #[error("not a workspace: {0}")]
    NotAWorkspace(NodeId),
    #[error("an agent's workspace is never archived: {0}")]
    AgentWorkspace(NodeId),
    #[error("not an Archive entry: {0}")]
    NotAnEntry(NodeId),
    #[error("no workspace to restore into: {0}")]
    NoWorkspace(NodeId),
    #[error("this restore takes {needed} ids, and was given {given}")]
    WrongIdCount { needed: usize, given: usize },
    #[error("a node already has id {0}")]
    IdInUse(NodeId),
}

impl ArchiveError {
    /// The host's stable name for this failure (`docs/host-contract.md` §8).
    pub fn code(&self) -> &'static str {
        match self {
            ArchiveError::NoSuchNode(_) => "no_such_node",
            ArchiveError::NoWorkspace(_) => "no_such_parent",
            ArchiveError::IdInUse(_) => "id_in_use",
            _ => "invalid_argument",
        }
    }
}

/// The period choice `choice` names, or `None` for Never.
pub fn period(choice: &str) -> Result<Option<Timestamp>, ArchiveError> {
    match choice {
        "12h" => Ok(Some(12 * HOUR)),
        "24h" => Ok(Some(DAY)),
        "7d" => Ok(Some(7 * DAY)),
        "30d" => Ok(Some(30 * DAY)),
        "never" => Ok(None),
        other => Err(ArchiveError::BadChoice(other.to_string())),
    }
}

/// `at`, or `now` when `at` is later: a time later than this device's clock
/// counts as now.
fn no_later_than(at: Timestamp, now: Timestamp) -> Timestamp {
    at.min(now)
}

/// Touches tab `id` when its touch is an hour old or more, and says whether
/// it did (idle-tab archive spec §4.1). Selecting a tab calls this, so the
/// touch carries the latest use on any device at the cost of one write per
/// tab per hour. A touch later than `now` is left alone: it counts as now.
///
/// A pane's use is its split's: the split and every pane in it are touched
/// together. A split is archived whole, so a use another device had not
/// seen must bring the whole split back, and a touch on one pane alone
/// would bring back that pane without its split.
pub fn mark_used(
    tree: &mut Document,
    id: NodeId,
    by: DeviceId,
    now: Timestamp,
) -> Result<bool, ArchiveError> {
    let node = tree.node(id).ok_or(ArchiveError::NoSuchNode(id))?;
    if node.kind != NodeKind::Tab {
        return Err(ArchiveError::NotATab(id));
    }
    if node.touched_at.saturating_add(HOUR) > now {
        return Ok(false);
    }
    let split = node
        .placement
        .parent
        .filter(|p| tree.node(*p).is_some_and(|n| n.kind == NodeKind::Split));
    let used = match split {
        Some(split) => std::iter::once(split)
            .chain(children(tree, split))
            .collect(),
        None => vec![id],
    };
    for node in used {
        tree.touch(node, by, now);
    }
    Ok(true)
}

/// Sets workspace `id`'s own choice, or clears it with `None` so it follows
/// the global one (idle-tab archive spec §5). Stamps the lifecycle group
/// only, carrying the rest of it over, as `set_isolation` does.
pub fn set_auto_archive(
    tree: &mut Document,
    id: NodeId,
    choice: Option<&str>,
    by: DeviceId,
    now: Timestamp,
) -> Result<(), ArchiveError> {
    if let Some(choice) = choice {
        period(choice)?;
    }
    let node = tree.node(id).ok_or(ArchiveError::NoSuchNode(id))?;
    if node.kind != NodeKind::Workspace {
        return Err(ArchiveError::NotAWorkspace(id));
    }
    if node.agent.is_some() {
        return Err(ArchiveError::AgentWorkspace(id));
    }
    if let Some(node) = tree.node_mut(id) {
        node.lifecycle.auto_archive = choice.map(str::to_string);
        node.lifecycle_at = now;
        node.lifecycle_by = Some(by);
    }
    Ok(())
}

/// What a sweep needs from the host (idle-tab archive spec §4.2).
pub struct Sweep<'a> {
    /// The global choice, one of [`CHOICES`].
    pub default: &'a str,
    /// This device's `lastActive` for each tab it has recorded one for.
    pub last_active: &'a BTreeMap<NodeId, Timestamp>,
    /// Tabs only a live tab can say are in use: shown in a window, playing
    /// audio, in picture-in-picture or a call, using camera or mic, or
    /// holding form data (idle-tab archive spec §4.3).
    pub exempt: &'a BTreeSet<NodeId>,
}

/// What a sweep did: the tabs it removed from the tree, and the entries it
/// added to the Archive.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub tabs: Vec<NodeId>,
    pub entries: Vec<NodeId>,
}

/// One tab or split at a workspace's top level, as the sweep judges it.
struct Unit {
    /// The tab, or the split.
    id: NodeId,
    workspace: NodeId,
    /// The tab alone, or the split's panes in order.
    tabs: Vec<NodeId>,
    split: bool,
}

/// The latest use of node `id`: the latest of its touch, its `placement_at`
/// and this device's `lastActive`, each no later than `now` (idle-tab
/// archive spec §4.2). `placement_at` gives a tab nobody has selected its
/// full period from when it was opened or last moved.
fn last_used(tree: &Document, id: NodeId, sweep: &Sweep, now: Timestamp) -> Timestamp {
    let Some(node) = tree.node(id) else {
        return now;
    };
    let local = sweep.last_active.get(&id).copied().unwrap_or(0);
    [node.touched_at, node.placement_at, local]
        .into_iter()
        .map(|at| no_later_than(at, now))
        .max()
        .unwrap_or(0)
}

/// The period workspace `ws` archives after, or `None` when it archives
/// nothing: an agent's workspace, one set to Never, and one whose own choice
/// this build does not know, which a newer build wrote.
fn workspace_period(tree: &Document, ws: NodeId, default: Option<Timestamp>) -> Option<Timestamp> {
    let node = tree.node(ws)?;
    if node.agent.is_some() {
        return None;
    }
    match &node.lifecycle.auto_archive {
        Some(choice) => period(choice).ok().flatten(),
        None => default,
    }
}

/// Every unit of the tree the sweep may archive, before the host's
/// exemptions and the clock are applied, with the period its workspace
/// archives after.
fn units(tree: &Document, default: Option<Timestamp>) -> Vec<(Unit, Timestamp)> {
    let index = crate::tree::ChildIndex::build(tree);
    let mut found = Vec::new();
    for (ws, _) in tree.workspaces() {
        let Some(period) = workspace_period(tree, *ws, default) else {
            continue;
        };
        found.extend(
            units_in(tree, &index, *ws)
                .into_iter()
                .map(|unit| (unit, period)),
        );
    }
    found
}

/// The units of workspace `ws`. Only a workspace's direct children are
/// units, so a tab in a group, at any depth, is never one. A split is a unit
/// only when it holds tabs and nothing else.
fn units_in(tree: &Document, index: &crate::tree::ChildIndex, ws: NodeId) -> Vec<Unit> {
    let mut found = Vec::new();
    for id in index.children(ws) {
        let Some(node) = tree.node(*id) else {
            continue;
        };
        let (tabs, split) = match node.kind {
            NodeKind::Tab => (vec![*id], false),
            NodeKind::Split => {
                let panes = index.children(*id).to_vec();
                let all_tabs = panes
                    .iter()
                    .all(|p| tree.node(*p).is_some_and(|n| n.kind == NodeKind::Tab));
                if panes.is_empty() || !all_tabs {
                    continue;
                }
                (panes, true)
            }
            _ => continue,
        };
        found.push(Unit {
            id: *id,
            workspace: ws,
            tabs,
            split,
        });
    }
    found
}

/// Archives every unit of `tree` nobody has used for its workspace's period
/// (idle-tab archive spec §4.2): each tab gets an entry in `archive`, and the
/// unit leaves the tree. One call, so the tree it judges is the tree it
/// changes.
///
/// A unit is skipped when any node in it is exempt, or was used within the
/// period. The global choice is checked before anything changes, and nothing
/// after that check can fail, so a refusal changes neither document.
///
/// A host persists `archive` before `tree` (idle-tab archive spec §6.3), so
/// a file without the tab always has a file with its entry beside it.
pub fn archive_idle(
    tree: &mut Document,
    archive: &mut Document,
    sweep: &Sweep,
    by: DeviceId,
    now: Timestamp,
) -> Result<Swept, ArchiveError> {
    let default = period(sweep.default)?;
    let idle: Vec<Unit> = units(tree, default)
        .into_iter()
        .filter(|(unit, period)| {
            let split = unit.split.then_some(unit.id);
            let mut nodes = split.into_iter().chain(unit.tabs.iter().copied());
            nodes.all(|id| {
                !sweep.exempt.contains(&id)
                    && now.saturating_sub(last_used(tree, id, sweep, now)) >= *period
            })
        })
        .map(|(unit, _)| unit)
        .collect();
    Ok(archive_units(tree, archive, &idle, by, now))
}

/// Archives tab `id` now, whatever its workspace's period and whether it is
/// in use: the user asked (launcher spec §4). A pane takes its split with it,
/// as the sweep archives a split whole. Only what the sweep could archive is
/// archived, so a tab in a group, a split holding anything but tabs, and an
/// agent's tab are refused, and a refusal changes neither document.
pub fn archive_now(
    tree: &mut Document,
    archive: &mut Document,
    id: NodeId,
    by: DeviceId,
    now: Timestamp,
) -> Result<Swept, ArchiveError> {
    let node = tree.node(id).ok_or(ArchiveError::NoSuchNode(id))?;
    if node.kind != NodeKind::Tab {
        return Err(ArchiveError::NotATab(id));
    }
    let mut parent = node.placement.parent;
    if let Some(split) = parent
        .and_then(|p| tree.node(p))
        .filter(|p| p.kind == NodeKind::Split)
    {
        parent = split.placement.parent;
    }
    let ws = parent
        .filter(|ws| {
            tree.node(*ws)
                .is_some_and(|n| n.kind == NodeKind::Workspace)
        })
        .ok_or(ArchiveError::NotArchivable(id))?;
    if tree.node(ws).is_some_and(|n| n.agent.is_some()) {
        return Err(ArchiveError::AgentWorkspace(ws));
    }
    let unit = units_in(tree, &crate::tree::ChildIndex::build(tree), ws)
        .into_iter()
        .find(|unit| unit.tabs.contains(&id))
        .ok_or(ArchiveError::NotArchivable(id))?;
    Ok(archive_units(tree, archive, &[unit], by, now))
}

/// Gives each tab of `going` an entry in `archive` and takes each unit out
/// of `tree`. Nothing here can fail, so its callers check first.
fn archive_units(
    tree: &mut Document,
    archive: &mut Document,
    going: &[Unit],
    by: DeviceId,
    now: Timestamp,
) -> Swept {
    // Neighbours archived in the same call will not be there to restore
    // beside, so each entry names the nearest sibling on each side that
    // stays.
    let leaving: BTreeSet<NodeId> = going.iter().map(|u| u.id).collect();
    let neighbours = |unit: &Unit| {
        let siblings = children(tree, unit.workspace);
        let at = siblings.iter().position(|s| *s == unit.id).unwrap_or(0);
        let staying = |s: &&NodeId| !leaving.contains(*s);
        let before = siblings[..at].iter().rev().find(staying).copied();
        let after = siblings[at + 1..].iter().find(staying).copied();
        (before, after)
    };

    let mut swept = Swept::default();
    for unit in going {
        let (before, after) = neighbours(unit);
        let workspace_name = tree
            .node(unit.workspace)
            .map(|n| n.content.name.clone())
            .unwrap_or_default();
        for (pane, tab) in unit.tabs.iter().enumerate() {
            let Some(node) = tree.node(*tab) else {
                continue;
            };
            let record = Archived {
                tab: *tab,
                workspace: unit.workspace,
                workspace_name: workspace_name.clone(),
                before,
                after,
                split: unit.split.then(|| ArchivedSplit {
                    id: unit.id,
                    pane: pane as u32,
                    extra: BTreeMap::new(),
                }),
                closed_at: now,
                device: by,
                extra: BTreeMap::new(),
            };
            let (title, url, icon, local) = (
                node.content.name.clone(),
                node.content.url.clone(),
                node.content.icon.clone(),
                node.content.local,
            );
            let entry = archive.add_archived(title, url, icon, record, by, now);
            // An entry holds the tab's address, so it stays where the tab
            // would have.
            if let Some(node) = archive.node_mut(entry) {
                node.content.local = local;
            }
            swept.entries.push(entry);
            swept.tabs.push(*tab);
        }
    }
    for unit in going {
        tree.remove(unit.id);
    }
    swept
}

/// A tab another browser had archived, as an import brings it into the
/// Archive (idle-tab archive spec §7.6).
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    /// An id the host mints for the tab. No tree ever holds it, and the
    /// entry's id derives from it.
    pub tab: NodeId,
    pub title: String,
    pub url: Option<String>,
    /// The workspace a restore puts the tab back in. One no tree holds sends
    /// it to the current workspace, as for any entry whose workspace is gone.
    pub workspace: NodeId,
    pub workspace_name: String,
    /// When the other browser archived it.
    pub closed_at: Timestamp,
}

/// Adds an entry to `archive` for each of `entries` (idle-tab archive spec
/// §7.6), in order, and answers their ids. Each is a tab archived on its
/// own, at its own closed time, by `by`. A tab whose entry the Archive
/// already holds, or that `entries` names twice, is refused with
/// [`ArchiveError::IdInUse`] before anything changes.
pub fn add_imported(
    archive: &mut Document,
    entries: &[Imported],
    by: DeviceId,
    now: Timestamp,
) -> Result<Vec<NodeId>, ArchiveError> {
    let mut tabs = BTreeSet::new();
    for entry in entries {
        if !tabs.insert(entry.tab) || archive.node(archived_id(entry.tab)).is_some() {
            return Err(ArchiveError::IdInUse(entry.tab));
        }
    }
    Ok(entries
        .iter()
        .map(|entry| {
            let record = Archived {
                tab: entry.tab,
                workspace: entry.workspace,
                workspace_name: entry.workspace_name.clone(),
                before: None,
                after: None,
                split: None,
                closed_at: no_later_than(entry.closed_at, now),
                device: by,
                extra: BTreeMap::new(),
            };
            archive.add_archived(
                entry.title.clone(),
                entry.url.clone(),
                None,
                record,
                by,
                now,
            )
        })
        .collect())
}

/// What a restored tab is given from its entry.
struct Page {
    title: String,
    url: Option<String>,
    icon: Option<String>,
    local: bool,
}

/// What a restore made: the tabs, in pane order, the split that holds them
/// when there is one, and the workspace they went into.
#[derive(Debug, PartialEq, Eq)]
pub struct Restored {
    pub tabs: Vec<NodeId>,
    pub split: Option<NodeId>,
    pub workspace: NodeId,
}

/// The entries a restore of `entry` restores, in pane order: the entry
/// alone, or every entry the same sweep wrote for its split when the Archive
/// holds more than one. An entry an earlier archiving of the split left
/// names the split too, and is not one of its panes now.
fn members(archive: &Document, entry: NodeId, record: &Archived) -> Vec<NodeId> {
    let Some(split) = &record.split else {
        return vec![entry];
    };
    let mut panes: Vec<(u32, NodeId)> = archive
        .nodes
        .iter()
        .filter(|(_, n)| n.kind == NodeKind::Archived)
        .filter_map(|(id, n)| {
            let other = n.content.archived.as_ref()?;
            let s = other.split.as_ref()?;
            (s.id == split.id && other.closed_at == record.closed_at).then_some((s.pane, *id))
        })
        .collect();
    panes.sort();
    if panes.len() < 2 {
        return vec![entry];
    }
    panes.into_iter().map(|(_, id)| id).collect()
}

/// How many ids a restore of `entry` takes: one per tab it opens, and one
/// more for the split when it opens a split.
pub fn ids_needed(archive: &Document, entry: NodeId) -> Result<usize, ArchiveError> {
    let record = entry_record(archive, entry)?;
    let tabs = members(archive, entry, record).len();
    Ok(if tabs > 1 { tabs + 1 } else { 1 })
}

fn entry_record(archive: &Document, entry: NodeId) -> Result<&Archived, ArchiveError> {
    archive
        .node(entry)
        .filter(|n| n.kind == NodeKind::Archived)
        .and_then(|n| n.content.archived.as_ref())
        .ok_or(ArchiveError::NotAnEntry(entry))
}

/// Restores Archive entry `entry` into `tree` as a new tab, or with the
/// rest of its split as a new split, and marks each entry restored
/// (idle-tab archive spec §2, §6.4).
///
/// `ids` are the new nodes' ids, from the host: the split's first when the
/// restore opens a split, then each tab in pane order ([`ids_needed`] says
/// how many). New ids never meet the delete that archived the tab, so the
/// restore and that delete both stand on every device.
///
/// The tab goes back into its workspace, right after the sibling it sorted
/// after, or right before the one it sorted before, whichever is still
/// there, and at the end of the workspace with neither. With its workspace
/// gone it goes at the end of `current`.
///
/// Everything is checked before anything changes, so a refusal changes
/// neither document.
pub fn restore(
    tree: &mut Document,
    archive: &mut Document,
    entry: NodeId,
    current: NodeId,
    ids: &[NodeId],
    by: DeviceId,
    now: Timestamp,
) -> Result<Restored, ArchiveError> {
    let record = entry_record(archive, entry)?.clone();
    let members = members(archive, entry, &record);
    let split = members.len() > 1;
    let needed = if split { members.len() + 1 } else { 1 };
    if ids.len() != needed {
        return Err(ArchiveError::WrongIdCount {
            needed,
            given: ids.len(),
        });
    }
    // The archived tabs' ids stay deleted (idle-tab archive spec §6.4).
    let archived: BTreeSet<NodeId> = members
        .iter()
        .filter_map(|m| archive.node(*m)?.content.archived.as_ref().map(|a| a.tab))
        .collect();
    let mut distinct = BTreeSet::new();
    for id in ids {
        if tree.node(*id).is_some() || archived.contains(id) || !distinct.insert(*id) {
            return Err(ArchiveError::IdInUse(*id));
        }
    }
    let is_workspace = |id: NodeId| tree.node(id).is_some_and(|n| n.kind == NodeKind::Workspace);
    let home = is_workspace(record.workspace);
    let workspace = if home {
        record.workspace
    } else if is_workspace(current) {
        current
    } else {
        return Err(ArchiveError::NoWorkspace(current));
    };

    let siblings = children(tree, workspace);
    let place = |id: Option<NodeId>| id.and_then(|id| siblings.iter().position(|s| *s == id));
    let (before, after) = match (
        home.then(|| place(record.before)).flatten(),
        home.then(|| place(record.after)).flatten(),
    ) {
        (Some(b), _) => (Some(siblings[b]), siblings.get(b + 1).copied()),
        (None, Some(a)) => (a.checked_sub(1).map(|p| siblings[p]), Some(siblings[a])),
        (None, None) => (siblings.last().copied(), None),
    };
    let order = order_between(tree, before, after);

    let pages: Vec<Page> = members
        .iter()
        .filter_map(|m| archive.node(*m))
        .map(|n| Page {
            title: n.content.name.clone(),
            url: n.content.url.clone(),
            icon: n.content.icon.clone(),
            local: n.content.local,
        })
        .collect();

    let (holder, tab_ids, split_id) = if split {
        let split_id = ids[0];
        tree.add_split(workspace, "", split_id, by, now);
        if let Some(node) = tree.node_mut(split_id) {
            node.placement.order = order.clone();
        }
        (split_id, &ids[1..], Some(split_id))
    } else {
        (workspace, ids, None)
    };
    for (page, id) in pages.into_iter().zip(tab_ids) {
        tree.add_tab(
            holder,
            page.title,
            page.url.unwrap_or_default(),
            *id,
            by,
            now,
        );
        if let Some(node) = tree.node_mut(*id) {
            node.content.icon = page.icon;
            node.content.local = page.local;
            if !split {
                node.placement.order = order.clone();
            }
        }
    }
    for m in &members {
        if let Some(node) = archive.node_mut(*m) {
            node.lifecycle.restored = true;
            node.lifecycle_at = now;
            node.lifecycle_by = Some(by);
        }
    }
    Ok(Restored {
        tabs: tab_ids.to_vec(),
        split: split_id,
        workspace,
    })
}

/// Drops every entry of `archive` closed at least `retention` before `now`,
/// and returns their ids (idle-tab archive spec §3.3). An entry closed later
/// than `now` counts as closed now, so it is kept.
///
/// Runs on the sync path, after the merge and before the write decision,
/// never inside `merge` (`engine/CLAUDE.md` rule 8): an expired entry a peer's later
/// write made news again is dropped before anything publishes it.
pub fn expire(archive: &mut Document, retention: Timestamp, now: Timestamp) -> Vec<NodeId> {
    let expired: Vec<NodeId> = archive
        .nodes
        .iter()
        .filter(|(_, n)| n.kind == NodeKind::Archived)
        .filter(|(_, n)| {
            let closed = n
                .content
                .archived
                .as_ref()
                .map_or(n.content_at, |a| a.closed_at);
            no_later_than(closed, now).saturating_add(retention) <= now
        })
        .map(|(id, _)| *id)
        .collect();
    for id in &expired {
        archive.remove(*id);
    }
    expired
}
