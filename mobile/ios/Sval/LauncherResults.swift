// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// What the Launcher offers for what was typed, worked out as the desktop's
/// Launcher does (launcher spec §5): the row Enter takes is always what was
/// typed, then the sections in the synced order, each to its synced limit,
/// with Open tabs moved up to follow that row when a tab matches strongly.
/// A page shows once, in the first section that has it.
@MainActor
struct LauncherResults {
    enum Section: String {
        case tabs, favorites, history
    }

    /// A pin or Favorite the Launcher offers.
    struct Kept: Identifiable {
        let id: String
        let name: String
        let url: String
        let pin: PinRow?
    }

    var tabs: [OutlineRow] = []
    var kept: [Kept] = []
    var history: [HistoryPage] = []
    /// The sections that have rows, in the order the desktop lists them.
    var order: [Section] = []

    /// The sections the phone has, from `browser.sval.launcher.order`;
    /// commands and search suggestions are the desktop's alone.
    private static let defaultOrder = "tabs,favorites,commands,history,suggestions"
    private static let defaultLimits: [Section: Int] = [.tabs: 4, .favorites: 3, .history: 5]

    /// Whether the address bar's synced setting offers `kind`, one of
    /// Firefox's `browser.urlbar.suggest.*`: `openpage` for open tabs,
    /// `bookmark` for pins and Favorites, `history` for history.
    static func suggests(_ kind: String, settings: [String: Any]) -> Bool {
        settings["browser.urlbar.suggest.\(kind)"] as? Bool ?? true
    }

    /// What the Launcher reads from the model and the pages.
    struct Input {
        var rows: [OutlineRow]
        var isPrivate: (String) -> Bool
        var workspaceOf: (String) -> String?
        /// Whether the Workspace in front is the private session's.
        var inPrivate: Bool
        var currentTabId: String?
        var workspaceId: String?
        /// The guid of the pin in front, if one is.
        var currentPin: String?
        var lastUsed: (String) -> Double?
        /// The pins of the Workspace in front.
        var pins: [PinRow]
        var favorites: [Favorite]
        var historyPages: [HistoryPage]
        var settings: [String: Any]
    }

    init(query: String, model: AppModel) {
        let browser: Browser = model.browser
        self.init(query: query, input: Input(
            rows: model.rows, isPrivate: model.isPrivate, workspaceOf: model.workspace(of:),
            inPrivate: browser.inPrivate, currentTabId: browser.currentTabId, workspaceId: browser.workspaceId,
            currentPin: browser.currentPin?.guid, lastUsed: browser.lastUsed,
            pins: browser.workspaceId.flatMap { model.pinsByWorkspace[$0] } ?? [], favorites: model.favorites,
            historyPages: model.historyPages, settings: model.settings))
    }

