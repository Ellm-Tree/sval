// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The pages let go past the cap on live pages.
@MainActor
final class LivePagesTests: XCTestCase {
    private let pins = (0..<4).map { Browser.pinKey("pin-\($0)", in: "workspace") }

    /// Each page's last time in front: the tabs' and pins' interleaved.
    private func usedAt(_ ids: [String]) -> (String) -> Double {
        let order = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, Double($0)) })
        return { order[$0] ?? 0 }
    }

    func testPinsCountTowardTheCap() {
        let tabs = (0..<8).map { "tab-\($0)" }
        let ids = [tabs[0], pins[0], tabs[1], pins[1], tabs[2], tabs[3], pins[2], tabs[4], tabs[5], pins[3],
                   tabs[6], tabs[7]]
        let over = Browser.pastLimit(ids.shuffled(), counts: { _ in true }, usedAt: usedAt(ids))
        XCTAssertEqual(over, [tabs[0], pins[0]])
    }

    func testTenPagesWithPinsAreAllKept() {
        let ids = (0..<6).map { "tab-\($0)" } + pins
        XCTAssertEqual(Browser.pastLimit(ids, counts: { _ in true }, usedAt: usedAt(ids)), [])
    }

    /// Tabs alone are let go in the same order.
    func testTabsGoLeastRecentlyInFrontFirst() {
        let tabs = (0..<13).map { "tab-\($0)" }
        let over = Browser.pastLimit(tabs.reversed(), counts: { _ in true }, usedAt: usedAt(tabs))
        XCTAssertEqual(over, Array(tabs.prefix(3)))
    }

    /// A page `counts` leaves out, as a window's page before its tab, is
    /// neither counted nor let go.
    func testAPageLeftUncountedStays() {
        let tabs = (0..<11).map { "tab-\($0)" }
        let over = Browser.pastLimit(["opening"] + tabs, counts: { $0 != "opening" }, usedAt: usedAt(tabs))
        XCTAssertEqual(over, ["tab-0"])
    }
}
