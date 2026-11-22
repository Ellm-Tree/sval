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
struct Visit: Decodable, Equatable, Sendable {
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
    /// Its title and address prepared for the Launcher on the background
    /// task that lists the pages, so typing never prepares the history.
    let match: LauncherMatch.Fields

    init(url: String, title: String, lastVisit: Double, frecency: Double) {
        self.url = url
        self.title = title
        self.lastVisit = lastVisit
        self.frecency = frecency
        match = LauncherMatch.Fields(title: title, url: url)
    }

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
        var byURL: [String: [Visit]] = [:]
        for visit in visits { byURL[visit.url, default: []].append(visit) }
        return byURL.compactMap(page).sorted(by: precedes)
    }

    /// The page at `url` made from `visits`, its visits from every week, as
    /// `pages` scores it.
    static func page(_ url: String, _ visits: [Visit]) -> HistoryPage? {
        let lambda = log(2.0) / 30
        let day = 86_400_000.0
        // Visits made at the same time go by id, so the title and the
        // sample never depend on the order the visits came in.
        let newest = visits.sorted { ($0.visitedAt, $1.id) > ($1.visitedAt, $0.id) }
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

    /// Whether `a` ranks above `b`: higher frecency, then the newer last
    /// visit, then the address, so every list of pages has one order.
    static func precedes(_ a: HistoryPage, _ b: HistoryPage) -> Bool {
        if (a.frecency, a.lastVisit) != (b.frecency, b.lastVisit) {
            return (a.frecency, a.lastVisit) > (b.frecency, b.lastVisit)
        }
        return a.url < b.url
    }
}

/// One week's visits as the engine listed them, and which decode they came
/// from: the number moves whenever the listing did.
struct HistoryWeek: Sendable {
    let read: Int
    let visits: [Visit]
}

/// The weeks' visits, each decoded again only when the engine lists it
/// differently: the listing is the key, compared whole, so a week whose
/// listing is the same string holds the same visits.
struct WeekReads {
    private var weeks: [String: (listing: String, week: HistoryWeek)] = [:]
    private var reads = 0

    /// Week `name`'s visits, from `document`. A week that does not list
    /// holds no visits.
    mutating func visits(of name: String, in document: SvalDocument) -> HistoryWeek {
        let listing = (try? document.visitsJson()) ?? ""
        if let kept = weeks[name], kept.listing == listing { return kept.week }
        reads += 1
        let visits = (try? JSONDecoder().decode([Visit].self, from: Data(listing.utf8))) ?? []
        let week = HistoryWeek(read: reads, visits: visits)
        weeks[name] = (listing, week)
        return week
    }

    /// Forgets every week but `names`, the ones still loaded.
    mutating func keep(only names: Set<String>) {
        weeks = weeks.filter { names.contains($0.key) }
    }
}

/// History's pages kept by address, so a week that changes recomputes the
/// pages of the addresses it touched alone. `pages` always equals
/// `HistoryPage.pages` of every week's visits.
struct HistoryStore: Sendable {
    /// Each week's visits by address, and the read they came from.
    private var weeks: [String: (read: Int, byURL: [String: [Visit]])] = [:]
    private var byURL: [String: HistoryPage] = [:]
    /// Best first (`HistoryPage.precedes`).
    private(set) var pages: [HistoryPage] = []
    private(set) var visitCount = 0

    /// Takes the weeks loaded now, and returns whether `pages` changed.
    @discardableResult
    mutating func update(_ loaded: [String: HistoryWeek]) -> Bool {
        visitCount = loaded.values.reduce(0) { $0 + $1.visits.count }
        var touched = Set<String>()
        for (name, week) in weeks where loaded[name] == nil {
            touched.formUnion(week.byURL.keys)
            weeks[name] = nil
        }
        for (name, week) in loaded where weeks[name]?.read != week.read {
            let old = weeks[name]?.byURL ?? [:]
            let new = Dictionary(grouping: week.visits, by: \.url)
            for url in Set(old.keys).union(new.keys) where old[url] != new[url] {
                touched.insert(url)
            }
            weeks[name] = (week.read, new)
        }
        var gone = Set<String>()
        var made: [HistoryPage] = []
        for url in touched {
            let page = HistoryPage.page(url, weeks.values.flatMap { $0.byURL[url] ?? [] })
            guard page != byURL[url] else { continue }
            if byURL[url] != nil { gone.insert(url) }
            byURL[url] = page
            if let page { made.append(page) }
        }
        guard !gone.isEmpty || !made.isEmpty else { return false }
        pages = Self.merge(pages.filter { !gone.contains($0.url) }, made.sorted(by: HistoryPage.precedes))
        return true
    }

    /// Two lists, each best first, as one.
    private static func merge(_ a: [HistoryPage], _ b: [HistoryPage]) -> [HistoryPage] {
        var merged: [HistoryPage] = []
        merged.reserveCapacity(a.count + b.count)
        var i = 0
        var j = 0
        while i < a.count, j < b.count {
            if HistoryPage.precedes(b[j], a[i]) {
                merged.append(b[j])
                j += 1
            } else {
                merged.append(a[i])
                i += 1
            }
        }
        merged += a[i...]
        merged += b[j...]
        return merged
    }
}
