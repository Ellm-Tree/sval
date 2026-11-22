// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The routes the Workspace sheet pushes: Settings, and a page of
/// Favorites per folder.
enum SheetPage: Hashable {
    case settings
    case favorites(folder: String)
}

/// One folder of Favorites, pushed onto the Workspace sheet: its
/// favorites, folders and separators in order. A folder opens as a page of
/// its own, so each list stays short and New Folder adds to the one open.
/// Pins are left out, since the pins row shows them (pins spec §8.2).
struct FavoritesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let folder: String
    /// Closes the sheet.
    let onDone: () -> Void

    @State private var editing: FavoriteEdit?
    @State private var renaming: Favorite?
    @State private var moving: Favorite?
    @State private var deletingFolder: Favorite?
    @State private var openingAll: Favorite?
    @Environment(Toasts.self) private var toasts

    /// How many tabs Open All opens before it asks, Firefox's default
    /// (`browser.tabs.maxOpenBeforeWarn`).
    private static let openAllWarnAt = 15

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }
    private var isRoot: Bool { folder == model.favoritesRootId }
    private var title: String { isRoot ? "Favorites" : (model.favorite(folder).map(Self.name) ?? "Favorites") }

    static func name(_ item: Favorite) -> String {
        if !item.name.isEmpty { return item.name }
        return item.url.flatMap { URL(string: $0)?.host() } ?? "Untitled"
    }

    var body: some View {
        let items = model.favoriteItems(in: folder)
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                if items.isEmpty && isRoot {
                    empty
                } else {
                    list(items)
                }
            }
        }
        .sheet(item: $editing) { edit in
            FavoriteEditor(edit: edit, onClose: { self.editing = nil })
                .tintedSheet(sheetTint)
        }
        .renameFavoriteAlert($renaming)
        .foregroundStyle(theme.text)
        .sheetGround(glass: true)
        .sheetPage(title, onDone: onDone)
        .toolbar {
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("New Folder…", systemImage: "folder.badge.plus") { editing = .newFolder(in: folder) }
            }
        }
        .sheet(item: $moving) { item in
            FavoritesMoveSheet(item: item)
                .tintedSheet(sheetTint)
                .presentationDetents([.large])
        }
        .confirmationDialog(
            deletingFolder.map { "Delete the “\(Self.name($0))” folder?" } ?? "",
            isPresented: Binding(get: { deletingFolder != nil }, set: { if !$0 { deletingFolder = nil } }),
            titleVisibility: .visible, presenting: deletingFolder
        ) { item in
            Button("Delete Folder", role: .destructive) { delete(item) }
        } message: { item in
            let count = model.favoriteCount(in: item.id)
            Text(count == 1
                 ? "The folder holds 1 favorite. Deleting the folder deletes it on every device."
                 : "The folder holds \(count) favorites. Deleting the folder deletes them on every device.")
        }
        .confirmationDialog(
            openingAll.map { "Open \(urls(in: $0).count) tabs?" } ?? "",
            isPresented: Binding(get: { openingAll != nil }, set: { if !$0 { openingAll = nil } }),
            titleVisibility: .visible, presenting: openingAll
        ) { item in
            Button("Open Tabs") { Task { await openAll(urls(in: item)) } }
        } message: { _ in
            Text("Opening this many at once may slow Sval down.")
        }
    }

    // MARK: Parts

    private func list(_ items: [Favorite]) -> some View {
        List {
            ForEach(items, id: \.id) { item in
                row(item)
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 17)
        .scrollEdgeFade()
        .contentMargins(.top, 4, for: .scrollContent)
    }

    @ViewBuilder private func row(_ item: Favorite) -> some View {
        switch item.kind {
        case "folder": folderRow(item)
        case "favorite": favoriteRow(item)
        default: separatorRow(item)
        }
    }

    private func favoriteRow(_ item: Favorite) -> some View {
        Button { open(item) } label: {
            HStack(spacing: 10) {
                SiteTile(url: item.url, name: item.name, size: 22)
                Text(Self.name(item))
                    .titleLines()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .rowHeight(48)
            .contentShape(.rect)
        }
        .foregroundStyle(theme.text)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { delete(item) } label: { Label("Delete", systemImage: "trash") }
            Button { moving = item } label: { Label("Move to…", systemImage: "folder") }
                .tint(theme.action)
        }
        .contextMenu {
            if item.url.map(AppModel.opensHere) ?? false {
                Button("Open", systemImage: "arrow.up.right.square") { open(item) }
                if !model.hasPin(for: item) {
                    Button("Pin", systemImage: "pin") { Task { await model.pinFavorite(item) } }
                }
                Divider()
            }
            Button("Rename…", systemImage: "pencil") { renaming = item }
            Button("Edit Address…", systemImage: "link") { editing = .address(item) }
            Button("Move to…", systemImage: "folder") { moving = item }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { delete(item) }
        }
    }

    private func folderRow(_ item: Favorite) -> some View {
        NavigationLink(value: SheetPage.favorites(folder: item.id)) {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(theme.body)
                    .frame(width: 22)
                Text(Self.name(item))
                    .font(.system(.body, weight: .semibold))
                    .titleLines()
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(model.favoriteCount(in: item.id))")
                    .font(.system(.subheadline))
                    .monospacedDigit()
                    .foregroundStyle(theme.muted)
            }
            .padding(.leading, 12)
            .rowHeight(48)
        }
        .contextMenu {
            Button("Open All", systemImage: "arrow.up.right.square") { askOpenAll(item) }
                .disabled(urls(in: item).isEmpty)
            Button("Pin", systemImage: "pin") { Task { await model.pinFavorite(item) } }
            Divider()
            Button("Rename…", systemImage: "pencil") { renaming = item }
            Button("Move to…", systemImage: "folder") { moving = item }
            Divider()
            let empty = model.favoriteItems(in: item.id).isEmpty
            Button(empty ? "Delete Folder" : "Delete Folder…", systemImage: "trash", role: .destructive) {
                if empty { delete(item) } else { deletingFolder = item }
            }
        }
    }

    private func separatorRow(_ item: Favorite) -> some View {
        theme.divider
            .frame(height: 1)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 17)
            .contentShape(.rect)
            .accessibilityLabel("Separator")
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) { delete(item) } label: { Label("Delete", systemImage: "trash") }
                Button { moving = item } label: { Label("Move to…", systemImage: "folder") }
                    .tint(theme.action)
            }
            .contextMenu {
                Button("Move to…", systemImage: "folder") { moving = item }
                Button("Delete", systemImage: "trash", role: .destructive) { delete(item) }
            }
    }

    private var empty: some View {
        ContentUnavailableView("No Favorites", systemImage: "star", description: Text(
            "To add the page you're on, tap Site settings in the address bar, then tap Add to Favorites. Favorites show up on your other devices too."))
    }


    // MARK: Actions

    /// Opens a favorite in a new tab at the end of this Workspace's top
    /// level, in front.
    private func open(_ item: Favorite) {
        guard let address = item.url, AppModel.opensHere(address), let url = URL(string: address),
              let workspace = browser.workspaceId else { return }
        Task { await browser.openNewTab(url, in: workspace, transition: HistoryPage.bookmark) }
        onDone()
    }

    /// The addresses Open All opens: the favorites directly in the folder
    /// that this iPhone opens (`SvalFavoritesStore.favoritesIn`).
    private func urls(in folder: Favorite) -> [URL] {
        model.favorites
            .filter { $0.parent == folder.id && $0.kind == "favorite" }
            .compactMap { $0.url.flatMap { AppModel.opensHere($0) ? URL(string: $0) : nil } }
    }

    private func askOpenAll(_ item: Favorite) {
        let urls = urls(in: item)
        if urls.count >= Self.openAllWarnAt {
            openingAll = item
        } else {
            Task { await openAll(urls) }
        }
    }

    /// Opens each as a new tab at the end of this Workspace's top level,
    /// the first in front, as the desktop's Open All does.
    private func openAll(_ urls: [URL]) async {
        guard let workspace = browser.workspaceId else { return }
        onDone()
        var first: String?
        for url in urls {
            let last = model.children(of: workspace).last?.id
            let id = await model.addTab(to: workspace, url: url, after: last)
            first = first ?? id
        }
        if let first { browser.select(first) }
    }

    /// Deletes at once, and offers Undo, which puts it all back.
    private func delete(_ item: Favorite) {
        Task {
            guard let undo = await model.deleteFavorites([item]) else { return }
            let what = item.kind == "separator" ? "Deleted the separator" : "Deleted “\(Self.name(item))”"
            toasts.show(Toast(text: what) { Task { await model.editFavorites(undo) } })
        }
    }
}

