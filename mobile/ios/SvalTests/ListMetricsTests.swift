// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The list's room around coloured groups and where a held row's drop goes.
@MainActor
final class ListMetricsTests: XCTestCase {
    /// A Workspace with a tab, a coloured group holding a tab, a nested
    /// coloured group and another tab, then a tab.
    private let rows = [
        TreeLinesTests.row("w1", nil, .workspace),
        TreeLinesTests.row("t1", "w1", .tab, depth: 1),
        TreeLinesTests.row("g1", "w1", .group, depth: 1, color: "blue"),
        TreeLinesTests.row("t2", "g1", .tab, depth: 2),
        TreeLinesTests.row("g2", "g1", .group, depth: 2, color: "red"),
        TreeLinesTests.row("t3", "g2", .tab, depth: 3),
        TreeLinesTests.row("t4", "g1", .tab, depth: 2),
        TreeLinesTests.row("t5", "w1", .tab, depth: 1),
    ]

    /// Room opens above an outermost coloured group and below it, and
    /// nowhere inside it.
    func testRoomOpensAroundAnOutermostColouredGroup() {
        let sections = TreeLines.list(OutlineIndex(rows), workspace: "w1", collapsed: [])
        XCTAssertEqual(sections.map(\.id), ["w1#0", "g1#0", "g2#0", "g1#1", "w1#1"])
        XCTAssertEqual(sections.indices.map { ListMetrics.gapAbove(sections, $0) }, [false, true, false, false, true])
    }

    /// A closed group keeps its room, so opening it moves no row but those
    /// it shows.
    func testAClosedGroupKeepsItsRoom() {
        let sections = TreeLines.list(OutlineIndex(rows), workspace: "w1", collapsed: ["g1"])
        XCTAssertEqual(sections.indices.map { ListMetrics.gapAbove(sections, $0) }, [false, true, true])
    }

    // MARK: Reading a drag

    /// t1, t2, an open coloured group g1 holding a1 and a2, a closed group
    /// g2 holding b1, then t3.
    private let tree = OutlineIndex([
        TreeLinesTests.row("w1", nil, .workspace),
        TreeLinesTests.row("t1", "w1", .tab, depth: 1),
        TreeLinesTests.row("t2", "w1", .tab, depth: 1),
        TreeLinesTests.row("g1", "w1", .group, depth: 1, color: "blue"),
        TreeLinesTests.row("a1", "g1", .tab, depth: 2),
        TreeLinesTests.row("a2", "g1", .tab, depth: 2),
        TreeLinesTests.row("g2", "w1", .group, depth: 1, color: "red"),
        TreeLinesTests.row("b1", "g2", .tab, depth: 2),
        TreeLinesTests.row("t3", "w1", .tab, depth: 1),
    ])

    /// Each line 56pt tall, one under the other, with `strip` between the
    /// sections as the list's room around a coloured group leaves, in a
    /// 400pt list whose cells end at their section's trailing inset.
    private func spots(strip: CGFloat = 0) -> [ListSpot] {
        var y: CGFloat = 0
        var out: [ListSpot] = []
        for section in TreeLines.list(tree, workspace: "w1", collapsed: ["g2"]) {
            if !out.isEmpty { y += strip }
            let width = 400 - ListMetrics.sectionTrailing(section)
            for line in section.lines {
                out.append(ListSpot(line: line, frame: CGRect(x: 0, y: y, width: width, height: 56)))
                y += 56
            }
        }
        return out
    }

    private func aim(_ id: String, y: CGFloat, x: CGFloat = 300, strip: CGFloat = 0, ends: Bool = true) -> ListAim? {
        ListMetrics.aim(tree, dragged: id, spots: spots(strip: strip), at: CGPoint(x: x, y: y), workspace: "w1",
                        ends: ends, makesGroups: true)
    }

    private func line(_ aim: ListAim?) -> (y: CGFloat, depth: Int, kind: DropKind)? {
        guard case .line(let y, let depth, _, let kind) = aim else { return nil }
        return (y, depth, kind)
    }

    /// Between two top-level tabs, from either one's quarter beside the
    /// line, the line sits on their boundary at the top level.
    func testALineBetweenTopLevelTabs() {
        XCTAssertEqual(line(aim("t3", y: 56 + 5))?.y, 56, "t2's top quarter")
        XCTAssertEqual(line(aim("t3", y: 56 + 5))?.depth, 0)
        XCTAssertEqual(line(aim("t3", y: 56 - 5))?.y, 56, "t1's bottom quarter")
        XCTAssertEqual(line(aim("t3", y: 56 - 5))?.kind, .after)
        XCTAssertEqual(line(aim("t3", y: 56 + 12))?.y, 56,
                       "a quarter of the row, as the desktop's 8px of its 32px row: 12pt down a 56pt row")
    }

    /// Inside an open group the line is indented a level.
    func testALineInsideAGroup() {
        let between = line(aim("t1", y: 4 * 56 + 5))
        XCTAssertEqual(between?.y, 4 * 56, "a2's top quarter: between a1 and a2")
        XCTAssertEqual(between?.depth, 1)
        let first = line(aim("t1", y: 2 * 56 + 40))
        XCTAssertEqual(first?.kind, .firstChild, "an open group's lower half: first inside it")
        XCTAssertEqual(first?.y, 3 * 56)
        XCTAssertEqual(first?.depth, 1)
    }

    /// At a group's last row the two sides of one boundary differ: the last
    /// row's bottom quarter is the group's end, the next row's top quarter
    /// is after the group.
    func testAGroupsLastRowBoundary() {
        let end = line(aim("t1", y: 5 * 56 - 5))
        XCTAssertEqual(end?.y, 5 * 56)
        XCTAssertEqual(end?.depth, 1, "inside the group, at its end")
        let after = line(aim("t1", y: 5 * 56 + 5))
        XCTAssertEqual(after?.y, 5 * 56)
        XCTAssertEqual(after?.depth, 0, "after the group")
    }

