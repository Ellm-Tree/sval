// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

/// Runs one job at a time: a caller arriving while it runs waits for it,
/// then runs it once more if what it reads moved since that run began. A
/// call from inside the run, as an edit the job makes refreshes, runs at
/// once, since waiting would wait on itself.
@MainActor final class Coalescing {
    @TaskLocal private static var inside = false
    private var running: Task<Void, Never>?

    /// Runs `job`, unless a run that began after this call's caller changed
    /// anything covers it: `isDue` answers whether anything moved since the
    /// last run began.
    func run(isDue: () async -> Bool, _ job: @escaping @MainActor () async -> Void) async {
        if Self.inside {
            await job()
            return
        }
        while let running {
            await running.value
            // Its own caller may not have resumed yet to let it go.
            if self.running == running { self.running = nil }
            guard await isDue() else { return }
        }
        let run = Task { await Self.$inside.withValue(true) { await job() } }
        running = run
        await run.value
        if running == run { running = nil }
    }
}
