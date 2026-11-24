// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import XCTest
@testable import Sval

/// What each change to the tree or the sheet asks of the grid's collection
/// view: a change to one card touches that card alone.
@MainActor
final class TreeUpdateTests: XCTestCase {
    private let look = TreeLook(scheme: .light, tint: nil, sideways: false, size: .large)

    private func state(_ rows: [OutlineRow] = TreeLinesTests.rows, collapsed: Set<String> = [], editing: Bool = false,
                       ticked: Set<String> = [], look: TreeLook? = nil) -> TreeState {
        TreeState(sections: TreeLines.grid(OutlineIndex(rows), workspace: "w1", collapsed: collapsed),
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
        XCTAssertEqual(TreeUpdate.between(nil, state()), TreeUpdate(apply: true))
    }

    /// A title, an address or an emoji reaches the card through its row's
    /// box, so the collection view is asked for nothing.
    func testAContentChangeAsksForNothing() {
        let renamed = changed("t2") { $0.name = "Renamed" }
        XCTAssertEqual(TreeUpdate.between(state(), state(renamed)), TreeUpdate())
        let moved = changed("t2") { $0.url = "https://elsewhere.example/" }
        XCTAssertEqual(TreeUpdate.between(state(), state(moved)), TreeUpdate())
    }

    func testATickTouchesOneCard() {
        XCTAssertEqual(TreeUpdate.between(state(editing: true), state(editing: true, ticked: ["t2"])),
                       TreeUpdate(reconfigure: ["t2"]))
    }

    func testEditingTouchesEveryCard() {
        XCTAssertEqual(TreeUpdate.between(state(), state(editing: true)), TreeUpdate(reconfigure: allCards))
    }

    /// A group's colour is its box's: the layout is built again, and no
    /// card is.
    func testAColourChangeRedrawsTheBoxes() {
        let recoloured = changed("g1") { $0.color = "red" }
        XCTAssertEqual(TreeUpdate.between(state(), state(recoloured)), TreeUpdate(relayout: true))
    }

    func testClosingAGroupDropsItsCardsAndRedrawsItsHeader() {
        let update = TreeUpdate.between(state(), state(collapsed: ["g2"]))
        XCTAssertTrue(update.apply)
        XCTAssertTrue(update.relayout)
        XCTAssertEqual(update.headers, ["g2#0"])
        XCTAssertEqual(update.reconfigure, [])
    }

    /// A tab closed outside every group: the snapshot drops its card, and
    /// no other card, header or layout is touched.
    func testClosingATabTouchesNoOtherCard() {
        let closed = TreeLinesTests.rows.filter { $0.id != "t5" }
        XCTAssertEqual(TreeUpdate.between(state(), state(closed)), TreeUpdate(apply: true))
    }

    /// A tab closed in a group changes its header's count.
    func testClosingATabInAGroupRedrawsItsHeader() {
        let closed = TreeLinesTests.rows.filter { $0.id != "t4" }
        let update = TreeUpdate.between(state(), state(closed))
        XCTAssertEqual(update.reconfigure, [])
        XCTAssertEqual(update.headers, ["g1#0"])
    }

    /// A card moved into a group is drawn again at the group's depth.
    func testACardMovedInIsDrawnAgain() {
        let moved = TreeLinesTests.rows.filter { $0.id != "t1" } + [TreeLinesTests.row("t1", "g1", .tab, depth: 2)]
        let update = TreeUpdate.between(state(), state(moved))
        XCTAssertTrue(update.apply)
        XCTAssertEqual(update.reconfigure, ["t1"])
    }

    private func list(_ rows: [OutlineRow] = TreeLinesTests.rows, collapsed: Set<String> = [], editing: Bool = false,
                      ticked: Set<String> = [], marked: Set<String> = [], dimmed: Set<String> = []) -> TreeState {
        TreeState(sections: TreeLines.list(OutlineIndex(rows), workspace: "w1", collapsed: collapsed),
                  editing: editing, ticked: ticked, look: look, marked: marked, dimmed: dimmed)
    }

    /// A lifted group dims in place: its rows are drawn again, and its box
    /// with them; nothing moves.
    func testALiftedGroupDimsInPlace() {
        let update = TreeUpdate.between(list(), list(dimmed: ["g2", "t3"]))
        XCTAssertFalse(update.apply, "no row moves")
        XCTAssertEqual(update.reconfigure, ["g2", "t3"])
        XCTAssertTrue(update.relayout, "the box dims")
    }

    func testAListRenameAsksForNothing() {
        let renamed = changed("t2") { $0.name = "Renamed" }
        XCTAssertEqual(TreeUpdate.between(list(), list(renamed)), TreeUpdate())
    }

    func testAListTickTouchesOneRow() {
        XCTAssertEqual(TreeUpdate.between(list(editing: true), list(editing: true, ticked: ["t4"])),
                       TreeUpdate(reconfigure: ["t4"]))
    }

    /// A merge waiting on its new group's name outlines its two rows.
    func testAMergeOutlinesItsTwoRows() {
        XCTAssertEqual(TreeUpdate.between(list(), list(marked: ["t1", "t5"])), TreeUpdate(reconfigure: ["t1", "t5"]))
    }

    /// Closing a group drops its rows, and its own row is drawn again
    /// with its chevron turned.
    func testClosingAGroupInTheListRedrawsItsRowAlone() {
        let update = TreeUpdate.between(list(), list(collapsed: ["g2"]))
        XCTAssertTrue(update.apply)
        XCTAssertEqual(update.reconfigure, ["g2"])
    }

    /// A group's colour is in each of its rows' text: every row inside it
    /// is drawn again, and none outside it.
    func testAListColourChangeRedrawsTheGroupsRows() {
        let recoloured = changed("g1") { $0.color = "red" }
        let update = TreeUpdate.between(list(), list(recoloured))
        XCTAssertEqual(update.reconfigure, ["g1", "t2", "g2", "t3", "t4"])
        XCTAssertTrue(update.relayout)
    }

    func testANewLookTouchesEverything() {
        let dark = TreeLook(scheme: .dark, tint: nil, sideways: false, size: .large)
        let update = TreeUpdate.between(state(), state(look: dark))
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
        let actions = TreeActions(open: { _ in }, toggle: { _ in }, close: { _ in }, closeSplit: { _, _ in },
                                  move: { _ in }, drop: { _ in }, tabMenu: { _ in UIMenu() },
                                  splitMenu: { _, _ in UIMenu() }, groupMenu: { _ in [] }, paneMenu: { _, _, _ in [] },
                                  openPane: { _ in }, pinOpened: {})
        let grid = TreeView(model: model, workspace: workspace, layout: .grid, collapsed: [], editing: false,
                            selected: [], marked: [], scheme: .light, tint: nil, sideways: false, reduceMotion: false,
                            dropState: TreeDropState(), actions: actions)
        let coordinator = grid.makeCoordinator()
        _ = coordinator.make(grid)
        let box = try XCTUnwrap(model.treeStore.box(tab.id))
        await model.rename(tab, to: "Renamed here")
        XCTAssertEqual(box.row.title, "Renamed here", "the tab's own box carries the new name")
        XCTAssertEqual(coordinator.update(grid), TreeUpdate(), "the grid is asked for nothing")
    }

    /// The list, over the same model: a rename asks its collection view
    /// for nothing.
    func testARenameTouchesNoRow() async throws {
        let model = try await harness.launch()
        let workspace = try XCTUnwrap(model.browser.workspaceId)
        let id = AppHarness.id()
        _ = await model.editTree([["kind": "addTab", "parent": workspace, "name": "Tab", "url": "about:blank", "id": id]])
        let tab = try XCTUnwrap(model.row(id))
        let actions = TreeActions(open: { _ in }, toggle: { _ in }, close: { _ in }, closeSplit: { _, _ in },
                                  move: { _ in }, drop: { _ in }, tabMenu: { _ in UIMenu() },
                                  splitMenu: { _, _ in UIMenu() }, groupMenu: { _ in [] }, paneMenu: { _, _, _ in [] },
                                  openPane: { _ in }, pinOpened: {})
        let list = TreeView(model: model, workspace: workspace, layout: .list, collapsed: [], editing: false,
                            selected: [], marked: [], scheme: .light, tint: nil, sideways: false, reduceMotion: false,
                            dropState: TreeDropState(), actions: actions)
        let coordinator = list.makeCoordinator()
        _ = coordinator.make(list)
        await model.rename(tab, to: "Renamed here")
        XCTAssertEqual(coordinator.update(list), TreeUpdate(), "the list is asked for nothing")
    }
}
