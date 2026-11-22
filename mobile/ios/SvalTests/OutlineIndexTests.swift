// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The tree's index answers every lookup as a walk of the rows would.
final class OutlineIndexTests: XCTestCase {
    private func row(_ id: String, _ parent: String?, _ kind: NodeKind, depth: UInt32 = 0) -> OutlineRow {
        OutlineRow(id: id, parentId: parent, depth: depth, kind: kind, name: id, url: nil, icon: nil, local: false,
                   emoji: nil, label: nil, color: nil, transparency: nil, pinned: false, agent: nil,
                   agentDevice: nil, device: nil, isolated: false, shares: nil)
    }

    /// Workspaces with nested groups, a split and a row whose parent the
    /// tree lacks.
    private var rows: [OutlineRow] {
        [
            row("w1", nil, .workspace),
            row("t1", "w1", .tab, depth: 1),
            row("g1", "w1", .group, depth: 1),
            row("t2", "g1", .tab, depth: 2),
            row("g2", "g1", .group, depth: 2),
            row("t3", "g2", .tab, depth: 3),
            row("s1", "w1", .split, depth: 1),
            row("t4", "s1", .tab, depth: 2),
            row("t5", "s1", .tab, depth: 2),
            row("w2", nil, .workspace),
            row("t6", "w2", .tab, depth: 1),
            row("w3", nil, .workspace),
            row("orphan", "gone", .tab, depth: 1),
        ]
    }

    // The walks the index replaces.

    private func linearRow(_ rows: [OutlineRow], _ id: String) -> OutlineRow? {
        rows.first { $0.id == id }
    }

    private func linearWorkspace(_ rows: [OutlineRow], _ id: String) -> String? {
        var current = linearRow(rows, id)
        while let node = current, let parent = node.parentId {
            current = linearRow(rows, parent)
        }
        return current?.id
    }

    private func linearInside(_ rows: [OutlineRow], _ id: String) -> (tabs: Int, groups: Int) {
        let inside = rows.filter { row in
            var parent = row.parentId
            while let at = parent {
                if at == id { return true }
                parent = linearRow(rows, at)?.parentId
            }
            return false
        }
        return (inside.filter { $0.kind == .tab }.count, inside.filter { $0.kind == .group }.count)
    }

    func testLookupsMatchTheWalks() {
        let rows = rows
        let index = OutlineIndex(rows)
        let ids = rows.map(\.id) + ["gone", "missing"]
        for id in ids {
            XCTAssertEqual(index.row(id), linearRow(rows, id), id)
            XCTAssertEqual(index.children(of: id), rows.filter { $0.parentId == id }, id)
            XCTAssertEqual(index.workspace(of: id), linearWorkspace(rows, id), id)
            XCTAssertEqual(index.tabs(in: id),
                           rows.filter { $0.kind == .tab && linearWorkspace(rows, $0.id) == id }, id)
            let inside = index.inside(id), expected = linearInside(rows, id)
            XCTAssertEqual(inside.tabs, expected.tabs, id)
            XCTAssertEqual(inside.groups, expected.groups, id)
        }
    }

    func testAnswers() {
        let index = OutlineIndex(rows)
        XCTAssertEqual(index.workspace(of: "t3"), "w1")
        XCTAssertEqual(index.workspace(of: "w2"), "w2")
        XCTAssertNil(index.workspace(of: "orphan"))
        XCTAssertEqual(index.tabs(in: "w1").map(\.id), ["t1", "t2", "t3", "t4", "t5"])
        XCTAssertEqual(index.children(of: "g1").map(\.id), ["t2", "g2"])
        XCTAssertEqual(index.inside("g1").tabs, 2)
        XCTAssertEqual(index.inside("g1").groups, 1)
        XCTAssertTrue(index.tabs(in: "w3").isEmpty)
    }

    /// A loop of parents puts its rows in no Workspace, and the index is
    /// still built.
    func testLoopOfParents() {
        let index = OutlineIndex(rows + [row("a", "b", .group, depth: 1), row("b", "a", .group, depth: 1),
                                         row("t7", "a", .tab, depth: 2)])
        XCTAssertNil(index.workspace(of: "t7"))
        XCTAssertNil(index.workspace(of: "a"))
        XCTAssertEqual(index.inside("a").tabs, 1)
        XCTAssertEqual(index.tabs(in: "w1").count, 5)
    }
}
