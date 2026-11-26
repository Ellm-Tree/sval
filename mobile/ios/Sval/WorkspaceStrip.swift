// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Every Workspace as a tile, in a strip at the foot of the Workspace
/// sheet, where the thumb is: this phone's own held at the start, then
/// the user's in the synced order, the other devices' under Devices,
/// each agent's under the agent's name, then New (14b1, 14b3). A tap
/// switches Workspace and leaves the sheet open on it.
struct WorkspaceStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let onNew: () -> Void
    /// The Private tile asks to open the session, add a tab to it, or
    /// close it.
    var onPrivate: (PrivateAsk) -> Void = { _ in }
    /// The sideways panel's strip: 40pt tiles without names, 10pt apart.
    /// The current Workspace's name is in the panel's header (12f3).
    var compact = false

    @Environment(\.dynamicTypeSize) private var typeSize

    /// A group's heading line, which grows with its text.
    @ScaledMetric(relativeTo: .caption2) private var heading: CGFloat = 16

    private var large: Bool { typeSize.isAccessibilitySize }

    /// Tiles without names: the panel's strip, and any strip at the
    /// accessibility text sizes, where a name under a tile has room for a
    /// letter or two. A long press shows a tile's name enlarged, as it
    /// does a tab bar's.
    private var tight: Bool { compact || large }

    /// At the accessibility sizes the tiles are larger in place of names.
    private var tileSize: CGFloat { large ? 64 : compact ? 40 : 46 }
    private var radius: CGFloat { Radius.tile(tileSize) }

    /// The Workspace whose delete the strip is asking about.
    @State private var deleting: OutlineRow?

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }

    var body: some View {
        let sections = model.workspaceSections
        let own = sections.own, people = sections.people, devices = sections.devices, agents = sections.agents
        HStack(alignment: .bottom, spacing: 0) {
            // Held outside the scrolling run, as the Private tile is at the
            // other end, so this phone's own stays in reach.
            if let own {
                tile(own)
                    .padding(.horizontal, 8)
                    .padding(.vertical, tight ? 6 : 0)
                pinnedDivider
            }
        ScrollViewReader { reader in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .bottom, spacing: tight ? 10 : 2) {
                    group(label: people.isEmpty ? nil : "Workspaces", glyph: nil, people, reorders: true)
                    if !devices.isEmpty {
                        divider
                        group(label: "Devices", glyph: "device-phone", devices, reorders: false)
                    }
                    if !agents.isEmpty {
                        divider
                        ForEach(agents, id: \.name) { agent in
                            group(label: agent.name, glyph: agent.rows.first.flatMap(model.markImage) ?? "agent-robot",
                                  agent.rows, reorders: false)
                        }
                    }
                    // New is the user's own: a line sets it apart from the
                    // devices' and agents' Workspaces before it.
                    if !devices.isEmpty || !agents.isEmpty {
                        divider
                    }
                    newTile
                }
                // The first tile's edge lines up with the sheet's other
                // edges, 16pt in. Room above and below keeps the current
                // tile's ring and the corner badges inside the scroll view,
                // which clips.
                .padding(.horizontal, 8)
                .padding(.vertical, tight ? 6 : 0)
            }
            .scrollEdgeFade(.horizontal)
            .onAppear {
                if let id = browser.workspaceId { reader.scrollTo(id, anchor: .center) }
            }
        }
            // Held outside the scrolling run, so it shows however many
            // Workspaces there are (13a1).
            pinnedDivider
            privateTile
                .padding(.horizontal, 8)
                .padding(.vertical, tight ? 6 : 0)
        }
        .padding(.top, tight ? 0 : 8)
        .padding(.bottom, tight ? 0 : 6)
        .overlay(alignment: .top) { theme.divider.frame(height: 1) }
        .confirmsWorkspaceDelete($deleting)
    }

    /// A tile's long-press menu: the drag's moves for the user's own
    /// Workspaces, for a person who can't drag (decision 14), then Delete.
    /// This phone's own Workspace has neither, so it has no menu.
    @ViewBuilder
    private func menu(_ workspace: OutlineRow, among: [OutlineRow], reorders: Bool) -> some View {
        let deletes = workspace.id != model.ownWorkspace?.id
        if reorders || deletes {
            // Titled with the whole name, which the tile's label cuts short.
            Section(WorkspaceTile.name(workspace)) {
                if reorders {
                    let at = among.firstIndex { $0.id == workspace.id } ?? 0
                    Button("Move Left", systemImage: "arrow.left") { step(workspace, among: among, from: at, by: -1) }
                        .disabled(at == 0)
                    Button("Move Right", systemImage: "arrow.right") { step(workspace, among: among, from: at, by: 1) }
                        .disabled(at == among.count - 1)
                    Divider()
                }
                if deletes {
                    Button("Delete Workspace…", systemImage: "trash", role: .destructive) { deleting = workspace }
                        .disabled(!model.canDelete(workspace: workspace))
                }
            }
        }
    }

    /// Moves `workspace`, at `at` in `among`, one place along the strip.
    private func step(_ workspace: OutlineRow, among: [OutlineRow], from at: Int, by step: Int) {
        let others = among.filter { $0.id != workspace.id }
        let to = at + step
        guard among.indices.contains(to) else { return }
        // `before` names the Workspace it goes after, `after` the one it
        // goes before, as `moveWorkspace` takes them.
        let before = to > 0 ? others[to - 1].id : nil
        let after = to < others.count ? others[to].id : nil
        Task { await model.moveWorkspace(workspace.id, before: before, after: after) }
    }

    /// The line between the scrolling run and a tile held at its end.
    private var pinnedDivider: some View {
        VStack(spacing: 5) {
            theme.divider.frame(width: 1, height: tileSize)
            if !tight { nameRoom }
        }
        .padding(.bottom, 6)
    }

    private var divider: some View {
        VStack(spacing: 5) {
            theme.divider.frame(width: 1, height: tileSize)
            if !tight { nameRoom }
        }
        .padding(.horizontal, 8)
    }

    /// The room a tile's name takes under it: two lines, held whatever
    /// the name's length, so every tile and divider in the strip lines up
    /// at any text size.
    private var nameRoom: some View {
        Text(verbatim: " ")
            .font(.system(.caption2, weight: .bold))
            .lineLimit(2, reservesSpace: true)
            .hidden()
            .accessibilityHidden(true)
    }

    /// `glyph` is the heading's mark, the one its tiles wear, as the
    /// desktop's menu headings wear it. The user's own tiles wear none.
    private func group(label: String?, glyph: String?, _ workspaces: [OutlineRow], reorders: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if let label {
                    HStack(spacing: 6) {
                        if let glyph {
                            Image(glyph)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 10, height: 10)
                                .foregroundStyle(theme.muted)
                        }
                        Text(label)
                            .font(.system(.caption2, weight: .semibold))
                            .foregroundStyle(theme.muted)
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .padding(.horizontal, 10)
                    // A heading wider than its tiles runs under the next
                    // group's, so it stops growing at this size.
                    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                    .accessibilityAddTraits(.isHeader)
                } else {
                    Color.clear
                }
            }
            .frame(height: min(heading, 28))
            HStack(spacing: tight ? 10 : 2) {
                ForEach(workspaces, id: \.id) { workspace in
                    tile(workspace)
                        .id(workspace.id)
                        .modifier(Reorder(workspace: workspace, among: workspaces, enabled: reorders))
                        .contextMenu { menu(workspace, among: workspaces, reorders: reorders) }
                }
            }
        }
    }

    private func tile(_ workspace: OutlineRow) -> some View {
        let current = workspace.id == browser.workspaceId
        let playing = model.tabs(in: workspace.id).contains { browser.playingTabs.contains($0.id) }
        return Button {
            guard !current else { return }
            browser.showWorkspace(workspace.id)
        } label: {
            VStack(spacing: 5) {
                WorkspaceTile(workspace: workspace, size: tileSize, radius: radius)
                    .padding(2)
                    .overlay {
                        if current {
                            RoundedRectangle(cornerRadius: radius + 2).strokeBorder(theme.accent, lineWidth: Stroke.selected)
                        }
                    }
                    .padding(-2)
                    .overlay(alignment: .topTrailing) {
                        if playing {
                            badge(fill: theme.accent) {
                                Image(systemName: "speaker.wave.2.fill")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(theme.sheet)
                            }
                            .offset(x: 5, y: -5)
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if workspace.isolated {
                            badge(fill: theme.body) {
                                Image("workspace-isolated")
                                    .resizable()
                                    .frame(width: 11, height: 11)
                                    .foregroundStyle(theme.sheet)
                            }
                            .offset(x: 5, y: 5)
                        }
                    }
                if !tight {
                    Text(WorkspaceTile.name(workspace))
                        .font(.system(.caption2, weight: current ? .bold : .medium))
                        .foregroundStyle(current ? theme.text : theme.muted)
                        .multilineTextAlignment(.center)
                        .lineLimit(2, reservesSpace: true)
                        .frame(maxWidth: 62)
                }
            }
            .frame(width: tight ? tileSize + 4 : 62)
            .contentShape(.rect)
        }
        .accessibilityLabel(WorkspaceTile.name(workspace))
        .accessibilityShowsLargeContentViewer {
            Label { Text(WorkspaceTile.name(workspace)) } icon: {
                // The viewer draws outside the strip's environment, and the
                // tile reads the model from it.
                WorkspaceTile(workspace: workspace, size: 46).environment(model)
            }
        }
        .accessibilityValue([playing ? "Playing" : nil, workspace.isolated ? "Isolated" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    /// A mark at a tile's corner, ringed in the sheet colour.
    private func badge<Content: View>(fill: Color, @ViewBuilder _ content: () -> Content) -> some View {
        let mark = content()
        return Badge(diameter: Tile.badge, fill: fill, ring: theme.sheet) { mark }
            .accessibilityHidden(true)
    }

    /// The way into the private session, and back to it while it's open,
    /// with the count of its tabs.
    private var privateTile: some View {
        let count = model.tabs(in: model.privateWorkspace).count
        let open = model.privateWorkspace != nil
        return Button { onPrivate(.open) } label: {
            VStack(spacing: 5) {
                PrivateTile(size: tileSize, radius: radius)
                    .overlay(alignment: .topTrailing) {
                        if open {
                            Text("\(count)")
                                .font(.system(.caption2, weight: .bold))
                                .monospacedDigit()
                                .foregroundStyle(Theme.privateViolet)
                                .frame(minWidth: 20, minHeight: 20)
                                .background(.white, in: .circle)
                                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                                .offset(x: 6, y: -6)
                        }
                    }
                if !tight {
                    Text("Private")
                        .font(.system(.caption2, weight: .semibold))
                        .lineLimit(2, reservesSpace: true)
                        // The desktop's label colour reads on the dark sheet;
                        // on the light one it takes Private Violet itself. A
                        // Workspace's colour has ink of its own solved on it.
                        .foregroundStyle(theme.tint != nil ? theme.muted : theme.dark ? Theme.privateLabel : Theme.privateViolet)
                }
            }
            .frame(width: tight ? tileSize + 4 : 62)
            .contentShape(.rect)
        }
        .contextMenu {
            if open {
                NewPrivateTabButton { onPrivate(.newTab) }
                Button("Exit Private Workspace", systemImage: "xmark", role: .destructive) { onPrivate(.close) }
            }
        }
        .accessibilityLabel(open ? (count == 1 ? "Private, 1 tab" : "Private, \(count) tabs") : "Private")
        .accessibilityShowsLargeContentViewer { Label("Private", image: "private") }
    }

    private var newTile: some View {
        Button(action: onNew) {
            VStack(spacing: 5) {
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(theme.tileRing, style: StrokeStyle(lineWidth: Stroke.ring, dash: Stroke.dash))
                    .overlay { Image(systemName: "plus").font(.system(size: 18, weight: .medium)) }
                    .frame(width: tileSize, height: tileSize)
                if !tight {
                    Text("New")
                        .font(.system(.caption2, weight: .medium))
                        .lineLimit(2, reservesSpace: true)
                }
            }
            .foregroundStyle(theme.muted)
            .frame(width: tight ? tileSize + 4 : 62)
            .contentShape(.rect)
        }
        .accessibilityLabel("New Workspace")
        .accessibilityShowsLargeContentViewer { Label("New Workspace", systemImage: "plus") }
    }
}

/// Long-press a tile to drag it along the strip, which writes the new
/// order to the tree, as dragging the desktop's strip does. Only the
/// user's own Workspaces reorder.
private struct Reorder: ViewModifier {
    @Environment(AppModel.self) private var model
    let workspace: OutlineRow
    let among: [OutlineRow]
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content
                .draggable(workspace.id) {
                    // The lift draws its preview outside the strip's
                    // environment, and the tile reads the model from it.
                    WorkspaceTile(workspace: workspace, size: 46)
                        .environment(model)
                }
                .dropDestination(for: String.self) { ids, _ in
                    guard let moved = ids.first, moved != workspace.id,
                          let from = among.firstIndex(where: { $0.id == moved }),
                          let to = among.firstIndex(where: { $0.id == workspace.id }) else { return false }
                    // Dropped on a tile, the dragged one takes its place:
                    // after it when coming from the left, before it from
                    // the right.
                    let before = from < to ? workspace.id : (to > 0 ? among[to - 1].id : nil)
                    let after = from < to ? (to + 1 < among.count ? among[to + 1].id : nil) : workspace.id
                    Task { await model.moveWorkspace(moved, before: before, after: after) }
                    return true
                }
        } else {
            content
        }
    }
}

/// What the Private tile, the bar's badge or a menu asks of the private
/// session.
enum PrivateAsk {
    /// Open it, or go back to it while it's open.
    case open
    /// Add a tab to it on the private home.
    case newTab
    /// End it, once confirmed.
    case close
}
