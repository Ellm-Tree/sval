// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// What the Launcher offers for what was typed, worked out as the desktop's
/// Launcher does (launcher spec §5): the row Enter takes is always what was
/// typed, then the sections in the synced order, each to its synced limit,
/// with Open tabs moved up to follow that row when a tab matches strongly.
/// A page shows once, in the first section that has it.
struct LauncherResults: Sendable {
    enum Section: String, Sendable {
        case tabs, favorites, history, suggestions
    }

    /// A pin or Favorite the Launcher offers.
    struct Kept: Identifiable, Sendable, Equatable {
        let id: String
        let name: String
        let url: String
        let pin: PinRow?
    }

    /// Where the Launcher was opened from.
    struct Context: Sendable {
        /// Whether the Workspace in front is the private session's.
        var inPrivate: Bool
        var currentTabId: String?
        var workspaceId: String?
        /// The guid of the pin in front, if one is.
        var currentPin: String?
        /// When each tab was last brought to the front on this phone.
        var usedAt: [String: Double]
    }

    /// The entries of an index that matched what was typed, wherever the
    /// Launcher was opened from. Typing on can only narrow them, so the next
    /// keystroke searches these alone.
    struct Matched: Sendable {
        let generation: Int
        let words: [String]
        let tabs: [Int]
        let favorites: [Int]
        /// The pages matching on a boundary or anywhere, best first.
        let history: [Int]

        /// Whether every word typed before is the start of a word typed
        /// now: then whatever `words` matches, these did.
        func narrows(to words: [String], in index: LauncherIndex) -> Bool {
            generation == index.generation && self.words.allSatisfy { old in words.contains { $0.hasPrefix(old) } }
        }
    }

    var tabs: [OutlineRow] = []
    var kept: [Kept] = []
    var history: [HistoryPage] = []
    /// The sections that have rows, in the order the desktop lists them.
    /// Search suggestions' rows arrive apart (`SearchSuggestions`), so
    /// `order(suggesting:)` places that section.
    var order: [Section] = []
    /// Every section, in the order the desktop lists them.
    private var listed: [Section] = []
    /// What matched, to narrow the next keystroke's search from.
    var matched: Matched?

    init() {}

    /// Whether the address bar's synced setting offers `kind`, one of
    /// Firefox's `browser.urlbar.suggest.*`: `openpage` for open tabs,
    /// `bookmark` for pins and Favorites, `history` for history,
    /// `searches` for search suggestions.
    static func suggests(_ kind: String, settings: [String: Any]) -> Bool {
        settings["browser.urlbar.suggest.\(kind)"] as? Bool ?? true
    }

