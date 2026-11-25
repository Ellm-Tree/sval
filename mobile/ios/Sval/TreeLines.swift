// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

/// One drawn card or row: its id, how many groups in, and for a split of
/// two or more tabs, its panes in order. Ids and layout facts alone: a
/// title or an icon reaches the card through its `RowBox`.
struct TreeLine: Equatable {
    let id: String
    let depth: Int
    /// A split's panes; nil for a tab.
    let panes: [String]?
    /// In the list, a group's own row: its header's facts.
    var group: GroupHeader? = nil
    /// In the list, the colours of the groups around the row, outermost
    /// first, nil for a plain group. A row's text and its front card take
    /// the innermost colour.
    var tints: [String?] = []
}

/// One coloured or plain group around a section, and whether the section
/// opens or closes the group's box.
struct GroupLayer: Equatable {
    let tint: String?
    var top: Bool
    var bottom: Bool
}

/// A group's header over the section it opens: whether the group is open,
/// the tabs it holds at any depth, and the first three of them, whose icons
/// a closed group shows.
struct GroupHeader: Equatable {
    let id: String
    let open: Bool
    let nested: Bool
    let count: Int
    let icons: [String]
}

/// One section of the grid: a run of cards, under a group's header when it
/// opens one, inside the boxes of the groups around it.
struct TreeSection: Equatable {
    let id: String
    /// Where a drop into the section's empty end lands: its group, or the
    /// Workspace.
    let container: String
    let depth: Int
    /// The groups it is in, outermost first.
    let groups: [String]
    let header: GroupHeader?
    var lines: [TreeLine]
    var layers: [GroupLayer]

    var items: [String] { lines.map(\.id) }

    /// What the section's layout is built from: everything but its cards
    /// and the header's count and icons.
    var layout: SectionLayout {
        SectionLayout(depth: depth, layers: layers, header: header.map(\.nested), empty: lines.isEmpty)
    }
}

struct SectionLayout: Equatable {
    let depth: Int
    let layers: [GroupLayer]
    /// Whether the section has a header, and whether it is a nested one.
    let header: Bool?
    let empty: Bool
}

/// The Workspace's tree as the grid draws it, built from the index alone.
enum TreeLines {
    /// The tree under `workspace` as the grid's sections: each run of cards
    /// one section, each group its header's section and then its own. A
    /// closed group's section holds its header alone.
    static func grid(_ index: OutlineIndex, workspace: String, collapsed: Set<String>) -> [TreeSection] {
        build(index, workspace, depth: 0, chain: [], collapsed: collapsed, list: false)
    }

    /// The tree under `workspace` as the list's sections: the grid's, with
    /// each group's row first in the section its header heads, so a group
    /// is dragged, pressed and tapped as any row is, and a split of more
    /// than four tabs as one line per run of four.
    static func list(_ index: OutlineIndex, workspace: String, collapsed: Set<String>) -> [TreeSection] {
        build(index, workspace, depth: 0, chain: [], collapsed: collapsed, list: true)
    }

