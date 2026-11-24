// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

extension WorkspaceSheet {
    // MARK: Menus

    /// The room a nested card keeps above and below it.
    static let cardGap: CGFloat = 3
    /// The corner of a group's card, and of a row's highlight and drop
    /// mark, in the list.
    static let cardCorner: CGFloat = 12

    /// A tab's long-press menu, in the list and the grid. `rename` opens
    /// its Rename Tab alert.
    func tabMenu(_ row: OutlineRow, rename: @escaping () -> Void) -> [[MenuItem]] {
        var items = [MenuItem(title: "Rename…", symbol: "pencil", action: rename)]
        // Pins and Favorites sync, so a private tab offers neither.
        if row.agent == nil, !model.isPrivate(row.id), !model.isPane(row), let url = Browser.openable(row) {
            items.append(MenuItem(title: "Pin Tab", symbol: "pin") { pin(row, url: url) })
        }
        if !model.isPrivate(row.id), let url = Browser.openable(row) {
            items.append(favoriteItem(url, title: row.title))
        }
        items.append(MenuItem(title: "Move to…", symbol: "folder") { moving = row })
        return [items, orderItems(row),
                [MenuItem(title: "Close Tab", symbol: "xmark", destructive: true) { close(row) }]]
    }

    /// Add to Favorites, or Remove from Favorites for a page already in
    /// them.
    private func favoriteItem(_ url: URL, title: String) -> MenuItem {
        if model.favorites(of: url).contains(where: { !$0.pinned }) {
            return MenuItem(title: "Remove from Favorites", symbol: "star.slash") { unfavorite(url) }
        }
        return MenuItem(title: "Add to Favorites", symbol: "star") { Task { await model.addFavorite(url, title: title) } }
    }

    /// Move Up, Move Down and Split With…: what dragging a row does, for a
    /// person who can't drag (decision 14).
    func orderItems(_ row: OutlineRow) -> [MenuItem] {
        var items = [
            MenuItem(title: "Move Up", symbol: "arrow.up", disabled: !model.canMove(row, by: -1)) {
                Task { await model.movePane(row, by: -1) }
            },
            MenuItem(title: "Move Down", symbol: "arrow.down", disabled: !model.canMove(row, by: 1)) {
                Task { await model.movePane(row, by: 1) }
            },
        ]
        if row.kind != .group {
            items.append(MenuItem(title: "Split With…", symbol: "rectangle.split.2x1", disabled: !model.offersSplit(for: row)) {
                splittingWith = row
            })
        }
        return items
    }

    /// A pane's long-press menu (12e1): about the tab, then about the
    /// split. `rename` starts the pane's rename the view draws.
    func paneMenu(_ pane: OutlineRow, split: OutlineRow, panes: [OutlineRow], rename: @escaping () -> Void) -> [[MenuItem]] {
        let all = model.children(of: split.id)
        let at = all.firstIndex { $0.id == pane.id } ?? 0
        var tab = [MenuItem(title: "Rename Tab…", symbol: "pencil", action: rename)]
        // Favorites sync, so a private pane offers none, as `tabMenu`.
        if !model.isPrivate(pane.id), let url = Browser.openable(pane) {
            tab.append(favoriteItem(url, title: pane.title))
        }
        // The tree's tray lays the panes side by side.
        let moves = PaneMove.labels(sideways: true)
        let splitItems = [
            MenuItem(title: moves.back.title, symbol: moves.back.symbol, disabled: at == 0) {
                Task { await model.movePane(pane, by: -1) }
            },
            MenuItem(title: moves.ahead.title, symbol: moves.ahead.symbol, disabled: at == all.count - 1) {
                Task { await model.movePane(pane, by: 1) }
            },
            MenuItem(title: "Separate", symbol: "rectangle.split.2x1.slash") { Task { await model.separate(split) } },
            MenuItem(title: "Rename Split…", symbol: "character.cursor.ibeam") { renamingSplit = split },
            MenuItem(title: "Move to…", symbol: "folder") { moving = split },
        ]
        let closing = [
            MenuItem(title: "Close Tab", symbol: "xmark", destructive: true) { close(pane) },
            MenuItem(title: panes.count == 2 ? "Close Both" : "Close All", symbol: "xmark.square", destructive: true) {
                closeSplit(split, panes: panes)
            },
        ]
        return [tab, splitItems, orderItems(split), closing]
    }

    /// Opens the groups that hold the tab in front, however it came to the
    /// front, so the sheet shows it.
    func revealFront() {
        guard let id = browser.currentTabId else { return }
        var opened = false
        var parent = model.row(id)?.parentId.flatMap(model.row)
        while let at = parent, at.kind != .workspace {
            if collapsed.remove(at.id) != nil { opened = true }
            parent = at.parentId.flatMap(model.row)
        }
        guard opened else { return }
        UserDefaults.standard.set(Array(collapsed.filter { !model.isPrivate($0) }), forKey: Self.collapsedKey)
    }

    /// Opens or closes a group, and keeps which are closed.
    func toggle(_ group: OutlineRow) {
        withAnimation(reduceMotion ? nil : Motion.disclose) {
            if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
        }
        UserDefaults.standard.set(Array(collapsed.filter { !model.isPrivate($0) }), forKey: Self.collapsedKey)
    }

    /// Delete Group: an empty group goes at once, with Undo, as on the
    /// desktop; a group with something in it asks what becomes of that.
    func deleteGroup(_ row: OutlineRow) {
        let inside = model.tree.inside(row.id)
        guard inside.tabs == 0, inside.groups == 0 else {
            deletingGroup = row
            return
        }
        let place = model.place(of: row)
        Task {
            await model.deleteGroup(row, keepingContents: false)
            toasts.show(Toast(text: "Deleted the “\(name(row))” group") {
                guard let place else { return }
                Task { await model.reopenGroup(row, at: place) }
            })
        }
    }

    /// What Delete Group's question says for a group holding `tabs` tabs
    /// and `groups` groups, at any depth, and its two buttons.
    static func deleteGroupText(tabs: Int, groups: Int) -> (message: String, keep: String, delete: String) {
        func count(_ n: Int, _ noun: String) -> String { n == 1 ? "the \(noun)" : "the \(n) \(noun)s" }
        if groups == 0 {
            let noun = tabs == 1 ? "Tab" : "Tabs"
            return ("Keep or close \(count(tabs, "tab")) inside.", "Keep \(noun)", "Close \(noun)")
        }
        if tabs == 0 {
            let noun = groups == 1 ? "Group" : "Groups"
            return ("Keep or delete \(count(groups, "group")) inside.", "Keep \(noun)", "Delete \(noun)")
        }
        let tabsText = tabs == 1 ? "1 tab" : "\(tabs) tabs", groupsText = groups == 1 ? "1 group" : "\(groups) groups"
        return ("Keep or delete the \(tabsText) and \(groupsText) inside.", "Keep All", "Delete All")
    }

    /// A group's long-press menu, in the list and the grid.
    func groupMenu(_ row: OutlineRow) -> [[MenuItem]] {
        let edit = row.kind == .group
            ? MenuItem(title: "Edit Group…", symbol: "pencil") { editLook(of: row.id) }
            : MenuItem(title: "Rename…", symbol: "pencil") { renameCard(row) }
        return [[edit, MenuItem(title: "Move to…", symbol: "folder") { moving = row }],
                orderItems(row),
                row.kind == .group
                    ? [MenuItem(title: "Delete Group…", symbol: "trash", destructive: true) { deleteGroup(row) }] : []]
    }
}
