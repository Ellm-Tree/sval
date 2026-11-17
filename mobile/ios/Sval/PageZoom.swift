// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// Each host's page zoom on this iPhone (decision 12): set from the site
/// menu's zoom row, kept here and never synced, and put back on every page
/// of the host as it loads. A private tab's zoom is held in memory for the
/// session, since a stored host would say where it went.
@MainActor
enum PageZoom {
    /// Firefox's zoom steps (`toolkit.zoomManager.zoomValues`), which the
    /// desktop's site menu moves along.
    static let steps: [Double] = [
        0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.2, 2.4,
        2.6, 2.8, 3, 4, 5,
    ]

    private static let key = "pageZoom"
    private static var session: [String: Double] = [:]

    static func level(for host: String, isPrivate: Bool) -> Double {
        let levels = isPrivate ? session : UserDefaults.standard.dictionary(forKey: key) as? [String: Double] ?? [:]
        return levels[host] ?? 1
    }

    /// Keeps `level` for `host`; 100% keeps nothing.
    static func set(_ level: Double, for host: String, isPrivate: Bool) {
        if isPrivate {
            session[host] = level == 1 ? nil : level
            return
        }
        var levels = UserDefaults.standard.dictionary(forKey: key) as? [String: Double] ?? [:]
        levels[host] = level == 1 ? nil : level
        UserDefaults.standard.set(levels, forKey: key)
    }

    /// The step `by` steps on from `level`, held at the ends.
    static func step(_ level: Double, by: Int) -> Double {
        let at = steps.firstIndex { $0 >= level - 0.001 } ?? steps.count - 1
        return steps[min(max(at + by, 0), steps.count - 1)]
    }

    /// Forgets the private session's levels as it ends.
    static func endSession() {
        session = [:]
    }
}
