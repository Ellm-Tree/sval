// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CoreGraphics
import UniformTypeIdentifiers

extension UTType {
    /// A row of the Workspace tree being dragged. Its data is the node's id,
    /// seen by this app alone (`NSItemProvider` visibility `.ownProcess`).
    static let svalNode = UTType(exportedAs: "app.sval.ios.node")
}

/// What a drop at the finger would do: the desktop panel's `dropIntent`
/// kinds (`SvalPanelModel.sys.mjs`), less the reorder of an Alt-dragged
/// page, which the phone does with Move Pane Left and Right.
enum DropKind: Equatable {
    case before, after, firstChild, into, newGroup, split, join, merge
    /// Below the last row: the end of the Workspace.
    case end
    /// Nothing can land here; `full` when a split would pass four pages.
    case refused(full: Bool)
    case noop
}

/// The row under the finger: a tab, a group, or a split's line, which
/// stands for the split.
struct DropOver: Equatable {
    let id: String
    let kind: String
    let expanded: Bool
}

/// A new group waiting on its name: made in `parent` between `previous`
/// and `next`, holding `target` and then `id` (the desktop's
/// `mergeTarget`).
struct MergePlan: Equatable {
    let id: String
    let target: String
    let parent: String
    let previous: String?
    let next: String?
}

/// What a drop writes: one batch, or a new group once it's named.
enum DropPlan {
    case ops([[String: Any]])
    case merge(MergePlan)
}

/// The desktop panel's drop zones, in points (`DROP_EDGE_PX`,
/// `SPLIT_MAX_PANES`), so a row means the same on both. The split zone is
/// wider than the desktop's `SPLIT_ZONE_PX`: a finger covers what it
/// drops on, where a pointer doesn't.
enum TreeDrop {
    static let edge: CGFloat = 8
    /// The split zone of a row `width` wide: its right half, drawn as
    /// one of the row's two halves while a drag is over it.
    static func splitZone(_ width: CGFloat) -> CGFloat { width / 2 }
    static let maxPanes = 4
}

/// The drop planning, over one pass's rows: a pure answer from the tree,
/// which `AppModel` asks with its own.
extension OutlineIndex {
    func isPane(_ id: String) -> Bool {
        row(id)?.kind == "tab" && row(id)?.parentId.flatMap(row)?.kind == "split"
    }

    func splitTabs(_ split: String) -> [String] {
        children(of: split).filter { $0.kind == "tab" }.map(\.id)
    }

    private func dragKind(_ id: String) -> String? {
        switch row(id)?.kind {
        case "tab": isPane(id) ? "page" : "tab"
        case "split": "split"
        case "group": "group"
        default: nil
        }
    }

    func pageCount(_ id: String) -> Int {
        row(id)?.kind == "split" ? splitTabs(id).count : 1
    }

    /// What dropping `id` at (`x`, `y`) on row `over`, `w` by `h`, would
    /// do, zone by zone as the desktop's `dropIntent`:
    /// - the top and bottom `TreeDrop.edge`: before and after the row;
    /// - a tab's or split's middle: a new group of the two, except the last
    ///   `TreeDrop.splitZone(w)` at the trailing end, which makes a split,
    ///   and the whole middle makes a split where `makesGroups` says no;
    /// - an open group's header: before it or its first row, by halves; a
    ///   closed one's middle: into it, last;
    /// - a group onto a tab or split: before or after it, by halves.
    /// `makesGroups` is whether `over`'s Workspace takes groups.
    func dropIntent(_ id: String, over: DropOver, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
                    makesGroups: Bool) -> DropKind {
        let kind = dragKind(id)
        let top = y < h / 2
        if kind == "group", isInside(over.id, id) {
            return over.id == id ? .noop : .refused(full: false)
        }
        if over.id == id { return .noop }
        if over.kind == "group" {
            if over.expanded { return top ? .before : .firstChild }
            if y < TreeDrop.edge { return .before }
            return y > h - TreeDrop.edge ? .after : .into
        }
        if kind == "group" || (over.kind != "tab" && over.kind != "split") {
            return top ? .before : .after
        }
        if y < TreeDrop.edge { return .before }
        if y > h - TreeDrop.edge { return .after }
        if kind == "page", row(id)?.parentId == over.id { return .noop }
        if makesGroups, x < w - TreeDrop.splitZone(w) { return .newGroup }
        let pages = (over.kind == "split" ? splitTabs(over.id).count : 1) + pageCount(id)
        if pages > TreeDrop.maxPanes { return .refused(full: true) }
        if over.kind == "tab" { return .split }
        return kind == "split" ? .merge : .join
    }

