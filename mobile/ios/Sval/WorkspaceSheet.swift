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
    /// Each drawn line's frame in the tree, for the row under a drag. Kept
    /// outside the view's state: frames change on every scroll, and a
    /// scroll must not redraw the sheet.
    @State var frames = TreeFrames()
    /// Whether a row of the tree is lifted, which puts the drop target
    /// over it.
    @State var lifted = false
    /// The node being dragged: the first row asked for its item. The drag
    /// asks again for rows the finger passes, and a drop's data can't be
    /// read before it's let go.
    @State var dragging: String?
    /// The row under a drag in the tree, and what a drop there would do.
    @State var hover: DropHover?
    /// The row being renamed in the Rename Tab alert.
    @State var renamingCard: OutlineRow?
    /// The halves a card in the grid shows while a card is held over it.
    @State var gridDrop = GridDropState()
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
                            .padding(.horizontal, 16)
                            .padding(.bottom, 10)
                    }
                    if isPrivateSession {
                        privateNotice
                    } else if !panel {
                        PinsRow(onOpened: { close() })
                        theme.divider.frame(height: 1).padding(.horizontal, 16)
                    }
                    Group {
                        if layout == .grid { grid } else { tree }
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

    private var tree: some View {
        ScrollViewReader { reader in
            let rows = visibleEntries
            let blocks = blocks(for: rows)
            let gaps = gaps(for: rows, blocks: blocks)
            ZStack {
            List {
                // In the sideways panel the pins scroll away with the tree.
                if panel {
                    PinsRow(onOpened: { close() }, tileSize: 48)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                ForEach(rows, id: \.id) { entry in
                    item(entry, block: blocks[entry.id])
                        .opacity(isDragged(entry) ? 0.4 : 1)
                        .overlay { rowMark(entry, block: blocks[entry.id]).allowsHitTesting(false) }
                        // In screen space: each List row is a view of its own,
                        // where a space named outside the List can't be seen.
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            frames.rows[entry.id] = $0
                        }
                        .onDrag { startDrag(entry) } preview: { dragPreview(entry) }
                        .modifier(DragSessionPhases(began: { if !lifted { lifted = true } }, ended: endDrag))
                        .padding(.top, gaps.contains(entry.id) ? 4 : 0)
                        .listRowInsets(EdgeInsets(top: 0, leading: TreeFrames.inset, bottom: 0, trailing: TreeFrames.inset))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .id(entry.id)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 48)
            .scrollEdgeFade()
            .contentMargins(.top, 7, for: .scrollContent)
            .onAppear {
                revealFront()
                // After the opened groups' rows are drawn.
                Task { @MainActor in
                    if let id = browser.currentTabId {
                        reader.scrollTo(rows.first { $0.holds(id) }?.id ?? id, anchor: .center)
                    }
                }
            }
                // Rows are dragged as the system drags anything, from a
                // long press that moves, and the tree is one drop target
                // that reads the row under the finger as the desktop's
                // panel does. It lies over the List while a row is lifted:
                // each List row is a view of its own, which takes a drop
                // before anything around the List can.
                if lifted {
                    Color.clear
                        .contentShape(.rect)
                        .onDrop(of: [.svalNode], delegate: TreeDropDelegate(
                            update: { dragMoved(to: $0, rows: rows, blocks: blocks, reader: reader) },
                            exit: { hover = nil },
                            perform: drop))
                        // A drag let go outside the tree leaves it behind on
                        // iOS 26, which never says so; a touch clears it.
                        .onTapGesture { endDrag() }
                }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.tree = $0 }
            .sensoryFeedback(.selection, trigger: hover.map { "\($0.entry) \($0.kind)" })
        }
    }

    var isPrivateSession: Bool { workspace.map { model.isPrivate($0.id) } ?? false }

    // MARK: Actions

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
