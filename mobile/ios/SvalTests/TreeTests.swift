// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Where the phone's tree changes put a row, as the desktop's panel puts
/// it.
@MainActor
final class TreeTests: XCTestCase {
    /// An undo names both neighbours, so the row goes back between them.
    func testNeighboursAreTheSiblingsEitherSide() {
        let siblings = ["a", "b", "c", "d"]
        XCTAssertTrue(AppModel.neighbours(of: "b", among: siblings) == ("a", "c"))
        XCTAssertTrue(AppModel.neighbours(of: "a", among: siblings) == (nil, "b"))
        XCTAssertTrue(AppModel.neighbours(of: "d", among: siblings) == ("c", nil))
        XCTAssertTrue(AppModel.neighbours(of: "x", among: siblings) == (nil, nil))
    }

    /// Rows moving back together: the next neighbour is the first that
    /// stays, since those moving back ahead of it are placed first.
    func testNeighboursSkipRowsMovingBackTogether() {
        let siblings = ["a", "b", "c", "d"]
        XCTAssertTrue(AppModel.neighbours(of: "b", among: siblings, skipping: ["b", "c"]) == ("a", "d"))
        XCTAssertTrue(AppModel.neighbours(of: "c", among: siblings, skipping: ["b", "c"]) == ("b", "d"))
    }
}

/// A favorite's or pin's address as the desktop stores it, so two
/// spellings of one address are one favorite.
@MainActor
final class StoredAddressTests: XCTestCase {
    func testTypedAddressesAreStoredAsTheDesktopStoresThem() throws {
        let cases = [
            ("example.com", "https://example.com/"),
            ("HTTPS://Example.COM", "https://example.com/"),
            ("https://example.com:443/a?b=c", "https://example.com/a?b=c"),
            ("http://example.com:8080", "http://example.com:8080/"),
        ]
        for (typed, stored) in cases {
            let url = try XCTUnwrap(Address.typed(typed), typed)
            XCTAssertEqual(AppModel.normalAddress(url), stored, typed)
        }
        XCTAssertNil(Address.typed("not an address"))
    }
}

/// Where Move to puts what moves, as the desktop's `moveIntoTargets` does.
@MainActor
final class MoveIntoTests: XCTestCase {
    private func order(_ staying: [(String, Bool)], _ moving: [(String, Bool)]) -> [String] {
        AppModel.moveIntoOrder(staying: staying.map { ($0.0, $0.1) }, moving: moving.map { ($0.0, $0.1) })
            .map { "\($0.id):\($0.previous ?? "-"):\($0.next ?? "-")" }
    }

    func testTabsGoToTheEnd() {
        XCTAssertEqual(order([("g", true), ("t", false)], [("a", false), ("b", false)]),
                       ["a:t:-", "b:a:-"])
    }

    func testGroupsGoAfterTheGroupsThatStay() {
        XCTAssertEqual(order([("g", true), ("t", false)], [("h", true), ("a", false)]),
                       ["h:g:t", "a:t:-"])
        XCTAssertEqual(order([("t", false)], [("h", true)]), ["h:-:t"])
    }

    func testIntoAnEmptyContainer() {
        XCTAssertEqual(order([], [("a", false), ("h", true)]), ["h:-:-", "a:h:-"])
    }
}

/// Where a new group holding a selection goes, as the desktop's
/// `groupSelectionTarget` puts it: in the first member's place.
@MainActor
final class GroupSelectionTests: XCTestCase {
    func testTheGroupTakesTheFirstMembersPlace() {
        let siblings = ["a", "b", "c", "d", "e"]
        XCTAssertTrue(AppModel.selectionSlot(among: siblings, anchor: "b", members: ["b", "d"]) == ("a", "c"))
        XCTAssertTrue(AppModel.selectionSlot(among: siblings, anchor: "a", members: ["a"]) == (nil, "b"))
        XCTAssertTrue(AppModel.selectionSlot(among: siblings, anchor: "d", members: ["d", "e"]) == ("c", nil))
    }
}