    /// Throws `CancellationError` when the task it runs on is cancelled,
    /// which happens as soon as another key is typed.
    init(query: String, index: LauncherIndex, context: Context, after previous: Matched? = nil) throws {
        let typed = LauncherMatch.Query(query)
        guard !typed.isEmpty else { return }
        let narrowed = previous.flatMap { $0.narrows(to: typed.words, in: index) ? $0 : nil }
        let limits = index.settings.limits

        // Open tabs: every word on a boundary of the title or address; this
        // Workspace's first, then the most recently used (`matchTabs`).
        // The private session and the user's Workspaces never see each
        // other's tabs; in private, nothing comes from pins, Favorites or
        // history, which belong to the user's synced data.
        let inPrivate = context.inPrivate
        let matchedTabs = (narrowed?.tabs ?? Array(index.tabs.indices)).filter {
            LauncherMatch.onBoundary(typed, index.tabs[$0].match)
        }
        let candidates = matchedTabs.map { index.tabs[$0] }.filter { tab in
            tab.row.id != context.currentTabId && tab.isPrivate == inPrivate
        }
        let usedAt = context.usedAt
        let keyed: [(tab: LauncherIndex.Tab, here: Bool, used: Double, at: Int)] = candidates.enumerated().map { at, tab in
            (tab, tab.workspace == context.workspaceId, usedAt[tab.row.id] ?? -1, at)
        }
        let ranked = keyed.sorted { a, b in
            if a.here != b.here { return a.here }
            return a.used != b.used ? a.used > b.used : a.at < b.at
        }.map { $0.tab }
        let strong = ranked.filter { LauncherMatch.strong(typed, title: $0.match.title, host: $0.host) }
        let strongIds = Set(strong.map(\.row.id))
        tabs = Array((strong + ranked.filter { !strongIds.contains($0.row.id) }).prefix(limits[.tabs] ?? 0).map(\.row))

        // Pins and Favorites: on a boundary only, pins first, each by its
        // page's frecency, or an unvisited bookmark's when that is higher
        // (`SvalFavoritesUrlbarProvider`'s `scoreOf`).
        let ownPins = context.workspaceId.flatMap { index.pins[$0] } ?? []
        var options: [(kept: Kept, pin: Bool, score: Double)] = []
        if !inPrivate {
            for pin in ownPins where pin.guid != context.currentPin && LauncherMatch.onBoundary(typed, pin.match) {
                options.append((pin.kept, true, pin.score))
            }
        }
        let matchedFavorites = (narrowed?.favorites ?? Array(index.favorites.indices)).filter {
            LauncherMatch.onBoundary(typed, index.favorites[$0].match)
        }
        // Another Workspace's pin is a Favorite here, as the desktop offers
        // every favorite but the window's own pins (`pinsOf`).
        let ownGuids = context.workspaceId.flatMap { index.pinGuids[$0] } ?? []
        if !inPrivate {
            for favorite in matchedFavorites.map({ index.favorites[$0] })
            where !(favorite.guid.map(ownGuids.contains) ?? false) {
                options.append((favorite.kept, false, favorite.score))
            }
        }
        var seen = Set<String>()
        kept = Array(options
            .sorted { $0.pin != $1.pin ? $0.pin : $0.score > $1.score }
            .filter { seen.insert($0.kept.url).inserted }
            .map(\.kept)
            .prefix(limits[.favorites] ?? 0))

        // History: boundary matches first, then matches anywhere while the
        // section has room (`UrlbarProviderPlaces`), each by frecency. A page
        // open as a tab, or offered as a pin or Favorite, is left out.
        let pages = index.history.pages
        var boundary: [Int] = []
        var anywhere: [Int] = []
        for (n, at) in (narrowed?.history ?? Array(pages.indices)).enumerated() {
            if n % 512 == 0 { try Task.checkCancellation() }
            if LauncherMatch.onBoundary(typed, pages[at].match) {
                boundary.append(at)
            } else if LauncherMatch.anywhere(typed, pages[at].match) {
                anywhere.append(at)
            }
        }
        if !inPrivate {
            let shown = index.tabURLs.union(kept.map(\.url))
            history = Array((boundary + anywhere).lazy.map { pages[$0] }.filter { !shown.contains($0.url) }
                .prefix(limits[.history] ?? 0))
        }

        matched = Matched(generation: index.generation, words: typed.words, tabs: matchedTabs,
                          favorites: matchedFavorites, history: (boundary + anywhere).sorted())

        var listed = index.settings.order
        // A strong open-tab match moves Open tabs up, right after the row
        // Enter takes (launcher spec §5).
        if !strong.isEmpty {
            listed.removeAll { $0 == .tabs }
            listed.insert(.tabs, at: 0)
        }
        order = listed.filter { section in
            switch section {
            case .tabs: !tabs.isEmpty
            case .favorites: !kept.isEmpty
            case .history: !history.isEmpty
            case .suggestions: false
            }
        }
        self.listed = listed
    }

    /// The sections to show, with Search suggestions in its place when the
    /// engine has suggestions.
    func order(suggesting: Bool) -> [Section] {
        guard suggesting, listed.contains(.suggestions) else { return order }
        return listed.filter { $0 == .suggestions || order.contains($0) }
    }

    /// A pin's or Favorite's score: its page's frecency, or an unvisited
    /// bookmark's when that is higher (`SvalFavoritesUrlbarProvider`'s
    /// `scoreOf`).
    static func score(_ url: String, added: Double?, frecency: [String: Double]) -> Double {
        let decay = (log(100.0) * 30 / log(2.0)).rounded(.towardZero)
        let unvisited = added.map { ($0 / 86_400_000).rounded(.down) + decay } ?? 0
        return max(frecency[url] ?? 0, unvisited) + 0.5
    }
}
