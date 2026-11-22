// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// A watch that waits until it is cancelled, as a server with no changes to
/// report holds a request.
private final class HeldWait: ChangeWait, @unchecked Sendable {
    let waiting: XCTestExpectation
    private let cancelled = DispatchSemaphore(value: 0)

    init(waiting: XCTestExpectation) {
        self.waiting = waiting
    }

    func next() throws -> [String]? {
        waiting.fulfill()
        cancelled.wait()
        return nil
    }

    func cancel() {
        cancelled.signal()
    }
}

private struct Unreachable: Error {}

/// A stopped watcher's thread ends at once, whether it waits for a change
/// or between watches, so no thread or connection outlives the stop.
final class ChangeWatcherTests: XCTestCase {
    /// Runs the watcher's loop on a thread of its own and says when the loop
    /// returns.
    private func runInBackground(_ watcher: ChangeWatcher) -> XCTestExpectation {
        let ended = expectation(description: "the watcher's loop returns")
        Thread { watcher.run(); ended.fulfill() }.start()
        return ended
    }

    func testStopEndsAWaitUnderWay() {
        let held = HeldWait(waiting: expectation(description: "the watch waits"))
        let watcher = ChangeWatcher(name: "Test", open: { held }) { _ in
            XCTFail("no change was reported")
        }
        let ended = runInBackground(watcher)
        wait(for: [held.waiting], timeout: 1)
        watcher.stop()
        wait(for: [ended], timeout: 1)
    }

    func testStopEndsTheWaitBetweenWatches() {
        let opened = expectation(description: "the watch is tried")
        let watcher = ChangeWatcher(
            name: "Test", retry: 3600,
            open: {
                opened.fulfill()
                throw Unreachable()
            }
        ) { _ in }
        let ended = runInBackground(watcher)
        wait(for: [opened], timeout: 1)
        watcher.stop()
        wait(for: [ended], timeout: 1)
    }
}