    /// What the drop writes, or nil for one that writes nothing: the
    /// desktop's `_dropPlan`.
    func dropPlan(_ id: String, over: DropOver, _ kind: DropKind) -> DropPlan? {
        switch kind {
        case .noop, .refused:
            return nil
        case .newGroup:
            return mergeTarget(id, over.id).map(DropPlan.merge)
        case .split:
            return splitTogetherOps(over.id, id).map(DropPlan.ops)
        case .join:
            return joinSplitOps(over.id, id).map(DropPlan.ops)
        case .merge:
            return mergeSplitsOps(over.id, id).map(DropPlan.ops)
        case .before, .after, .firstChild, .into, .end:
            guard let dragged = row(id), let move = dropMove(id, over: over.id, kind) else { return nil }
            let leaves = dragged.parentId != move["newParent"] as? String
            return .ops([move] + (leaves ? splitShapeOps(leaving: dragged) : []))
        }
    }

    /// Siblings of `id` in `parent`, in order, without `id`.
    private func siblings(in parent: String, without id: String) -> [String] {
        children(of: parent).map(\.id).filter { $0 != id }
    }

    static func moveOp(_ id: String, into parent: String, previous: String?, next: String?) -> [String: Any] {
        var op: [String: Any] = ["kind": "moveNode", "id": id, "newParent": parent]
        // `before` names the node it goes after, `after` the one it goes
        // before, as every placement op takes them.
        op["before"] = previous
        op["after"] = next
        return op
    }

    /// The desktop's `dropTarget`: nil for a cycle, a container that can't
    /// take it, or a move that leaves the row where it is, which would
    /// only change its order key and could undo another device's move.
    private func dropMove(_ id: String, over target: String, _ kind: DropKind) -> [String: Any]? {
        guard let dragged = row(id) else { return nil }
        var overId = target
        // Nothing is dropped into a split (split-view spec §6.3): beside one
        // of its panes is beside the split.
        if kind == .before || kind == .after, isPane(overId), row(overId)?.parentId != dragged.parentId,
           let split = row(overId)?.parentId {
            overId = split
        }
        guard let over = row(overId), !isInside(overId, id) else { return nil }
        let parent: String
        let previous: String?
        let next: String?
        switch kind {
        case .before, .after:
            guard let up = over.parentId else { return nil }
            let others = siblings(in: up, without: id)
            guard let at = others.firstIndex(of: overId) else { return nil }
            parent = up
            previous = kind == .before ? (at > 0 ? others[at - 1] : nil) : overId
            next = kind == .before ? overId : (at + 1 < others.count ? others[at + 1] : nil)
        case .firstChild:
            guard over.kind == "group" || over.kind == "workspace" else { return nil }
            parent = overId
            previous = nil
            next = siblings(in: overId, without: id).first
        case .into:
            guard over.kind == "group" || over.kind == "workspace", dragged.parentId != overId else { return nil }
            parent = overId
            previous = siblings(in: overId, without: id).last
            next = nil
        case .end:
            guard over.kind == "workspace" else { return nil }
            parent = overId
            previous = siblings(in: overId, without: id).last
            next = nil
        default:
            return nil
        }
        if dragged.parentId == parent {
            let all = children(of: parent).map(\.id)
            if let at = all.firstIndex(of: id),
               (at > 0 ? all[at - 1] : nil) == previous, (at + 1 < all.count ? all[at + 1] : nil) == next {
                return nil
            }
        }
        return Self.moveOp(id, into: parent, previous: previous, next: next)
    }

    /// The desktop's `mergeTarget`: a tab or split onto a tab or split.
    func mergeTarget(_ id: String, _ target: String) -> MergePlan? {
        let kinds: Set<String> = ["tab", "split"]
        guard let dragged = row(id), kinds.contains(dragged.kind), let over = row(target), kinds.contains(over.kind),
              !isPane(target), !isInside(target, id), let parent = over.parentId else { return nil }
        let others = siblings(in: parent, without: id)
        guard let at = others.firstIndex(of: target) else { return nil }
        return MergePlan(id: id, target: target, parent: parent, previous: at > 0 ? others[at - 1] : nil, next: target)
    }

