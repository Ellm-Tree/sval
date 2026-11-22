// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Where a card held over a card in the grid counts as over its middle,
/// which shows Group and Split.
final class GridMetricsTests: XCTestCase {
    private let cell = CGSize(width: 180, height: GridMetrics.cell(depth: 0, sideways: false))

    func testTheMiddleReachesThePicturesTopAndBottom() {
        let ring = GridMetrics.ring
        XCTAssertNotNil(GridMetrics.middle(CGPoint(x: 90, y: ring), in: cell))
        XCTAssertNotNil(GridMetrics.middle(CGPoint(x: 90, y: cell.height - ring - 1), in: cell))
    }

    func testTheRingsRoomIsOutsideTheMiddle() {
        XCTAssertNil(GridMetrics.middle(CGPoint(x: 90, y: GridMetrics.ring - 1), in: cell))
        XCTAssertNil(GridMetrics.middle(CGPoint(x: 90, y: cell.height - GridMetrics.ring), in: cell))
    }

    func testThePicturesSidesAreOutsideTheMiddle() {
        let width = cell.width - 2 * GridMetrics.ring
        let side = GridMetrics.side(width)
        XCTAssertNil(GridMetrics.middle(CGPoint(x: GridMetrics.ring + side - 1, y: 70), in: cell))
        XCTAssertNil(GridMetrics.middle(CGPoint(x: GridMetrics.ring + width - side + 1, y: 70), in: cell))
        let middle = GridMetrics.middle(CGPoint(x: GridMetrics.ring + side, y: 70), in: cell)
        XCTAssertEqual(middle?.x, 0)
        XCTAssertEqual(middle?.span, width - 2 * side)
    }
}
