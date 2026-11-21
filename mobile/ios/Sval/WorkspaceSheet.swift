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
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
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
    @State var renaming: String?
    @State private var renameText = ""
    /// Names saved but not yet back from the tree, shown meanwhile so the
    /// row never flashes its old name.
    @State private var pendingNames: [String: String] = [:]
    /// The Workspace or group dialog, when it's open.
    @State var look: LookTarget?

    /// Opens the editor on the row as the tree holds it now. A menu keeps
    /// the row it was built with, and the header's menu is rebuilt only
    /// when its own inputs change, so its copy can predate a save.
    func editLook(of id: String) {
        if let row = model.row(id) { look = .edit(row) }
    }
    /// The name the rename field opened with.
    @State private var renameOriginal = ""
    @FocusState private var renameFocused: Bool
    @State var moving: OutlineRow?
    @State var deletingGroup: OutlineRow?
    /// The tab or split Split With… makes a split of.
    @State var splittingWith: OutlineRow?
    /// The split whose Rename Split card is open.
    @State var renamingSplit: OutlineRow?
    @State var toast: Toast?
    @State private var path: [SheetPage] = []
    /// Edit mode (14d1): tabs are ticked to move, group or close together.
    @State var editing = false
    @State var selected: Set<String> = []
    /// The tabs Edit's Move to… is moving.
    @State private var movingMany: [OutlineRow]?
    /// Each drawn line's frame in the tree, for the row under a drag. Kept
    /// outside the view's state: frames change on every scroll, and a
    /// scroll must not redraw the sheet.
    @State private var frames = TreeFrames()
    /// Whether a row of the tree is lifted, which puts the drop target
    /// over it.
    @State var lifted = false
    /// The node being dragged: the first row asked for its item. The drag
    /// asks again for rows the finger passes, and a drop's data can't be
    /// read before it's let go.
    @State var dragging: String?
    /// The row under a drag in the tree, and what a drop there would do.
    @State private var hover: DropHover?
    /// The card whose tab is being renamed in the grid, and its name.
    @State var renamingCard: OutlineRow?
    @State var cardName = ""
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
                        PinsRow(onOpened: { close() }, onToast: { toast = $0 })
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
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: workspace?.id)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: layout)
            }
            .renameSplitAlert($renamingSplit)
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
            .animation(.easeOut(duration: 0.15), value: editing)
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
            MoveSheet(row: row) { toast in self.toast = toast }
                .tintedSheet(model.tint(of: workspace))
                .presentationDetents([.large])
        }
        .sheet(item: $splittingWith) { row in
            SplitWithSheet(target: row)
                .tintedSheet(model.tint(of: workspace))
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: Binding(get: { movingMany != nil }, set: { if !$0 { movingMany = nil } })) {
            if let rows = movingMany {
                MoveSheet(rows: rows) { toast in
                    self.toast = toast
                    endEditing()
                }
                .tintedSheet(model.tint(of: workspace))
                .presentationDetents([.large])
            }
        }
        .confirmationDialog(
            deletingGroup.map { "Delete “\(name($0))”?" } ?? "",
            isPresented: Binding(get: { deletingGroup != nil }, set: { if !$0 { deletingGroup = nil } }),
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
                    PinsRow(onOpened: { close() }, onToast: { toast = $0 }, tileSize: 48)
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
                logDrawn(rows)
                // After the opened groups' rows are drawn.
                Task { @MainActor in
                    if let id = browser.currentTabId {
                        reader.scrollTo(rows.first { $0.holds(id) }?.id ?? id, anchor: .center)
                    }
                }
            }
            .onChange(of: rows.map(\.id)) { logDrawn(rows) }
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
        .toast($toast, top: true)
    }

    // MARK: Header and footer

    /// The Workspace's name, which opens its editor: name, emoji, colour
    /// and Delete. An agent's and the private session's aren't the user's
    /// to change.
    private func title(inBar: Bool) -> some View {
        Button {
            if let workspace, workspace.agent == nil, !isPrivateSession { look = .edit(workspace) }
        } label: {
            HStack(spacing: 10) {
                WorkspaceTile(workspace: workspace, size: inBar ? 34 : 56, fill: theme.cell)
                VStack(alignment: .leading, spacing: 0) {
                    Text(workspace.map(WorkspaceTile.name) ?? "")
                        .font(SvalFont.outfit(17, .bold, relativeTo: .headline))
                        .lineLimit(inBar ? 1 : 2)
                    Text(summary)
                        .font(.system(.caption))
                        .foregroundStyle(theme.muted)
                        .lineLimit(inBar ? 1 : 2)
                }
                .multilineTextAlignment(.leading)
            }
            .contentShape(.rect)
            // A leading bar item gets only the room it asks for.
            .fixedSize(horizontal: inBar, vertical: inBar)
        }
        .buttonStyle(.plain)
    }

    /// The sheet's top bar, the system's navigation bar: the Workspace and
    /// its ••• (15a1), or in Edit (14d1) Select All, how many are ticked,
    /// and Done.
    @ToolbarContentBuilder private var topBar: some ToolbarContent {
        if !editing {
            if !typeSize.isAccessibilitySize {
                ToolbarItem(placement: .topBarLeading) { title(inBar: true) }
                    .sharedBackgroundVisibility(.hidden)
            }
            if let workspace {
                // How the tabs are drawn, then the Workspace's own changes.
                // An agent's Workspace is the agent's to arrange.
                ToolbarItem(placement: .topBarTrailing) {
                    HeaderMenu(layout: $layout, workspaceId: workspace.id, editable: workspace.agent == nil,
                               groups: model.makesGroups(in: workspace.id),
                               editsWorkspace: !isPrivateSession,
                               onEditTabs: { editing = true },
                               onEditWorkspace: { editLook(of: workspace.id) },
                               onNewGroup: { look = .newGroup(parent: workspace.id) })
                        .equatable()
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .close, action: close)
            }
        } else {
            let tabs = editableTabs
            let all = !tabs.isEmpty && tabs.allSatisfy { selected.contains($0.id) }
            ToolbarItem(placement: .topBarLeading) {
                Button(all ? "Deselect All" : "Select All") {
                    selected = all ? [] : Set(tabs.map(\.id))
                }
                .disabled(tabs.isEmpty)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done", role: .confirm, action: endEditing)
            }
        }
    }

    /// The tabs Edit can tick: every tab in this Workspace but a split's
    /// panes, which move with their split.
    private var editableTabs: [OutlineRow] {
        visibleEntries.compactMap { $0.panes == nil && $0.row.kind == "tab" ? $0.row : nil }
    }

    private func endEditing() {
        editing = false
        selected = []
    }

    /// The sheet's bottom bar (14b1, 14d1): the system's toolbar, so its
    /// buttons are the size of every other bar's.
    @ToolbarContentBuilder private var bottomBar: some ToolbarContent {
        if editing {
            let rows = model.rows.filter { selected.contains($0.id) }
            // New Group… makes a group of the ticked tabs, in a Workspace
            // that holds groups.
            if model.makesGroups(in: workspace?.id) {
                ToolbarItem(placement: .bottomBar) {
                    Button("New Group…", systemImage: "folder.badge.plus", action: group)
                }
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("Move Selected…", systemImage: "folder") { movingMany = rows }
                    .disabled(rows.isEmpty)
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Close Selected", systemImage: "xmark", role: .destructive) { closeAll(rows) }
                    .disabled(rows.isEmpty)
            }
        } else if isPrivateSession {
            if panel {
                ToolbarItem(placement: .bottomBar) {
                    Button {
                        if let id = lastWorkspace?.id { browser.showWorkspace(id) }
                        close()
                    } label: {
                        HStack(spacing: 6) {
                            WorkspaceTile(workspace: lastWorkspace, size: 24)
                            Text(lastWorkspace.map(WorkspaceTile.name) ?? "").lineLimit(1)
                        }
                    }
                    .accessibilityLabel("Back to \(lastWorkspace.map(WorkspaceTile.name) ?? "your Workspaces")")
                }
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Exit", role: .destructive, action: exitPrivate)
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) { newTabButton(tint: Theme.privateViolet) }
        } else {
            ToolbarItem(placement: .bottomBar) {
                Button("Settings", systemImage: "gearshape") { path.append(.settings) }
                    .overlay(alignment: .topTrailing) { SyncProblemBadge(ring: theme.sheet) }
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Favorites", systemImage: "star") {
                    if let root = model.favoritesRootId { path.append(.favorites(folder: root)) }
                }
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) { newTabButton(tint: Theme.blue) }
        }
    }

    /// Edit's Group: a new group holding the ticked rows, made with them
    /// in one write.
    private func group() {
        guard let id = workspace?.id else { return }
        look = .newGroup(parent: id, members: model.rows.filter { selected.contains($0.id) }.map(\.id))
    }

    /// Close: the ticked tabs, at once, with one Undo.
    private func closeAll(_ rows: [OutlineRow]) {
        endEditing()
        Task {
            var entries: [Browser.ClosedTab] = []
            for row in rows where row.kind == "tab" {
                if let entry = await browser.close(row), Browser.openable(row) != nil { entries.append(entry) }
            }
            guard !model.isPrivate(rows.first?.id ?? "") else {
                toast = .closed(rows.count)
                return
            }
            toast = .closed(rows.count) {
                Task { for entry in entries.reversed() { await browser.reopen(entry) } }
            }
        }
    }


    private var summary: String {
        let inside = model.rows.filter { $0.id != workspace?.id && model.workspace(of: $0.id) == workspace?.id }
        let tabs = inside.filter { $0.kind == "tab" }.count
        let groups = inside.filter { $0.kind == "group" }.count
        let tabText = tabs == 1 ? "1 tab" : "\(tabs) tabs"
        guard groups > 0 else { return tabText }
        return "\(tabText) and \(groups == 1 ? "1 group" : "\(groups) groups")"
    }

    // MARK: The private session

    var isPrivateSession: Bool { workspace.map { model.isPrivate($0.id) } ?? false }

    /// The Private tile and the private menus' asks.
    private func askPrivate(_ ask: PrivateAsk) {
        switch ask {
        case .open:
            Task {
                await model.showPrivateSession()
                close()
            }
        case .newTab:
            Task { if await model.showPrivateSession() { onNewTab() } }
        case .close:
            exitPrivate()
        }
    }

    /// Exit: the private session ends at once, with nothing to undo, since
    /// undoing would mean keeping what it held.
    private func exitPrivate() {
        Task {
            await model.endPrivateSession()
            TopNotice.show(.privateClosed, token: model.tint(of: model.browser.workspaceId.flatMap(model.row)), scheme: scheme)
        }
    }

    /// The notice the private session always shows, which can't be
    /// dismissed (13c, the desktop's private window notice).
    private var privateNotice: some View {
        HStack(alignment: .top, spacing: 10) {
            Image("private").resizable().scaledToFit().frame(width: 18, height: 18)
            Text("Nothing in this private Workspace is saved or synced.")
                .font(.system(panel ? .footnote : .subheadline))
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, panel ? 12 : 14)
        .padding(.vertical, panel ? 8 : 10)
        .background(Theme.privateViolet, in: .rect(cornerRadius: 12))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }

    /// The Workspace the user was last in, which Back to Reading returns
    /// to while the session stays open.
    private var lastWorkspace: OutlineRow? {
        let saved = browser.savedWorkspace.flatMap(model.row)
        return saved.flatMap { model.isPrivate($0.id) ? nil : $0 } ?? model.workspaces.first
    }

    private var backToReading: some View {
        Button {
            if let id = lastWorkspace?.id { browser.showWorkspace(id) }
            close()
        } label: {
            HStack(spacing: 12) {
                WorkspaceTile(workspace: lastWorkspace, size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Back to \(lastWorkspace.map(WorkspaceTile.name) ?? "your Workspaces")")
                        .font(.system(.body, weight: .semibold))
                    Text("Your private tabs stay open")
                        .font(.system(.caption))
                        .foregroundStyle(theme.muted)
                }
                .lineLimit(1)
                Spacer(minLength: 4)
                Chevron(color: theme.muted)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 56)
            .background(theme.well, in: .rect(cornerRadius: 16))
            .contentShape(.rect)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .overlay(alignment: .top) { theme.divider.frame(height: 1) }
    }

    /// New Tab: the sheet's one main action, a prominent pill that opens
    /// the Launcher for a new tab here. A long press offers a new tab of
    /// either kind (13a2, 14k1).
    private func newTabButton(tint: Color) -> some View {
        Button("New Tab", systemImage: "plus") {
            close()
            onNewTab()
        }
        .buttonStyle(.glassProminent)
        .tint(tint)
        .contextMenu {
            Button("New Tab", systemImage: "plus") {
                close()
                onNewTab()
            }
            if !isPrivateSession {
                NewPrivateTabButton { askPrivate(.newTab) }
            }
        }
    }

    // MARK: The tree

    // MARK: Dragging

    func startDrag(_ entry: TreeEntry) -> NSItemProvider {
        let id = entry.row.id
        if !lifted {
            dragging = id
            // The system also asks for a row's item after a drop, with no
            // drag under way. Lifted there, the tree's drop target would
            // cover the rows and take the next long press. Where the
            // system reports the drag's session, the session lifts it.
            if #unavailable(iOS 27.0) { lifted = true }
        }
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: UTType.svalNode.identifier, visibility: .ownProcess) { done in
            done(Data(id.utf8), nil)
            return nil
        }
        return provider
    }

    /// What follows the finger: the row's tile and name, small enough to
    /// leave the marks on the row under it in view.
    private func dragPreview(_ entry: TreeEntry) -> some View {
        HStack(spacing: 8) {
            if entry.panes != nil {
                Image(systemName: "rectangle.split.2x1").font(.system(size: 15))
            } else if entry.row.kind == "group" {
                groupMark(entry.row, open: false)
            } else {
                SiteTile(row: entry.row, size: 22)
            }
            Text(entry.panes == nil ? name(entry.row) : (entry.row.name.isEmpty ? "Split" : entry.row.name))
                .font(.system(.body, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(theme.text)
        .padding(.horizontal, 12)
        .frame(maxWidth: 200, minHeight: 40)
        .background(theme.cell, in: .capsule)
        .contentShape(.dragPreview, .capsule)
    }

    /// Whether the line is the dragged row or inside it, dimmed while the
    /// drag is over the tree.
    private func isDragged(_ entry: TreeEntry) -> Bool {
        guard hover != nil, let dragging else { return false }
        return model.isInside(entry.row.id, dragging)
    }

    /// Reads the row under the finger, as the desktop's panel does
    /// (`dropIntent`). Returns whether a drop there writes anything.
    private func dragMoved(to point: CGPoint, rows: [TreeEntry], blocks: [String: RowBlock],
                           reader: ScrollViewProxy) -> Bool {
        guard let id = dragging, let workspace = workspace?.id else { return false }
        autoScroll(point.y, rows: rows, reader: reader)
        let point = CGPoint(x: point.x + frames.tree.minX, y: point.y + frames.tree.minY)
        let drawn = rows.compactMap { entry in frames.shown(entry.id).map { (entry, $0) } }
        var next: DropHover?
        if let (entry, frame) = drawn.first(where: { $0.1.minY <= point.y && point.y < $0.1.maxY }) {
            let over = DropOver(id: entry.row.id, kind: entry.panes == nil ? entry.row.kind : "split",
                                expanded: entry.row.kind == "group" && !collapsed.contains(entry.row.id))
            // The halves split the row's own target, as they are drawn.
            let (leading, trailing) = targetInsets(entry, block: blocks[entry.id])
            let width = frame.width - leading - trailing
            let kind = model.dropIntent(id, over: over, x: point.x - frame.minX - leading, y: point.y - frame.minY,
                                        w: width, h: frame.height)
            next = DropHover(entry: entry.id, over: over, kind: kind, frame: frame, depth: entry.depth,
                             writes: model.dropPlan(id, over: over, kind) != nil)
            if kind == .newGroup || kind == .split || kind == .join || kind == .merge || kind == .refused(full: true) {
                let split = model.dropIntent(id, over: over, x: width - 1, y: frame.height / 2,
                                             w: width, h: frame.height)
                next?.halves = DropHalves(groups: model.makesGroups(in: workspace),
                                          group: model.dropPlan(id, over: over, .newGroup) != nil, split: split,
                                          splits: model.dropPlan(id, over: over, split) != nil)
            }
        } else if let last = drawn.last, last.0.id == rows.last?.id, point.y >= last.1.maxY {
            let over = DropOver(id: workspace, kind: "workspace", expanded: true)
            next = DropHover(entry: last.0.id, over: over, kind: .end, frame: last.1, depth: 1,
                             writes: model.dropPlan(id, over: over, .end) != nil)
        } else {
            // Between two lines, the last row read still holds.
            return hover?.writes ?? false
        }
        if next != hover { hover = next }
        return next?.writes ?? false
    }

    /// Scrolls the tree a line at a time while a drag rests near its top
    /// or bottom edge, so a long Workspace can be crossed in one drag.
    private func autoScroll(_ y: CGFloat, rows: [TreeEntry], reader: ScrollViewProxy) {
        let edge: CGFloat = 32
        let now = Date.now
        guard now.timeIntervalSince(frames.scrolled) > 0.15 else { return }
        let shown = rows.indices.filter { frames.shown(rows[$0].id) != nil }
        var target: (String, UnitPoint)?
        if y < edge, let first = shown.first, first > 0 {
            target = (rows[first - 1].id, .top)
        } else if y > frames.tree.height - edge, let last = shown.last, last + 1 < rows.count {
            target = (rows[last + 1].id, .bottom)
        }
        guard let target else { return }
        frames.scrolled = now
        withAnimation(.linear(duration: 0.15)) { reader.scrollTo(target.0, anchor: target.1) }
    }

    func endDrag() {
        lifted = false
        dragging = nil
        hover = nil
    }

    private func drop() -> Bool {
        defer { endDrag() }
        guard let id = dragging, let hover, let plan = model.dropPlan(id, over: hover.over, hover.kind) else { return false }
        Diagnostics.log("sheet: dropped, \(hover.kind)")
        switch plan {
        case .ops(let ops):
            Task { await model.editTree(ops) }
        case .merge(let merge):
            look = .mergeGroup(merge)
        }
        return true
    }

    /// A row's drop mark, as the desktop panel draws them
    /// (`_paintDragState`): a line where the dragged row would land, an
    /// outline on a closed group it would go into, and on a tab's middle
    /// its two halves. Two rows waiting on a new group's name keep dashed
    /// outlines. Each is drawn in its own row, so it takes the row's size
    /// as drawn: an overlay on the tree, placed from the rows' frames,
    /// drew narrower than the rows.
    /// How far inside its line a row's own target lies, past its group's
    /// margin and inside its card, where its card or content is drawn.
    private func targetInsets(_ entry: TreeEntry, block: RowBlock?) -> (CGFloat, CGFloat) {
        let leading = entry.panes != nil
            ? block.map { $0.layers.last!.inset + 24 } ?? 0
            : CGFloat(max(entry.depth - 1, 0)) * 24
        return (leading, CGFloat(block?.layers.count ?? 0) * 6)
    }

    @ViewBuilder private func rowMark(_ entry: TreeEntry, block: RowBlock?) -> some View {
        let color = theme.accent
        let (leading, trailing) = targetInsets(entry, block: block)
        if case .mergeGroup(let plan) = look, [plan.id, plan.target].contains(entry.row.id) {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(color, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
                .padding(.leading, leading)
                .padding(.trailing, trailing)
        }
        if let hover, hover.entry == entry.id, hover.writes || hover.halves.map({ $0.group || $0.splits }) == true {
            switch hover.kind {
            case .before, .after, .firstChild, .end:
                let lead = 12 + CGFloat(max(hover.depth - 1, 0) + (hover.kind == .firstChild ? 1 : 0)) * 24
                DropLine(color: color, background: theme.sheet)
                    .padding(.leading, lead - 4)
                    .padding(.trailing, 8)
                    .frame(maxHeight: .infinity, alignment: hover.kind == .before ? .top : .bottom)
            case .into:
                RoundedRectangle(cornerRadius: 12)
                    .fill(color.opacity(0.3))
                    .strokeBorder(color, lineWidth: 1.5)
                    .padding(.leading, leading)
                    .padding(.trailing, trailing)
            default:
                if let halves = hover.halves {
                    DropHalvesMark(halves: halves, onSplit: hover.kind != .newGroup, color: color,
                                   muted: theme.muted, cover: theme.sheet)
                        .padding(.leading, leading)
                        .padding(.trailing, trailing)
                }
            }
        }
    }

    /// What the tree draws, against the tab in front, for the device log.
    private func logDrawn(_ rows: [TreeEntry]) {
        let front = browser.currentTabId
        let kind = front.map { Browser.pinParts($0) != nil ? "a pin" : (model.row($0) == nil ? "no row" : "a tab") } ?? "nothing"
        let drawn = front.map { id in rows.contains { $0.holds(id) } } ?? false
        Diagnostics.log("sheet: \(rows.count) rows drawn; in front \(kind), \(drawn ? "drawn" : "not drawn")")
    }

    /// One line of the tree: a row, or a split's run of panes.
    struct TreeEntry {
        let id: String
        let row: OutlineRow
        /// A split's panes this line draws; nil for any other row.
        let panes: [OutlineRow]?
        let depth: Int

        /// Whether tab `id` is drawn on this line.
        func holds(_ id: String) -> Bool { self.id == id || panes?.contains { $0.id == id } == true }
    }

    /// The Workspace's rows in tree order, without those inside a closed
    /// group. A split is one line, or one per run of up to four; a split
    /// holding one tab draws as that tab, and one holding none draws
    /// nothing (split-view spec §5.1).
    private var visibleEntries: [TreeEntry] {
        guard let id = workspace?.id else { return [] }
        let all = model.rows.filter { $0.id != id && model.workspace(of: $0.id) == id }
        var hidden = Set<String>()
        var out: [TreeEntry] = []
        for row in all {
            if let parent = row.parentId, hidden.contains(parent) || collapsed.contains(parent) {
                hidden.insert(row.id)
                continue
            }
            guard row.kind == "split" else {
                out.append(TreeEntry(id: row.id, row: row, panes: nil, depth: Int(row.depth)))
                continue
            }
            hidden.insert(row.id)
            let panes = all.filter { $0.parentId == row.id && $0.kind == "tab" }
            for (index, run) in splitRuns(panes).enumerated() {
                if run.count == 1 {
                    out.append(TreeEntry(id: run[0].id, row: run[0], panes: nil, depth: Int(row.depth)))
                } else {
                    out.append(TreeEntry(id: index == 0 ? row.id : "\(row.id)#\(index)", row: row, panes: run,
                                         depth: Int(row.depth)))
                }
            }
        }
        return out
    }

    /// A tab's site, as the bar shows the page in front's.
    /// A tab row's spoken label: its title, its site, and whether it plays
    /// or can't open here.
    private func rowLabel(_ row: OutlineRow, elsewhere: Bool, playing: Bool) -> String {
        [name(row), site(of: row), playing ? "playing" : nil, elsewhere ? "can't open on \(UIDevice.current.model)" : nil]
            .compactMap { $0 }.joined(separator: ", ")
    }

    func site(of row: OutlineRow) -> String? {
        guard let host = row.url.flatMap(URL.init(string:))?.host() else { return nil }
        return SiteRules.site(of: host) ?? host
    }

    func name(_ row: OutlineRow) -> String {
        if let pending = pendingNames[row.id] { return pending }
        return row.displayTitle
    }

    @ViewBuilder private func item(_ entry: TreeEntry, block: RowBlock?) -> some View {
        let indent = CGFloat(max(entry.depth - 1, 0)) * 24
        if let panes = entry.panes {
            splitRow(entry.row, panes: panes, indent: indent, block: block)
        } else if entry.row.kind == "tab" {
            tabRow(entry.row, indent: indent, block: block)
        } else {
            groupRow(entry.row, indent: indent, block: block)
        }
    }

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

    private func blocks(for entries: [TreeEntry]) -> [String: RowBlock] {
        var out: [String: RowBlock] = [:]
        let rows = entries.map(\.row)
        for (index, entry) in entries.enumerated() {
            let row = entry.row
            var chain: [OutlineRow] = []
            var node: OutlineRow? = row.kind == "tab" ? row.parentId.flatMap(model.row) : row
            while let group = node, group.kind != "workspace" {
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
    private func gaps(for rows: [TreeEntry], blocks: [String: RowBlock]) -> Set<String> {
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

    /// The block behind a row: only a group's outer corners round, and the
    /// tab in front lifts its block further, as the desktop's selected row.
    @ViewBuilder private func blockBackground(_ block: RowBlock?, front: Bool) -> some View {
        let dark = theme.dark
        if let block {
            ZStack {
                ForEach(Array(block.layers.enumerated()), id: \.offset) { index, layer in
                    shape(layer)
                        .fill(GroupBlock.color(layer.tint, dark: dark, surface: theme.sheetLightness, blockDir: theme.blockDir,
                                               selected: front && index == block.layers.count - 1))
                        .padding(.leading, layer.inset)
                        .padding(.trailing, CGFloat(index) * 6)
                        // A nested card stands clear of what's above and
                        // below it inside its parent.
                        .padding(.top, index > 0 && layer.top ? Self.cardGap : 0)
                        .padding(.bottom, index > 0 && layer.bottom ? Self.cardGap : 0)
                }
            }
        } else if front {
            RoundedRectangle(cornerRadius: 12).fill(theme.accentWash)
        }
    }

    /// The room a nested card keeps above and below it.
    static let cardGap: CGFloat = 3

    /// A row in front inside a coloured group lifts as a card of its own
    /// within the group's block, as a split does, never to the block's
    /// edges. Outside any group it takes the accent wash.
    @ViewBuilder private func frontCard(_ block: RowBlock?, front: Bool, depth: Int? = nil) -> some View {
        ZStack {
            blockBackground(block, front: false)
            if front {
                if let block, let last = block.layers.last {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(GroupBlock.color(last.tint, dark: theme.dark, surface: theme.sheetLightness,
                                               blockDir: theme.blockDir, selected: true))
                        .padding(.leading, last.inset + 24)
                        .padding(.trailing, CGFloat(block.layers.count) * 6)
                        .padding(.vertical, Self.cardGap)
                } else {
                    RoundedRectangle(cornerRadius: 12).fill(theme.accentWash)
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
            topLeadingRadius: layer.top ? 12 : 0, bottomLeadingRadius: layer.bottom ? 12 : 0,
            bottomTrailingRadius: layer.bottom ? 12 : 0, topTrailingRadius: layer.top ? 12 : 0)
    }

    private func tabRow(_ row: OutlineRow, indent: CGFloat, block: RowBlock?) -> some View {
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
            if renaming == row.id {
                renameField(row)
            } else {
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
            }
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
        // A tap gesture, since a Button's label can't hold the rename
        // field or the row's own buttons.
        .onTapGesture {
            guard renaming == nil else { return }
            if editing {
                if ticked { selected.remove(row.id) } else { selected.insert(row.id) }
                return
            }
            // A tab the phone can't open never takes the screen: it stays
            // in the tree, where it can be closed (decision 1372).
            if elsewhere {
                toast = Toast(text: "Sval on \(UIDevice.current.model) can't open this tab", undo: { close(row) }, action: "Close Tab")
                return
            }
            browser.select(row.id)
            close()
        }
        // One element, as a grid card is: the title, the site, then any
        // state, with × and the speaker as actions. A row being renamed
        // keeps its field.
        .accessibilityElement(children: renaming == row.id ? .contain : .ignore)
        .accessibilityLabel(renaming == row.id ? "" : rowLabel(row, elsewhere: elsewhere, playing: playing))
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
        .contextMenu { MenuItems(sections: tabMenu(row, rename: { startRename(row) })) }
    }

    /// A tab's long-press menu, in the list and the grid. `rename` starts
    /// the rename the view draws.
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
        if row.kind != "group" {
            items.append(MenuItem(title: "Split With…", symbol: "rectangle.split.2x1", disabled: !model.offersSplit(for: row)) {
                splittingWith = row
            })
        }
        return items
    }

    /// A split's line: its tray of panes. A tap on a pane opens the split
    /// there and closes the sheet (12a).
    private func splitRow(_ split: OutlineRow, panes: [OutlineRow], indent: CGFloat, block: RowBlock?) -> some View {
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
            MenuItems(sections: paneMenu(pane, split: split, panes: panes, rename: { startRename(pane) }))
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
        if let url = Browser.openable(pane) { tab.append(favoriteItem(url, title: pane.title)) }
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

    private func groupRow(_ row: OutlineRow, indent: CGFloat, block: RowBlock?) -> some View {
        let open = !collapsed.contains(row.id)
        let count = tabCount(in: row.id)
        let rowInk = ink(block)
        return HStack(spacing: 10) {
            Chevron(open: open, color: rowInk.muted)
                .frame(width: 14)
            groupMark(row, open: open)
            if renaming == row.id {
                renameField(row)
            } else {
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
        }
        .padding(.leading, 12 + indent)
        .padding(.trailing, cardInset(block))
        .rowHeight(RowMetrics.group)
        .background { blockBackground(block, front: false) }
        .contentShape(.rect)
        // A tap gesture, since a Button's label can't hold the rename field.
        .onTapGesture {
            guard renaming == nil else { return }
            toggle(row)
        }
        .accessibilityElement(children: renaming == row.id ? .contain : .combine)
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
        while let at = parent, at.kind != "workspace" {
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
            toast = Toast(text: "Deleted the “\(name(row))” group") {
                guard let place else { return }
                Task { await model.reopenGroup(row, at: place) }
            }
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
        let edit = row.kind == "group"
            ? MenuItem(title: "Edit Group…", symbol: "pencil") { editLook(of: row.id) }
            : MenuItem(title: "Rename…", symbol: "pencil") { startRename(row) }
        return [[edit, MenuItem(title: "Move to…", symbol: "folder") { moving = row }],
                orderItems(row),
                row.kind == "group"
                    ? [MenuItem(title: "Delete Group…", symbol: "trash", destructive: true) { deleteGroup(row) }] : []]
    }

    /// A group's emoji, or its folder in its colour's ink: the block
    /// carries the colour, and the name stays in the text colour, which
    /// reads on every block (`sval-panel.css`, `data-sval-fill="own"`).
    @ViewBuilder private func groupMark(_ row: OutlineRow, open: Bool) -> some View {
        let tint = row.color.flatMap(WorkspaceTint.init(rawValue:))
        if let emoji = row.emoji, !emoji.isEmpty {
            Text(emoji).font(.system(size: 20)).accessibilityIgnoresInvertColors().frame(width: 28)
        } else {
            Image(systemName: row.kind == "split" ? "rectangle.split.2x1" : (open ? "folder" : "folder.fill"))
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(tint?.swatch(dark: theme.dark) ?? theme.body)
                .frame(width: 28)
        }
    }

    private func renameField(_ row: OutlineRow) -> some View {
        TextField("Name", text: $renameText)
            .font(.system(.body, weight: .semibold))
            .focused($renameFocused)
            .submitLabel(.done)
            .onSubmit { finishRename(row) }
            .onChange(of: renameFocused) { _, focused in
                if !focused { finishRename(row) }
            }
            .selectsAllWhenEditing(renameOriginal)
            .padding(.horizontal, 10)
            .frame(minHeight: 36)
            .background(theme.cell, in: .rect(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(theme.accent, lineWidth: 2) }
            .padding(.trailing, 6)
    }

    func tabCount(in id: String) -> Int {
        model.rows.filter { $0.kind == "tab" && isInside($0, id) }.count
    }

    // MARK: Actions

    /// Pins a tab: its page becomes the pin's, and it leaves the tree
    /// (pins spec §8.1).
    func pin(_ row: OutlineRow, url: URL) {
        Task { await browser.pin(row, url: url) }
    }

    func unfavorite(_ url: URL) {
        Task {
            guard let undo = await model.removeFavorites(of: url) else { return }
            toast = Toast(text: "Removed from Favorites") { Task { await model.editFavorites(undo) } }
        }
    }

    func startRename(_ row: OutlineRow) {
        renameText = name(row)
        renameOriginal = renameText
        renaming = row.id
        renameFocused = true
    }

    /// Saves the name typed in place. An empty name keeps the old one.
    private func finishRename(_ row: OutlineRow) {
        guard renaming == row.id else { return }
        renaming = nil
        let text = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { pendingNames[row.id] = text }
        Task {
            await model.rename(row, to: text)
            pendingNames[row.id] = nil
        }
    }

    /// Closes every pane at once, as one write, and offers Undo, which
    /// brings the split back with its pages.
    func closeSplit(_ split: OutlineRow, panes: [OutlineRow]) {
        Task {
            guard let undo = await browser.closeSplit(split) else { return }
            toast = .closed(panes.count) { Task { await browser.reopenSplit(undo) } }
        }
    }

    func close(_ row: OutlineRow) {
        // A private tab's close has no Undo: undoing it would mean keeping
        // the tab (13d).
        if model.isPrivate(row.id) {
            Task {
                guard await browser.close(row) != nil else { return }
                if model.privateWorkspace != nil { toast = .closed(1) }
            }
            return
        }
        Task {
            guard let entry = await browser.close(row), Browser.openable(row) != nil else { return }
            toast = .closed(1, title: name(row)) { Task { await browser.reopen(entry) } }
        }
    }
}

/// A notice on glass at the foot of a sheet, which may offer Undo for a
/// few seconds.
struct Toast: Identifiable {
    let id = UUID()
    let text: String
    /// A glyph before the text, from the app's icons.
    var icon: String?
    var undo: (() -> Void)?
    /// The button's label, when it does something other than undo.
    var action = "Undo"
    /// A system glyph before the text, in place of `icon`.
    var symbol: String?
    /// How long it shows.
    var seconds: Double = 5
}

extension Toast {
    /// What closing tabs says: the tab's title for one, else how many.
    /// A private tab's title stays out of it, and its close has no Undo,
    /// which would mean keeping the tab (13d).
    static func closed(_ count: Int, title: String? = nil, undo: (() -> Void)? = nil) -> Toast {
        let text = if count == 1, let title { "Closed “\(title)”" }
            else if count == 1 { "Closed 1 tab" } else { "Closed \(count) tabs" }
        return Toast(text: text, undo: undo)
    }
}

struct ToastView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl
    let toast: Toast
    let onDone: () -> Void

    var body: some View {
        // The bar's glass in the Workspace's colour, as the notices at the
        // top of the screen are.
        let colors = BarColors(token: sheetTint ?? model.tint(of: model.browser.workspaceId.flatMap(model.row)),
                               dark: scheme == .dark)
        let ink = colors.ink
        HStack(spacing: 12) {
            if let icon = toast.icon {
                Image(icon).resizable().frame(width: 18, height: 18).foregroundStyle(ink)
            } else if let symbol = toast.symbol {
                Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(ink)
            }
            Text(toast.text)
                .font(.system(.subheadline, weight: .medium))
                .foregroundStyle(ink)
                .lineLimit(2)
            Spacer(minLength: 4)
            if let undo = toast.undo {
                Button(toast.action) {
                    undo()
                    onDone()
                }
                .font(.system(.subheadline, weight: .bold))
                .foregroundStyle(ink)
            }
        }
        .frame(minHeight: 48)
        .padding(.horizontal, 18)
        .glassEffect(workspaceGlass(colors.layer), in: .capsule)
        .padding(.horizontal, 16)
        // A toast says what just happened, which VoiceOver reads out as
        // it shows. One offering Undo stays while VoiceOver or Switch
        // Control runs, since reaching its button takes longer than it
        // shows for; the escape gesture puts it away.
        .accessibilityAction(.escape, onDone)
        .task(id: toast.id) {
            AccessibilityNotification.Announcement(toast.text).post()
            if toast.undo != nil, voiceOver || switchControl { return }
            try? await Task.sleep(for: .seconds(toast.seconds))
            onDone()
        }
    }
}

/// Shows a toast at the foot of a view, `lift` above whatever covers
/// its foot, sliding up as it comes. With `top`, it shows at the top of
/// the screen over every sheet instead, where the Workspace sheet or
/// panel leaves the page showing.
struct ToastPlace: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var toast: Toast?
    let lift: CGFloat
    let top: Bool

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let toast, !top {
                    ToastView(toast: toast) { self.toast = nil }
                        .padding(.bottom, lift + 12)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(Motion.overlay, value: toast?.id)
            .onChange(of: top ? toast?.id : nil, initial: true) {
                if top, let toast {
                    TopToast.show(toast, model: model, scheme: scheme, tint: sheetTint) {
                        if self.toast?.id == toast.id { self.toast = nil }
                    }
                } else if let shown = TopToast.shown, shown == toast?.id || toast == nil {
                    TopToast.hide(shown)
                }
            }
    }
}

extension View {
    func toast(_ toast: Binding<Toast?>, lift: CGFloat = 0, top: Bool = false) -> some View {
        modifier(ToastPlace(toast: toast, lift: lift, top: top))
    }
}

/// A toast at the top of the screen over every sheet, in a window of its
/// own that takes only the toast's touches.
@MainActor
enum TopToast {
    private static var window: UIWindow?
    private static let state = TopToastState()
    /// The toast showing.
    static var shown: UUID? { state.toast?.id }

    static func show(_ toast: Toast, model: AppModel, scheme: ColorScheme, tint: String?, onDone: @escaping () -> Void) {
        if window == nil {
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
            let window = PassThroughWindow(windowScene: scene)
            window.windowLevel = .alert
            let host = UIHostingController(rootView: AnyView(EmptyView()))
            host.view.backgroundColor = .clear
            window.rootViewController = host
            self.window = window
        }
        (window?.rootViewController as? UIHostingController<AnyView>)?.rootView = AnyView(
            TopToastView(state: state)
                .environment(model)
                .environment(\.appearance, scheme)
                .environment(\.sheetTint, tint))
        window?.isHidden = false
        state.onDone = onDone
        state.toast = toast
    }

    /// Puts `id` away, if it is still the toast showing.
    static func hide(_ id: UUID) {
        guard state.toast?.id == id else { return }
        state.toast = nil
        Task {
            try? await Task.sleep(for: .seconds(0.4))
            if state.toast == nil { window?.isHidden = true }
        }
    }
}

@MainActor
@Observable
private final class TopToastState {
    var toast: Toast?
    var onDone: () -> Void = {}
}

/// A window whose own background lets touches through to the windows
/// under it.
private final class PassThroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === rootViewController?.view ? nil : hit
    }
}

private struct TopToastView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: TopToastState

    var body: some View {
        VStack {
            if let toast = state.toast {
                ToastView(toast: toast) {
                    state.onDone()
                    TopToast.hide(toast.id)
                }
                .id(toast.id)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 8)
        .animation(Motion.overlay, value: state.toast?.id)
    }
}

/// A notice with nothing to undo, at the top of the screen over every
/// sheet, on the bar's glass in the Workspace's colour. It takes no
/// touches, in a window of its own, as `PrivacyCover`'s is.
@MainActor
enum TopNotice {
    private static var window: UIWindow?

    static func show(_ toast: Toast, token: String?, scheme: ColorScheme) {
        hide()
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert
        window.isUserInteractionEnabled = false
        let host = UIHostingController(rootView: TopNoticeView(toast: toast, colors: BarColors(token: token, dark: scheme == .dark)))
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.isHidden = false
        self.window = window
        // Its window takes no touches, so VoiceOver never lands on it.
        UIAccessibility.post(notification: .announcement, argument: toast.text)
    }

    static func hide() {
        window?.isHidden = true
        window = nil
    }
}

private struct TopNoticeView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let toast: Toast
    let colors: BarColors
    @State private var shown = false

    var body: some View {
        VStack {
            if shown {
                HStack(spacing: 12) {
                    if let symbol = toast.symbol {
                        Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
                    }
                    Text(toast.text)
                        .font(.system(.subheadline, weight: .medium))
                        .lineLimit(2)
                }
                .foregroundStyle(colors.ink)
                .frame(minHeight: 48)
                .padding(.horizontal, 18)
                .glassEffect(workspaceGlass(colors.layer, interactive: false), in: .capsule)
                .padding(.horizontal, 16)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 8)
        .task {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.35)) { shown = true }
            try? await Task.sleep(for: .seconds(toast.seconds))
            withAnimation(.easeIn(duration: 0.25)) { shown = false }
            try? await Task.sleep(for: .seconds(0.3))
            TopNotice.hide()
        }
    }
}

/// The sync moon's warning badge, on the Settings button while sync has a
/// problem, so it shows without the moon. Settings says what it is.
struct SyncProblemBadge: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    /// The surface under the badge, which rings it.
    let ring: Color

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if model.stage == .ready, SyncIndicator(model, now: context.date).icon == .warning {
                Badge(diameter: 17, fill: theme.warning, ring: ring, ringWidth: 1) {
                    Image("badge-bang").resizable()
                        .foregroundStyle(theme.warningInk)
                        .frame(width: 14, height: 14)
                }
                .offset(x: 3, y: 3)
                .accessibilityLabel("Sync needs attention")
            }
        }
    }
}

/// Each drawn line's frame in the Workspace tree, and the tree's own.
final class TreeFrames {
    /// Each line's last frame. A List row's appearing and disappearing
    /// is no guide to whether it's on screen, so a frame is kept and
    /// checked against the tree's own.
    var rows: [String: CGRect] = [:]
    /// The tree's own frame, in screen space as the rows' are.
    var tree: CGRect = .zero
    /// When a drag last scrolled the tree.
    var scrolled = Date.distantPast

    /// The line's frame, when it lies inside the tree.
    /// Its sides are the tree's, inside the List's row insets, which every
    /// row spans.
    func shown(_ id: String) -> CGRect? {
        rows[id].flatMap { row in
            row.intersects(tree)
                ? CGRect(x: tree.minX + Self.inset, y: row.minY, width: tree.width - 2 * Self.inset, height: row.height)
                : nil
        }
    }

    /// The List's row inset on each side (`listRowInsets`).
    static let inset: CGFloat = 16
}

/// The line under a drag in the Workspace tree, and what a drop there
/// would do.
struct DropHover: Equatable {
    let entry: String
    let over: DropOver
    let kind: DropKind
    let frame: CGRect
    let depth: Int
    /// Whether a drop here writes anything.
    let writes: Bool
    /// Over a tab's or split's middle, both of its halves: whether a new
    /// group writes anything, and what the split half would do.
    var halves: DropHalves?
}

/// A tab's or split's middle under a drag: a new group on the left half,
/// a split on the right.
struct DropHalves: Equatable {
    /// Whether the Workspace offers groups at all; without, the split
    /// takes the whole row.
    let groups: Bool
    let group: Bool
    let split: DropKind
    let splits: Bool
}

struct TreeDropDelegate: DropDelegate {
    let update: (CGPoint) -> Bool
    let exit: () -> Void
    let perform: () -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        return info.hasItemsConforming(to: [.svalNode])
    }

    func dropEntered(info: DropInfo) { _ = update(info.location) }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: update(info.location) ? .move : .forbidden)
    }

    func dropExited(info: DropInfo) { exit() }

    func performDrop(info: DropInfo) -> Bool { perform() }
}

