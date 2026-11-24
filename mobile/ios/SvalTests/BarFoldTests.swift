// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import XCTest
@testable import Sval

/// Whether an observer was told of a change.
private final class Told: @unchecked Sendable {
    var told = false
}

/// The bar's fold, fed the reports a page's scrolling sends.
@MainActor
final class BarFoldTests: XCTestCase {
    private let start = BarFold.foldStart
    private let distance = BarFold.foldDistance

    /// Scrolls by `by` points, down when positive, with a finger on the page.
    private func drag(_ fold: BarFold, _ by: Double) {
        fold.pageScrolled(.moved(by: by, atTop: false, held: true))
    }

    /// Waits for the fold to come to `value`, as a fold left partway
    /// settles once the page is at rest.
    private func settles(_ fold: BarFold, to value: Double, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<100 where fold.value != value {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(fold.value, value, "the fold settles", file: file, line: line)
    }

    func testFoldStartsOnlyPastItsStart() {
        let fold = BarFold()
        drag(fold, 60)
        XCTAssertEqual(fold.value, 0, "the first 100pt leave the bar open")
        drag(fold, 60)
        XCTAssertEqual(fold.value, 20 / distance, accuracy: 1e-9, "the scroll past the start folds the bar")
        XCTAssertEqual(fold.phase, .partway)
    }

    func testFoldFollowsTheFingerToItsEnd() {
        let fold = BarFold()
        drag(fold, start + 1)
        drag(fold, distance / 2)
        XCTAssertEqual(fold.value, (1 + distance / 2) / distance, accuracy: 1e-9)
        drag(fold, -distance / 4)
        XCTAssertEqual(fold.value, (1 + distance / 4) / distance, accuracy: 1e-9, "a fold partway turns with the finger")
        drag(fold, 500)
        XCTAssertEqual(fold.value, 1, "the fold stops at its end")
        XCTAssertEqual(fold.phase, .folded)
    }

    func testAFoldedBarOpensPastTheStartUpward() {
        let fold = BarFold()
        drag(fold, start + distance + 10)
        XCTAssertEqual(fold.value, 1)
        drag(fold, 40)
        drag(fold, -60)
        XCTAssertEqual(fold.value, 1, "scrolling down further leaves the folded bar as it is")
        drag(fold, -60)
        XCTAssertEqual(fold.value, 1 - 20 / distance, accuracy: 1e-9, "up past the start opens it")
    }

    func testATurnBeforeTheStartBeginsTheRunAgain() {
        let fold = BarFold()
        drag(fold, 80)
        drag(fold, -30)
        drag(fold, 80)
        XCTAssertEqual(fold.value, 0, "the run toward the fold starts over after a turn")
        drag(fold, 30)
        XCTAssertEqual(fold.value, 10 / distance, accuracy: 1e-9)
    }

    func testTheTopAndTheEndOpenTheBar() {
        let fold = BarFold()
        drag(fold, start + distance / 2)
        fold.pageScrolled(.moved(by: -1, atTop: true, held: true))
        XCTAssertEqual(fold.value, 0, "at the page's start the bar is open")
        drag(fold, start + distance)
        XCTAssertEqual(fold.value, 1)
        fold.pageScrolled(.atEnd)
        XCTAssertEqual(fold.value, 0, "at the page's end the bar is open")
        XCTAssertEqual(fold.phase, .open)
    }

    func testABarOpenedByATapStaysOpenUntilTheNextTouch() {
        let fold = BarFold()
        drag(fold, start + distance)
        fold.openBar()
        XCTAssertEqual(fold.value, 0)
        fold.pageScrolled(.moved(by: start + distance, atTop: false, held: false))
        XCTAssertEqual(fold.value, 0, "the page's coasting leaves the opened bar open")
        fold.pageScrolled(.touched)
        drag(fold, start + distance)
        XCTAssertEqual(fold.value, 1, "a new drag folds it again")
    }

    func testAFoldLeftPartwaySettlesTowardItsNearerEnd() async {
        let fold = BarFold()
        drag(fold, start + distance * 0.6)
        fold.pageScrolled(.released)
        await settles(fold, to: 1)
        drag(fold, -(start + distance * 0.7))
        XCTAssertEqual(fold.value, 0.3, accuracy: 1e-9)
        fold.pageScrolled(.released)
        await settles(fold, to: 0)
    }

    func testAHeldFingerKeepsTheFoldWhereItIs() async throws {
        let fold = BarFold()
        drag(fold, start + distance * 0.6)
        try await Task.sleep(for: BarFold.settleDelay * 4)
        XCTAssertEqual(fold.value, 0.6, accuracy: 1e-9, "no settle while the finger is down")
    }

    func testKeepFoldPutsTheFoldBackAtOnce() {
        let fold = BarFold()
        fold.keepFold(0.4)
        XCTAssertEqual(fold.value, 0.4)
        XCTAssertEqual(fold.phase, .partway)
        drag(fold, 10)
        XCTAssertEqual(fold.value, 0.4 + 10 / distance, accuracy: 1e-9, "a kept fold partway moves on at once")
    }

    /// A reader of the phase is told when the fold starts and when it
    /// ends.
    func testThePhaseChangesAsAFoldStartsAndEnds() {
        let fold = BarFold()
        func watch() -> Told {
            let told = Told()
            withObservationTracking { _ = fold.phase } onChange: { told.told = true }
            return told
        }
        var told = watch()
        drag(fold, start + 10)
        XCTAssertTrue(told.told, "the fold starting changes the phase")
        told = watch()
        drag(fold, distance)
        XCTAssertTrue(told.told, "the fold ending changes the phase")
        XCTAssertEqual(fold.phase, .folded)
    }
}
