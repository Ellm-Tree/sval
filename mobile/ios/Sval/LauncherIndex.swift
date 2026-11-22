// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// What the Launcher searches: the tabs, pins, Favorites, history and
/// settings, each title and address folded and each address parsed once per
/// change, off the main thread. A keystroke then compares bytes and parses
/// nothing.
struct LauncherIndex: Sendable {
    /// The synced settings the Launcher reads.
    struct Settings: Sendable, Equatable {
        /// Each section's synced limit; 0 for a section its address bar
        /// switch turns off. Search suggestions have theirs from
        /// `SearchSuggestions.limit`.
        let limits: [LauncherResults.Section: Int]
        /// The sections in the synced order, each once.
        let order: [LauncherResults.Section]
        /// Firefox's `browser.urlbar.suggest.history` and `.bookmark`,
        /// which also stop autofill from their source.
        let history: Bool
        let bookmark: Bool

        /// The sections the phone has, from `browser.sval.launcher.order`;
        /// commands are the desktop's alone.
        private static let defaultOrder = "tabs,favorites,commands,history,suggestions"
        private static let defaultLimits: [LauncherResults.Section: Int] = [.tabs: 4, .favorites: 3, .history: 5]

        init(_ settings: [String: Any]) {
            func suggests(_ kind: String) -> Bool { LauncherResults.suggests(kind, settings: settings) }
            history = suggests("history")
            bookmark = suggests("bookmark")
            var limits: [LauncherResults.Section: Int] = [:]
            for (section, kind) in [(LauncherResults.Section.tabs, "openpage"), (.favorites, "bookmark"), (.history, "history")] {
                limits[section] = suggests(kind)
                    ? max(0, settings["browser.sval.launcher.limit.\(section.rawValue)"] as? Int ?? Self.defaultLimits[section]!)
                    : 0
            }
            self.limits = limits
            var order: [LauncherResults.Section] = []
            for name in (settings["browser.sval.launcher.order"] as? String ?? Self.defaultOrder).split(separator: ",") {
                if let section = LauncherResults.Section(rawValue: name.trimmingCharacters(in: .whitespaces)),
                   !order.contains(section) {
                    order.append(section)
                }
            }
            self.order = order
        }
    }

    /// An open tab the Launcher can switch to.
    struct Tab: Sendable, Equatable {
        let row: OutlineRow
        let match: LauncherMatch.Fields
        /// Its address's host, in lower case.
        let host: String
        let workspace: String?
        let isPrivate: Bool
    }

    /// A pin or Favorite, with its score (`SvalFavoritesUrlbarProvider`'s
    /// `scoreOf`).
    struct Entry: Sendable, Equatable {
        let kept: LauncherResults.Kept
        let guid: String?
        let match: LauncherMatch.Fields
        let score: Double
    }

    /// A site autofill completes to: a host in lower case, and the origin
    /// of the first address found at it.
    struct Site: Sendable, Equatable {
        let host: String
        let origin: URL

        init?(_ address: String) {
            guard let url = URL(string: address), let host = url.host()?.lowercased(), let scheme = url.scheme,
                  let origin = URL(string: "\(scheme)://\(host)/") else { return nil }
            self.host = host
            self.origin = origin
        }
    }

    /// History's share, prepared with the pages, since history changes far
    /// less often than the tabs.
    struct History: Sendable {
        /// Best first by frecency.
        let pages: [HistoryPage]
        let frecency: [String: Double]
        /// Each host once, in the order of its first page.
        let sites: [Site]

        init(_ pages: [HistoryPage]) {
            self.pages = pages
            frecency = Dictionary(pages.map { ($0.url, $0.frecency) }, uniquingKeysWith: max)
            sites = LauncherIndex.distinct(pages.lazy.compactMap { Site($0.url) })
        }

        static let empty = History([])
    }

