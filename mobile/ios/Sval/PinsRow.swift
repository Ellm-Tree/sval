// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The Workspace's pins, a row of tiles at the top of the Workspace sheet
/// (design 2a; pins spec §4): each a pin whose page is its own, or a pinned
/// pin folder holding more. With more than fit, the row scrolls sideways.
struct PinsRow: View {
    @Environment(AppModel.self) private var model
    @Environment(Toasts.self) private var toasts
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Closes the sheet once a pin is in front.
    let onOpened: () -> Void
    /// A tile's size: 56pt, or 48pt in the sideways panel (12f3).
    var tileSize: CGFloat = 56

    @State private var openPinFolder: PinRow?
    @State private var renaming: PinRow?
    @State private var addressing: PinRow?
    /// The pin whose tile shows the refresh glyph, after a first tap on the
    /// pin in front while it is off its saved page.
    @State private var revealed: String?
    /// The row's scroll: how far along, how wide its tiles, how wide its view.
    @State private var scroll: [CGFloat] = [0, 0, 0]
    @State private var hiding: Task<Void, Never>?
    /// The tile a dragged pin is over, which it would join.
    @State private var dropTarget: String?
    /// A pin dropped on a pin, waiting on the pin folder's name: nothing is
    /// made until Create, and Cancel leaves both pins as they were.
    @State private var folding: (target: String, dragged: String)?

