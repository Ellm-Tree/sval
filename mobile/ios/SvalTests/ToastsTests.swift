// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

@testable import Sval
import XCTest

/// The toasts' presenter: where a toast shows for what covers the main
/// screen, that a new toast takes the place of the one showing, and how
/// long each shows. Its waits are recorded and return at once.
@MainActor
final class ToastsTests: XCTestCase {
    /// The seconds each wait was asked for, in order.
    private var waits: [Double] = []

    private func presenter(assistive: Bool = false) -> Toasts {
        Toasts(windowed: false, wait: { [weak self] seconds in
            await MainActor.run { self?.waits.append(seconds) }
        }, assistive: { assistive })
    }

    func testPlaceForEachCover() {
        XCTAssertEqual(Toasts.place(cover: .none, barHeight: 100), .bottom(lift: 112))
        XCTAssertEqual(Toasts.place(cover: .workspace, barHeight: 100), .top)
        XCTAssertEqual(Toasts.place(cover: .other, barHeight: 100), .top)
    }

    func testPlaceFollowsWhatItIsTold() {
        let toasts = presenter()
        toasts.barHeight = 80
        XCTAssertEqual(toasts.place, .bottom(lift: 92), "nothing open: above the bar")
        toasts.barHeight = 50
        XCTAssertEqual(toasts.place, .bottom(lift: 62), "a folded bar lowers the toast")
        toasts.covered(by: .workspace)
        XCTAssertEqual(toasts.place, .top, "the Workspace sheet or panel open: at the top")
        toasts.covered(by: .other)
        XCTAssertEqual(toasts.place, .top, "another sheet open: at the top")
        toasts.covered(by: .none)
        XCTAssertEqual(toasts.place, .bottom(lift: 62), "the sheet closed: above the bar again")
    }

    func testNewToastReplacesTheOneShowing() async {
        // Waits that never end by themselves: only the replacement calls
        // the first one off, and nothing waits on the second.
        let toasts = Toasts(windowed: false, wait: { _ in try? await Task.sleep(for: .seconds(3600)) }, assistive: { false })
        let first = Toast(text: "Closed 1 tab")
        let second = Toast(text: "Closed 2 tabs")
        toasts.show(first)
        let firstTimer = toasts.timer
        toasts.show(second)
        XCTAssertEqual(toasts.current?.id, second.id)
        // The first toast's wait was called off, so it puts nothing away.
        await firstTimer?.value
        XCTAssertEqual(toasts.current?.id, second.id)
        toasts.dismiss(first.id)
        XCTAssertEqual(toasts.current?.id, second.id, "putting away a toast no longer showing leaves the new one")
    }

    func testEachToastShowsForItsSeconds() async {
        let toasts = presenter()
        let toast = Toast(text: "Closed 1 tab", undo: {})
        toasts.show(toast)
        await toasts.timer?.value
        XCTAssertEqual(waits, [5])
        XCTAssertNil(toasts.current, "it goes once its wait is up")

        var removed = Toast(text: "Removed from example.com")
        removed.seconds = 8
        toasts.show(removed)
        await toasts.timer?.value
        toasts.show(.privateClosed)
        await toasts.timer?.value
        XCTAssertEqual(waits, [5, 8, 3])
        XCTAssertNil(toasts.current)
    }

    func testUndoStaysWhileVoiceOverRuns() async {
        let toasts = presenter(assistive: true)
        let undoable = Toast(text: "Closed 1 tab", undo: {})
        toasts.show(undoable)
        XCTAssertNil(toasts.timer, "a toast with Undo waits for VoiceOver to reach it")
        XCTAssertEqual(toasts.current?.id, undoable.id)
        toasts.dismiss(undoable.id)
        XCTAssertNil(toasts.current, "the escape gesture puts it away")

        toasts.show(Toast(text: "Closed 1 tab"))
        await toasts.timer?.value
        XCTAssertEqual(waits, [5], "one with nothing to undo goes as usual")
        XCTAssertNil(toasts.current)
    }
}
