// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import UIKit
import XCTest
@testable import Sval

/// The bar's fold, fed the reports a page's scrolling sends.
@MainActor
final class BarFoldTests: XCTestCase {
    private let start = BarFold.foldStart

    /// Scrolls by `by` points, down when positive.
    private func drag(_ fold: BarFold, _ by: Double) {
        fold.pageScrolled(.moved(by: by, atTop: false))
    }

    func testTheBarFoldsWholeOncePastTheStart() {
        let fold = BarFold()
        drag(fold, start)
        XCTAssertFalse(fold.folded, "the first 100pt leave the bar open")
        drag(fold, 1)
        XCTAssertTrue(fold.folded, "past the start the bar folds")
        drag(fold, -start)
        XCTAssertTrue(fold.folded)
        drag(fold, -1)
        XCTAssertFalse(fold.folded, "past the start upward it opens")
    }

    func testATurnBeforeTheStartBeginsTheRunAgain() {
        let fold = BarFold()
        drag(fold, 80)
        drag(fold, -30)
        drag(fold, 80)
        XCTAssertFalse(fold.folded, "the run toward the fold starts over after a turn")
        drag(fold, 30)
        XCTAssertTrue(fold.folded)
    }

    func testTheTopAndTheEndOpenTheBar() {
        let fold = BarFold()
        drag(fold, start + 1)
        fold.pageScrolled(.moved(by: -1, atTop: true))
        XCTAssertFalse(fold.folded, "at the page's start the bar is open")
        drag(fold, start + 1)
        XCTAssertTrue(fold.folded)
        fold.pageScrolled(.atEnd)
        XCTAssertFalse(fold.folded, "at the page's end the bar is open")
    }

    func testABarOpenedByATapStaysOpenUntilTheNextTouch() {
        let fold = BarFold()
        drag(fold, start + 1)
        fold.openBar()
        XCTAssertFalse(fold.folded)
        drag(fold, start + 1)
        XCTAssertFalse(fold.folded, "the page's coasting leaves the opened bar open")
        fold.pageScrolled(.touched)
        drag(fold, start + 1)
        XCTAssertTrue(fold.folded, "a new drag folds it again")
    }

    func testEndingTheRunStartsTheNextPageAfresh() {
        let fold = BarFold()
        drag(fold, 60)
        fold.endRun()
        drag(fold, 60)
        XCTAssertFalse(fold.folded, "the run before the switch doesn't count toward the start")
    }

    /// A finger's drag reports a touch, and an offset set while no finger
    /// drags or coasts the page moves the bar not at all.
    func testThePageScrollDelegateReportsOnlyTheFingersScrolling() {
        var reports: [ScrollReport] = []
        let delegate = PageScroll { reports.append($0) }
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        scroll.contentSize = CGSize(width: 100, height: 1000)
        delegate.scrollViewWillBeginDragging(scroll)
        scroll.contentOffset = CGPoint(x: 0, y: 300)
        delegate.scrollViewDidScroll(scroll)
        XCTAssertEqual(reports, [.touched], "the page's own offsets are no scroll")
    }
}