    /// How long the refresh glyph waits for its tap.
    private static let revealFor: Duration = .seconds(4)

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }

    var body: some View {
        let pins = browser.workspaceId.flatMap { model.pinsByWorkspace[$0] } ?? []
        let slots = pins.filter { $0.folder == nil }
        if !slots.isEmpty {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(slots, id: \.id) { slot in
                            if slot.kind == "folder" {
                                pinFolderTile(slot, inside: pins.filter { $0.folder == slot.id })
                            } else {
                                pinTile(slot)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
                .onScrollGeometryChange(for: [CGFloat].self) {
                    [$0.contentOffset.x, $0.contentSize.width, $0.containerSize.width]
                } action: { _, now in scroll = now }
                .scrollEdgeFade(.horizontal)
                if overflows { dots.padding(.bottom, 6) }
            }
            .textPrompt(renaming?.kind == "folder" ? "Rename Pin Folder" : "Rename Pin", item: $renaming,
                        initial: \.name, value: PromptValue.asTyped) { pin, name in
                Task { await model.renamePin(pin, to: name) }
            }
            .textPrompt("Create Pin Folder", item: $folding, confirm: "Create", initial: { _ in Self.newPinFolderName },
                        value: PromptValue.pinFolderName) { folding, name in
                Task {
                    await model.makePinFolder(of: folding.target, and: folding.dragged, named: name)
                    Diagnostics.log("pins: a pin dropped on a pin made a pin folder")
                }
            }
            .textPrompt("Edit Address", item: $addressing, placeholder: "Address", confirm: "Save", keyboard: .URL,
                        initial: { $0.url ?? "" }, value: PromptValue.address) { pin, url in
                Task { await model.setPinAddress(pin, to: url) }
            }
            // A pin held over another, as a row held over a row in the tree.
            .sensoryFeedback(.selection, trigger: dropTarget) { _, now in now != nil }
            .sheet(item: $openPinFolder) { folder in
                PinFolderList(folder: folder, pins: pins.filter { $0.folder == folder.id }, onPick: { pin in
                    openPinFolder = nil
                    open(pin)
                }, onMoveOut: { pin in
                    guard let root = model.pinsRootId else { return }
                    Task { await model.movePin(pin.id, into: root) }
                })
                .tintedSheet(sheetTint)
                .presentationDetents([.medium])
            }
        }
    }

    private var overflows: Bool { scroll[1] > scroll[2] + 1 }


    /// A dot for each screenful of pins, the one in view a wider accent
    /// pill, as the desktop's Workspace strip marks where it stands while
    /// it overflows.
    private var dots: some View {
        let pages = max(1, Int((scroll[1] / max(scroll[2], 1)).rounded(.up)))
        let travel = max(scroll[1] - scroll[2], 1)
        let current = min(pages - 1, max(0, Int((scroll[0] / travel * CGFloat(pages - 1)).rounded())))
        return PageDots(count: pages, current: current, on: theme.accent, off: theme.muted.opacity(0.45))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: current)
            .accessibilityHidden(true)
    }

    private func open(_ pin: PinRow) {
        browser.selectPin(pin)
        onOpened()
    }

    /// A pin dropped on `target`: into it when it's a pin folder, or, when
    /// it's a pin, the Create Pin Folder alert for a pin folder of both (pins-root spec
    /// §5).
    private func drop(_ dragged: String?, on target: PinRow) -> Bool {
        dropTarget = nil
        guard let dragged, dragged != target.id, model.favorites.contains(where: { $0.id == dragged && $0.pinned })
        else { return false }
        if target.kind == "folder" {
            Task {
                await model.movePin(dragged, into: target.id)
                Diagnostics.log("pins: a pin was dropped into a pin folder")
            }
        } else {
            folding = (target.id, dragged)
        }
        return true
    }

    /// A new pin folder's name until it is given one.
    static let newPinFolderName = "Untitled pin folder"

    /// Takes a dragged pin over `slot`'s tile, which rings in the accent.
    private func targeted(_ slot: PinRow, _ over: Bool) {
        if over { dropTarget = slot.id } else if dropTarget == slot.id { dropTarget = nil }
    }

    /// A tap on the pin in front, off its saved page, shows the refresh
    /// glyph in its tile; a second tap within `revealFor` takes it back to
    /// its saved page (pins spec §5, where a refresh button on the selected
    /// pin does this). A pin not in front is only brought to the front.
    private func tapped(_ pin: PinRow, front: Bool) {
        guard front, browser.pinOffSaved else { return open(pin) }
        hiding?.cancel()
        if revealed == pin.guid {
            revealed = nil
            browser.backToSaved()
            onOpened()
            return
        }
        revealed = pin.guid
        Diagnostics.log("pins: the refresh glyph shows")
        hiding = Task {
            try? await Task.sleep(for: Self.revealFor)
            guard !Task.isCancelled else { return }
            revealed = nil
        }
    }

    private func pinTile(_ pin: PinRow) -> some View {
        let front = browser.currentPin?.guid == pin.guid
        let showsRefresh = revealed == pin.guid && front && browser.pinOffSaved
        return Button { tapped(pin, front: front) } label: {
            tile(selected: front || dropTarget == pin.id) {
                if showsRefresh {
                    Image("reload")
                        .resizable()
                        .frame(width: 24, height: 24)
                        .foregroundStyle(theme.accent)
                } else {
                    SiteTile(url: pin.url, name: pin.name, size: tileSize / 2)
                }
            }
        }
        .animation(.easeOut(duration: 0.15), value: showsRefresh)
        .accessibilityLabel(showsRefresh ? "Back to \(title(pin))" : title(pin))
        .accessibilityAddTraits(front ? .isSelected : [])
        .contextMenu { pinMenu(pin, front: front) }
        .draggable(pin.id) {
            SiteTile(url: pin.url, name: pin.name, size: tileSize / 2)
                .frame(width: tileSize, height: tileSize)
                .background(theme.cell, in: .rect(cornerRadius: 16))
        }
        .dropDestination(for: String.self) { ids, _ in drop(ids.first, on: pin) } isTargeted: { targeted(pin, $0) }
    }

    private func pinFolderTile(_ folder: PinRow, inside: [PinRow]) -> some View {
        let front = inside.contains { $0.guid == browser.currentPin?.guid }
        return Button { openPinFolder = folder } label: {
            tile(selected: front || dropTarget == folder.id) {
                LazyVGrid(columns: [GridItem(.fixed(13), spacing: 3), GridItem(.fixed(13), spacing: 3)], spacing: 3) {
                    ForEach(inside.prefix(4), id: \.id) { pin in
                        SiteTile(url: pin.url, name: pin.name, size: 13)
                    }
                }
                .frame(width: 30, height: 30)
            }
        }
        .accessibilityLabel(title(folder))
        .accessibilityAddTraits(front ? .isSelected : [])
        .contextMenu {
            showIn(folder)
            Divider()
            Button("Rename…", systemImage: "pencil") { renaming = folder }
            Divider()
            Button("Move Contents to Row", systemImage: "rectangle.portrait.and.arrow.right") {
                Task { await model.moveContentsToRow(folder) }
            }
            Button("Move to Favorites", systemImage: "star") { moveToFavorites(folder) }
            Button("Delete", systemImage: "trash", role: .destructive) { deletePinFolder(folder) }
        }
        .dropDestination(for: String.self) { ids, _ in drop(ids.first, on: folder) } isTargeted: { targeted(folder, $0) }
    }

    /// Deletes a pin folder and what it holds, and offers Undo, which
    /// puts them back.
    private func deletePinFolder(_ folder: PinRow) {
        Task {
            guard let undo = await model.deletePinFolder(folder) else { return }
            Diagnostics.log("pins: deleted a pin folder, Undo offered")
            toasts.show(Toast(text: "Deleted “\(title(folder))”") {
                Task { await model.editFavorites(undo) }
            })
        }
    }

    /// Move to Pin Folder: the row's pin folders, the pin's own unavailable
    /// (pins-root spec §5).
    @ViewBuilder private func moveToPinFolder(_ pin: PinRow) -> some View {
        let folders = model.pinFolders
        let current = model.favorites.first { $0.id == pin.id }?.parent
        if !folders.isEmpty {
            Menu("Move to Pin Folder", systemImage: "folder") {
                ForEach(folders, id: \.id) { folder in
                    Button(folder.name.isEmpty ? Self.newPinFolderName : folder.name) {
                        Task { await model.movePin(pin.id, into: folder.id) }
                    }
                    .disabled(folder.id == current)
                }
            }
        }
    }

    /// New Pin Folder With…: a pin folder of this pin and another, what
    /// dropping one pin on another makes, for a person who can't drag
    /// (decision 14).
    @ViewBuilder private func newPinFolder(with pin: PinRow) -> some View {
        let row = browser.workspaceId.flatMap { model.pinsByWorkspace[$0] } ?? []
        let others = row.filter { $0.kind != "folder" && $0.folder == nil && $0.id != pin.id }
        if pin.folder == nil, !others.isEmpty {
            Menu("New Pin Folder With…", systemImage: "folder.badge.plus") {
                ForEach(others, id: \.id) { other in
                    Button(title(other)) {
                        folding = (pin.id, other.id)
                    }
                }
            }
        }
    }

    private func title(_ slot: PinRow) -> String {
        guard slot.name.isEmpty else { return slot.name }
        return slot.kind == "folder" ? Self.newPinFolderName : "Untitled pin"
    }

    private func moveToFavorites(_ slot: PinRow) {
        Task { toasts.show(await model.moveToFavoritesKeepingPage(slot, title: title(slot))) }
    }

    /// Deletes the pin, and offers Undo, which puts it back where it was.
    private func delete(_ pin: PinRow) {
        let place = model.place(of: pin)
        Task {
            await model.deletePin(pin)
            Diagnostics.log("pins: deleted, Undo offered")
            toasts.show(Toast(text: "Deleted the “\(title(pin))” pin") {
                Task {
                    await model.restore(pin, at: place)
                    Diagnostics.log("pins: a delete was undone")
                }
            })
        }
    }

    /// A tile, ringed in the accent while its pin is in front.
    private func tile<Content: View>(selected: Bool, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(width: tileSize, height: tileSize)
            .background(theme.cell, in: .rect(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(selected ? theme.accent : theme.divider, lineWidth: selected ? 2 : 1)
            }
            .contentShape(.rect)
    }

    /// The pin's menu, as the desktop's (pins spec §8).
    @ViewBuilder private func pinMenu(_ pin: PinRow, front: Bool) -> some View {
        let off = front && browser.pinOffSaved
        Button("Back to Saved Page", systemImage: "arrow.clockwise") { browser.backToSaved() }
            .disabled(!off)
        Button("Save Current Page as This Pin", systemImage: "pin") {
            if let url = browser.pinCurrentURL { Task { await model.setPinAddress(pin, to: url) } }
        }
        .disabled(!off)
        Divider()
        showIn(pin)
        moveToPinFolder(pin)
        newPinFolder(with: pin)
        Divider()
        Button("Rename…", systemImage: "pencil") { renaming = pin }
        Button("Edit Address…", systemImage: "link") { addressing = pin }
        Divider()
        Button("Move to Favorites", systemImage: "star") { moveToFavorites(pin) }
        Button("Delete", systemImage: "trash", role: .destructive) { delete(pin) }
    }

    /// Show In: a tick for each of the user's Workspaces. Ticking every one
    /// shows the pin in Workspaces made later too; the last tick can't be
    /// taken away (pins spec §7).
    private func showIn(_ slot: PinRow) -> some View {
        let mine = model.workspaces.filter { $0.agent == nil }
        let live = Set(slot.scope ?? []).intersection(mine.map(\.id))
        let shown = live.isEmpty ? Set(mine.map(\.id)) : live
        return Menu("Show In", systemImage: "square.stack") {
            ForEach(mine, id: \.id) { workspace in
                let ticked = shown.contains(workspace.id)
                Button {
                    var next = shown
                    if ticked { next.remove(workspace.id) } else { next.insert(workspace.id) }
                    Task { await model.setPinScope(slot, to: next) }
                } label: {
                    if ticked {
                        Label(label(workspace), systemImage: "checkmark")
                    } else {
                        Text(label(workspace))
                    }
                }
                .disabled(ticked && shown.count == 1)
            }
        }
    }

    private func label(_ workspace: OutlineRow) -> String {
        [workspace.emoji, WorkspaceTile.name(workspace)].compactMap { $0 }.joined(separator: " ")
    }
}

