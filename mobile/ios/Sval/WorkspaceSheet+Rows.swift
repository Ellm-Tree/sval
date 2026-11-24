// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

extension WorkspaceSheet {
    // MARK: Group blocks

    /// One coloured group's part in a row's block: whether the row opens or
    /// closes the group, and how far in a nested group's card starts.
    struct BlockLayer {
        let tint: WorkspaceTint
        let top: Bool
        let bottom: Bool
        let inset: CGFloat
    }

    /// A row's place in the blocks of the coloured groups around it,
    /// outermost first. The outermost colour keeps the row's whole width,
    /// and each group inside it is a card within its parent's, so a nested
    /// group never breaks its parent's block.
    struct RowBlock {
        let layers: [BlockLayer]
        var outer: BlockLayer { layers[0] }
        var inner: BlockLayer? { layers.count > 1 ? layers.last : nil }
    }

    func blocks(for entries: [TreeEntry]) -> [String: RowBlock] {
        var out: [String: RowBlock] = [:]
        let rows = entries.map(\.row)
        for (index, entry) in entries.enumerated() {
            let row = entry.row
            var chain: [OutlineRow] = []
            var node: OutlineRow? = row.kind == .tab ? row.parentId.flatMap(model.row) : row
            while let group = node, group.kind != .workspace {
                if group.color.flatMap(WorkspaceTint.init(rawValue:)) != nil { chain.insert(group, at: 0) }
                node = group.parentId.flatMap(model.row)
            }
            guard let outer = chain.first else { continue }
            let next = rows.indices.contains(index + 1) ? rows[index + 1] : nil
            func layer(_ group: OutlineRow) -> BlockLayer {
                BlockLayer(
                    tint: WorkspaceTint(rawValue: group.color!)!,
                    top: row.id == group.id,
                    bottom: next.map { !isInside($0, group.id) } ?? true,
                    inset: CGFloat(group.depth - 1) * 24)
            }
            out[entry.id] = RowBlock(layers: chain.map(layer))
        }
        return out
    }

    /// The rows with a little space above them, outside any block: a
    /// coloured group's header, and the row after a coloured group. Both
    /// hold whether the group is open or closed, so opening one moves no
    /// row but those it reveals.
    func gaps(for rows: [TreeEntry], blocks: [String: RowBlock]) -> Set<String> {
        var out: Set<String> = []
        for (index, row) in rows.enumerated() {
            if blocks[row.id]?.outer.top == true {
                out.insert(row.id)
            } else if index > 0, blocks[rows[index - 1].id]?.outer.bottom == true {
                out.insert(row.id)
            }
        }
        return out
    }

    /// Whether `row` lies inside `group`, at any depth.
    func isInside(_ row: OutlineRow, _ group: String) -> Bool {
        row.parentId.map { model.isInside($0, group) } ?? false
    }

    /// The block behind a row: only a group's outer corners round.
    @ViewBuilder private func blockBackground(_ block: RowBlock?) -> some View {
        let dark = theme.dark
        if let block {
            ZStack {
                ForEach(Array(block.layers.enumerated()), id: \.offset) { index, layer in
                    shape(layer)
                        .fill(GroupBlock.color(layer.tint, dark: dark, surface: theme.sheetLightness, blockDir: theme.blockDir))
                        .padding(.leading, layer.inset)
                        .padding(.trailing, CGFloat(index) * 6)
                        // A nested card stands clear of what's above and
                        // below it inside its parent.
                        .padding(.top, index > 0 && layer.top ? Self.cardGap : 0)
                        .padding(.bottom, index > 0 && layer.bottom ? Self.cardGap : 0)
                }
            }
        }
    }

    /// The room a nested card keeps above and below it.
    static let cardGap: CGFloat = 3
    /// The corner of a group's card, and of a row's highlight and drop
    /// mark, in the tree.
    static let cardCorner: CGFloat = 12

