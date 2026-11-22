// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// A row of a test tree, with the fields drop planning reads.
private func row(_ id: String, _ parent: String?, _ kind: NodeKind, shares: [Double]? = nil) -> OutlineRow {
    OutlineRow(id: id, parentId: parent, depth: 0, kind: kind, name: kind == .split ? "" : id, url: nil, icon: nil,
               local: false, emoji: nil, label: nil, color: nil, transparency: nil, pinned: false, agent: nil,
               agentDevice: nil, device: nil, isolated: false, shares: shares)
}

/// An op as the engine reads it, with the absent keys left out as a
/// placement op leaves them.
private func op(_ pairs: KeyValuePairs<String, Any?>) -> NSDictionary {
    var dictionary: [String: Any] = [:]
    for (key, value) in pairs { dictionary[key] = value }
    return dictionary as NSDictionary
}

private func move(_ id: String, into parent: String, after previous: String?, before next: String?) -> NSDictionary {
    op(["kind": "moveNode", "id": id, "newParent": parent, "before": previous, "after": next])
}

private func ops(_ list: [[String: Any]]?) -> [NSDictionary]? {
    list?.map { $0 as NSDictionary }
}

private func ops(_ plan: DropPlan?) -> [NSDictionary]? {
    guard case .ops(let list) = plan else { return nil }
    return ops(list)
}

/// The desktop's `mixedDocument`: in `ws`, t-top, g-a (t-1, t-2, t-3,
/// g-inner), t-mid, g-b (t-4) and g-c.
private let mixed = OutlineIndex([
    row("ws", nil, .workspace),
    row("t-top", "ws", .tab),
    row("g-a", "ws", .group),
    row("t-1", "g-a", .tab),
    row("t-2", "g-a", .tab),
    row("t-3", "g-a", .tab),
    row("g-inner", "g-a", .group),
    row("t-mid", "ws", .tab),
    row("g-b", "ws", .group),
    row("t-4", "g-b", .tab),
    row("g-c", "ws", .group),
])

/// The desktop's split fixture: tabs t and u, splits s (a, b) and r (c, d),
/// a full split f (e, h, i, j) and a group g.
private let splits = OutlineIndex([
    row("ws", nil, .workspace),
    row("t", "ws", .tab),
    row("u", "ws", .tab),
    row("s", "ws", .split),
    row("a", "s", .tab),
    row("b", "s", .tab),
    row("r", "ws", .split),
    row("c", "r", .tab),
    row("d", "r", .tab),
    row("f", "ws", .split),
    row("e", "f", .tab),
    row("h", "f", .tab),
    row("i", "f", .tab),
    row("j", "f", .tab),
    row("g", "ws", .group),
])

/// Where a finger's place on a row drops what it carries, as the
/// desktop's `dropIntent` reads a pointer's.
final class DropIntentTests: XCTestCase {
    private let tab = DropOver(id: "t-mid", kind: .tab, expanded: false)
    private let closedGroup = DropOver(id: "g-b", kind: .group, expanded: false)
    private let openGroup = DropOver(id: "g-b", kind: .group, expanded: true)

    /// A 224-point row, 32 tall.
    private func kind(_ id: String, _ over: DropOver, y: CGFloat, x: CGFloat = 100, groups: Bool = true,
                      in tree: OutlineIndex = mixed) -> DropKind {
        tree.dropIntent(id, over: over, x: x, y: y, w: 224, h: 32, makesGroups: groups)
    }

    func testATabsEdgesGoBesideIt() {
        XCTAssertEqual(kind("t-top", tab, y: 4), .before)
        XCTAssertEqual(kind("t-top", tab, y: 28), .after)
    }

    func testATabsLeadingHalfMakesAGroupAndItsTrailingHalfASplit() {
        XCTAssertEqual(kind("t-top", tab, y: 16), .newGroup)
        XCTAssertEqual(kind("t-top", tab, y: 16, x: 111), .newGroup)
        XCTAssertEqual(kind("t-top", tab, y: 16, x: 112), .split)
        XCTAssertEqual(kind("t-top", tab, y: 16, x: 223), .split)
    }

