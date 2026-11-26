// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import SwiftUI
import UIKit

/// Whether the bar is folded into its pill, following the page in front
/// as it scrolls. `Browser` owns one. The bar folds or opens whole, in one
/// animation, once the page has scrolled `foldStart` one way.
@MainActor
@Observable
final class BarFold {
    private(set) var folded = false {
        didSet { Signposts.bar.emitEvent("fold") }
    }

    /// The scroll so far toward folding or opening the bar.
    @ObservationIgnored private var run = 0.0
    /// Set when the bar is opened by a tap: the page's coasting leaves it
    /// open until a finger drags the page again.
    @ObservationIgnored private var heldOpen = false

    /// How far the page scrolls one way before the bar folds or opens.
    static let foldStart = 100.0

    /// Folds the bar as the page scrolls down and opens it as the page
    /// scrolls up, at its start or at its end.
    func pageScrolled(_ report: ScrollReport) {
        switch report {
        case .touched:
            heldOpen = false
        case .atEnd:
            if !heldOpen { open() }
        case .moved(let delta, let atTop):
            guard !heldOpen else { return }
            guard !atTop else { return open() }
            let toward = folded ? delta < 0 : delta > 0
            run = toward && (run == 0 || (run > 0) == (delta > 0)) ? run + delta : 0
            guard abs(run) > Self.foldStart else { return }
            set(folded: !folded)
        }
    }

    /// Opens the bar from a tap on its pill. The page's coasting leaves
    /// it open until a finger drags the page again.
    func openBar() {
        heldOpen = true
        open()
    }

    /// Opens the bar, as a switch to another page does.
    func open() {
        set(folded: false)
    }

    /// Forgets the scroll toward a fold and leaves the bar where it is, as
    /// when a Workspace swipe brings another page under the bar that slid
    /// in: that page's scrolling starts its own run.
    func endRun() {
        run = 0
    }

    private func set(folded end: Bool) {
        run = 0
        guard folded != end else { return }
        // Under Reduce Motion the bar goes to its fold at once.
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : Motion.glide) { folded = end }
    }
}

/// What a page's scrolling tells the bar (`BarFold.pageScrolled`).
enum ScrollReport: Equatable {
    /// A finger started dragging the page.
    case touched
    /// The page reached its end.
    case atEnd
    /// The page moved by `by` points, down when positive; `atTop` once
    /// back at its start.
    case moved(by: Double, atTop: Bool)
}

/// The delegate of a page's scroll view, which turns its scrolling into
/// the reports the bar's fold reads. WebKit's scroll view passes each call
/// to its own delegate and to this one, and holds this one weakly
/// (`WKScrollViewDelegateForwarder`), so its page keeps it.
@MainActor
final class PageScroll: NSObject, UIScrollViewDelegate {
    private let report: @MainActor (ScrollReport) -> Void
    /// The offset at the last call, to measure each move from.
    private var lastY: CGFloat?

    init(report: @escaping @MainActor (ScrollReport) -> Void) {
        self.report = report
    }

    func scrollViewWillBeginDragging(_ scroll: UIScrollView) {
        lastY = scroll.contentOffset.y
        report(.touched)
    }

    /// Offsets the page sets itself, as a load or an anchor does, move the
    /// bar not at all: only a finger's drag or its coasting do.
    func scrollViewDidScroll(_ scroll: UIScrollView) {
        let new = scroll.contentOffset.y
        defer { lastY = new }
        guard scroll.isTracking || scroll.isDecelerating, let old = lastY, new != old else { return }
        let end = scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height
        let top = -scroll.adjustedContentInset.top
        report(new >= end - 1 ? .atEnd : .moved(by: new - old, atTop: new <= top))
    }
}