/// A pin folder's pins, each a pin as one in the row is (pins spec §6).
private struct PinFolderList: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let folder: PinRow
    let pins: [PinRow]
    let onPick: (PinRow) -> Void
    /// Moves a pin out of the pin folder, to the end of the row.
    let onMoveOut: (PinRow) -> Void

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        NavigationStack {
            List(pins, id: \.id) { pin in
                Button { onPick(pin) } label: {
                    Label {
                        Text(pin.name).lineLimit(1)
                    } icon: {
                        SiteTile(url: pin.url, name: pin.name, size: 28)
                    }
                }
                .foregroundStyle(theme.text)
                .listRowBackground(theme.cell)
                .contextMenu {
                    Button("Move to Row", systemImage: "rectangle.portrait.and.arrow.right") { onMoveOut(pin) }
                }
            }
            .overlay {
                if pins.isEmpty {
                    ContentUnavailableView("No Pins", systemImage: "pin",
                                           description: Text("Drag a pin onto this pin folder to put it here."))
                }
            }
            .sheetGround()
            .navigationTitle(folder.name.isEmpty ? PinsRow.newPinFolderName : folder.name)
            .sheetTitleMode(folder.name.isEmpty ? PinsRow.newPinFolderName : folder.name)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
    }
}

/// A pin is identified by its node id, so a sheet can present one.
extension PinRow: Identifiable {}