    /// The private session makes no groups, so a tab's whole middle splits.
    func testWhereNoGroupsAreMadeTheWholeMiddleSplits() {
        XCTAssertEqual(kind("t-top", tab, y: 16, x: 10, groups: false), .split)
    }

    func testAClosedGroupsMiddleTakesATabOrAGroupIn() {
        XCTAssertEqual(kind("t-top", closedGroup, y: 16), .into)
        XCTAssertEqual(kind("g-a", closedGroup, y: 16), .into)
        XCTAssertEqual(kind("t-top", closedGroup, y: 28), .after)
        XCTAssertEqual(kind("t-top", closedGroup, y: 4), .before)
    }

    func testAGroupOnATabGoesBeforeOrAfterItByHalves() {
        XCTAssertEqual(kind("g-a", tab, y: 10), .before)
        XCTAssertEqual(kind("g-a", tab, y: 20), .after)
    }

    func testAnOpenGroupsLowerHalfIsItsFirstChildsPlace() {
        XCTAssertEqual(kind("t-top", openGroup, y: 20), .firstChild)
        XCTAssertEqual(kind("t-top", openGroup, y: 12), .before)
    }

    func testARowOnItselfDoesNothing() {
        XCTAssertEqual(kind("g-a", DropOver(id: "g-a", kind: .group, expanded: true), y: 16), .noop)
        XCTAssertEqual(kind("s", DropOver(id: "s", kind: .split, expanded: false), y: 14, in: splits), .noop)
    }

    func testAGroupIsRefusedInsideItself() {
        XCTAssertEqual(kind("g-a", DropOver(id: "t-2", kind: .tab, expanded: false), y: 16), .refused(full: false))
    }

    // The desktop's `a_rows_middle_groups_and_its_split_zone_combines`.

    private func split(_ id: String) -> DropOver { DropOver(id: id, kind: .split, expanded: false) }

    /// A 224-point row, 28 tall: its middle, or its split zone.
    private func onSplits(_ id: String, _ over: DropOver, zone: Bool) -> DropKind {
        splits.dropIntent(id, over: over, x: zone ? 200 : 100, y: 14, w: 224, h: 28, makesGroups: true)
    }

    func testASplitsMiddleGroupsAndItsSplitZoneCombines() {
        XCTAssertEqual(onSplits("t", split("s"), zone: false), .newGroup)
        XCTAssertEqual(onSplits("t", split("s"), zone: true), .join, "a tab joins")
        XCTAssertEqual(onSplits("r", split("s"), zone: true), .merge, "a split merges")
        XCTAssertEqual(onSplits("r", DropOver(id: "u", kind: .tab, expanded: false), zone: true), .split,
                       "a split on a tab splits")
        XCTAssertEqual(onSplits("c", split("s"), zone: true), .join, "a page joins")
    }

    func testADropPastFourPagesIsRefusedAsFull() {
        XCTAssertEqual(onSplits("t", split("f"), zone: true), .refused(full: true))
        XCTAssertEqual(onSplits("t", split("f"), zone: false), .newGroup, "the middle still makes a group")
        XCTAssertEqual(onSplits("r", split("f"), zone: true), .refused(full: true))
    }

    /// The phone reorders panes with Move Pane Left and Right, so a page on
    /// its own split does nothing.
    func testAPageOnItsOwnSplitDoesNothing() {
        XCTAssertEqual(onSplits("a", split("s"), zone: false), .noop)
        XCTAssertEqual(onSplits("a", split("s"), zone: true), .noop)
    }

    func testAGroupOnASplitGoesByHalvesAndATabIntoAClosedGroup() {
        XCTAssertEqual(onSplits("g", split("s"), zone: true), .after)
        XCTAssertEqual(onSplits("t", DropOver(id: "g", kind: .group, expanded: false), zone: false), .into)
    }
}