    private static func build(_ index: OutlineIndex, _ parentId: String, depth: Int, chain: [OutlineRow],
                              collapsed: Set<String>, list: Bool) -> [TreeSection] {
        var out: [TreeSection] = []
        let group = chain.last.flatMap { $0.id == parentId ? $0 : nil }
        let open = group.map { !collapsed.contains($0.id) } ?? true
        let header = group.map { group in
            GroupHeader(id: group.id, open: open, nested: chain.count > 1, count: index.inside(group.id).tabs,
                        icons: firstTabs(index, in: group.id, count: 3))
        }
        var at = 0
        let tints = list ? chain.map(\.color) : []
        func section(_ lines: [TreeLine]) -> TreeSection {
            defer { at += 1 }
            var lines = lines
            if list, at == 0, let header {
                lines.insert(TreeLine(id: header.id, depth: depth - 1, panes: nil, group: header, tints: tints), at: 0)
            }
            return TreeSection(id: "\(parentId)#\(at)", container: parentId, depth: depth, groups: chain.map(\.id),
                               header: at == 0 ? header : nil, lines: lines,
                               layers: chain.map { GroupLayer(tint: $0.color, top: false, bottom: false) })
        }
        if open {
            for run in runs(index.children(of: parentId)) {
                if run.count == 1, run[0].kind == .group {
                    // A group's header heads a section, so a group that
                    // opens with a group gets an empty one first.
                    if header != nil, at == 0 { out.append(section([])) }
                    out += build(index, run[0].id, depth: depth + 1, chain: chain + [run[0]], collapsed: collapsed,
                                 list: list)
                } else if list {
                    out.append(section(run.flatMap { rowLines($0, index: index, depth: depth, tints: tints) }))
                } else {
                    out.append(section(run.compactMap { line($0, index: index, depth: depth) }))
                }
            }
        }
        if header != nil, at == 0 { out.append(section([])) }
        // The sections a group holds open and close its box.
        if header != nil, !out.isEmpty {
            let level = chain.count - 1
            out[0].layers[level].top = true
            out[out.count - 1].layers[level].bottom = true
        }
        return out
    }

    /// The children in order, as runs: each group alone, and the cards
    /// between groups together.
    private static func runs(_ children: [OutlineRow]) -> [[OutlineRow]] {
        var out: [[OutlineRow]] = []
        var cards: [OutlineRow] = []
        for row in children {
            if row.kind == .group {
                if !cards.isEmpty { out.append(cards); cards = [] }
                out.append([row])
            } else {
                cards.append(row)
            }
        }
        if !cards.isEmpty { out.append(cards) }
        return out
    }

    /// A card for `row`: a tab's, a split's, or for a split holding one
    /// tab, that tab's; a split holding none draws nothing (split-view spec
    /// §5.1).
    static func line(_ row: OutlineRow, index: OutlineIndex, depth: Int) -> TreeLine? {
        guard row.kind == .split else { return row.kind == .tab ? TreeLine(id: row.id, depth: depth, panes: nil) : nil }
        let panes = index.children(of: row.id).filter { $0.kind == .tab }.map(\.id)
        if panes.count == 1 { return TreeLine(id: panes[0], depth: depth, panes: nil) }
        return panes.isEmpty ? nil : TreeLine(id: row.id, depth: depth, panes: panes)
    }

    /// The list's lines for `row`: as `line`, with a split of more than
    /// four tabs as one line per run of four (`splitRuns`), the first under
    /// the split's id, and a run of one as its tab.
    private static func rowLines(_ row: OutlineRow, index: OutlineIndex, depth: Int, tints: [String?]) -> [TreeLine] {
        guard row.kind == .split else {
            return line(row, index: index, depth: depth).map { [TreeLine(id: $0.id, depth: depth, panes: nil, tints: tints)] } ?? []
        }
        let panes = index.children(of: row.id).filter { $0.kind == .tab }
        return splitRuns(panes).enumerated().map { at, run in
            run.count == 1
                ? TreeLine(id: run[0].id, depth: depth, panes: nil, tints: tints)
                : TreeLine(id: at == 0 ? row.id : "\(row.id)#\(at)", depth: depth, panes: run.map(\.id), tints: tints)
        }
    }

    /// The row a list line draws: a split's for a later run of its panes.
    static func rowId(of line: String) -> String {
        line.split(separator: "#").first.map(String.init) ?? line
    }

    /// The first `count` tabs inside `group` at any depth, in tree order.
    private static func firstTabs(_ index: OutlineIndex, in group: String, count: Int) -> [String] {
        var out: [String] = []
        func walk(_ id: String) {
            for child in index.children(of: id) where out.count < count {
                if child.kind == .tab { out.append(child.id) } else { walk(child.id) }
            }
        }
        walk(group)
        return out
    }
}
