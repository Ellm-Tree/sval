// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The tabs in front a pass gives back, worked out only when the tree's
/// change may have moved a row, against working them out after every pass
/// from the whole outline.
@MainActor
final class TabsInFrontTests: XCTestCase {
    /// The edits the gated run makes for `read`, after a pass whose whole
    /// outline is `after`, and the edits the ungated run makes.
    private func both(_ before: OutlineIndex, _ read: TreeRead, after: [OutlineRow],
                      inFront: Set<String>) -> (gated: NSArray, ungated: NSArray) {
        var gated: [[String: Any]] = []
        if case .whole(_, let rows) = read {
            gated = AppModel.keptInFrontOps(before, after: rows, privateIds: [], inFront: inFront.contains)
        }
        let ungated = AppModel.keptInFrontOps(before, after: after, privateIds: [], inFront: inFront.contains)
        return (gated as NSArray, ungated as NSArray)
    }

    func testTheGatedPassGivesBackWhatEveryPassWould() async {
        let id = TwoDevices.id
        let devices = TwoDevices()
        let store = TreeStore()
        let inFront: Set<String> = [id(3), id(5)]
        devices.desktopEdits(#"""
            [{"kind":"addWorkspace","name":"Work","id":"\#(id(1))"},
             {"kind":"addWorkspace","name":"Home","id":"\#(id(8))"},
             {"kind":"addGroup","parent":"\#(id(1))","name":"Docs","id":"\#(id(2))"},
             {"kind":"addTab","parent":"\#(id(2))","name":"One","url":"https://one.example/","id":"\#(id(3))"},
             {"kind":"addTab","parent":"\#(id(1))","name":"Two","url":"https://two.example/","id":"\#(id(4))"},
             {"kind":"addTab","parent":"\#(id(1))","name":"Three","url":"https://three.example/","id":"\#(id(5))"}]
            """#)
        devices.phoneSyncs()
        await store.refresh(from: devices.phone, own: [])
        let steps: [(String, () -> Void)] = [
            ("a tab in front renamed elsewhere", {
                devices.desktopEdits(#"[{"kind":"rename","id":"\#(id(3))","name":"Uno"}]"#)
            }),
            ("a tab behind closed elsewhere", {
                devices.desktopEdits(#"[{"kind":"remove","id":"\#(id(4))"}]"#)
            }),
            ("a tab in front closed elsewhere", {
                devices.desktopEdits(#"[{"kind":"remove","id":"\#(id(5))"}]"#)
            }),
            ("a tab in front's group moved elsewhere", {
                devices.desktopEdits(#"[{"kind":"moveNode","id":"\#(id(2))","newParent":"\#(id(8))"}]"#)
            }),
            ("a tab in front labelled elsewhere", {
                devices.desktopEdits(#"[{"kind":"setLabel","id":"\#(id(3))","label":"Mine"}]"#)
            }),
            ("a tab in front's group closed elsewhere", {
                devices.desktopEdits(#"[{"kind":"remove","id":"\#(id(2))"}]"#)
            }),
            ("a tab in front's Workspace closed elsewhere", {
                devices.desktopEdits(#"[{"kind":"remove","id":"\#(id(8))"}]"#)
            }),
            ("nothing elsewhere", {}),
        ]
        var gaveBack = 0
        for (name, step) in steps {
            step()
            let before = store.index
            devices.phoneSyncs()
            let read = devices.phone.treeRead(since: store.revision)
            let (gated, ungated) = both(before, read, after: devices.phone.outline(), inFront: inFront)
            XCTAssertEqual(gated, ungated, name)
            gaveBack += ungated.count
            store.install(read, own: [])
        }
        XCTAssertGreaterThan(gaveBack, 0, "the run reached a tab given back")
    }

    /// A peer that moves a tab in front's group under a node of a kind a
    /// newer build wrote takes the tab out of the outline. The engine reads
    /// that change as structural (`ffi::a_group_moved_out_of_reach_is_a_structural_change`),
    /// so the gated pass works it out from the whole outline as every pass
    /// would.
    func testAGroupMovedOutOfReachGivesItsTabBack() {
        func row(_ id: String, _ parent: String?, _ kind: NodeKind, depth: UInt32) -> OutlineRow {
            OutlineRow(id: id, parentId: parent, depth: depth, kind: kind, name: id, url: kind == .tab ? "https://\(id).example/" : nil,
                       icon: nil, local: false, emoji: nil, label: nil, color: nil, transparency: nil, pinned: false,
                       agent: nil, agentDevice: nil, device: nil, isolated: false, shares: nil)
        }
        let before = OutlineIndex([row("w", nil, .workspace, depth: 0), row("board", "w", .unknown("board"), depth: 1),
                                   row("g", "w", .group, depth: 1), row("t", "g", .tab, depth: 2),
                                   row("x", "w", .tab, depth: 1)])
        let after = [row("w", nil, .workspace, depth: 0), row("board", "w", .unknown("board"), depth: 1),
                     row("x", "w", .tab, depth: 1)]
        let (gated, ungated) = both(before, .whole(revision: 2, after), after: after, inFront: ["t"])
        XCTAssertEqual(gated, ungated)
        XCTAssertEqual(ungated.count, 1, "the tab comes back")
    }
}
