// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Observation

/// Holds back the titles a tab's page sets soon after the last one written,
/// as the desktop's `SvalTitleHold` does. A page that keeps setting its
/// title, a timer, an unread count or a chat that blinks, would otherwise
/// cost a write of the tree and a pass per change, each publishing a file
/// into the user's folder. The first title a tab's page sets is written at
/// once and starts a hold; a title set during the hold waits for its end,
/// and is then written and starts a fresh one, so a title that keeps
/// changing is written once per hold, its latest each time.
///
/// A held title shows wherever the tab's title does (`OutlineRow.title`),
/// as the desktop's panel shows `pendingName`, since what a page's title
/// says is what the user watches its row for.
@MainActor
@Observable
final class TitleHold {
    /// The tabs' hold. History holds its own, by address, as
    /// `SvalHistorySync` does.
    static let shared = TitleHold()

    /// How long a title, once written, holds back the titles after it
    /// (`TITLE_HOLD_MS`).
    nonisolated static let length: Duration = .seconds(30)

    /// Waits out one hold: `length`, or what a test sets.
    @ObservationIgnored private let wait: @Sendable () async -> Void

    init(wait: @escaping @Sendable () async -> Void = { try? await Task.sleep(for: TitleHold.length) }) {
        self.wait = wait
    }

    /// The latest title held back for each tab, by tab id.
    private(set) var pending: [String: String] = [:]
    /// Each tab's running hold, and whether a title came during it.
    @ObservationIgnored private var holds: [String: (timer: Task<Void, Never>, due: Bool)] = [:]
    /// Called with a tab whose hold ended with a title held, to write it.
    @ObservationIgnored var onDue: (@MainActor (String) -> Void)?

    /// Notes a new title for tab `id`. True when it is to be written now,
    /// which starts a hold; false when it waits, `name` held as its
    /// latest, or nil when the page went back to the title written.
    func admit(_ id: String, name: String?) -> Bool {
        guard var hold = holds[id] else {
            start(id)
            return true
        }
        hold.due = true
        holds[id] = hold
        pending[id] = name
        return false
    }

    private func start(_ id: String) {
        let timer = Task { [weak self] in
            await self?.wait()
            guard let self, !Task.isCancelled else { return }
            let due = holds.removeValue(forKey: id)?.due ?? false
            if due {
                start(id)
                onDue?(id)
            }
        }
        holds[id] = (timer, false)
    }

    /// Ends tab `id`'s hold and drops its held title, for a tab whose next
    /// title is a new page's first, or a tab that closed.
    func forget(_ id: String) {
        holds.removeValue(forKey: id)?.timer.cancel()
        if pending[id] != nil { pending[id] = nil }
    }

    /// Takes the held titles of `ids`, or of every tab, to write them. Their
    /// holds run on.
    func take(_ ids: [String]? = nil) -> [String: String] {
        guard let ids else {
            let taken = pending
            if !taken.isEmpty { pending = [:] }
            return taken
        }
        var taken: [String: String] = [:]
        for id in ids {
            if let name = pending.removeValue(forKey: id) { taken[id] = name }
        }
        return taken
    }

    /// Puts back titles taken for a write that failed.
    func putBack(_ taken: [String: String]) {
        for (id, name) in taken where pending[id] == nil { pending[id] = name }
    }
}