/// What the Favorites edit card is open for.
enum FavoriteEdit: Identifiable {
    case newFolder(in: String)
    case address(Favorite)

    var id: String {
        switch self {
        case .newFolder(let parent): "new-" + parent
        case .address(let item): "address-" + item.id
        }
    }
}

/// New Folder and Edit Address: one field in a sheet. Titles and buttons are the desktop's (`SvalFavoritesMenu`).
struct FavoriteEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let edit: FavoriteEdit
    let onClose: () -> Void
    /// Told the new folder's id once it is made.
    var onCreated: (String) -> Void = { _ in }

    @State private var text: String
    @State private var refused = false
    @FocusState private var focused: Bool

    init(edit: FavoriteEdit, onClose: @escaping () -> Void, onCreated: @escaping (String) -> Void = { _ in }) {
        self.edit = edit
        self.onClose = onClose
        self.onCreated = onCreated
        switch edit {
        case .newFolder: _text = State(initialValue: "")
        case .address(let item): _text = State(initialValue: item.url ?? "")
        }
    }

    private var title: String {
        switch edit {
        case .newFolder: "New Folder"
        case .address: "Edit Address"
        }
    }

    private var button: String {
        switch edit {
        case .newFolder: "Create"
        case .address: "Save"
        }
    }

    /// The line under the field: where a new folder goes, or which item
    /// this is.
    private var line: String {
        switch edit {
        case .newFolder(let parent):
            let name = parent == model.favoritesRootId ? "Favorites" : model.favorite(parent).map(FavoritesView.name) ?? "Favorites"
            return "Added at the end of \(name)"
        case .address(let item):
            return FavoritesView.name(item)
        }
    }

    private var isAddress: Bool {
        if case .address = edit { return true }
        return false
    }

    var body: some View {
        let blank = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let theme = Theme(scheme, tint: sheetTint)
        NavigationStack {
            Form {
                Section {
                    TextField(isAddress ? "Address" : "Name", text: $text, axis: isAddress ? .vertical : .horizontal)
                        .font(isAddress ? SvalFont.mono(16, relativeTo: .callout) : .body)
                        .keyboardType(isAddress ? .URL : .default)
                        .textInputAutocapitalization(isAddress ? .never : .sentences)
                        .autocorrectionDisabled(isAddress)
                        .focused($focused)
                        .selectsAllWhenEditing(text)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .onChange(of: text) { refused = false }
                } footer: {
                    Text(refused ? "That isn't an address Sval can open." : line)
                        .foregroundStyle(refused ? theme.error : theme.muted)
                }
                .listRowBackground(theme.cell)
            }
            .foregroundStyle(theme.text)
            .sheetGround()
            .navigationTitle(title)
            .sheetTitleMode(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close, action: onClose)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(button, role: .confirm, action: save).disabled(blank)
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }

    private func save() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        switch edit {
        case .newFolder(let parent):
            onClose()
            Task {
                if let folder = await model.addFavoriteFolder(named: value, in: parent) { onCreated(folder) }
            }
        case .address(let item):
            // The phone writes only web addresses into synced data
            // (decision 1372).
            guard let url = Address.typed(value) else {
                refused = true
                return
            }
            onClose()
            Task { await model.setFavoriteAddress(item, to: url) }
        }
    }
}

