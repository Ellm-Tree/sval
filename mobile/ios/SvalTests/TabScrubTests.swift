// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The pages the address bar's scrub moves through.
@MainActor
final class TabScrubTests: XCTestCase {
    private let index = OutlineIndex(TreeLinesTests.rows)

    func testASplitOfTwoIsOnePage() {
        let pages = TabScrub.pages(in: "w1", index: index)
        XCTAssertEqual(pages.map(\.id), ["t1", "t2", "t3", "t4", "s1", "p3", "t5"])
        guard case .split(_, let panes, _) = pages[4] else { return XCTFail("s1 is no split page") }
        XCTAssertEqual(panes.map(\.id), ["p1", "p2"])
        XCTAssertTrue(pages[4].holds("p2"))
    }

    func testASplitOfOneIsItsTab() {
        let pages = TabScrub.pages(in: "w1", index: index)
        guard let page = pages.first(where: { $0.id == "p3" }), case .tab = page else {
            return XCTFail("p3 is no tab page")
        }
    }
}
