// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Every Workspace as a tile, in a strip at the foot of the Workspace
/// sheet, where the thumb is: this phone's own first, then the user's in
/// the synced order, the other devices' under Devices, each agent's under
/// the agent's name, then New (14b1, 14b3). A tap switches Workspace and
/// leaves the sheet open on it.
struct WorkspaceStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
    private var radius: CGFloat { large ? 18 : compact ? 12 : 14 }

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }

    var body: some View {
        let own = model.ownWorkspace
        let people = model.workspaces.filter { $0.agent == nil && $0.device == nil }
        let devices = model.workspaces.filter { $0.agent == nil && model.isOtherDevices($0) }
        let agents = model.workspaces.filter { $0.agent != nil }
        HStack(alignment: .bottom, spacing: 0) {
        ScrollViewReader { reader in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .bottom, spacing: tight ? 10 : 2) {
                    if let own {
                        group(label: nil, [own], reorders: false)
                        divider
                    }
                    group(label: nil, people, reorders: true)
                    if !devices.isEmpty {
                        divider
                        group(label: "Devices", glyph: "device-phone", devices, reorders: false)
                    }
                    if !agents.isEmpty {
                        divider
                        ForEach(agentNames(agents), id: \.self) { name in
                            let own = agents.filter { model.agentName($0) == name }
                            group(label: name, glyph: own.first.flatMap(model.markImage) ?? "agent-robot",
                                  own, reorders: false)
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
            theme.divider.frame(width: 1, height: tileSize).padding(.bottom, tight ? 6 : 26)
            privateTile
                .padding(.horizontal, 8)
                .padding(.vertical, tight ? 6 : 0)
        }
        .padding(.top, tight ? 0 : 8)
        .padding(.bottom, tight ? 0 : 6)
        .overlay(alignment: .top) { theme.divider.frame(height: 1) }
    }

    /// Each agent once, in the order its first Workspace comes. One agent
    /// app paired on two devices is two agents.
    private func agentNames(_ agents: [OutlineRow]) -> [String] {
        var seen = Set<String>()
        return agents.compactMap(model.agentName).filter { seen.insert($0).inserted }
    }

    private var divider: some View {
        theme.divider
            .frame(width: 1, height: tileSize)
            .padding(.horizontal, 8)
            .padding(.bottom, tight ? 0 : 20)
    }

    /// `glyph` is the heading's mark, the one its tiles wear, as the
    /// desktop's menu headings wear it.
    private func group(label: String?, glyph: String = "agent-robot", _ workspaces: [OutlineRow], reorders: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if let label {
                    HStack(spacing: 6) {
                        Image(glyph)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 10, height: 10)
                            .foregroundStyle(theme.muted)
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
                }
            }
        }
    }

    private func tile(_ workspace: OutlineRow) -> some View {
        let current = workspace.id == browser.workspaceId
        let playing = model.tabs(in: workspace.id).contains { browser.playingTabs.contains($0.id) }
        return Button {
            guard !current else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                browser.showWorkspace(workspace.id)
            }
        } label: {
            VStack(spacing: 5) {
                WorkspaceTile(workspace: workspace, size: tileSize, radius: radius)
                    .padding(2)
                    .overlay {
                        if current {
                            RoundedRectangle(cornerRadius: radius + 2).strokeBorder(theme.accent, lineWidth: 2)
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
                        .lineLimit(1)
                        .frame(maxWidth: 62)
                }
            }
            .frame(width: tight ? tileSize + 4 : 62)
            .contentShape(.rect)
        }
        .accessibilityLabel(WorkspaceTile.name(workspace))
        .accessibilityShowsLargeContentViewer {
            Label { Text(WorkspaceTile.name(workspace)) } icon: { WorkspaceTile(workspace: workspace, size: 46, radius: 14) }
        }
        .accessibilityValue([playing ? "Playing" : nil, workspace.isolated ? "Isolated" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    /// A mark at a tile's corner, ringed in the sheet colour.
    private func badge<Content: View>(fill: Color, @ViewBuilder _ content: () -> Content) -> some View {
        let mark = content()
        return Badge(diameter: 18, fill: fill, ring: theme.sheet) { mark }
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
                    .strokeBorder(theme.tileRing, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .overlay { Image(systemName: "plus").font(.system(size: 18, weight: .medium)) }
                    .frame(width: tileSize, height: tileSize)
                if !tight {
                    Text("New")
                        .font(.system(.caption2, weight: .medium))
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
                    WorkspaceTile(workspace: workspace, size: 46, radius: 14)
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
                // The drag's moves, for a person who can't drag (decision 14).
                .contextMenu {
                    let at = among.firstIndex { $0.id == workspace.id } ?? 0
                    Button("Move Left", systemImage: "arrow.left") { step(at, by: -1) }
                        .disabled(at == 0)
                    Button("Move Right", systemImage: "arrow.right") { step(at, by: 1) }
                        .disabled(at == among.count - 1)
                }
        } else {
            content
        }
    }
}

extension Reorder {
    /// Moves the Workspace at `at` one place along the strip.
    private func step(_ at: Int, by step: Int) {
        let others = among.filter { $0.id != workspace.id }
        let to = at + step
        guard among.indices.contains(to) else { return }
        // `before` names the Workspace it goes after, `after` the one it
        // goes before, as `moveWorkspace` takes them.
        let before = to > 0 ? others[to - 1].id : nil
        let after = to < others.count ? others[to].id : nil
        Task { await model.moveWorkspace(workspace.id, before: before, after: after) }
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