    /// A landing that changes nothing shows nothing: the row's own slot and
    /// the boundaries on either side of it.
    func testALandingThatChangesNothingIsRefused() {
        XCTAssertNil(aim("t2", y: 56 + 20), "over the dragged row itself")
        XCTAssertNil(aim("t2", y: 56 - 5), "the boundary above it")
        XCTAssertNil(aim("t2", y: 2 * 56 + 5), "the boundary below it")
    }

    /// Off every row, the nearest row is read at its edge; below the last
    /// row is the Workspace's end.
    func testOffTheRowsTheNearestBoundary() {
        // The strip between t2's section and g1's: nearer t2's bottom.
        let strip = line(aim("t3", y: 2 * 56 + 1, strip: 4))
        XCTAssertEqual(strip?.y, 2 * 56, "the boundary under t2")
        XCTAssertEqual(strip?.kind, .after)
        let end = line(aim("t1", y: 7 * 56 + 30))
        XCTAssertEqual(end?.kind, .end)
        XCTAssertEqual(end?.y, 7 * 56)
        XCTAssertEqual(end?.depth, 0)
        XCTAssertEqual(line(aim("t1", y: 7 * 56 + 30, ends: false))?.kind, .after,
                       "below the last row drawn, with rows past it, the last row's bottom")
    }

    /// A tab's middle shows its halves; a closed group's middle takes the
    /// row into it.
    func testARowsMiddle() {
        guard case .middle(let id, _, let kind) = aim("t3", y: 56 + 28, x: 60) else { return XCTFail("a middle") }
        XCTAssertEqual(id, "t2")
        XCTAssertEqual(kind, .newGroup)
        guard case .middle(_, _, let into) = aim("t1", y: 5 * 56 + 28) else { return XCTFail("a middle") }
        XCTAssertEqual(into, .into)
    }

    /// A row's place: its indent, and the coloured groups around it.
    func testARowsPlaceInItsBlocks() {
        let line = TreeLine(id: "t3", depth: 2, panes: nil, tints: ["blue", "red"])
        let place = RowPlace(line)
        XCTAssertEqual(place.indent, 48)
        XCTAssertEqual(place.blocks.map(\.level), [0, 1])
        XCTAssertEqual(place.cardInset, 6)
        XCTAssertEqual(place.trailing, 6)
        XCTAssertEqual(place.cardLeading, 48)
        XCTAssertEqual(RowPlace(TreeLine(id: "t", depth: 1, panes: nil, tints: [nil, "red"])).blocks.map(\.level), [1],
                       "a plain group draws no block")
    }

    /// A section's cells end at the sheet's margin, or inside the nested
    /// group at its card, so their swipe actions end inside them.
    func testCellsEndAtTheirGroupsCard() {
        let sections = TreeLines.list(OutlineIndex(rows), workspace: "w1", collapsed: [])
        XCTAssertEqual(sections.map(\.id), ["w1#0", "g1#0", "g2#0", "g1#1", "w1#1"])
        let margin = ListMetrics.inset
        XCTAssertEqual(sections.map(ListMetrics.sectionTrailing), [margin, margin, margin + 6, margin, margin])
    }

    /// Separators run only between two tab or split rows of a section:
    /// never below a group's own row or above one, never after a section's
    /// last row, and never against the row in front.
    func testSeparatorsRunOnlyBetweenRows() {
        let sections = TreeLines.list(OutlineIndex(rows), workspace: "w1", collapsed: [])
        func below(_ front: String?) -> [[Bool]] {
            sections.map { section in
                section.lines.indices.map { index in
                    ListMetrics.separatesBelow(section.lines, at: index) { $0.id == front }
                }
            }
        }
        // w1#0: t1; g1#0: g1's row, t2; g2#0: g2's row, t3; g1#1: t4; w1#1: t5.
        XCTAssertEqual(sections.map { $0.lines.map(\.id) }, [["t1"], ["g1", "t2"], ["g2", "t3"], ["t4"], ["t5"]])
        XCTAssertEqual(below(nil), [[false], [false, false], [false, false], [false], [false]])
        let flat = [TreeLine(id: "a", depth: 1, panes: nil), TreeLine(id: "b", depth: 1, panes: nil),
                    TreeLine(id: "c", depth: 1, panes: ["p1", "p2"]), TreeLine(id: "d", depth: 1, panes: nil)]
        XCTAssertEqual(flat.indices.map { ListMetrics.separatesBelow(flat, at: $0) { _ in false } },
                       [true, true, true, false])
        XCTAssertEqual(flat.indices.map { ListMetrics.separatesBelow(flat, at: $0) { $0.id == "b" } },
                       [false, false, true, false], "none against the row in front")
    }

    /// A row's highlight keeps to its group's card: from the front card's
    /// leading edge, or the sheet's margin outside any coloured group, to
    /// the cell's end, which the section sets.
    func testARowsBackgroundKeepsToItsGroupsCard() {
        let nested = RowPlace(TreeLine(id: "t3", depth: 2, panes: nil, tints: ["blue", "red"])).backgroundInsets
        XCTAssertEqual(nested.leading, ListMetrics.inset + 48)
        XCTAssertEqual(nested.trailing, 0)
        let plain = RowPlace(TreeLine(id: "t1", depth: 0, panes: nil)).backgroundInsets
        XCTAssertEqual(plain.leading, ListMetrics.inset)
        XCTAssertEqual(plain.trailing, 0)
    }
}
