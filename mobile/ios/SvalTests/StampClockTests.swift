// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The phone's stamps only move forward, as decision 1714 asks of every
/// device: a wall clock set back stamps nothing below what a peer has
/// seen from this device.
final class StampClockTests: XCTestCase {
    /// A wall clock the test sets, in milliseconds since the epoch.
    private final class Wall {
        var ms: Double = 1_800_000_000_000
    }

    func testFollowsTheWallClock() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        XCTAssertEqual(clock.now(), wall.ms)
        wall.ms += 5000
        XCTAssertEqual(clock.now(), wall.ms)
    }

    func testEveryStampIsLaterThanTheOneBefore() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        let first = clock.now()
        XCTAssertEqual(clock.now(), first + 1)
        XCTAssertEqual(clock.now(), first + 2)
    }

    func testAWallClockSetBackMovesNoStampBack() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        let before = clock.now()
        wall.ms -= 3_600_000
        XCTAssertEqual(clock.now(), before + 1)
        wall.ms = before + 10_000
        XCTAssertEqual(clock.now(), before + 10_000)
    }

    func testStampsStayAboveTheOwnWatermark() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        clock.atLeast(wall.ms + 30_000)
        XCTAssertEqual(clock.now(), wall.ms + 30_001)
    }

    func testAWatermarkWithinTheMarginIsKept() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        clock.atLeast(wall.ms + StampClock.ownWatermarkMargin)
        XCTAssertEqual(clock.now(), wall.ms + StampClock.ownWatermarkMargin + 1)
    }

    func testAWatermarkPastTheMarginIsPassedOver() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        clock.atLeast(wall.ms + StampClock.ownWatermarkMargin + 1)
        XCTAssertEqual(clock.now(), wall.ms)
    }

    func testAnOlderWatermarkLowersNothing() {
        let wall = Wall()
        var clock = StampClock(wall: { wall.ms })
        let stamp = clock.now()
        clock.atLeast(stamp - 50_000)
        XCTAssertEqual(clock.now(), stamp + 1)
    }

    func testStampsAreWholeMilliseconds() {
        let wall = Wall()
        wall.ms += 0.75
        var clock = StampClock(wall: { wall.ms })
        XCTAssertEqual(clock.now(), wall.ms - 0.75)
    }
}