    /// Which build of the index this is, so a search narrowed from the
    /// last keystroke's matches never mixes two builds.
    let generation: Int
    let settings: Settings
    /// Every tab the phone can open, in tree order. A split's picker is no
    /// page, and is left out.
    let tabs: [Tab]
    /// The address of every tab but a private one, the ones left out of
    /// `tabs` included. History leaves these out, and leaving out a private
    /// tab's would show which page the private session has open.
    let tabURLs: Set<String>
    /// Each Workspace's pins to web pages, in the row's order.
    let pins: [String: [Entry]]
    /// The guids of each Workspace's pins, folders included.
    let pinGuids: [String: Set<String>]
    /// Every favorite at a web address, in the favorites document's order.
    let favorites: [Entry]
    /// The sites of `favorites`, best scored first, `https` winning a tie.
    let favoriteSites: [Site]
    let history: History

    static let empty = LauncherIndex(generation: 0, tabs: [], pins: [:], favorites: [], history: .empty,
                                     settings: Settings([:]))

    /// A tab row with the title it shows, its Workspace and whether it is
    /// the private session's.
    struct TabInput: Sendable, Equatable {
        let row: OutlineRow
        let title: String
        let workspace: String?
        let isPrivate: Bool
    }

    /// The tabs' share, each entry kept with the input it was made from.
    struct Tabs: Sendable {
        let tabs: [Tab]
        let tabURLs: Set<String>
        private let made: [String: (input: TabInput, tab: Tab?)]

        static let empty = Tabs([])

        /// Makes an entry for each of `inputs`, taking `previous`'s where
        /// its tab's input is the same.
        init(_ inputs: [TabInput], reusing previous: Tabs? = nil) {
            tabURLs = Set(inputs.lazy.filter { !$0.isPrivate }.compactMap(\.row.url))
            var made: [String: (input: TabInput, tab: Tab?)] = [:]
            made.reserveCapacity(inputs.count)
            tabs = inputs.compactMap { input in
                let tab: Tab?
                if let kept = previous?.made[input.row.id], kept.input == input {
                    tab = kept.tab
                } else if !input.row.awaitsPick, let url = Browser.openable(input.row) {
                    tab = Tab(row: input.row, match: .init(title: input.title, url: input.row.url ?? ""),
                              host: url.host()?.lowercased() ?? "", workspace: input.workspace,
                              isPrivate: input.isPrivate)
                } else {
                    tab = nil
                }
                made[input.row.id] = (input, tab)
                return tab
            }
            self.made = made
        }
    }

    /// The pins' and Favorites' share, scored by history's frecency.
    struct Kept: Sendable {
        let pins: [String: [Entry]]
        let pinGuids: [String: Set<String>]
        let favorites: [Entry]
        let favoriteSites: [Site]

        static let empty = Kept(pins: [:], favorites: [], frecency: [:])

        init(pins: [String: [PinRow]], favorites: [Favorite], frecency: [String: Double]) {
            let byGuid = Dictionary(favorites.compactMap { f in f.guid.map { ($0, f) } },
                                    uniquingKeysWith: { a, _ in a })
            func score(_ url: String, _ favorite: Favorite?) -> Double {
                LauncherResults.score(url, added: favorite?.added ?? favorite?.contentAt, frecency: frecency)
            }
            pinGuids = pins.mapValues { Set($0.map(\.guid)) }
            self.pins = pins.mapValues { row in
                row.compactMap { pin in
                    guard pin.kind == "favorite", let url = pin.url else { return nil }
                    return Entry(kept: .init(id: pin.id, name: pin.name, url: url, pin: pin), guid: pin.guid,
                                 match: .init(title: pin.name, url: url), score: score(url, byGuid[pin.guid]))
                }
            }
            self.favorites = favorites.compactMap { favorite in
                guard favorite.kind == "favorite", let url = favorite.url, AppModel.opensHere(url) else { return nil }
                return Entry(kept: .init(id: favorite.id, name: favorite.name, url: url, pin: nil),
                             guid: favorite.guid, match: .init(title: favorite.name, url: url),
                             score: score(url, favorite))
            }
            let ranked = self.favorites.sorted { a, b in
                a.score != b.score
                    ? a.score > b.score : a.kept.url.hasPrefix("https://") && !b.kept.url.hasPrefix("https://")
            }
            favoriteSites = LauncherIndex.distinct(ranked.lazy.compactMap { Site($0.kept.url) })
        }
    }