extension AppModel {
    /// Moves a pin to Favorites, and returns the toast that offers Undo:
    /// the pin goes back where it was in the row, with its Show in choices,
    /// and the tab its page became is its page again (pins-root spec §6).
    func moveToFavoritesKeepingPage(_ slot: PinRow, title: String) async -> Toast {
        let place = place(of: slot)
        let tab = slot.kind == "favorite" ? await browser.keepUnpinnedPage(slot) : nil
        let refolding = await moveToFavorites(slot)
        Diagnostics.log("pins: moved to Favorites, Undo offered")
        return Toast(text: "Moved “\(title)” to Favorites") {
            Task {
                await self.repin(slot, at: place, refolding: refolding)
                if let tab { await self.browser.returnToPin(tab, guid: slot.guid) }
                Diagnostics.log("pins: a move to Favorites was undone")
            }
        }
    }

    /// The row's pin folders, in the row's order, as Move to Pin Folder lists them
    /// (`SvalFavoritesStore.pinFolders`, pins-root spec §5).
    var pinFolders: [Favorite] {
        guard let root = pinsRootId else { return [] }
        return favorites.filter { $0.parent == root && $0.kind == "folder" }
    }

    /// Moves a pin to the end of `folder`, the row's or one of its pin folders
    /// (`SvalFavoritesStore.movePin`). A pin folder the move leaves holding one
    /// pin is removed, that pin taking its place.
    func movePin(_ id: String, into folder: String) async {
        guard id != folder, !isWithin(folder, id) else { return }
        var op: [String: Any] = ["kind": "moveNode", "id": id, "newParent": folder]
        op["before"] = favorites.last { $0.parent == folder && $0.id != id }?.id
        // A pin folder the move leaves holding one pin goes, that pin in its
        // place.
        await editFavorites([op] + (dissolving(id, to: folder)?.ops ?? []))
    }