    /// A row in front inside a coloured group lifts as a card of its own
    /// within the group's block, as a split does, never to the block's
    /// edges. Outside any group it takes the accent wash.
    @ViewBuilder private func frontCard(_ block: RowBlock?, front: Bool) -> some View {
        ZStack {
            blockBackground(block)
            if front {
                if let block, let last = block.layers.last {
                    RoundedRectangle(cornerRadius: Self.cardCorner)
                        .fill(GroupBlock.color(last.tint, dark: theme.dark, surface: theme.sheetLightness,
                                               blockDir: theme.blockDir, selected: true))
                        .padding(.leading, last.inset + 24)
                        .padding(.trailing, CGFloat(block.layers.count) * 6)
                        .padding(.vertical, Self.cardGap)
                } else {
                    RoundedRectangle(cornerRadius: Self.cardCorner).fill(theme.accentWash)
                }
            }
        }
    }

    /// How far the innermost group's card ends inside the row's trailing
    /// edge, which the row's own content stays inside.
    private func cardInset(_ block: RowBlock?) -> CGFloat {
        CGFloat(max((block?.layers.count ?? 1) - 1, 0)) * 6
    }

    /// A row's text and muted text: on a coloured group's block, solved on
    /// the innermost block (`sval-panel.css`, `data-sval-fill`), else the
    /// sheet's.
    private func ink(_ block: RowBlock?) -> (text: Color, muted: Color) {
        let surface = DesktopColor.Surface(l: theme.sheetLightness, surfaceDark: theme.dark, dir: theme.blockDir)
        guard let tint = block?.layers.last?.tint, let ink = DesktopColor.groupInk(tint.rawValue, on: surface) else {
            return (theme.text, theme.muted)
        }
        return (Color(hex: ink.text), Color(hex: ink.muted))
    }

