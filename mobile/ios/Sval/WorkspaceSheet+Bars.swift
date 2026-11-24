// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

extension WorkspaceSheet {
    // MARK: Header and footer

    /// The Workspace's name, which opens its editor: name, emoji, colour
    /// and Delete. An agent's and the private session's aren't the user's
    /// to change.
    func title(inBar: Bool) -> some View {
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
    @ToolbarContentBuilder var topBar: some ToolbarContent {
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
        visibleEntries.compactMap { $0.panes == nil && $0.row.kind == .tab ? $0.row : nil }
    }

    func endEditing() {
        editing = false
        selected = []
    }

    /// The sheet's bottom bar (14b1, 14d1): the system's toolbar, so its
    /// buttons are the size of every other bar's.
    @ToolbarContentBuilder var bottomBar: some ToolbarContent {
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
        // Asked before the close, which drops the tabs from the private
        // session's ids.
        let wasPrivate = model.isPrivate(rows.first?.id ?? "")
        Task {
            var entries: [Browser.ClosedTab] = []
            for row in rows where row.kind == .tab {
                if let entry = await browser.close(row), Browser.openable(row) != nil { entries.append(entry) }
            }
            guard !wasPrivate else {
                toasts.show(.closed(rows.count))
                return
            }
            toasts.show(.closed(rows.count) {
                Task { for entry in entries.reversed() { await browser.reopen(entry) } }
            })
        }
    }

    private var summary: String {
        let inside = model.rows.filter { $0.id != workspace?.id && model.workspace(of: $0.id) == workspace?.id }
        let tabs = inside.filter { $0.kind == .tab }.count
        let groups = inside.filter { $0.kind == .group }.count
        let tabText = tabs == 1 ? "1 tab" : "\(tabs) tabs"
        guard groups > 0 else { return tabText }
        return "\(tabText) and \(groups == 1 ? "1 group" : "\(groups) groups")"
    }

    // MARK: The private session

    /// The Private tile and the private menus' asks.
    func askPrivate(_ ask: PrivateAsk) {
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
            toasts.show(.privateClosed)
        }
    }

    /// The notice the private session always shows, which can't be
    /// dismissed (13c, the desktop's private window notice).
    var privateNotice: some View {
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

    var backToReading: some View {
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
}