    /// Makes a pin folder named `name` of the pins `target` and `dragged`, where
    /// `target` stands, holding them in that order, as one change
    /// (`SvalFavoritesStore.folderOf`, pins-root spec §5). Returns its id.
    @discardableResult
    func makePinFolder(of target: String, and dragged: String, named name: String) async -> String? {
        guard target != dragged, let row = favorites.first(where: { $0.id == target }), let parent = row.parent,
              !isWithin(target, dragged)
        else { return nil }
        let siblings = favorites.filter { $0.parent == parent }
        let at = siblings.firstIndex { $0.id == target }
        let guid = Self.mintGuid()
        let folder = favoriteId(guid: guid)
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "folder", "guid": guid, "parent": parent, "name": name,
            "after": target,
        ]
        add["before"] = at.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil }
        let ops: [[String: Any]] = [
            add,
            ["kind": "moveNode", "id": target, "newParent": folder],
            ["kind": "moveNode", "id": dragged, "newParent": folder, "before": target],
        ]
        return await editFavorites(ops) ? folder : nil
    }

    /// Moves what a pin folder holds to where it stands, in order, and deletes
    /// it (`SvalFavoritesStore.moveContentsOut`).
    func moveContentsToRow(_ folder: PinRow) async {
        await editFavorites([["kind": "removeKeepingChildren", "id": folder.id]])
    }

    /// Deletes a pin folder and what it holds, and returns what puts
    /// them back where they were, its Show in choices included.
    func deletePinFolder(_ folder: PinRow) async -> [[String: Any]]? {
        guard let item = favorites.first(where: { $0.id == folder.id }),
              var undo = await deleteFavorites([item])
        else { return nil }
        if let scope = folder.scope, !scope.isEmpty {
            undo.append(["kind": "setPinScope", "id": folder.id, "scope": scope])
        }
        return undo
    }

    /// Takes every favorite of a page out of Favorites, leaving its pins, as the
    /// star's Remove does (`SvalFavoritesStore.removeUrl`). Returns what
    /// puts them back.
    func removeFavorites(of url: URL) async -> [[String: Any]]? {
        await deleteFavorites(favorites(of: url).filter { !$0.pinned })
    }
}
