// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Where a card held over a card in the grid counts as over its middle,
/// which shows Group and Split.
final class GridMetricsTests: XCTestCase {
    /// A top-level card in the left cell of a 390 point grid: 12 points
    /// in from the sheet's side, 5.5 from the next cell, and 7 above and
    /// below, which hold half the 4 point row gap.
    private let card = CGRect(x: 12, y: 7, width: 177.5, height: 140)
    private let left = (left: true, right: false)
    private func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: card.minX + card.width * x, y: card.minY + card.height * y)
    }

    func testACardSitsInFromTheSheetsEdgeByItsBoxesMargin() {
        XCTAssertTrue(GridMetrics.insets(layers: 0, column: 0, columns: 2) == (12, 5.5))
        XCTAssertTrue(GridMetrics.insets(layers: 0, column: 1, columns: 2) == (5.5, 12))
        XCTAssertTrue(GridMetrics.insets(layers: 1, column: 1, columns: 2) == (5.5, 20), "a group's box keeps its margin")
        XCTAssertTrue(GridMetrics.insets(layers: 0, column: 0, columns: 1) == (12, 12), "one column faces both edges")
    }

    @MainActor
    func testACellPlacesItsCardByItsColumn() {
        let cell = GridCell(frame: CGRect(x: 0, y: 0, width: 195, height: 154))
        cell.place(cell.frame)
        XCTAssertEqual(cell.card, card)
        XCTAssertTrue(cell.outer.left && !cell.outer.right, "the left column's left side faces the edge")
        cell.frame = CGRect(x: 195, y: 0, width: 195, height: 154)
        cell.place(cell.frame)
        XCTAssertEqual(cell.card, CGRect(x: 5.5, y: 7, width: 177.5, height: 140))
        XCTAssertTrue(!cell.outer.left && cell.outer.right, "the right column's right side faces the edge")
        XCTAssertEqual(cell.contentView.frame, CGRect(x: -6.5, y: 0, width: 194.5, height: 154),
                       "the content keeps the left cell's layout, moved to the card")
    }

    func testTheMiddleTakesTheCardsWholeHeight() {
        XCTAssertNotNil(GridMetrics.middle(CGPoint(x: card.midX, y: card.minY), card: card), "the title strip is in the middle")
        XCTAssertNotNil(GridMetrics.middle(CGPoint(x: card.midX, y: card.maxY - 1), card: card))
        XCTAssertNil(GridMetrics.middle(CGPoint(x: card.midX, y: card.minY - 1), card: card))
    }

    func testTheRoomTowardTheSheetsEdgeIsTheEdge() {
        XCTAssertEqual(GridMetrics.zone(CGPoint(x: 0, y: card.midY), card: card, outer: left), .edge(left: true))
        XCTAssertEqual(GridMetrics.zone(CGPoint(x: card.minX - 1, y: 2), card: card, outer: left), .edge(left: true),
                       "beside the card's corner")
        XCTAssertEqual(GridMetrics.zone(CGPoint(x: card.maxX + 1, y: card.midY), card: card, outer: left), .crack(left: false),
                       "toward the next column")
        XCTAssertEqual(GridMetrics.zone(CGPoint(x: card.maxX + 1, y: card.midY), card: card, outer: (true, true)),
                       .edge(left: false), "one column")
        XCTAssertEqual(GridMetrics.zone(CGPoint(x: card.midX - 1, y: card.minY - 1), card: card, outer: left), .crack(left: true),
                       "toward the next row")
    }

    func testTheSidesAreTheCardsOuterFifths() {
        XCTAssertEqual(GridMetrics.zone(at(0.19, 0.5), card: card, outer: left), .side(left: true))
        XCTAssertEqual(GridMetrics.zone(at(0.21, 0.5), card: card, outer: left), .middle(left: true))
        XCTAssertEqual(GridMetrics.zone(at(0.79, 0.5), card: card, outer: left), .middle(left: false))
        XCTAssertEqual(GridMetrics.zone(at(0.81, 0.5), card: card, outer: left), .side(left: false))
        XCTAssertNil(GridMetrics.middle(at(0.19, 0.5), card: card))
        let middle = GridMetrics.middle(at(0.2, 0.5), card: card)
        XCTAssertEqual(middle?.x ?? -1, 0, accuracy: 0.001)
        XCTAssertEqual(middle?.span ?? 0, card.width * 3 / 5, accuracy: 0.001)
    }

    func testALatchedCardsMiddleTakesItsWholeCell() {
        let corner = GridMetrics.middle(CGPoint(x: 0, y: 0), card: card, latched: true)
        XCTAssertEqual(corner?.x, 0, "the cell's left edge counts as the middle's left end")
        let side = GridMetrics.middle(at(0.95, 0.5), card: card, latched: true)
        XCTAssertEqual(side?.x ?? -1, side?.span ?? 0, accuracy: 0.001, "the right side counts as the middle's right end")
    }

    func testTheLatchHoldsUntilTheFingerLeavesTheCard() {
        XCTAssertEqual(GridMetrics.latch("a", over: "a", zone: .side(left: true)), "a")
        XCTAssertEqual(GridMetrics.latch("a", over: "a", zone: .crack(left: true)), "a", "the room toward the next card")
        XCTAssertNil(GridMetrics.latch("a", over: "a", zone: .edge(left: true)), "the room toward the sheet's edge")
        XCTAssertNil(GridMetrics.latch("a", over: "b", zone: .side(left: true)), "another card")
        XCTAssertNil(GridMetrics.latch("a", over: nil, zone: .side(left: true)), "off every card")
    }

    func testOffTheCardRestsShorterThanASide() {
        XCTAssertEqual(GridMetrics.restTime(.crack(left: true)), 0.1)
        XCTAssertEqual(GridMetrics.restTime(.edge(left: true)), 0.1)
        XCTAssertEqual(GridMetrics.restTime(.side(left: false)), 0.25)
    }

    func testAFingerStillOnASideKeepsItsRest() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        let rest = GridMetrics.rest(nil, key: "a left", at: CGPoint(x: 20, y: 50), now: start)
        let later = GridMetrics.rest(rest, key: "a left", at: CGPoint(x: 26, y: 56), now: start + 1)
        XCTAssertEqual(later.since, start, "a finger drifting within the radius keeps resting")
    }

    func testAFingerMovingAcrossASideStartsItsRestOver() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        let rest = GridMetrics.rest(nil, key: "a left", at: CGPoint(x: 20, y: 50), now: start)
        let later = GridMetrics.rest(rest, key: "a left", at: CGPoint(x: 20 + GridMetrics.restDrift + 1, y: 50), now: start + 1)
        XCTAssertEqual(later.since, start + 1, "a finger passing through the side has not rested")
        XCTAssertEqual(later.at, CGPoint(x: 20 + GridMetrics.restDrift + 1, y: 50))
    }

    func testAnotherSideStartsItsRestOver() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        let rest = GridMetrics.rest(nil, key: "a left", at: CGPoint(x: 20, y: 50), now: start)
        let later = GridMetrics.rest(rest, key: "b left", at: CGPoint(x: 20, y: 50), now: start + 1)
        XCTAssertEqual(later.since, start + 1, "a rest on one card's side doesn't carry to another's")
    }
}

/// Which edges of a scrolling view fade: those with more to scroll to.
final class EdgeFadeTests: XCTestCase {
    func testTheTopFadesOnceScrolled() {
        XCTAssertFalse(EdgeFade.edges(offset: 0, size: 1000, room: 400)[0], "at the top")
        XCTAssertTrue(EdgeFade.edges(offset: 10, size: 1000, room: 400)[0], "scrolled down")
    }

    func testTheBottomFadesUntilTheEnd() {
        XCTAssertTrue(EdgeFade.edges(offset: 0, size: 1000, room: 400)[1], "more below")
        XCTAssertFalse(EdgeFade.edges(offset: 600, size: 1000, room: 400)[1], "at the end")
        XCTAssertFalse(EdgeFade.edges(offset: 0, size: 300, room: 400)[1], "everything fits")
    }
}
