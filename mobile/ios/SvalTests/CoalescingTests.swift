// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Refreshes asked for while one runs, against a counter standing for a
/// document's revision.
@MainActor
final class CoalescingTests: XCTestCase {
    /// A job that waits, once started, until the test lets it go.
    private final class Job {
        var revision = 0
        var startedAt: [Int] = []
        private var gate: CheckedContinuation<Void, Never>?
        private var held = true

        func body() async {
            startedAt.append(revision)
            if held { await withCheckedContinuation { gate = $0 } }
        }

        func release() {
            held = false
            gate?.resume()
            gate = nil
        }

        var isStarted: Bool { gate != nil }
    }

    /// Lets every task that can run, run.
    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
    }

    func testCallersDuringARunWaitAndRunOnceMoreWhenSomethingMoved() async {
        let queue = Coalescing()
        let job = Job()
        let isDue = { job.startedAt.last != job.revision }
        var returned: [Int] = []
        let first = Task { await queue.run(isDue: isDue, job.body); returned.append(1) }
        await settle()
        XCTAssertTrue(job.isStarted)
        // Three edits land while the first run reads.
        var waiting: [Task<Void, Never>] = []
        for caller in 2...4 {
            job.revision += 1
            waiting.append(Task { await queue.run(isDue: isDue, job.body); returned.append(caller) })
        }
        await settle()
        XCTAssertEqual(job.startedAt, [0], "the callers wait for the run")
        XCTAssertTrue(returned.isEmpty)
        job.release()
        await first.value
        for task in waiting { await task.value }
        XCTAssertEqual(job.startedAt, [0, 3], "one run more covers every edit")
        XCTAssertEqual(returned.sorted(), [1, 2, 3, 4], "no caller is dropped")
    }

    func testACallerAfterARunThatMovedNothingDoesNotRunAgain() async {
        let queue = Coalescing()
        let job = Job()
        let isDue = { job.startedAt.last != job.revision }
        let first = Task { await queue.run(isDue: isDue, job.body) }
        await settle()
        let second = Task { await queue.run(isDue: isDue, job.body) }
        await settle()
        job.release()
        await first.value
        await second.value
        XCTAssertEqual(job.startedAt, [0], "nothing moved, so the run covered the caller")
        await queue.run(isDue: isDue, job.body)
        XCTAssertEqual(job.startedAt, [0, 0], "with none running, a caller runs")
    }

    /// A call from inside the run, as an edit a refresh makes, runs at once.
    func testACallFromInsideTheRunRunsAtOnce() async {
        let queue = Coalescing()
        var order: [String] = []
        await queue.run(isDue: { true }) {
            order.append("outer")
            await queue.run(isDue: { true }) { order.append("inner") }
            order.append("outer done")
        }
        XCTAssertEqual(order, ["outer", "inner", "outer done"])
    }
}