    init(query: String, input: Input) {
        let words = LauncherMatch.words(query)
        guard !words.isEmpty else { return }
        let settings = input.settings
        func limit(_ section: Section) -> Int {
            let offered = switch section {
            case .tabs: Self.suggests("openpage", settings: settings)
            case .favorites: Self.suggests("bookmark", settings: settings)
            case .history: Self.suggests("history", settings: settings)
            }
            guard offered else { return 0 }
            return max(0, settings["browser.sval.launcher.limit.\(section.rawValue)"] as? Int ?? Self.defaultLimits[section]!)
        }
        let frecency = Dictionary(input.historyPages.map { ($0.url, $0.frecency) }, uniquingKeysWith: max)

        // Open tabs: every word on a boundary of the title or address; this
        // Workspace's first, then the most recently used (`matchTabs`).
        // The private session and the user's Workspaces never see each
        // other's tabs; in private, nothing comes from pins, Favorites or
        // history, which belong to the user's synced data.
        let inPrivate = input.inPrivate
        let candidates = input.rows.filter { row in
            row.kind == "tab" && row.id != input.currentTabId && !row.awaitsPick && Browser.openable(row) != nil
                && input.isPrivate(row.id) == inPrivate
                && LauncherMatch.onBoundary(words, title: row.title, url: row.url ?? "")
        }
        let here = input.workspaceId
        let keyed: [(tab: OutlineRow, here: Bool, used: Double, at: Int)] = candidates.enumerated().map { at, tab in
            (tab, input.workspaceOf(tab.id) == here, input.lastUsed(tab.id) ?? -1, at)
        }
        let ranked: [OutlineRow] = keyed.sorted { a, b in
            if a.here != b.here { return a.here }
            return a.used != b.used ? a.used > b.used : a.at < b.at
        }.map { $0.tab }
        let strong = ranked.filter { LauncherMatch.strong(words, title: $0.title, url: $0.url ?? "") }
        tabs = Array((strong + ranked.filter { tab in !strong.contains { $0.id == tab.id } }).prefix(limit(.tabs)))

        // Pins and Favorites: on a boundary only, pins first, each by its
        // page's frecency, or an unvisited bookmark's when that is higher
        // (`SvalFavoritesUrlbarProvider`'s `scoreOf`).
        func score(_ url: String, added: Double?) -> Double {
            Self.score(url, added: added, frecency: frecency)
        }
        let pinRows = inPrivate ? [] : input.pins.filter { $0.kind == "favorite" && $0.guid != input.currentPin }
        var options: [(kept: Kept, pin: Bool, score: Double)] = []
        for pin in pinRows {
            guard let url = pin.url, LauncherMatch.onBoundary(words, title: pin.name, url: url) else { continue }
            let favorite = input.favorites.first { $0.guid == pin.guid }
            options.append((Kept(id: pin.id, name: pin.name, url: url, pin: pin), true,
                            score(url, added: favorite?.added ?? favorite?.contentAt)))
        }
        // Another Workspace's pin is a Favorite here, as the desktop offers
        // every favorite but the window's own pins (`pinsOf`).
        let ownPins = Set(input.pins.map(\.guid))
        for favorite in input.favorites where !inPrivate && favorite.kind == "favorite"
            && !(favorite.guid.map(ownPins.contains) ?? false) {
            guard let url = favorite.url, AppModel.opensHere(url),
                  LauncherMatch.onBoundary(words, title: favorite.name, url: url) else { continue }
            options.append((Kept(id: favorite.id, name: favorite.name, url: url, pin: nil), false,
                            score(url, added: favorite.added ?? favorite.contentAt)))
        }
        var seen = Set<String>()
        kept = Array(options
            .sorted { $0.pin != $1.pin ? $0.pin : $0.score > $1.score }
            .filter { seen.insert($0.kept.url).inserted }
            .map(\.kept)
            .prefix(limit(.favorites)))

        // History: boundary matches first, then matches anywhere while the
        // section has room (`UrlbarProviderPlaces`), each by frecency. A page
        // open as a tab, or offered as a pin or Favorite, is left out.
        let shown = Set(input.rows.filter { $0.kind == "tab" }.compactMap(\.url) + kept.map(\.url))
        let pages = inPrivate ? [] : input.historyPages.filter { !shown.contains($0.url) }
        let boundary = pages.filter { LauncherMatch.onBoundary(words, title: $0.title, url: $0.url) }
        let found = Set(boundary.map(\.url))
        let rest = pages.filter { !found.contains($0.url) && LauncherMatch.anywhere(words, title: $0.title, url: $0.url) }
        history = Array((boundary + rest).prefix(limit(.history)))

        let names = (settings["browser.sval.launcher.order"] as? String ?? Self.defaultOrder)
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var listed: [Section] = []
        for name in names {
            if let section = Section(rawValue: name), !listed.contains(section) { listed.append(section) }
        }
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
            }
        }
    }

    /// A pin's or Favorite's score: its page's frecency, or an unvisited
    /// bookmark's when that is higher (`SvalFavoritesUrlbarProvider`'s
    /// `scoreOf`).
    static func score(_ url: String, added: Double?, frecency: [String: Double]) -> Double {
        let decay = (log(100.0) * 30 / log(2.0)).rounded(.towardZero)
        let unvisited = added.map { ($0 / 86_400_000).rounded(.down) + decay } ?? 0
        return max(frecency[url] ?? 0, unvisited) + 0.5
    }

    /// The site to complete what was typed to: from history, as Firefox's
    /// origin autofill does, and where history has none, from pins and
    /// Favorites, best first, as `SvalFavoritesAutofillProvider` fills a
    /// favorite's origin. Each follows its synced suggestion switch.
    static func autofill(_ typed: String, model: AppModel) -> (text: String, url: URL)? {
        autofill(typed, settings: model.settings, historyPages: model.historyPages, favorites: model.favorites)
    }

    static func autofill(_ typed: String, settings: [String: Any], historyPages: [HistoryPage],
                         favorites: [Favorite]) -> (text: String, url: URL)? {
        if suggests("history", settings: settings),
           let found = autofill(typed, urls: historyPages.map(\.url)) {
            return found
        }
        guard suggests("bookmark", settings: settings) else { return nil }
        let frecency = Dictionary(historyPages.map { ($0.url, $0.frecency) }, uniquingKeysWith: max)
        let ranked = favorites
            .filter { $0.kind == "favorite" && $0.url.map(AppModel.opensHere) == true }
            .compactMap { favorite in
                favorite.url.map { (url: $0, score: score($0, added: favorite.added ?? favorite.contentAt, frecency: frecency)) }
            }
            .sorted { a, b in
                a.score != b.score ? a.score > b.score : a.url.hasPrefix("https://") && !b.url.hasPrefix("https://")
            }
        return autofill(typed, urls: ranked.map(\.url))
    }

    /// The first of `urls` whose host, without `www.`, starts with what was
    /// typed, completed to that host and a slash.
    static func autofill(_ typed: String, urls: [String]) -> (text: String, url: URL)? {
        let lower = typed.lowercased()
        guard !lower.isEmpty, !lower.contains(where: { $0.isWhitespace || $0 == "/" || $0 == ":" }) else { return nil }
        for address in urls {
            guard let url = URL(string: address), let host = url.host()?.lowercased(),
                  let scheme = url.scheme else { continue }
            let bare = host.hasPrefix("www.") && !lower.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            guard bare.hasPrefix(lower) else { continue }
            guard let origin = URL(string: "\(scheme)://\(host)/") else { continue }
            return (typed + bare.dropFirst(lower.count) + "/", origin)
        }
        return nil
    }
}
