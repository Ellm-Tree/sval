// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

/// The Workspace in front, whole, and the way to every other: its tree of
/// groups and tabs, with the strip of Workspaces under it, opened by the
/// bar's Workspace button. It stands in for the desktop's Workspace panel
/// and its strip.
struct WorkspaceSheet: View {
    @Environment(AppModel.self) var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) var scheme
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Environment(\.dynamicTypeSize) var typeSize

    let onNewTab: () -> Void
    /// Closes the panel the sheet is drawn in while the phone is sideways,
    /// where it is no system sheet (12f3).
    var onClose: (() -> Void)?

    /// Whether the sheet is the sideways panel, which is tightened so the
    /// tree keeps room on a 393pt-tall screen (12f3).
    var panel: Bool { onClose != nil }

    func close() {
        if let onClose { onClose() } else { dismiss() }
    }

    @State var collapsed: Set<String> = Set(UserDefaults.standard.stringArray(forKey: collapsedKey) ?? [])
    /// The Workspace or group dialog, when it's open.
    @State var look: LookTarget?

    /// Opens the editor on the row as the tree holds it now. A menu keeps
    /// the row it was built with, and the header's menu is rebuilt only
    /// when its own inputs change, so its copy can predate a save.
    func editLook(of id: String) {
        if let row = model.row(id) { look = .edit(row) }
    }
    @State var moving: OutlineRow?
    @State var deletingGroup: OutlineRow?
    /// The tab or split Split With… makes a split of.
    @State var splittingWith: OutlineRow?
    /// The split whose Rename Split card is open.
    @State var renamingSplit: OutlineRow?
    @Environment(Toasts.self) var toasts
    @State var path: [SheetPage] = []
    /// Edit mode (14d1): tabs are ticked to move, group or close together.
    @State var editing = false
    @State var selected: Set<String> = []
    /// The tabs Edit's Move to… is moving.
    @State var movingMany: [OutlineRow]?
    /// The row being renamed in the Rename Tab alert.
    @State var renamingCard: OutlineRow?
    /// The halves or outline a row or card shows while one is held over it.
    @State var treeDrop = TreeDropState()
    /// How the tree is drawn: a list, or the grid of cards (15a).
    @AppStorage(TabLayout.key) var layout = TabLayout.list

    static let collapsedKey = "collapsedGroups"

    /// The sheet takes its Workspace's colour, as the bar does, and hands
    /// it to what opens from it.
    var theme: Theme { Theme(scheme, tint: model.tint(of: workspace)) }
    var browser: Browser { model.browser }
    var workspace: OutlineRow? { browser.workspaceId.flatMap(model.row) }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack(alignment: .bottom) {
                VStack(spacing: 0) {
                    // A bar holds what is in it to a few sizes past the
                    // standard one, so at the accessibility sizes the
                    // Workspace's name heads the sheet's content.
                    if typeSize.isAccessibilitySize, !editing {
                        title(inBar: false)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Space.sheetSide)
                            .padding(.bottom, 10)
                    }
                    if isPrivateSession {
                        privateNotice
                    } else if !panel {
                        PinsRow(onOpened: { close() })
                        theme.divider.frame(height: 1).padding(.horizontal, Space.sheetSide)
                    }
                    Group {
                        if layout == .grid { grid } else { list }
                    }
                    .id("\(workspace?.id ?? "")-\(layout.rawValue)")
                    .transition(.opacity)
                    if !editing {
                        if isPrivateSession {
                            if !panel { backToReading }
                        } else {
                            WorkspaceStrip(onNew: { look = .newWorkspace }, onPrivate: askPrivate, compact: panel)
                        }
                    }
                }
                .animation(reduceMotion ? nil : Motion.disclose, value: workspace?.id)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: layout)
            }
            .renameSplitAlert($renamingSplit)
            .textPrompt("Rename Tab", item: $renamingCard, initial: { name($0) }, value: PromptValue.tabName) { row, name in
                Task { await model.rename(row, to: name) }
            }
            .sheet(item: $look) { target in
                LookEditor(target: target, onClose: { self.look = nil }) { id in
                    switch target {
                    case .newWorkspace:
                        browser.showWorkspace(id)
                        close()
                    case .newGroup:
                        endEditing()
                    case .edit, .mergeGroup:
                        break
                    }
                }
            }
            .foregroundStyle(theme.text)
            // The sheet is glass (14b1). Its Workspace's colour lies over
            // it, thin enough for the glass to show, so the bar and its
            // sheet read as one thing.
            .background(theme.sheet.opacity(Theme.glassSheet).ignoresSafeArea())
            .animation(Motion.disclose, value: editing)
            // A tick holds only a tab Edit can reach. A tab closed, moved
            // out of the Workspace or into a closed group, or whose group
            // closes, leaves the ticks and the count.
            .onChange(of: editing ? Self.tickable(model.tree, workspace: workspace?.id, collapsed: collapsed) : []) {
                _, shown in selected.formIntersection(shown)
            }
            .toolbar(.visible, for: .navigationBar)
            .toolbar { topBar }
            .toolbar { bottomBar }
            .navigationTitle(editing ? (selected.isEmpty ? "Select Tabs" : "\(selected.count) Selected") : "")
            .navigationBarTitleDisplayMode(editing && typeSize.isAccessibilitySize ? .large : .inline)
            .sheetTint(model.tint(of: workspace))
            .navigationDestination(for: SheetPage.self) { page in
                switch page {
                case .settings:
                    SettingsView(onDone: { close() })
                case .favorites(let folder):
                    FavoritesView(
                        folder: folder, onDone: { close() })
                }
            }
        }
        // The grid draws from the same groups as the list.
        .onAppear { revealFront() }
        .sheet(item: $moving) { row in
            MoveSheet(row: row)
                .tintedSheet(model.tint(of: workspace))
                .presentationDetents([.large])
        }
        .sheet(item: $splittingWith) { row in
            SplitWithSheet(target: row)
                .tintedSheet(model.tint(of: workspace))
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: Binding(presenting: $movingMany)) {
            if let rows = movingMany {
                MoveSheet(rows: rows) { endEditing() }
                .tintedSheet(model.tint(of: workspace))
                .presentationDetents([.large])
            }
        }
        .confirmationDialog(
            deletingGroup.map { "Delete “\(name($0))”?" } ?? "",
            isPresented: Binding(presenting: $deletingGroup),
            titleVisibility: .visible, presenting: deletingGroup
        ) { group in
            let inside = model.tree.inside(group.id)
            let text = Self.deleteGroupText(tabs: inside.tabs, groups: inside.groups)
            Button(text.keep) { Task { await model.deleteGroup(group, keepingContents: true) } }
            Button(text.delete, role: .destructive) { Task { await model.deleteGroup(group, keepingContents: false) } }
        } message: { group in
            let inside = model.tree.inside(group.id)
            Text(Self.deleteGroupText(tabs: inside.tabs, groups: inside.groups).message)
        }
    }

    var isPrivateSession: Bool { workspace.map { model.isPrivate($0.id) } ?? false }

    // MARK: Actions

    func name(_ row: OutlineRow) -> String {
        row.displayTitle
    }

    /// Pins a tab: its page becomes the pin's, and it leaves the tree
    /// (pins spec §8.1).
    func pin(_ row: OutlineRow, url: URL) {
        Task { await browser.pin(row, url: url) }
    }

    func unfavorite(_ url: URL) {
        Task {
            guard let undo = await model.removeFavorites(of: url) else { return }
            toasts.show(Toast(text: "Removed from Favorites") { Task { await model.editFavorites(undo) } })
        }
    }

    /// Closes every pane at once, as one write, and offers Undo, which
    /// brings the split back with its pages. A private split's close has no
    /// Undo, as a private tab's has none.
    func closeSplit(_ split: OutlineRow, panes: [OutlineRow]) {
        if model.isPrivate(split.id) {
            Task {
                _ = await browser.closeSplit(split)
                if model.row(split.id) == nil { toasts.show(.closed(panes.count)) }
            }
            return
        }
        Task {
            guard let undo = await browser.closeSplit(split) else { return }
            toasts.show(.closed(panes.count) { Task { await browser.reopenSplit(undo) } })
        }
    }

    func close(_ row: OutlineRow) {
        // A private tab's close has no Undo: undoing it would mean keeping
        // the tab (13d).
        if model.isPrivate(row.id) {
            Task {
                await browser.close(row)
                if model.row(row.id) == nil { toasts.show(.closed(1)) }
            }
            return
        }
        Task {
            guard let entry = await browser.close(row), Browser.openable(row) != nil else { return }
            toasts.show(.closed(1, title: name(row)) { Task { await browser.reopen(entry) } })
        }
    }
}
