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

    /// A let-go swipe starts at the finger's speed, measured in the share
    /// of the distance left that it covers in a second.
    func testALetGoSwipeStartsAtTheFingersSpeed() {
        XCTAssertEqual(Motion.releaseVelocity(-600, from: -100, to: -400), 2, "600pt/s with 300pt left")
        XCTAssertEqual(Motion.releaseVelocity(300, from: -100, to: 0), 3, "back toward rest")
        XCTAssertEqual(Motion.releaseVelocity(200, from: -100, to: -400), -200.0 / 300,
                       "a finger heading away starts the bar backward")
        XCTAssertEqual(Motion.releaseVelocity(500, from: 0, to: 0), 0, "nothing left to cover")
    }
}