/// Where a Favorite, folder or separator can move: Favorites' top level
/// and its folders, indented by depth. One tree serves every Workspace, so
/// there is no Workspace to pick.
struct FavoritesMoveSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(Toasts.self) private var toasts
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let item: Favorite
    /// New Folder…'s editor, open over the sheet.
    @State private var naming: FavoriteEdit?

    private var theme: Theme { Theme(scheme, tint: sheetTint) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let root = model.favoritesRootId {
                        destination(root, text: "Top level", icon: "list.bullet", depth: 0)
                    }
                    ForEach(folders, id: \.folder.id) { entry in
                        destination(entry.folder.id, text: FavoritesView.name(entry.folder), icon: "folder", depth: entry.depth)
                    }
                    NewDestinationRow(text: "New Folder…", indent: 14, theme: theme) {
                        naming = model.favoritesRootId.map { .newFolder(in: $0) }
                    }
                } header: {
                    SectionCaption("Favorites", color: theme.muted)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(theme.cell)
            }
            .foregroundStyle(theme.text)
            .sheetGround()
            .navigationTitle("Move to…")
            .navigationSubtitle(item.kind == "separator" ? "Separator" : FavoritesView.name(item))
            .sheetTitleMode("Move to…", subtitle: item.kind == "separator" ? "Separator" : FavoritesView.name(item))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        // The folder is named first, as the desktop's New folder is, and an
        // empty name or Cancel writes nothing.
        .sheet(item: $naming) { edit in
            FavoriteEditor(edit: edit, onClose: { naming = nil }) { folder in
                Task { await move(to: folder) }
            }
            .tintedSheet(sheetTint)
        }
    }

    /// Every folder the item can go into, in tree order, without the item
    /// and what's inside it, or pinned folders, which the Favorites page
    /// doesn't show.
    private var folders: [(folder: Favorite, depth: Int)] {
        var out: [(Favorite, Int)] = []
        func walk(_ parent: String, depth: Int) {
            for child in model.favoriteItems(in: parent) where child.kind == "folder" && child.id != item.id {
                out.append((child, depth))
                walk(child.id, depth: depth + 1)
            }
        }
        if let root = model.favoritesRootId { walk(root, depth: 1) }
        return out
    }

    private func destination(_ folder: String, text: String, icon: String, depth: Int) -> some View {
        DestinationRow(text: text, icon: icon, indent: 14 + CGFloat(max(depth - 1, 0)) * 30, current: item.parent == folder,
                       theme: theme) { Task { await move(to: folder) } }
    }

    private func move(to folder: String) async {
        let id = item.id
        guard let back = await model.moveFavorite(item, to: folder) else { return }
        dismiss()
        let name = folder == model.favoritesRootId ? "Favorites" : model.favorite(folder).map(FavoritesView.name) ?? "Favorites"
        toasts.show(Toast(text: "Moved to \(name)") {
            Task { await model.moveFavorite(id, back: back) }
        })
    }


}

/// Rename on a Favorite or a folder, as a system alert with its name to
/// edit, as every rename is. An empty name changes nothing.
struct RenameFavoriteAlert: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var item: Favorite?

    func body(content: Content) -> some View {
        content.textPrompt(item?.kind == "folder" ? "Rename Folder" : "Rename Favorite", item: $item, submit: .done,
                           initial: \.name, value: PromptValue.favoriteName) {
            item, name in Task { await model.renameFavorite(item, to: name) }
        }
    }
}

extension View {
    func renameFavoriteAlert(_ item: Binding<Favorite?>) -> some View {
        modifier(RenameFavoriteAlert(item: item))
    }
}