/// Where a dragged row lands in the list: a line, with a ring at its
/// start (`sval-drop-line`).
struct DropLine: View {
    let color: Color
    let background: Color

    var body: some View {
        HStack(spacing: 0) {
            Circle()
                .strokeBorder(color, lineWidth: 2)
                .background(background, in: .circle)
                .frame(width: 8, height: 8)
            Rectangle().fill(color).frame(height: 2)
        }
        .frame(height: 8)
    }
}

/// A tab's or split's middle under a drag (`sval-drop-mark`): the row's
/// own content fades, and its two halves show both drops, New group on the
/// left and the split on the right, the one under the finger filled. A
/// half that would write nothing is drawn faint.
struct DropHalvesMark: View {
    let halves: DropHalves
    /// Whether the finger is on the split half.
    let onSplit: Bool
    let color: Color
    let muted: Color
    /// The sheet's colour, laid over the row to fade it.
    let cover: Color
    /// A grid card's halves, too narrow for the list's labels: Group and
    /// Split, the glyph above each.
    var compact = false

    private var splitLabel: String {
        if compact { return "Split" }
        return switch halves.split {
        case .join: "Join Split"
        case .merge: "Merge Splits"
        case .refused(full: true): "\(TreeDrop.maxPanes) Pages Max"
        default: "Create Split"
        }
    }

