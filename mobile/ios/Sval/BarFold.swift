// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import SwiftUI
import UIKit

/// How far the bar has folded into its pill, from 0 (open) to 1, following
/// the page in front as it scrolls. `Browser` owns one. `value` changes
/// with each scroll report, so the bar's `FoldingBar` alone reads it, and
/// every other view reads `phase`.
@MainActor
@Observable
final class BarFold {
    /// Where the fold is, which changes only as a fold starts or ends.
    enum Phase {
        case open, partway, folded
    }

    private(set) var value = 0.0 {
        didSet {
            // An equal write notifies no reader: the Observable macro's
            // `shouldNotifyObservers` compares Equatable values.
            phase = value == 0 ? .open : value == 1 ? .folded : .partway
            Signposts.bar.emitEvent("fold")
        }
    }
    private(set) var phase = Phase.open

    /// The scroll so far toward folding or unfolding a bar at rest.
    @ObservationIgnored private var run = 0.0
    /// Set when the bar is opened by a tap: the page's coasting leaves it
    /// open until a finger drags the page again.
    @ObservationIgnored private var heldOpen = false
    @ObservationIgnored private var settle: Task<Void, Never>?
    /// When the page counts as at rest, unless another report comes first.
    @ObservationIgnored private var settleAt: ContinuousClock.Instant?

    /// How far the page scrolls one way before a resting bar starts to
    /// fold or unfold.
    static let foldStart = 100.0
    /// How far the page scrolls to fold the bar all the way, once started.
    static let foldDistance = 86.0
    /// How long after the last report the page counts as at rest.
    static let settleDelay = Duration.milliseconds(120)

    /// Moves the fold with the page in front: down folds it, up opens it,
    /// by the distance scrolled once past `foldStart`, so it stops when the
    /// finger stops and turns when the finger turns. Once the page comes to
    /// rest, a fold left partway finishes toward its nearer end.
    func pageScrolled(_ report: ScrollReport) {
        settleAt = nil
        switch report {
        case .touched:
            heldOpen = false
            return
        case .released:
            break
        case .atEnd:
            if !heldOpen, value > 0 { foldBar(to: 0) }
            return
        case .moved(let delta, let atTop, let held):
            guard !heldOpen else { return }
            var moved = delta
            if !atTop, value == 0 || value == 1 {
                let toward = value == 0 ? delta > 0 : delta < 0
                run = toward && (run == 0 || (run > 0) == (delta > 0)) ? run + delta : 0
                guard abs(run) > Self.foldStart else { return }
                moved = run - (run > 0 ? Self.foldStart : -Self.foldStart)
                run = 0
            }
            let next = atTop ? 0 : min(1, max(0, value + moved / Self.foldDistance))
            if next != value {
                var still = Transaction()
                still.disablesAnimations = true
                withTransaction(still) { value = next }
            }
            if held { return }
        }
        // Coasting reports keep coming; the page is at rest once they stop.
        // They come each frame, so one task waits out a deadline each
        // report moves on.
        settleAt = .now + Self.settleDelay
        guard settle == nil else { return }
        settle = Task { [weak self] in
            while let at = self?.settleAt {
                try? await Task.sleep(until: at, clock: .continuous)
                guard let self else { return }
                guard let due = settleAt else { break }
                if due > .now { continue }
                settleAt = nil
                if value > 0, value < 1 { foldBar(to: value >= 0.5 ? 1 : 0) }
            }
            self?.settle = nil
        }
    }

    /// Opens the bar from a tap on its pill. The page's coasting leaves
    /// it open until a finger drags the page again.
    func openBar() {
        heldOpen = true
        foldBar(to: 0)
    }

    /// Forgets the scroll toward a fold and leaves the bar where it is, as
    /// when a Workspace swipe brings another page under the bar that slid
    /// in: that page's scrolling starts its own run.
    func endRun() {
        run = 0
    }

    func foldBar(to end: Double) {
        run = 0
        guard value != end else { return }
        // Under Reduce Motion the bar goes to its fold at once.
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : Motion.glide) { value = end }
    }
}

/// What a page's scrolling tells the bar (`BarFold.pageScrolled`).
enum ScrollReport {
    /// A finger came down on the page.
    case touched
    /// The finger lifted, perhaps leaving the page to coast.
    case released
    /// The page reached its end.
    case atEnd
    /// The page moved by `by` points, down when positive; `atTop` once
    /// back at its start, and `held` while a finger is on it.
    case moved(by: Double, atTop: Bool, held: Bool)
}
