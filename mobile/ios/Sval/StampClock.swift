// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The time this phone stamps synced data with, as the desktop's
/// `CorrectedClock` gives it (decision 1714) with no time reading: the
/// phone contacts no time server, so corrected time is its wall clock.
/// Every stamp is later than the one before, and later than this device's
/// own watermark, so a wall clock set back never stamps a change below
/// what a peer has already seen from this device, which the peer would
/// read as one it had seen and dropped.
struct StampClock {
    /// How far past the wall clock this device's own watermark may be and
    /// still raise its next stamps: decision 0135's margin, as the desktop's
    /// `OWN_WATERMARK_MARGIN_MS` and the engine's `WATERMARK_MARGIN`. A
    /// watermark further ahead is a fast clock's, and following it would
    /// keep every later stamp in the future.
    static let ownWatermarkMargin: Double = 60 * 1000

    /// The wall clock, in milliseconds since the epoch.
    private let wall: () -> Double
    private var last: Double = 0

    init(wall: @escaping () -> Double = { Date.now.timeIntervalSince1970 * 1000 }) {
        self.wall = wall
    }

    private var wallMs: Double { wall().rounded(.down) }

    /// The next stamp, in whole milliseconds since the epoch: the wall
    /// clock, or one past the last stamp when that is later.
    mutating func now() -> Double {
        last = max(last + 1, wallMs)
        return last
    }

    /// Keeps every later stamp above `at`, this device's own watermark as
    /// a pass reports it, unless it is more than `ownWatermarkMargin` past
    /// the wall clock.
    mutating func atLeast(_ at: Double) {
        guard at - wallMs <= Self.ownWatermarkMargin else { return }
        last = max(last, at)
    }
}
