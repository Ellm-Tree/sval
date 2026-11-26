// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Where a swipe of the bar goes, and whether letting go switches.
@MainActor
final class BarSwipeTests: XCTestCase {
    private let order = ["w1", "w2", "w3"].map { TreeLinesTests.row($0, nil, .workspace) }

    func testASwipeLeftGoesToTheNextWorkspaceAndWraps() {
        XCTAssertEqual(BarSwipeSession.next(in: order, from: "w1", offset: -10)?.id, "w2")
        XCTAssertEqual(BarSwipeSession.next(in: order, from: "w3", offset: -10)?.id, "w1")
    }

    func testASwipeRightGoesToTheOneBeforeAndWraps() {
        XCTAssertEqual(BarSwipeSession.next(in: order, from: "w2", offset: 10)?.id, "w1")
        XCTAssertEqual(BarSwipeSession.next(in: order, from: "w1", offset: 10)?.id, "w3")
    }

    func testOneWorkspaceHasNowhereToGo() {
        XCTAssertNil(BarSwipeSession.next(in: [order[0]], from: "w1", offset: -10))
    }

    func testLettingGoPastAThirdSwitches() {
        XCTAssertFalse(BarSwipeSession.switches(offset: -110, predicted: -110, width: 400))
        XCTAssertTrue(BarSwipeSession.switches(offset: -130, predicted: -130, width: 400))
    }

    func testAFlickSwitchesOnlyTheWayTheBarMoved() {
        XCTAssertTrue(BarSwipeSession.switches(offset: -40, predicted: -260, width: 400))
        XCTAssertFalse(BarSwipeSession.switches(offset: 40, predicted: -260, width: 400))
    }
}