    private func half(_ label: String, icon: String, active: Bool, enabled: Bool) -> some View {
        let layout = compact ? AnyLayout(VStackLayout(spacing: 4)) : AnyLayout(HStackLayout(spacing: 6))
        return layout {
            Image(systemName: icon).font(.system(size: 15, weight: .semibold))
            Text(label)
                .font(.system(.subheadline, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(active && enabled ? BarColors.ink(on: color, dark: true) : (enabled ? color : muted))
        .padding(.horizontal, 8)
        // On a card, the label sits at the half's foot, clear of the card
        // held over it.
        .padding(.bottom, compact ? 10 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compact ? .bottom : .center)
        .background(active && enabled ? color : .clear, in: .rect(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(enabled ? color : muted, style: StrokeStyle(lineWidth: 1.5, dash: enabled ? [] : [4, 3]))
        }
        .opacity(enabled ? 1 : 0.6)
    }

    var body: some View {
        HStack(spacing: 6) {
            if halves.groups {
                half(compact ? "Group" : "New Group", icon: "folder", active: !onSplit, enabled: halves.group)
            }
            half(splitLabel, icon: "rectangle.split.2x1", active: onSplit, enabled: halves.splits)
        }
        .padding(4)
        .background(cover.opacity(0.85), in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

/// Tells when a drag from the view is under way, and when it ends
/// wherever it's let go, on the systems that report its session.
struct DragSessionPhases: ViewModifier {
    let began: () -> Void
    let ended: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.onDragSessionUpdated { session in
                switch session.phase {
                case .initial, .active: began()
                case .ended: ended()
                default: break
                }
            }
        } else {
            content
        }
    }
}

/// The header's ••• menu (15a1). A view of its own that redraws only when
/// what it shows changes: rebuilt with the sheet, the open menu flashed.
struct HeaderMenu: View, Equatable {
    @Binding var layout: TabLayout
    /// The Workspace the actions act on: a menu kept for another one would
    /// edit that one.
    let workspaceId: String
    let editable: Bool
    let groups: Bool
    let editsWorkspace: Bool
    let onEditTabs: () -> Void
    let onEditWorkspace: () -> Void
    let onNewGroup: () -> Void

    static func == (a: HeaderMenu, b: HeaderMenu) -> Bool {
        a.layout == b.layout && a.workspaceId == b.workspaceId && a.editable == b.editable && a.groups == b.groups && a.editsWorkspace == b.editsWorkspace
    }

    var body: some View {
        Menu {
            Picker("Show Tabs As", selection: $layout) {
                ForEach(TabLayout.allCases, id: \.self) { choice in choice.label.tag(choice) }
            }
            .pickerStyle(.palette)
            .menuActionDismissBehavior(.enabled)
            if editable {
                Section {
                    Button(groups ? "Edit Tabs and Groups…" : "Edit Tabs…", systemImage: "checkmark.circle",
                           action: onEditTabs)
                    if editsWorkspace {
                        Button("Edit Workspace…", systemImage: "pencil", action: onEditWorkspace)
                    }
                }
                if groups {
                    Button("New Group…", systemImage: "folder.badge.plus", action: onNewGroup)
                }
            }
        } label: {
            Label("Workspace options", systemImage: "ellipsis")
        }
    }
}
