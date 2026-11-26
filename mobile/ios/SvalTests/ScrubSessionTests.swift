// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The scrub under way: where the finger takes the strip, and when it lets
/// go without switching.
@MainActor
final class ScrubSessionTests: XCTestCase {
    private let strip = CGRect(x: 0, y: 400, width: 390, height: 300)
    /// Where the finger starts, on the address under the strip.
    private let origin = CGPoint(x: 195, y: 780)

    private func opened() -> ScrubSession {
        let session = ScrubSession()
        let items = TabScrub.pages(in: "w1", index: OutlineIndex(TreeLinesTests.rows))
        session.open(TabScrub(kind: .tabs, items: items, start: 0))
        session.stripFrame = strip
        XCTAssertTrue(session.move(to: origin))
        return session
    }

    func testOpeningAndClosingShowAndHideTheStrip() {
        let session = opened()
        XCTAssertTrue(session.isOpen)
        session.close()
        XCTAssertFalse(session.isOpen)
        XCTAssertNil(session.scrub)
    }

    func testASlideStepsThroughThePages() {
        let session = opened()
        XCTAssertTrue(session.move(to: CGPoint(x: origin.x + TabScrub.step * 2, y: origin.y)))
        XCTAssertEqual(session.scrub?.index, 2)
        XCTAssertEqual(session.finger, CGPoint(x: origin.x + TabScrub.step * 2, y: origin.y))
    }

    func testDraggingDownOffTheAddressLetsGo() {
        let session = opened()
        XCTAssertTrue(session.move(to: CGPoint(x: origin.x, y: origin.y + 30)), "a short drag down holds")
        XCTAssertFalse(session.move(to: CGPoint(x: origin.x, y: origin.y + 40)))
    }

    func testLeavingTheStripLetsGoOnlyOnceTheFingerHasBeenOnIt() {
        let session = opened()
        XCTAssertTrue(session.move(to: CGPoint(x: 195, y: 300)), "a finger never on the strip holds above it")
        XCTAssertTrue(session.move(to: CGPoint(x: 195, y: 500)))
        XCTAssertFalse(session.move(to: CGPoint(x: 195, y: 300)), "a finger that was on the strip lets go above it")
    }

    func testAFingerThatLetsGoLeavesTheStripWhereItWas() {
        let session = opened()
        XCTAssertTrue(session.move(to: CGPoint(x: origin.x + TabScrub.step, y: origin.y)))
        XCTAssertFalse(session.move(to: CGPoint(x: origin.x + TabScrub.step * 3, y: origin.y + 40)))
        XCTAssertEqual(session.scrub?.index, 1)
    }
}