    /// The desktop's `splitTogetherOps`: a new split in the tab's place,
    /// the tab first and the dropped pages after it.
    func splitTogetherOps(_ target: String, _ id: String) -> [[String: Any]]? {
        guard let over = row(target), over.kind == "tab", !isPane(target), target != id,
              let dragged = row(id), dragged.kind == "tab" || dragged.kind == "split",
              1 + pageCount(id) <= TreeDrop.maxPanes, let parent = over.parentId else { return nil }
        let others = siblings(in: parent, without: id)
        let at = others.firstIndex(of: target) ?? 0
        let split = UUID().uuidString.lowercased()
        var add: [String: Any] = ["kind": "addSplit", "parent": parent, "id": split]
        add["before"] = at > 0 ? others[at - 1] : nil
        add["after"] = target
        var ops = [add, Self.moveOp(target, into: split, previous: nil, next: nil)]
        var last = target
        for tab in dragged.kind == "split" ? splitTabs(id) : [id] {
            ops.append(Self.moveOp(tab, into: split, previous: last, next: nil))
            last = tab
        }
        return ops + (dragged.kind == "split" ? [Self.removeEmptied(id)] : splitShapeOps(leaving: dragged))
    }

    /// The desktop's `joinSplitOps`: the tab joins the split as its last
    /// pane, and the widths go back to equal.
    func joinSplitOps(_ split: String, _ id: String) -> [[String: Any]]? {
        guard let tab = row(id), tab.kind == "tab", tab.parentId != split,
              splitTabs(split).count < TreeDrop.maxPanes else { return nil }
        return [Self.moveOp(id, into: split, previous: splitTabs(split).last, next: nil)]
            + resetWidthsOps(split) + splitShapeOps(leaving: tab)
    }

    /// The desktop's `mergeSplitsOps`: the dropped split's pages join the
    /// target's after its own, and the dropped split goes.
    func mergeSplitsOps(_ target: String, _ id: String) -> [[String: Any]]? {
        guard row(target)?.kind == "split", row(id)?.kind == "split", target != id else { return nil }
        let incoming = splitTabs(id)
        guard splitTabs(target).count + incoming.count <= TreeDrop.maxPanes else { return nil }
        var ops: [[String: Any]] = []
        var last = splitTabs(target).last
        for tab in incoming {
            ops.append(Self.moveOp(tab, into: target, previous: last, next: nil))
            last = tab
        }
        return ops + [Self.removeEmptied(id)] + resetWidthsOps(target)
    }

    /// Removes split `id` once its panes have moved out. The rows are the
    /// last pass's, and a pass can merge a pane another device moved into
    /// the split before the rows show it, so the split goes with its
    /// children kept: `remove` would delete that pane on every device.
    private static func removeEmptied(_ id: String) -> [String: Any] {
        ["kind": "removeKeepingChildren", "id": id]
    }

    /// Equal widths for a split whose panes change: a list of widths that
    /// doesn't match its panes is one the engine refuses.
    private func resetWidthsOps(_ split: String) -> [[String: Any]] {
        guard let row = row(split), row.shares != nil else { return [] }
        var reset: [String: Any] = ["kind": "setContent", "id": split, "name": row.name]
        reset["url"] = row.url
        reset["icon"] = row.icon
        return [reset]
    }

    /// What Split With… on `target`, a tab outside a split or a split,
    /// writes for `picked`: what dropping `picked` on `target`'s split half
    /// writes (decision 14).
    func splitWithOps(_ target: String, _ picked: String) -> [[String: Any]]? {
        switch (row(target)?.kind, row(picked)?.kind) {
        case ("tab", _): splitTogetherOps(target, picked)
        case ("split", "tab"): joinSplitOps(target, picked)
        case ("split", "split"): mergeSplitsOps(target, picked)
        default: nil
        }
    }

    /// Whether `id` is `ancestor` or lies inside it.
    func isInside(_ id: String, _ ancestor: String) -> Bool {
        var node: String? = id
        while let at = node {
            if at == ancestor { return true }
            node = row(at)?.parentId
        }
        return false
    }

