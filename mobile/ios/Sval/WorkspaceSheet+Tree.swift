// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

extension WorkspaceSheet {
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
    func dragPreview(_ entry: TreeEntry) -> some View {
        HStack(spacing: 8) {
            if entry.panes != nil {
                Image(systemName: "rectangle.split.2x1").font(.system(size: 15))
            } else if entry.row.kind == .group {
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
    func isDragged(_ entry: TreeEntry) -> Bool {
        guard hover != nil, let dragging else { return false }
        return model.isInside(entry.row.id, dragging)
    }

    /// Reads the row under the finger, as the desktop's panel does
    /// (`dropIntent`). Returns whether a drop there writes anything.
    func dragMoved(to point: CGPoint, rows: [TreeEntry], blocks: [String: RowBlock],
                           reader: ScrollViewProxy) -> Bool {
        guard let id = dragging, let workspace = workspace?.id else { return false }
        autoScroll(point.y, rows: rows, reader: reader)
        let point = CGPoint(x: point.x + frames.tree.minX, y: point.y + frames.tree.minY)
        let drawn = rows.compactMap { entry in frames.shown(entry.id).map { (entry, $0) } }
        var next: DropHover?
        if let (entry, frame) = drawn.first(where: { $0.1.minY <= point.y && point.y < $0.1.maxY }) {
            let over = DropOver(id: entry.row.id, kind: entry.panes == nil ? entry.row.kind : .split,
                                expanded: entry.row.kind == .group && !collapsed.contains(entry.row.id))
            // The halves split the row's own target, as they are drawn.
            let (leading, trailing) = targetInsets(entry, block: blocks[entry.id])
            let width = frame.width - leading - trailing
            let kind = model.dropIntent(id, over: over, x: point.x - frame.minX - leading, y: point.y - frame.minY,
                                        w: width, h: frame.height)
            next = DropHover(entry: entry.id, over: over, kind: kind, depth: entry.depth,
                             writes: model.dropPlan(id, over: over, kind) != nil)
            if kind == .newGroup || kind == .split || kind == .join || kind == .merge || kind == .refused(full: true) {
                let split = model.dropIntent(id, over: over, x: width - 1, y: frame.height / 2,
                                             w: width, h: frame.height)
                next?.halves = DropHalves(groups: model.makesGroups(in: workspace),
                                          group: model.dropPlan(id, over: over, .newGroup) != nil, split: split,
                                          splits: model.dropPlan(id, over: over, split) != nil)
            }
        } else if let last = drawn.last, last.0.id == rows.last?.id, point.y >= last.1.maxY {
            let over = DropOver(id: workspace, kind: .workspace, expanded: true)
            next = DropHover(entry: last.0.id, over: over, kind: .end, depth: 1,
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

    func drop() -> Bool {
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
    /// (`SvalPanelDrag.paint`): a line where the dragged row would land, an
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

    @ViewBuilder func rowMark(_ entry: TreeEntry, block: RowBlock?) -> some View {
        let color = theme.accent
        let (leading, trailing) = targetInsets(entry, block: block)
        if case .mergeGroup(let plan) = look, [plan.id, plan.target].contains(entry.row.id) {
            RoundedRectangle(cornerRadius: Self.cardCorner)
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
                RoundedRectangle(cornerRadius: Self.cardCorner)
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
    var visibleEntries: [TreeEntry] {
        guard let id = workspace?.id else { return [] }
        let all = model.rows.filter { $0.id != id && model.workspace(of: $0.id) == id }
        var hidden = Set<String>()
        var out: [TreeEntry] = []
        for row in all {
            if let parent = row.parentId, hidden.contains(parent) || collapsed.contains(parent) {
                hidden.insert(row.id)
                continue
            }
            guard row.kind == .split else {
                out.append(TreeEntry(id: row.id, row: row, panes: nil, depth: Int(row.depth)))
                continue
            }
            hidden.insert(row.id)
            let panes = all.filter { $0.parentId == row.id && $0.kind == .tab }
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
    func rowLabel(_ row: OutlineRow, elsewhere: Bool, playing: Bool) -> String {
        [name(row), site(of: row), playing ? "playing" : nil, elsewhere ? "can't open on \(UIDevice.current.model)" : nil]
            .compactMap { $0 }.joined(separator: ", ")
    }

    func site(of row: OutlineRow) -> String? {
        guard let host = row.url.flatMap(URL.init(string:))?.host() else { return nil }
        return SiteRules.site(of: host) ?? host
    }

    func name(_ row: OutlineRow) -> String {
        row.displayTitle
    }

    @ViewBuilder func item(_ entry: TreeEntry, block: RowBlock?) -> some View {
        let indent = CGFloat(max(entry.depth - 1, 0)) * 24
        if let panes = entry.panes {
            splitRow(entry.row, panes: panes, indent: indent, block: block)
        } else if entry.row.kind == .tab {
            tabRow(entry.row, indent: indent, block: block)
        } else {
            groupRow(entry.row, indent: indent, block: block)
        }
    }
}
