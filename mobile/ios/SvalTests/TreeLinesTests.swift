// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The tree as the grid draws it.
@MainActor
final class TreeLinesTests: XCTestCase {
    nonisolated static func row(_ id: String, _ parent: String?, _ kind: NodeKind, depth: UInt32 = 0, color: String? = nil,
                    name: String? = nil) -> OutlineRow {
        OutlineRow(id: id, parentId: parent, depth: depth, kind: kind, name: name ?? id,
                   url: kind == .tab ? "https://\(id).example/" : nil, icon: nil, local: false, emoji: nil, label: nil,
                   color: color, transparency: nil, pinned: false, agent: nil, agentDevice: nil, device: nil,
                   isolated: false, shares: nil)
    }

    /// A Workspace with a tab, a coloured group holding a tab, a nested
    /// group and another tab, then a two-pane split, a one-pane split, an
    /// empty split and a tab.
    nonisolated static var rows: [OutlineRow] {
        [
            row("w1", nil, .workspace),
            row("t1", "w1", .tab, depth: 1),
            row("g1", "w1", .group, depth: 1, color: "blue"),
            row("t2", "g1", .tab, depth: 2),
            row("g2", "g1", .group, depth: 2),
            row("t3", "g2", .tab, depth: 3),
            row("t4", "g1", .tab, depth: 2),
            row("s1", "w1", .split, depth: 1),
            row("p1", "s1", .tab, depth: 2),
            row("p2", "s1", .tab, depth: 2),
            row("s2", "w1", .split, depth: 1),
            row("p3", "s2", .tab, depth: 2),
            row("s3", "w1", .split, depth: 1),
            row("t5", "w1", .tab, depth: 1),
        ]
    }

    private let index = OutlineIndex(TreeLinesTests.rows)

    private func ids(_ sections: [TreeSection]) -> [String] {
        sections.map { "\($0.id): " + $0.lines.map(\.id).joined(separator: " ") }
    }

    func testGridSections() {
        let sections = TreeLines.grid(index, workspace: "w1", collapsed: [])
        XCTAssertEqual(ids(sections), ["w1#0: t1", "g1#0: t2", "g2#0: t3", "g1#1: t4", "w1#1: s1 p3 t5"])
        XCTAssertEqual(sections.map(\.depth), [0, 1, 2, 1, 0])
        XCTAssertEqual(sections[1].header, GroupHeader(id: "g1", open: true, nested: false, count: 3,
                                                       icons: ["t2", "t3", "t4"]))
        XCTAssertEqual(sections[2].header?.nested, true)
        XCTAssertNil(sections[3].header)
        XCTAssertEqual(sections[1].layers, [GroupLayer(tint: "blue", top: true, bottom: false)])
        XCTAssertEqual(sections[2].layers, [GroupLayer(tint: "blue", top: false, bottom: false),
                                            GroupLayer(tint: nil, top: true, bottom: true)])
        XCTAssertEqual(sections[3].layers, [GroupLayer(tint: "blue", top: false, bottom: true)])
        // A split of two is one card with its panes, a split of one is its
        // tab's card, and an empty split draws nothing.
        XCTAssertEqual(sections[4].lines, [TreeLine(id: "s1", depth: 0, panes: ["p1", "p2"]),
                                           TreeLine(id: "p3", depth: 0, panes: nil),
                                           TreeLine(id: "t5", depth: 0, panes: nil)])
    }

    func testClosedGroupKeepsItsHeaderAlone() {
        let sections = TreeLines.grid(index, workspace: "w1", collapsed: ["g1"])
        XCTAssertEqual(ids(sections), ["w1#0: t1", "g1#0: ", "w1#1: s1 p3 t5"])
        XCTAssertEqual(sections[1].header?.open, false)
        XCTAssertEqual(sections[1].layers, [GroupLayer(tint: "blue", top: true, bottom: true)])
    }

    func testGroupOpeningWithAGroupHeadsAnEmptySection() {
        let index = OutlineIndex([
            Self.row("w1", nil, .workspace),
            Self.row("g3", "w1", .group, depth: 1),
            Self.row("g4", "g3", .group, depth: 2),
            Self.row("t6", "g4", .tab, depth: 3),
        ])
        XCTAssertEqual(ids(TreeLines.grid(index, workspace: "w1", collapsed: [])), ["g3#0: ", "g4#0: t6"])
    }
}
