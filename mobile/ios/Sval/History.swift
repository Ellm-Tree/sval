// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// History as the desktop syncs it (history-sync spec): one document per
/// ISO week of visits, `history-YYYY-Www`, and an index naming every week a
/// device wrote to.
enum HistoryWeeks {
    /// The index of weeks (`HISTORY_INDEX` in `SvalHistorySync`).
    static let index = "history-index"

    /// The least time between two writes of the current week to the shared
    /// folder (`CURRENT_WEEK_PUBLISH_MS`): the week is the largest file a
    /// device writes while browsing, and a provider uploads all of it on
    /// each write.
    static let publishEvery: TimeInterval = 10 * 60

    /// How many weeks other than the current one a pass takes, newest first
    /// (`COLD_SHARDS_PER_PASS`).
    static let coldPerPass = 4

    /// How many weeks back the phone keeps history, the current one
    /// included. The desktop works through every week; a phone holds the
    /// recent ones, which are what the Launcher ranks highest.
    static let kept = 8

    /// How many of a page's visits sync from each device in a week, the
    /// newest (`VISITS_PER_PAGE`).
    static let visitsPerPage = 20

    /// The week holding visits made at `date`: its ISO week in UTC, as
    /// `weekOf` names it.
    static func name(for date: Date) -> String {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return String(format: "history-%04d-W%02d", parts.yearForWeekOfYear ?? 1970, parts.weekOfYear ?? 1)
    }

    /// The weeks the phone keeps, newest first.
    static func window(_ now: Date = .now) -> [String] {
        (0..<kept).map { name(for: now.addingTimeInterval(-Double($0) * 7 * 86400)) }
    }

    static func isWeek(_ name: String) -> Bool { name.hasPrefix("history-") && name != index }
}

/// One visit, as the engine lists a week's (`visits_json`).
struct Visit: Decodable, Sendable {
    let id: String
    let url: String
    let title: String
    /// Milliseconds since the epoch.
    let visitedAt: Double
    let transition: UInt32
    /// The hex id of the device that made it.
    let device: String
}

/// A week in the history index.
struct HistoryShard: Decodable {
    let name: String
    let changedAt: Double
}

/// A page the Launcher can suggest from history: its newest title, when it
/// was last visited, and its frecency.
struct HistoryPage: Equatable, Sendable {
    let url: String
    let title: String
    let lastVisit: Double
    let frecency: Double

    /// Places' transition for an address the user typed
    /// (`nsINavHistoryService.TRANSITION_TYPED`).
    static let typed: UInt32 = 2
    /// A link followed, every other visit the phone records
    /// (`TRANSITION_LINK`).
    static let link: UInt32 = 1
    /// A Favorite opened (`TRANSITION_BOOKMARK`).
    static let bookmark: UInt32 = 3

    /// The pages of `visits`, best first by Firefox's frecency
    /// (`CalculateFrecencyFunction` in `places/SQLFunctions.cpp`): each of a
    /// page's newest ten visits, downloads, framed links and reloads left
    /// out, weighs 100 typed or from a Favorite, 50 followed, 20 otherwise
    /// (`places.frecency.pages.*Weight`), decayed with a 30-day half-life
    /// from the page's newest visit (`halfLifeDays`), each counted in whole
    /// days. The score is the whole day on which that sum, scaled by the
    /// page's visit count (`VISIT_COUNT_INC`), would decay to 1. A page with
    /// no visit to sample has no frecency, and the Launcher offers it never.
    /// The phone has no bookmark visits or interaction data, so neither
    /// raises a weight.
    static func pages(_ visits: [Visit]) -> [HistoryPage] {
        let lambda = log(2.0) / 30
        let day = 86_400_000.0
        var byURL: [String: [Visit]] = [:]
        for visit in visits { byURL[visit.url, default: []].append(visit) }
        return byURL.compactMap { url, visits in
            let newest = visits.sorted { $0.visitedAt > $1.visitedAt }
            let sampled = newest.filter { ![7, 8, 9].contains($0.transition) }.prefix(10)
            guard let first = sampled.first else { return nil }
            let days = { (visit: Visit) in (visit.visitedAt / day).rounded(.down) }
            let reference = days(first)
            let sum = sampled.reduce(0.0) { sum, visit in
                let high = visit.transition == typed || visit.transition == bookmark
                let weight: Double = high ? 100 : visit.transition == 4 ? 20 : 50
                return sum + weight * exp(-lambda * (reference - days(visit)))
            }
            let counted = visits.filter { ![0, 4, 7, 8, 9].contains($0.transition) }.count
            let score = reference
                + (log(sum / Double(sampled.count) * Double(max(counted, sampled.count))) / lambda).rounded(.towardZero)
            let title = newest.first { !$0.title.isEmpty }?.title ?? ""
            return HistoryPage(url: url, title: title, lastVisit: newest.first?.visitedAt ?? 0, frecency: score)
        }
        .sorted { ($0.frecency, $0.lastVisit) > ($1.frecency, $1.lastVisit) }
    }
}
