// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// History pages ranked by Firefox's frecency (`CalculateFrecencyFunction`).
final class HistoryTests: XCTestCase {
    private let day = 86_400_000.0

    private func visit(_ url: String, day at: Double, _ transition: UInt32) -> Visit {
        let json = #"{"id":"\#(UUID().uuidString)","url":"\#(url)","title":"","visitedAt":\#(at * day),"transition":\#(transition),"device":"00"}"#
        return try! JSONDecoder().decode(Visit.self, from: Data(json.utf8))
    }

    func testAPageOnlyReloadedOrDownloadedHasNoFrecency() {
        let pages = HistoryPage.pages([
            visit("https://a.example/", day: 100, 9),
            visit("https://b.example/", day: 100, 7),
            visit("https://c.example/", day: 100, 1),
        ])
        XCTAssertEqual(pages.map(\.url), ["https://c.example/"])
    }

    func testAReloadNeitherSamplesNorCounts() {
        let followed = HistoryPage.pages([visit("https://a.example/", day: 100, 1)])
        let reloaded = HistoryPage.pages([
            visit("https://a.example/", day: 100, 1),
            visit("https://a.example/", day: 100.5, 9),
        ])
        XCTAssertEqual(followed.first?.frecency, reloaded.first?.frecency)
    }

    func testScoresInWholeDays() {
        let early = HistoryPage.pages([visit("https://a.example/", day: 100.1, 1)])
        let late = HistoryPage.pages([visit("https://a.example/", day: 100.9, 1)])
        XCTAssertEqual(early.first?.frecency, late.first?.frecency)
        XCTAssertEqual(early.first?.frecency, (early.first?.frecency ?? 0).rounded(.towardZero))
    }

    func testATypedVisitOutranksAFollowedOne() {
        let pages = HistoryPage.pages([
            visit("https://followed.example/", day: 100, 1),
            visit("https://typed.example/", day: 100, 2),
        ])
        XCTAssertEqual(pages.first?.url, "https://typed.example/")
    }

    func testPagesThatTieGoInTheOrderOfTheirAddresses() {
        let visits = ["https://c.example/", "https://a.example/", "https://b.example/"].map {
            visit($0, day: 100, 1)
        }
        XCTAssertEqual(HistoryPage.pages(visits).map(\.url),
                       ["https://a.example/", "https://b.example/", "https://c.example/"])
        XCTAssertEqual(HistoryPage.pages(visits.reversed()), HistoryPage.pages(visits))
    }
}