/// What a drop beside or into a row writes: the sibling pair the row
/// lands between, as the desktop's `dropTarget` names it.
final class DropTargetTests: XCTestCase {
    private func over(_ id: String) -> DropOver {
        DropOver(id: id, kind: mixed.row(id)!.kind, expanded: false)
    }

    private func plan(_ id: String, _ target: String, _ kind: DropKind, in tree: OutlineIndex = mixed) -> [NSDictionary]? {
        ops(tree.dropPlan(id, over: DropOver(id: target, kind: tree.row(target)!.kind, expanded: false), kind))
    }

    func testAGroupCanGoAboveATab() {
        XCTAssertEqual(plan("g-c", "t-top", .before), [move("g-c", into: "ws", after: nil, before: "t-top")])
    }

    func testATabCanGoBetweenTwoGroups() {
        XCTAssertEqual(plan("t-top", "g-b", .after), [move("t-top", into: "ws", after: "g-b", before: "g-c")])
    }

    func testBesideARowInsideAGroupIsInThatGroup() {
        XCTAssertEqual(plan("t-mid", "t-2", .after), [move("t-mid", into: "g-a", after: "t-2", before: "t-3")])
    }

    func testTheFirstChildsPlaceIsAheadOfTheFirstRow() {
        XCTAssertEqual(plan("t-top", "g-a", .firstChild), [move("t-top", into: "g-a", after: nil, before: "t-1")])
    }

    func testBelowTheLastRowIsTheEndOfTheWorkspace() {
        XCTAssertEqual(plan("t-1", "ws", .end), [move("t-1", into: "ws", after: "g-c", before: nil)])
    }

    func testIntoAGroupIsLast() {
        XCTAssertEqual(plan("t-top", "g-b", .into), [move("t-top", into: "g-b", after: "t-4", before: nil)])
    }

    func testADropThatLeavesARowWhereItIsWritesNothing() {
        XCTAssertNil(plan("t-top", "g-a", .before))
        XCTAssertNil(plan("g-c", "ws", .end), "including at the end, for what is already last")
        XCTAssertNil(plan("t-4", "g-b", .into), "and into the group it is in")
    }

    func testARowIsNeverDroppedBesideOrInsideItself() {
        XCTAssertNil(plan("g-a", "g-a", .after))
        XCTAssertNil(plan("g-a", "t-2", .before))
    }

    func testNoopAndRefusedWriteNothing() {
        XCTAssertNil(mixed.dropPlan("t-top", over: over("t-mid"), .noop))
        XCTAssertNil(mixed.dropPlan("t-top", over: over("t-mid"), .refused(full: true)))
    }

    // The desktop's `a_drop_beside_a_pane_goes_beside_its_split`.

    private let besideSplit = OutlineIndex([
        row("ws", nil, .workspace),
        row("t", "ws", .tab),
        row("s", "ws", .split),
        row("a", "s", .tab),
        row("b", "s", .tab),
        row("u", "ws", .tab),
    ])

    func testATabDroppedBesideAPaneLandsBesideItsSplit() {
        XCTAssertEqual(plan("t", "b", .after, in: besideSplit), [move("t", into: "ws", after: "s", before: "u")])
    }

    func testAPaneDroppedBesideAnotherOfItsSplitMovesWithinIt() {
        XCTAssertEqual(plan("b", "a", .before, in: besideSplit), [move("b", into: "s", after: nil, before: "a")])
    }

    func testNoGroupIsMadeInsideASplit() {
        XCTAssertNil(besideSplit.mergeTarget("t", "a"))
    }

    /// A pane dragged out of a split of two leaves an ordinary tab, its
    /// children kept so a pane another device added stays.
    func testAPaneDraggedOutOfASplitOfTwoSeparatesIt() {
        XCTAssertEqual(plan("a", "u", .after, in: besideSplit), [
            move("a", into: "ws", after: "u", before: nil),
            op(["kind": "removeKeepingChildren", "id": "s"]),
        ])
    }

