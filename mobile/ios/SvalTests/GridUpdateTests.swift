// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import XCTest
@testable import Sval

/// What each change to the tree or the sheet asks of the grid's collection
/// view: a change to one card touches that card alone.
@MainActor
final class GridUpdateTests: XCTestCase {
    private let look = GridLook(scheme: .light, tint: nil, sideways: false, size: .large)

    private func state(_ rows: [OutlineRow] = TreeLinesTests.rows, collapsed: Set<String> = [], editing: Bool = false,
                       ticked: Set<String> = [], look: GridLook? = nil) -> GridState {
        GridState(sections: TreeLines.grid(OutlineIndex(rows), workspace: "w1", collapsed: collapsed),
                  editing: editing, ticked: ticked, look: look ?? self.look)
    }

    private func changed(_ id: String, _ change: (inout OutlineRow) -> Void) -> [OutlineRow] {
        TreeLinesTests.rows.map { row in
            var row = row
            if row.id == id { change(&row) }
            return row
        }
    }

    private var allCards: [String] { ["t1", "t2", "t3", "t4", "s1", "p3", "t5"] }

    func testTheFirstStateAppliesASnapshot() {
        XCTAssertEqual(GridUpdate.between(nil, state()), GridUpdate(apply: true))
    }

    /// A title, an address or an emoji reaches the card through its row's
    /// box, so the collection view is asked for nothing.
    func testAContentChangeAsksForNothing() {
        let renamed = changed("t2") { $0.name = "Renamed" }
        XCTAssertEqual(GridUpdate.between(state(), state(renamed)), GridUpdate())
        let moved = changed("t2") { $0.url = "https://elsewhere.example/" }
        XCTAssertEqual(GridUpdate.between(state(), state(moved)), GridUpdate())
    }

    func testATickTouchesOneCard() {
        XCTAssertEqual(GridUpdate.between(state(editing: true), state(editing: true, ticked: ["t2"])),
                       GridUpdate(reconfigure: ["t2"]))
    }

    func testEditingTouchesEveryCard() {
        XCTAssertEqual(GridUpdate.between(state(), state(editing: true)), GridUpdate(reconfigure: allCards))
    }

    /// A group's colour is its box's: the layout is built again, and no
    /// card is.
    func testAColourChangeRedrawsTheBoxes() {
        let recoloured = changed("g1") { $0.color = "red" }
        XCTAssertEqual(GridUpdate.between(state(), state(recoloured)), GridUpdate(relayout: true))
    }

    func testClosingAGroupDropsItsCardsAndRedrawsItsHeader() {
        let update = GridUpdate.between(state(), state(collapsed: ["g2"]))
        XCTAssertTrue(update.apply)
        XCTAssertTrue(update.relayout)
        XCTAssertEqual(update.headers, ["g2#0"])
        XCTAssertEqual(update.reconfigure, [])
    }

    /// A tab closed outside every group: the snapshot drops its card, and
    /// no other card, header or layout is touched.
    func testClosingATabTouchesNoOtherCard() {
        let closed = TreeLinesTests.rows.filter { $0.id != "t5" }
        XCTAssertEqual(GridUpdate.between(state(), state(closed)), GridUpdate(apply: true))
    }

    /// A tab closed in a group changes its header's count.
    func testClosingATabInAGroupRedrawsItsHeader() {
        let closed = TreeLinesTests.rows.filter { $0.id != "t4" }
        let update = GridUpdate.between(state(), state(closed))
        XCTAssertEqual(update.reconfigure, [])
        XCTAssertEqual(update.headers, ["g1#0"])
    }

    /// A card moved into a group is drawn again at the group's depth.
    func testACardMovedInIsDrawnAgain() {
        let moved = TreeLinesTests.rows.filter { $0.id != "t1" } + [TreeLinesTests.row("t1", "g1", .tab, depth: 2)]
        let update = GridUpdate.between(state(), state(moved))
        XCTAssertTrue(update.apply)
        XCTAssertEqual(update.reconfigure, ["t1"])
    }

    func testANewLookTouchesEverything() {
        let dark = GridLook(scheme: .dark, tint: nil, sideways: false, size: .large)
        let update = GridUpdate.between(state(), state(look: dark))
        XCTAssertFalse(update.apply)
        XCTAssertTrue(update.relayout)
        XCTAssertEqual(update.reconfigure, allCards)
        XCTAssertEqual(update.headers, ["g1#0", "g2#0"])
    }
}

/// The grid over the real model: a rename made on the phone reaches the
/// tree as a change of content, and the grid's collection view is asked
/// for nothing.
@MainActor
final class GridOverModelTests: AppModelTestCase {
    func testARenameTouchesNoCell() async throws {
        let model = try await harness.launch()
        let workspace = try XCTUnwrap(model.browser.workspaceId)
        let id = AppHarness.id()
        _ = await model.editTree([["kind": "addTab", "parent": workspace, "name": "Tab", "url": "about:blank", "id": id]])
        let tab = try XCTUnwrap(model.row(id))
        let actions = GridActions(open: { _ in }, toggle: { _ in }, close: { _ in }, closeSplit: { _, _ in },
                                  drop: { _ in }, tabMenu: { _ in UIMenu() }, splitMenu: { _, _ in UIMenu() },
                                  groupMenu: { _ in [] })
        let grid = TabGridView(model: model, workspace: workspace, collapsed: [], editing: false, selected: [],
                               scheme: .light, tint: nil, sideways: false, dropState: GridDropState(),
                               actions: actions)
        let coordinator = grid.makeCoordinator()
        _ = coordinator.make(grid)
        let box = try XCTUnwrap(model.treeStore.box(tab.id))
        await model.rename(tab, to: "Renamed here")
        XCTAssertEqual(box.row.title, "Renamed here", "the tab's own box carries the new name")
        XCTAssertEqual(coordinator.update(grid), GridUpdate(), "the grid is asked for nothing")
    }
}