    /// The index built whole. `tabs` holds every tab row with the title it
    /// shows, its Workspace and whether it is the private session's.
    init(generation: Int, tabs: [(row: OutlineRow, title: String, workspace: String?, isPrivate: Bool)],
         pins: [String: [PinRow]],
         favorites: [Favorite], history: History, settings: Settings) {
        self.init(generation: generation,
                  tabs: Tabs(tabs.map { TabInput(row: $0.row, title: $0.title, workspace: $0.workspace,
                                                 isPrivate: $0.isPrivate) }),
                  kept: Kept(pins: pins, favorites: favorites, frecency: history.frecency),
                  history: history, settings: settings)
    }

    init(generation: Int, tabs: Tabs, kept: Kept, history: History, settings: Settings) {
        self.generation = generation
        self.settings = settings
        self.history = history
        tabURLs = tabs.tabURLs
        self.tabs = tabs.tabs
        pins = kept.pins
        pinGuids = kept.pinGuids
        favorites = kept.favorites
        favoriteSites = kept.favoriteSites
    }

    fileprivate static func distinct(_ sites: some Sequence<Site>) -> [Site] {
        var seen = Set<String>()
        return sites.filter { seen.insert($0.host).inserted }
    }

    /// The site to complete what was typed to: from history, as Firefox's
    /// origin autofill does, and where history has none, from pins and
    /// Favorites, best first, as `SvalFavoritesAutofillProvider` fills a
    /// favorite's origin. Each follows its synced suggestion switch.
    func autofill(_ typed: String) -> (text: String, url: URL)? {
        if settings.history, let found = Self.autofill(typed, sites: history.sites) { return found }
        return settings.bookmark ? Self.autofill(typed, sites: favoriteSites) : nil
    }

    /// The first of `sites` whose host, without `www.`, starts with what
    /// was typed, completed to that host and a slash.
    static func autofill(_ typed: String, sites: [Site]) -> (text: String, url: URL)? {
        let lower = typed.lowercased()
        guard !lower.isEmpty, !lower.contains(where: { $0.isWhitespace || $0 == "/" || $0 == ":" }) else { return nil }
        let keepsWww = lower.hasPrefix("www.")
        for site in sites {
            let bare = site.host.hasPrefix("www.") && !keepsWww ? site.host.dropFirst(4) : Substring(site.host)
            if bare.hasPrefix(lower) { return (typed + bare.dropFirst(lower.count) + "/", site.origin) }
        }
        return nil
    }
}

/// The Launcher's index built part by part: the tabs' share when a tab's
/// input changed, making again only the entries of tabs that changed, and
/// the pins' and Favorites' share when they or history changed, since their
/// scores read its frecency. History's and the settings' shares come
/// prepared. Each index equals the one built whole from the same inputs.
struct LauncherParts: Sendable {
    private var tabInputs: [LauncherIndex.TabInput] = []
    private var tabs = LauncherIndex.Tabs.empty
    private var pins: [String: [PinRow]] = [:]
    private var favorites: [Favorite] = []
    private var pages: [HistoryPage] = []
    private var kept = LauncherIndex.Kept.empty

    mutating func index(generation: Int, tabs inputs: [LauncherIndex.TabInput], pins: [String: [PinRow]],
                        favorites: [Favorite], history: LauncherIndex.History,
                        settings: LauncherIndex.Settings) -> LauncherIndex {
        if inputs != tabInputs {
            tabs = LauncherIndex.Tabs(inputs, reusing: tabs)
            tabInputs = inputs
        }
        if pins != self.pins || favorites != self.favorites || history.pages != pages {
            kept = LauncherIndex.Kept(pins: pins, favorites: favorites, frecency: history.frecency)
            self.pins = pins
            self.favorites = favorites
            pages = history.pages
        }
        return LauncherIndex(generation: generation, tabs: tabs, kept: kept, history: history, settings: settings)
    }
}