    private func shape(_ layer: BlockLayer) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: layer.top ? Self.cardCorner : 0, bottomLeadingRadius: layer.bottom ? Self.cardCorner : 0,
            bottomTrailingRadius: layer.bottom ? Self.cardCorner : 0, topTrailingRadius: layer.top ? Self.cardCorner : 0)
    }

    func tabRow(_ row: OutlineRow, indent: CGFloat, block: RowBlock?) -> some View {
        let front = row.id == browser.currentTabId
        let elsewhere = Browser.openable(row) == nil && row.url != nil
        let playing = browser.playingTabs.contains(row.id)
        let ticked = selected.contains(row.id)
        let rowInk = ink(block)
        return HStack(spacing: 10) {
            if editing {
                SelectionTick(ticked: ticked, tick: theme.action, off: rowInk.muted)
            }
            SiteTile(row: row, size: 28)
                .opacity(elsewhere ? 0.55 : 1)
            // The title, and under it the page's site as the bar shows
            // it: a title alone can be the same on many pages, and the
            // site tells them apart (Teevan et al., CHI 2009).
            VStack(alignment: .leading, spacing: 1) {
                Text(name(row))
                    .font(.system(.body, weight: front ? .semibold : .regular))
                    .foregroundStyle(elsewhere ? rowInk.muted : rowInk.text)
                    .titleLines()
                if let site = site(of: row) {
                    Text(site)
                        .font(.system(.footnote))
                        .foregroundStyle(rowInk.muted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if elsewhere {
                Image(systemName: "laptopcomputer")
                    .font(.system(size: 14))
                    .foregroundStyle(rowInk.muted)
                    .frame(width: 36, height: 36)
                    .accessibilityLabel("Can't open on \(UIDevice.current.model)")
            }
            // Every row closes from its ×, which a playing tab's speaker
            // takes the place of (14b1).
            RowAccessory(playing: playing, muted: browser.mutedTabs.contains(row.id), editing: editing, title: name(row),
                         ink: rowInk.muted, accent: theme.accent,
                         onMute: { browser.toggleMute(row.id) }, onClose: { close(row) })
        }
        .padding(.leading, 12 + indent)
        .padding(.trailing, 2 + cardInset(block))
        .rowHeight(RowMetrics.tab)
        .background { frontCard(block, front: front) }
        .contentShape(.rect)
        // A tap gesture, since a Button's label can't hold the row's own
        // buttons.
        .onTapGesture {
            if editing {
                if ticked { selected.remove(row.id) } else { selected.insert(row.id) }
                return
            }
            // A tab the phone can't open never takes the screen: it stays
            // in the tree, where it can be closed (decision 1372).
            if elsewhere {
                toasts.show(Toast(text: "Sval on \(UIDevice.current.model) can't open this tab", undo: { close(row) }, action: "Close Tab"))
                return
            }
            browser.select(row.id)
            close()
        }
        // One element, as a grid card is: the title, the site, then any
        // state, with × and the speaker as actions.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rowLabel(row, elsewhere: elsewhere, playing: playing))
        .accessibilityAddTraits(front || (editing && ticked) ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(named: "Close") { close(row) }
        .accessibilityActions {
            if playing {
                Button(browser.mutedTabs.contains(row.id) ? "Unmute" : "Mute") { browser.toggleMute(row.id) }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { close(row) } label: { Label("Close", systemImage: "xmark") }
            Button { moving = row } label: { Label("Move to…", systemImage: "folder") }
                .tint(theme.action)
        }
        .contextMenu { MenuItems(sections: tabMenu(row, rename: { renameCard(row) })) }
    }

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

    /// A split's line: its tray of panes. A tap on a pane opens the split
    /// there and closes the sheet (12a).
    func splitRow(_ split: OutlineRow, panes: [OutlineRow], indent: CGFloat, block: RowBlock?) -> some View {
        let front = panes.contains { $0.id == browser.currentTabId }
        let group = block.map { ($0.inner ?? $0.outer).tint }
        // The split's card starts where a group nested at its depth would,
        // and ends 6pt inside its group's card. The tray, which starts at
        // the glyph's left edge, keeps the same room to the card's right
        // edge as to its left.
        let cardLeading = block.map { $0.layers.last!.inset + 24 } ?? 0
        let cardTrailing = CGFloat(block?.layers.count ?? 0) * 6
        let trailing = cardTrailing + (12 + indent + 1 - cardLeading)
        return SplitRow(split: split, panes: panes, indent: indent, trailing: trailing, countTrailing: 10 + cardInset(block),
                        group: group, onOpen: { pane in
            guard let id = pane ?? browser.focusedPane(of: split.id, among: panes.map(\.id)) else { return }
            browser.select(id)
            close()
        }) { pane in
            MenuItems(sections: paneMenu(pane, split: split, panes: panes, rename: { renameCard(pane) }))
        }
        .background { frontCard(block, front: front) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { closeSplit(split, panes: panes) } label: {
                Label(panes.count == 2 ? "Close Both" : "Close All", systemImage: "xmark")
            }
            Button { moving = split } label: { Label("Move to…", systemImage: "folder") }
                .tint(theme.action)
        }
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

    func groupRow(_ row: OutlineRow, indent: CGFloat, block: RowBlock?) -> some View {
        let open = !collapsed.contains(row.id)
        let count = tabCount(in: row.id)
        let rowInk = ink(block)
        return HStack(spacing: 10) {
            Chevron(open: open, color: rowInk.muted)
                .frame(width: 14)
            groupMark(row, open: open)
            Text(name(row))
                .font(.system(.body, weight: .semibold))
                .foregroundStyle(rowInk.text)
                .titleLines()
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(count)")
                .font(.system(.subheadline))
                .monospacedDigit()
                .foregroundStyle(rowInk.muted)
                .padding(.trailing, 10)
        }
        .padding(.leading, 12 + indent)
        .padding(.trailing, cardInset(block))
        .rowHeight(RowMetrics.group)
        .background { blockBackground(block) }
        .contentShape(.rect)
        .onTapGesture { toggle(row) }
        .accessibilityElement(children: .combine)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(.isButton)
        .contextMenu { MenuItems(sections: groupMenu(row)) }
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

    /// A group's emoji, or its folder in its colour's ink: the block
    /// carries the colour, and the name stays in the text colour, which
    /// reads on every block (`sval-panel.css`, `data-sval-fill="own"`).
    @ViewBuilder func groupMark(_ row: OutlineRow, open: Bool) -> some View {
        let tint = row.color.flatMap(WorkspaceTint.init(rawValue:))
        if let emoji = row.emoji, !emoji.isEmpty {
            Text(emoji).font(.system(size: 20)).accessibilityIgnoresInvertColors().frame(width: 28)
        } else {
            Image(systemName: open ? "folder" : "folder.fill")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(tint?.swatch(dark: theme.dark) ?? theme.body)
                .frame(width: 28)
        }
    }

    func tabCount(in id: String) -> Int {
        model.rows.filter { $0.kind == .tab && isInside($0, id) }.count
    }
}
