// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// Whether `id` is `ancestor` or lies inside it.
    func isInside(_ id: String, _ ancestor: String) -> Bool {
        tree.isInside(id, ancestor)
    }

    /// Separate: the panes become tabs in the split's place, in order.
    func separate(_ split: OutlineRow) async {
        await edit(["kind": "removeKeepingChildren", "id": split.id])
    }

    /// Rename Split: an empty name clears it.
    func renameSplit(_ split: OutlineRow, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != split.name else { return }
        await edit(["kind": "rename", "id": split.id, "name": name])
    }

    /// Moves `row` one place among its siblings, -1 back or 1 on, as the
    /// desktop's panel moves one (`moveTarget`): Move Pane Left and Right
    /// for a pane, Move Up and Down for any other row, which is what
    /// dragging it past its neighbour does.
    func movePane(_ pane: OutlineRow, by step: Int) async {
        guard canMove(pane, by: step), let split = pane.parentId else { return }
        let panes = children(of: split)
        guard let at = panes.firstIndex(where: { $0.id == pane.id }) else { return }
        let to = at + step
        let others = panes.filter { $0.id != pane.id }
        var op: [String: Any] = ["kind": "moveNode", "id": pane.id, "newParent": split]
        // `before` names the node it goes after, `after` the one it goes
        // before, as every placement op takes them.
        op["before"] = to > 0 ? others[to - 1].id : nil
        op["after"] = to < others.count ? others[to].id : nil
        await edit(op)
    }

    /// Whether `row` has a sibling `step` places along to move past.
    func canMove(_ row: OutlineRow, by step: Int) -> Bool {
        guard let parent = row.parentId, let at = children(of: parent).firstIndex(where: { $0.id == row.id })
        else { return false }
        return children(of: parent).indices.contains(at + step)
    }

    /// Sets the panes' widths, one percentage per pane, summing to 100.
    func setShares(_ split: OutlineRow, _ shares: [Double]) async {
        var op: [String: Any] = ["kind": "setContent", "id": split.id, "name": split.name, "shares": shares]
        op["url"] = split.url
        op["icon"] = split.icon
        await edit(op)
    }

    /// Close Both or Close All: the split and every pane, as one write.
    func closeSplit(_ split: OutlineRow) async -> Bool {
        await edit(["kind": "remove", "id": split.id])
    }

    /// Puts a closed split back where it was, with its name, widths and
    /// panes. Returns the panes' new ids, in order.
    func reopenSplit(_ split: OutlineRow, panes: [OutlineRow], at place: Place, workspace: String?) async -> [String]? {
        let parent = row(place.parent) != nil ? place.parent : workspace.flatMap { row($0) != nil ? $0 : nil }
        guard let parent else { return nil }
        let id = UUID().uuidString.lowercased()
        var add: [String: Any] = ["kind": "addSplit", "parent": parent, "name": split.name, "id": id]
        add["before"] = sibling(place.previous, in: parent)
        add["after"] = sibling(place.next, in: parent)
        var ops = [add]
        var ids: [String] = []
        for pane in panes {
            guard let url = pane.url else { continue }
            let tab = UUID().uuidString.lowercased()
            var addTab: [String: Any] = ["kind": "addTab", "parent": id, "name": pane.name, "url": url, "id": tab]
            addTab["before"] = ids.last
            ops.append(addTab)
            if let label = pane.label { ops.append(["kind": "setLabel", "id": tab, "label": label]) }
            ids.append(tab)
        }
        if let shares = split.shares, shares.count == ids.count {
            var content: [String: Any] = ["kind": "setContent", "id": id, "name": split.name, "shares": shares]
            content["url"] = split.url
            ops.append(content)
        }
        return await edit(ops) ? ids : nil
    }

    /// Fills a pane waiting for a pick with `tab`: the picker's tab goes,
    /// and `tab` moves into its place (split-view spec §5.2).
    /// Returns the change that takes the pick back: the tab to where it was,
    /// and a pane waiting for a pick in its place.
    func pick(_ tab: OutlineRow, for pane: OutlineRow) async -> [[String: Any]]? {
        guard let split = pane.parentId, let from = place(of: tab) else { return nil }
        let panes = children(of: split)
        guard let at = panes.firstIndex(where: { $0.id == pane.id }) else { return nil }
        var move: [String: Any] = ["kind": "moveNode", "id": tab.id, "newParent": split]
        move["before"] = at > 0 ? panes[at - 1].id : nil
        move["after"] = at + 1 < panes.count ? panes[at + 1].id : nil
        guard await edit([["kind": "remove", "id": pane.id], move]) else { return nil }
        var back: [String: Any] = ["kind": "moveNode", "id": tab.id, "newParent": from.parent]
        back["before"] = from.previous
        back["after"] = from.next
        // The picker's address stays on the device that writes it, so it
        // carries the mark the desktop gives every address it never syncs
        // (decision 1372, `markLocal`).
        var picker: [String: Any] = [
            "kind": "addTab", "parent": split, "name": "", "url": splitPickAddress, "id": UUID().uuidString.lowercased(),
            "local": true,
        ]
        picker["before"] = at > 0 ? panes[at - 1].id : nil
        return [back, picker]
    }

    /// Applies `ops` to the tree as one batch, as an Undo does.
    @discardableResult
    func editTree(_ ops: [[String: Any]]) async -> Bool {
        await edit(ops)
    }

    /// Renames a row. A tab's name is its label, which its navigations
    /// never touch, and an empty one takes the label away so the tab shows
    /// its page's title again, as on the desktop (spec §5.1). A Workspace or
    /// group keeps its name when given none.
    func rename(_ row: OutlineRow, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if row.kind == .tab {
            let label: String? = name.isEmpty ? nil : name
            guard label != row.label else { return }
            await edit(["kind": "setLabel", "id": row.id, "label": label ?? NSNull()])
            return
        }
        guard !name.isEmpty, name != row.name else { return }
        await edit(["kind": "rename", "id": row.id, "name": name])
    }

    /// Saves a Workspace's or group's name, emoji and colour from its Edit
    /// dialog, as one write. The appearance group is written whole
    /// (`setAppearance`), so the emoji and colour go together.
    /// A colour as `setAppearance` takes it: a preset's token as it is, and
    /// a custom colour, which rows carry as JSON, as the object it is.
    static func appearanceColor(_ color: String?) -> Any? {
        guard let color, color.hasPrefix("{") else { return color }
        return try? JSONSerialization.jsonObject(with: Data(color.utf8))
    }

    func saveLook(_ row: OutlineRow, name: String, emoji: String?, color: String?) async -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return false }
        var ops: [[String: Any]] = []
        if name != row.name { ops.append(["kind": "rename", "id": row.id, "name": name]) }
        if emoji != row.emoji || color != row.color {
            var look: [String: Any] = ["kind": "setAppearance", "id": row.id]
            look["emoji"] = emoji
            look["color"] = Self.appearanceColor(color)
            // The op writes the whole group, so the window's transparency,
            // which the phone doesn't edit, goes back as it was.
            look["transparency"] = row.transparency
            ops.append(look)
        }
        return ops.isEmpty ? true : await edit(ops)
    }

    /// Adds a tab for `url` at the end of `parent`, named by its address
    /// until the page gives it a title, and returns its id: `id` when given,
    /// for a tab whose page is made ahead of its row.
    func addTab(to parent: String, url: URL, after previous: String? = nil, before next: String? = nil, name: String? = nil,
                id given: String? = nil) async -> String? {
        // The phone writes only web addresses into synced data: any other
        // stays on the device it was made on (decision 1372).
        guard Self.opensHere(url.absoluteString) else { return nil }
        let id = given ?? UUID().uuidString.lowercased()
        var op: [String: Any] = [
            "kind": "addTab", "parent": parent, "name": name ?? url.absoluteString,
            "url": url.absoluteString, "id": id,
        ]
        // The engine orders a node after `before` and ahead of `after`
        // (`tree::order_between`).
        op["before"] = previous
        op["after"] = next
        return await edit(op) ? id : nil
    }

    /// Where a row sits: its parent and the siblings either side of it,
    /// so an undo can put it back between the two, as the desktop's moves
    /// name both (`moveNode`'s `before` and `after`). With `previous` alone
    /// the engine orders it after that sibling and can pass the next one or
    /// tie with it (`tree::key_between`).
    struct Place {
        let parent: String
        let previous: String?
        var next: String? = nil
    }

    /// Where `row` sits. A sibling in `skipping` moves back with it, ahead
    /// of it in tree order, so the next sibling named is one that stays.
    func place(of row: OutlineRow, skipping: Set<String> = []) -> Place? {
        Self.place(of: row, in: tree, skipping: skipping)
    }

    nonisolated static func place(of row: OutlineRow, in tree: OutlineIndex, skipping: Set<String> = []) -> Place? {
        guard let parent = row.parentId else { return nil }
        let (previous, next) = neighbours(of: row.id, among: tree.children(of: parent).map(\.id), skipping: skipping)
        return Place(parent: parent, previous: previous, next: next)
    }

    /// `id` when it is still a child of `parent`: the engine orders by a
    /// neighbour's key wherever that neighbour sits (`tree::order_between`).
    func sibling(_ id: String?, in parent: String) -> String? {
        id.flatMap { row($0)?.parentId == parent ? $0 : nil }
    }

    /// The siblings either side of `id` in `siblings`: the one before it,
    /// and the first after it outside `skipping`.
    nonisolated static func neighbours(of id: String, among siblings: [String], skipping: Set<String> = [])
        -> (previous: String?, next: String?) {
        guard let index = siblings.firstIndex(of: id) else { return (nil, nil) }
        return (index > 0 ? siblings[index - 1] : nil,
                siblings[(index + 1)...].first { !skipping.contains($0) })
    }

    /// Whether `row` is a split's pane, which is never pinned on its own
    /// (the desktop's `canPin`, pins spec §8.1).
    func isPane(_ row: OutlineRow) -> Bool {
        row.parentId.flatMap(self.row)?.kind == .split
    }

    /// Where a closed tab goes back: where it was, or for a split's pane
    /// beside its split, since a tab joins a split only by the user
    /// splitting it (split-view spec §6.1, the desktop's `placeBeside`).
    func closedPlace(of row: OutlineRow) -> Place? {
        Self.closedPlace(of: row, in: tree)
    }

    nonisolated static func closedPlace(of row: OutlineRow, in tree: OutlineIndex) -> Place? {
        guard let parent = row.parentId, let split = tree.row(parent), split.kind == .split else {
            return place(of: row, in: tree)
        }
        return place(of: split, in: tree).map { Place(parent: $0.parent, previous: split.id, next: $0.next) }
    }

    /// Opens a closed tab again where it was, under its own id, as the
    /// desktop's undo close does: a closed tab leaves no record to restore
    /// (engine rule 5), and the id is the one way it comes back as itself.
    /// The tab goes back under its own name, with its label. A place
    /// another device has since deleted gives way to the end of its
    /// Workspace, or of the Workspace shown. A tab that was private goes
    /// back into its own session or nowhere: the Workspace shown may be
    /// one that syncs.
    func reopen(_ row: OutlineRow, at place: Place, workspace: String?, wasPrivate: Bool) async -> String? {
        guard let address = row.url, let url = URL(string: address) else { return nil }
        let parent: String
        let previous: String?
        var next: String?
        if self.row(place.parent) != nil {
            parent = place.parent
            previous = sibling(place.previous, in: parent)
            next = sibling(place.next, in: parent)
        } else if let home = [workspace, wasPrivate ? nil : browser.workspaceId].compactMap({ $0 })
                    .first(where: { self.row($0) != nil }) {
            parent = home
            previous = children(of: home).last?.id
        } else {
            return nil
        }
        let id = row.id
        var add: [String: Any] = ["kind": "addTab", "parent": parent, "name": row.name, "url": url.absoluteString, "id": id]
        add["before"] = previous
        add["after"] = next
        var ops = [add]
        if let label = row.label { ops.append(["kind": "setLabel", "id": id, "label": label]) }
        return await edit(ops) ? id : nil
    }

    /// Makes a workspace, last in the order, and returns its id.
    func addWorkspace(named name: String, emoji: String?, color: String?) async -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let id = UUID().uuidString.lowercased()
        var ops: [[String: Any]] = [["kind": "addWorkspace", "name": name, "id": id]]
        if emoji != nil || color != nil {
            var appearance: [String: Any] = ["kind": "setAppearance", "id": id]
            appearance["emoji"] = emoji
            appearance["color"] = Self.appearanceColor(color)
            ops.append(appearance)
        }
        return await edit(ops) ? id : nil
    }

    /// Makes a group in Workspace `parent` holding `members`, as one
    /// write, and returns its id. With members from that Workspace the
    /// group takes the first one's place (`groupSelectionTarget`); with
    /// none, or from elsewhere, it goes after the groups already in
    /// `parent` (`defaultSlot`), as the desktop places a new group.
    func addGroup(named name: String, emoji: String? = nil, color: String? = nil, in parent: String,
                  holding members: [OutlineRow] = []) async -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let members = outermost(members)
        let id = UUID().uuidString.lowercased()
        var home = parent
        var slot: (previous: String?, next: String?)
        // A pane's place is its split's: nothing but tabs goes in a split.
        if let first = members.first, workspace(of: first.id) == workspace(of: parent),
           let anchor = isPane(first) ? first.parentId : first.id, let at = row(anchor)?.parentId {
            home = at
            slot = Self.selectionSlot(among: children(of: at).map(\.id), anchor: anchor,
                                      members: Set(members.map(\.id)))
        } else {
            let placed = Self.moveIntoOrder(staying: children(of: parent).map { ($0.id, $0.kind == .group) },
                                            moving: [(id, true)])
            slot = (placed.first?.previous, placed.first?.next)
        }
        var ops: [[String: Any]] = [["kind": "addGroup", "parent": home, "name": name, "id": id]]
        if emoji != nil || color != nil {
            var look: [String: Any] = ["kind": "setAppearance", "id": id]
            look["emoji"] = emoji
            look["color"] = Self.appearanceColor(color)
            ops.append(look)
        }
        if slot.previous != nil || slot.next != nil {
            var place: [String: Any] = ["kind": "moveNode", "id": id, "newParent": home]
            place["before"] = slot.previous
            place["after"] = slot.next
            ops.append(place)
        }
        for (index, member) in members.enumerated() {
            var move: [String: Any] = ["kind": "moveNode", "id": member.id, "newParent": id]
            move["before"] = index > 0 ? members[index - 1].id : nil
            ops.append(move)
        }
        ops += splitShapeOps(leaving: members)
        return await edit(ops) ? id : nil
    }

    /// Where a new group holding `members` goes among `siblings`: the place
    /// of `anchor`, the first of them, among the siblings that stay
    /// (`groupSelectionTarget`).
    static func selectionSlot(among siblings: [String], anchor: String, members: Set<String>)
        -> (previous: String?, next: String?) {
        let staying = siblings.filter { !members.contains($0) }
        let at = siblings.prefix { $0 != anchor }.filter { !members.contains($0) }.count
        return (at > 0 ? staying[at - 1] : nil, at < staying.count ? staying[at] : nil)
    }

    /// Puts Workspace `id` between `before` and `after` in the order every
    /// device lists Workspaces (`tree::move_workspace`).
    func moveWorkspace(_ id: String, before: String?, after: String?) async {
        var op: [String: Any] = ["kind": "moveWorkspace", "id": id]
        op["before"] = before
        op["after"] = after
        await edit(op)
    }

    /// Moves a tab to the end of `parent`, a workspace or a group.
    @discardableResult
    func move(_ row: OutlineRow, to parent: String) async -> Bool {
        guard row.parentId != parent else { return false }
        let last = rows.last { $0.parentId == parent && $0.id != row.id }
        return await move(row.id, to: Place(parent: parent, previous: last?.id))
    }

    /// Moves `rows` into `parent`, as one write, each where the desktop's
    /// Move to puts it (`moveIntoTargets`): groups after the groups that
    /// stay, the rest at the end, in tree order. A row already in `parent`
    /// stays where it is, and one inside another of `rows` goes with it.
    /// Returns what puts them back where they were.
    func move(_ rows: [OutlineRow], to parent: String) async -> [[String: Any]]? {
        let moving = outermost(rows).filter { $0.parentId != parent && !isInside(parent, $0.id) }
        guard !moving.isEmpty else { return nil }
        let ids = Set(moving.map(\.id))
        let staying = children(of: parent).filter { !ids.contains($0.id) }
        let ops: [[String: Any]] = Self.moveIntoOrder(
            staying: staying.map { ($0.id, $0.kind == .group) }, moving: moving.map { ($0.id, $0.kind == .group) }
        ).map { slot in
            var op: [String: Any] = ["kind": "moveNode", "id": slot.id, "newParent": parent]
            op["before"] = slot.previous
            op["after"] = slot.next
            return op
        } + splitShapeOps(leaving: moving)
        let undo = returnOps(for: moving)
        return await edit(ops) ? undo : nil
    }

    /// `rows` in tree order, leaving out any inside another of them.
    func outermost(_ rows: [OutlineRow]) -> [OutlineRow] {
        let ids = Set(rows.map(\.id))
        let order = Dictionary(self.rows.enumerated().map { ($1.id, $0) }, uniquingKeysWith: min)
        return rows
            .filter { row in !ids.contains { $0 != row.id && isInside(row.id, $0) } }
            .sorted { (order[$0.id] ?? 0) < (order[$1.id] ?? 0) }
    }

    /// The moves that put `rows`, in tree order, back where they are.
    func returnOps(for rows: [OutlineRow]) -> [[String: Any]] {
        let ids = Set(rows.map(\.id))
        return rows.compactMap { row in
            guard let place = place(of: row, skipping: ids) else { return nil }
            var back: [String: Any] = ["kind": "moveNode", "id": row.id, "newParent": place.parent]
            back["before"] = place.previous
            back["after"] = place.next
            return back
        }
    }

    /// Where each of `moving` lands in a container holding `staying`, as
    /// the desktop orders a Move to (`moveIntoTargets`): groups after the
    /// last group that stays, everything else at the end, each in its
    /// order. Each lands after the one before it, which an earlier move in
    /// the batch has placed, and before the next that stays.
    static func moveIntoOrder(staying: [(id: String, group: Bool)], moving: [(id: String, group: Bool)])
        -> [(id: String, previous: String?, next: String?)] {
        let lastGroup = staying.lastIndex { $0.group }.map { $0 + 1 } ?? 0
        let final = staying[..<lastGroup].map(\.id) + moving.filter(\.group).map(\.id)
            + staying[lastGroup...].map(\.id) + moving.filter { !$0.group }.map(\.id)
        let movingIds = Set(moving.map(\.id))
        return final.enumerated().compactMap { index, id in
            guard movingIds.contains(id) else { return nil }
            return (id, index > 0 ? final[index - 1] : nil, final[(index + 1)...].first { !movingIds.contains($0) })
        }
    }

    /// Puts back rows `move(_:to:)` moved. A neighbour that has since
    /// left the place is dropped, unless an earlier move in the batch puts
    /// it back there.
    func moveBack(_ undo: [[String: Any]]) async {
        var placed: [String: String] = [:]
        let ops = undo.map { op in
            guard let parent = op["newParent"] as? String, let id = op["id"] as? String else { return op }
            var op = op
            for key in ["before", "after"] {
                if let near = op[key] as? String, placed[near] != parent, sibling(near, in: parent) == nil {
                    op[key] = nil
                }
            }
            placed[id] = parent
            return op
        }
        _ = await edit(ops)
    }

    /// Moves node `id` into `place`, after the sibling it names.
    @discardableResult
    func move(_ id: String, to place: Place) async -> Bool {
        var op: [String: Any] = ["kind": "moveNode", "id": id, "newParent": place.parent]
        op["before"] = sibling(place.previous, in: place.parent)
        op["after"] = sibling(place.next, in: place.parent)
        return await edit(op)
    }

    /// Deletes a group, its contents with it or moved up to its parent in
    /// their order (decision 0077, spec §5.4).
    func deleteGroup(_ row: OutlineRow, keepingContents: Bool) async {
        guard row.kind == .group else { return }
        await edit(["kind": keepingContents ? "removeKeepingChildren" : "remove", "id": row.id])
    }

    /// Makes deleted empty group `row` again where it was, under its own
    /// id, with its name and look: Undo of deleting it, which asks nothing.
    func reopenGroup(_ row: OutlineRow, at place: Place) async {
        guard self.row(place.parent) != nil else { return }
        var ops: [[String: Any]] = [["kind": "addGroup", "parent": place.parent, "name": row.name, "id": row.id]]
        if row.emoji != nil || row.color != nil {
            var look: [String: Any] = ["kind": "setAppearance", "id": row.id]
            look["emoji"] = row.emoji
            look["color"] = Self.appearanceColor(row.color)
            ops.append(look)
        }
        var move: [String: Any] = ["kind": "moveNode", "id": row.id, "newParent": place.parent]
        move["before"] = sibling(place.previous, in: place.parent)
        move["after"] = sibling(place.next, in: place.parent)
        ops.append(move)
        await edit(ops)
    }

    /// Deletes a workspace and everything in it (decision 0077), and shows
    /// the next Workspace in the order.
    func deleteWorkspace(_ id: String) async {
        guard row(id)?.parentId == nil else { return }
        let order = workspaces.map(\.id)
        let next = order.firstIndex(of: id).flatMap { index in
            order.indices.contains(index + 1) ? order[index + 1] : (index > 0 ? order[index - 1] : nil)
        }
        if await edit(["kind": "remove", "id": id]), let next {
            browser.showWorkspace(next)
        }
    }

    /// Records where a tab's page went, so every device shows the tab at its
    /// new address and title. A title the page sets soon after its last
    /// is held back (`TitleHold`).
    func followNavigation(tabId: String, url: URL, title: String, isPrivate pagePrivate: Bool) async {
        // A private page whose tab has left the session writes nowhere:
        // its address would otherwise go to the synced tree.
        if pagePrivate, !isPrivate(tabId) { return }
        guard let row = row(tabId), ["http", "https"].contains(url.scheme ?? ""),
              let name = Self.navigationName(row, url: url, title: title, holds: TitleHold.shared,
                                             holdsBack: !isPrivate(tabId)) else { return }
        await edit(Self.content(row, name: name, url: url.absoluteString))
    }

    /// The name tab `row` is written with now that its page is at `url`,
    /// titled `title`, or nil when nothing is written yet. `holdsBack` is
    /// false for the private session's tree, which is never written to the
    /// folder, so nothing of it is held.
    static func navigationName(_ row: OutlineRow, url: URL, title: String, holds: TitleHold,
                               holdsBack: Bool) -> String? {
        // A page reopened or put back from its saved state reports its
        // address before its title, and that empty title would replace the
        // name the tab had there.
        if title.isEmpty, row.url == url.absoluteString { return nil }
        let name = title.isEmpty ? url.absoluteString : title
        if row.url != url.absoluteString {
            // A new page's first title goes with its address at once.
            holds.forget(row.id)
        } else {
            guard name != (holds.pending[row.id] ?? row.name) else { return nil }
            if holdsBack, !holds.admit(row.id, name: name == row.name ? nil : name) { return nil }
            guard row.name != name else { return nil }
        }
        return name
    }

    /// A `setContent` op for tab `row`. The content group is written whole
    /// (`docs/host-contract.md` §3), so the icon and the local mark go back
    /// as the tree holds them.
    private static func content(_ row: OutlineRow, name: String, url: String) -> [String: Any] {
        var op: [String: Any] = ["kind": "setContent", "id": row.id, "name": name, "url": url, "local": row.local]
        if let icon = row.icon { op["icon"] = icon }
        return op
    }

    /// The ops writing the titles `TitleHold` held back for `ids`, or for
    /// every tab, taking them from it.
    func heldTitleOps(_ ids: [String]? = nil) -> (ops: [[String: Any]], taken: [String: String]) {
        let taken = TitleHold.shared.take(ids)
        let ops = taken.compactMap { id, name -> [String: Any]? in
            guard let row = row(id), row.name != name, let url = row.url else { return nil }
            return Self.content(row, name: name, url: url)
        }
        return (ops, taken)
    }

    /// Writes the titles held back for `ids`, or for every tab.
    func writeHeldTitles(_ ids: [String]? = nil) async {
        let (ops, taken) = heldTitleOps(ids)
        guard !ops.isEmpty else { return }
        if !(await edit(ops)) { TitleHold.shared.putBack(taken) }
    }

    func row(_ id: String) -> OutlineRow? {
        tree.row(id)
    }

    /// The workspace `id` is in, or is.
    func workspace(of id: String) -> String? {
        tree.workspace(of: id)
    }

    /// Whether `workspace` can be deleted from this phone: never the last
    /// one, and never the phone's own, which it would only make again
    /// (decision 2254). Another device can delete that one.
    func canDelete(workspace: OutlineRow) -> Bool {
        workspaces.count > 1 && workspace.id != ownWorkspace?.id
    }

    /// The tabs in `workspace`, in tree order.
    func tabs(in workspace: String?) -> [OutlineRow] {
        guard let workspace else { return [] }
        return tree.tabs(in: workspace)
    }

    /// Sets a synced setting to `value`, a string or a Boolean, or resets it
    /// to its default when `value` is nil, as the desktop's pref would be
    /// set or cleared (settings-sync spec §3).
    func setSetting(_ key: String, to value: Any?) async {
        await setSettings([(key, value)])
    }

    /// Sets several synced settings in one write, as `setSetting` sets one.
    func setSettings(_ changes: [(key: String, value: Any?)]) async {
        let ops = changes.map { key, value -> [String: Any] in
            var op: [String: Any] = ["kind": "setSetting", "key": key]
            if let value,
               let json = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed) {
                op["valueJson"] = String(decoding: json, as: UTF8.self)
            }
            return op
        }
        await edit(ops, in: settingsDocument)
    }

    /// Opens a link another app hands Sval, as its default browser, in a new
    /// tab in front, over setup if it shows.
    func openIncoming(_ url: URL) async {
        guard Self.opensHere(url.absoluteString) else { return }
        settingUp = false
        _ = await loadedSyncer()
        await keepOwnWorkspace()
        guard let workspace = newTabWorkspace(from: browser.workspaceId) else { return }
        Diagnostics.log("links: a link from another app")
        await browser.openNewTab(url, in: workspace)
    }

    /// Whether the phone can open `url`: a web address.
    nonisolated static func opensHere(_ url: String) -> Bool {
        guard let scheme = URL(string: url)?.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    var workspaces: [OutlineRow] {
        rows.filter { $0.depth == 0 && !privateIds.contains($0.id) }
    }

    /// The Workspaces as the Workspace sheet's strip shows them: this
    /// phone's own, the user's, other devices', then each agent's.
    var workspaceSections: WorkspaceSections {
        let agents = workspaces.filter { $0.agent != nil }
        var seen = Set<String>()
        let names = agents.compactMap(agentName).filter { seen.insert($0).inserted }
        return WorkspaceSections(
            own: ownWorkspace,
            people: workspaces.filter { $0.agent == nil && $0.device == nil },
            devices: workspaces.filter { $0.agent == nil && isOtherDevices($0) },
            agents: names.map { name in (name, agents.filter { agentName($0) == name }) })
    }

    /// The colour token a Workspace's surfaces take: the private palette
    /// for the private session's, else the Workspace's own colour.
    func tint(of workspace: OutlineRow?) -> String? {
        guard let workspace else { return nil }
        return privateIds.contains(workspace.id) ? Theme.privateToken : workspace.color
    }

    func children(of id: String) -> [OutlineRow] {
        tree.children(of: id)
    }

    /// Closes a tab. Only a tab closes this way: groups and Workspaces are
    /// deleted by name on the desktop (decision 0077).
    @discardableResult
    func closeTab(_ row: OutlineRow) async -> Bool {
        guard row.kind == .tab else { return false }
        let wasPrivate = isPrivate(row.id)
        // The page goes before the edit drops the tab from the session's
        // ids, so nothing it reports later can be taken for the user's.
        if wasPrivate { browser.closePage(row.id) }
        guard await edit([["kind": "remove", "id": row.id]] + splitShapeOps(leaving: row)) else { return false }
        TitleHold.shared.forget(row.id)
        return true
    }

    /// What keeps a split whole when `row` leaves it, as the desktop's
    /// panel writes it (`splitShapeOps`): a split left with one tab or none
    /// is separated, and one whose widths no longer fit goes back to equal
    /// widths.
    func splitShapeOps(leaving row: OutlineRow) -> [[String: Any]] {
        tree.splitShapeOps(leaving: row)
    }

    /// What keeps each split whole when `rows` leave it together: a split
    /// that itself leaves, or sits inside a row that does, goes with them.
    func splitShapeOps(leaving rows: [OutlineRow]) -> [[String: Any]] {
        tree.splitShapeOps(leaving: rows)
    }
}