    func testAPaneDraggedOutOfASplitOfThreeResetsItsWidths() {
        let tree = OutlineIndex([
            row("ws", nil, .workspace),
            row("s", "ws", .split, shares: [30, 30, 40]),
            row("a", "s", .tab),
            row("b", "s", .tab),
            row("c", "s", .tab),
        ])
        XCTAssertEqual(plan("a", "ws", .end, in: tree), [
            move("a", into: "ws", after: "s", before: nil),
            op(["kind": "setContent", "id": "s", "name": ""]),
        ])
    }
}

/// Where a new group of two rows goes, as the desktop's `mergeTarget`
/// puts it: where the target was.
final class MergeTargetTests: XCTestCase {
    func testTwoTabsMakeTheGroupWhereTheTargetIs() {
        XCTAssertEqual(mixed.mergeTarget("t-top", "t-mid"),
                       MergePlan(id: "t-top", target: "t-mid", parent: "ws", previous: "g-a", next: "t-mid"))
    }

    func testFromInsideAnotherGroupToo() {
        XCTAssertEqual(mixed.mergeTarget("t-1", "t-mid"),
                       MergePlan(id: "t-1", target: "t-mid", parent: "ws", previous: "g-a", next: "t-mid"))
    }

    func testATabOrGroupOnAGroupIsNoMerge() {
        XCTAssertNil(mixed.mergeTarget("t-top", "g-b"))
        XCTAssertNil(mixed.mergeTarget("g-b", "t-mid"))
        XCTAssertNil(mixed.mergeTarget("g-a", "g-inner"))
    }

    func testARowIsNoMergeWithItself() {
        XCTAssertNil(mixed.mergeTarget("t-top", "t-top"))
    }

    func testANewGroupDropPlansTheMerge() {
        guard case .merge(let plan) = mixed.dropPlan("t-top", over: DropOver(id: "t-mid", kind: .tab, expanded: false),
                                                     .newGroup) else { return XCTFail("no merge") }
        XCTAssertEqual(plan.target, "t-mid")
    }
}

/// What making, joining and merging splits writes, as the desktop's
/// `splitTogetherOps`, `joinSplitOps` and `mergeSplitsOps` write it.
final class SplitOpsTests: XCTestCase {
    func testTwoTabsSplitTogetherWhereTheTargetWasTargetFirst() throws {
        let written = try XCTUnwrap(splits.splitTogetherOps("u", "t"))
        let made = try XCTUnwrap(written.first?["id"] as? String)
        XCTAssertEqual(ops(written), [
            op(["kind": "addSplit", "parent": "ws", "id": made, "before": nil, "after": "u"]),
            move("u", into: made, after: nil, before: nil),
            move("t", into: made, after: "u", before: nil),
        ])
    }

    /// The dropped split goes with its children kept, so a pane another
    /// device moved into it is never deleted.
    func testADroppedSplitBringsItsPagesInOrderAndGoes() throws {
        let written = try XCTUnwrap(splits.splitTogetherOps("u", "r"))
        let made = try XCTUnwrap(written.first?["id"] as? String)
        XCTAssertEqual(ops(Array(written.suffix(3))), [
            move("c", into: made, after: "u", before: nil),
            move("d", into: made, after: "c", before: nil),
            op(["kind": "removeKeepingChildren", "id": "r"]),
        ])
    }

    func testAPageLeavingASplitOfTwoLeavesAnOrdinaryTab() {
        XCTAssertEqual(ops(splits.splitTogetherOps("u", "a"))?.last, op(["kind": "removeKeepingChildren", "id": "s"]))
    }

    func testFivePagesAreNoSplit() {
        XCTAssertNil(splits.splitTogetherOps("u", "f"))
    }

    func testASplitDropPlanIsTheSplitTogetherOps() {
        let plan = ops(splits.dropPlan("t", over: DropOver(id: "u", kind: .tab, expanded: false), .split))
        XCTAssertEqual(plan?.count, 3)
        XCTAssertEqual(plan?.first?["kind"] as? String, "addSplit")
    }