    /// What keeps each split whole when `rows` leave it together: a split
    /// that itself leaves, or sits inside a row that does, goes with them.
    func splitShapeOps(leaving rows: [OutlineRow]) -> [[String: Any]] {
        let gone = Set(rows.map(\.id))
        var splits: [String] = []
        for row in rows {
            guard let parent = row.parentId, !gone.contains(parent), !splits.contains(parent),
                  self.row(parent)?.kind == "split", !gone.contains(where: { isInside(parent, $0) }) else { continue }
            splits.append(parent)
        }
        return splits.flatMap { id -> [[String: Any]] in
            guard let split = self.row(id) else { return [] }
            let left = children(of: id).filter { !gone.contains($0.id) && $0.kind == "tab" }
            if left.count <= 1 { return [["kind": "removeKeepingChildren", "id": id]] }
            guard split.shares != nil else { return [] }
            var reset: [String: Any] = ["kind": "setContent", "id": id, "name": split.name]
            reset["url"] = split.url
            reset["icon"] = split.icon
            return [reset]
        }
    }

    func splitShapeOps(leaving row: OutlineRow) -> [[String: Any]] {
        splitShapeOps(leaving: [row])
    }
}

extension AppModel {
    func isPane(_ id: String) -> Bool {
        tree.isPane(id)
    }

    /// What dropping `id` at (`x`, `y`) on row `over`, `w` by `h`, would
    /// do (`OutlineIndex.dropIntent`).
    func dropIntent(_ id: String, over: DropOver, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> DropKind {
        tree.dropIntent(id, over: over, x: x, y: y, w: w, h: h, makesGroups: makesGroups(in: workspace(of: over.id)))
    }

    /// What the drop writes, or nil for one that writes nothing.
    func dropPlan(_ id: String, over: DropOver, _ kind: DropKind) -> DropPlan? {
        tree.dropPlan(id, over: over, kind)
    }

    /// What Split With… offers `target`: the other tabs outside a split
    /// and the splits of its Workspace that make a split with it.
    func splitCandidates(for target: OutlineRow) -> [OutlineRow] {
        guard let home = workspace(of: target.id) else { return [] }
        return rows.filter { row in
            (row.kind == "split" || (row.kind == "tab" && !isPane(row.id) && !row.awaitsPick))
                && workspace(of: row.id) == home && tree.splitWithOps(target.id, row.id) != nil
        }
    }

    /// Whether Split With… has anything to offer `target`, by counting
    /// pages alone, so a menu can ask it for every row it draws.
    func offersSplit(for target: OutlineRow) -> Bool {
        guard target.kind == "split" || (target.kind == "tab" && !isPane(target.id)),
              let home = workspace(of: target.id) else { return false }
        let own = tree.pageCount(target.id)
        return tabs(in: home).contains { tab in
            guard !tab.awaitsPick else { return false }
            let other = isPane(tab.id) ? tab.parentId ?? tab.id : tab.id
            guard other != target.id else { return false }
            // A tab joins a split, and a split joins a tab or a split.
            if target.kind == "split", row(other)?.kind == "tab" || row(other)?.kind == "split" {
                return own + tree.pageCount(other) <= TreeDrop.maxPanes
            }
            return 1 + tree.pageCount(other) <= TreeDrop.maxPanes
        }
    }

    /// Split With…: `picked` joins `target` in a split.
    func split(_ target: OutlineRow, with picked: OutlineRow) async {
        guard let ops = tree.splitWithOps(target.id, picked.id) else { return }
        await editTree(ops)
    }

    /// Makes the group a merge waits on, named, and moves the two rows in,
    /// as one write (the desktop's `_merge`). Returns the group's id.
    func makeGroup(named name: String, emoji: String?, color: String?, for plan: MergePlan) async -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let dragged = row(plan.id) else { return nil }
        let id = UUID().uuidString.lowercased()
        var ops: [[String: Any]] = [["kind": "addGroup", "parent": plan.parent, "name": name, "id": id]]
        if emoji != nil || color != nil {
            var look: [String: Any] = ["kind": "setAppearance", "id": id]
            look["emoji"] = emoji
            look["color"] = AppModel.appearanceColor(color)
            ops.append(look)
        }
        ops.append(OutlineIndex.moveOp(id, into: plan.parent, previous: plan.previous, next: plan.next))
        ops.append(OutlineIndex.moveOp(plan.target, into: id, previous: nil, next: nil))
        ops.append(OutlineIndex.moveOp(plan.id, into: id, previous: plan.target, next: nil))
        ops += splitShapeOps(leaving: dragged)
        return await editTree(ops) ? id : nil
    }
}