    func testAMergeAppendsTheDroppedSplitsPagesAndRemovesIt() {
        XCTAssertEqual(ops(splits.mergeSplitsOps("s", "r")), [
            move("c", into: "s", after: "b", before: nil),
            move("d", into: "s", after: "c", before: nil),
            op(["kind": "removeKeepingChildren", "id": "r"]),
        ])
        XCTAssertNil(splits.mergeSplitsOps("f", "r"), "past four pages")
        XCTAssertNil(splits.mergeSplitsOps("s", "s"), "onto itself")
    }

    func testAMergeSetsTheWidthsBackToEqual() {
        let tree = OutlineIndex([
            row("ws", nil, .workspace),
            row("s", "ws", .split, shares: [30, 70]),
            row("a", "s", .tab),
            row("b", "s", .tab),
            row("r", "ws", .split),
            row("c", "r", .tab),
            row("d", "r", .tab),
        ])
        XCTAssertEqual(ops(tree.mergeSplitsOps("s", "r"))?.last, op(["kind": "setContent", "id": "s", "name": ""]))
    }

    // The desktop's `a_tab_joins_a_split_at_its_end`.

    private func joinTree(panes: Int) -> OutlineIndex {
        OutlineIndex([row("ws", nil, .workspace), row("s", "ws", .split, shares: panes == 2 ? [30, 70] : nil)]
            + (0..<panes).map { row("p\($0)", "s", .tab) }
            + [row("x", "ws", .tab)])
    }

    func testATabJoinsASplitAsItsLastPaneWithEqualWidths() {
        XCTAssertEqual(ops(joinTree(panes: 2).joinSplitOps("s", "x")), [
            move("x", into: "s", after: "p1", before: nil),
            op(["kind": "setContent", "id": "s", "name": ""]),
        ])
    }

    func testOnlyATabFromOutsideJoins() {
        XCTAssertNil(joinTree(panes: 2).joinSplitOps("s", "p0"), "a pane does not join its own split")
        XCTAssertNil(joinTree(panes: 2).joinSplitOps("s", "ws"), "only a tab joins")
    }

    func testAFullSplitTakesNoMore() {
        XCTAssertNil(joinTree(panes: 4).joinSplitOps("s", "x"))
    }

    func testAJoinDropPlanIsTheJoinOps() {
        XCTAssertEqual(ops(joinTree(panes: 3).dropPlan("x", over: DropOver(id: "s", kind: .split, expanded: false),
                                                       .join)),
                       [move("x", into: "s", after: "p2", before: nil)])
    }
}

/// What keeps a split whole when panes leave it, as the desktop's
/// `splitShapeOps` writes it.
final class SplitShapeTests: XCTestCase {
    private func tree(shares: [Double]?) -> OutlineIndex {
        OutlineIndex([
            row("ws", nil, .workspace),
            row("s", "ws", .split, shares: shares),
            row("a", "s", .tab),
            row("b", "s", .tab),
            row("c", "s", .tab),
        ])
    }

    private func leaving(_ ids: [String], _ tree: OutlineIndex) -> [NSDictionary]? {
        ops(tree.splitShapeOps(leaving: ids.compactMap(tree.row)))
    }

    func testASplitLeftWithOneTabIsSeparated() {
        XCTAssertEqual(leaving(["a", "b"], tree(shares: nil)), [op(["kind": "removeKeepingChildren", "id": "s"])])
    }

    func testASplitLeftWithTwoGetsEqualWidths() {
        XCTAssertEqual(leaving(["a"], tree(shares: [30, 30, 40])), [op(["kind": "setContent", "id": "s", "name": ""])])
        XCTAssertEqual(leaving(["a"], tree(shares: nil)), [], "equal widths already need nothing")
    }

    func testASplitGoingWholeNeedsNothing() {
        XCTAssertEqual(leaving(["s"], tree(shares: [30, 30, 40])), [])
    }
}
