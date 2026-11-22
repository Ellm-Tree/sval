// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CryptoKit
import Foundation
import WebKit

/// Ad blocking on the iPhone (mobile spec §4.1). The synced level picks the
/// desktop's lists, which are downloaded from their publishers, converted
/// into WebKit's content rules (`contentRules`) and compiled. My filters and
/// the allowed domains sync and apply as on the desktop.
@MainActor
@Observable
final class ContentBlocker {
    /// The compiled rule lists a page chooses from by its site's protections
    /// (`Page.useRules`).
    struct Rules {
        /// The level's lists but `lastLists`, with My filters' exceptions.
        var lists: [WKContentRuleList] = []
        /// `lastLists`, with My filters' exceptions.
        var last: [WKContentRuleList] = []
        /// My filters, with the level's exceptions, compiled apart so that a
        /// line added to them compiles this small list alone
        /// (`exceptionLines`).
        var mine: [WKContentRuleList] = []
        /// My filters' page rules alone, for a page the lists skip
        /// (decision 1993).
        var own: [WKContentRuleList] = []
        /// The scripts of a site with JavaScript off, stopped in its frames
        /// on any page (`scriptRules`).
        var scripts: WKContentRuleList?

        /// The lists a page blocks with, in order: the level's and My
        /// filters' where its site has protections on, My filters' page
        /// rules alone where it hasn't or no list runs (decision 1993), and
        /// the scripts' everywhere.
        func installed(protected: Bool) -> [WKContentRuleList] {
            let level = lists + last
            return (protected && !level.isEmpty ? level + mine : own) + (scripts.map { [$0] } ?? [])
        }

        /// The lists of each part, named apart so that each part is
        /// compiled, kept and looked up on its own.
        enum Part: CaseIterable, Sendable {
            case lists, last, mine, own

            var field: WritableKeyPath<Rules, [WKContentRuleList]> {
                switch self {
                case .lists: \.lists
                case .last: \.last
                case .mine: \.mine
                case .own: \.own
                }
            }

            /// The identifiers' prefix. Each list is kept in a store of its
            /// own, named by its identifier (`ContentBlocker.store(for:)`).
            var prefix: String {
                switch self {
                case .lists: "sval-lists-"
                case .last: "sval-last-"
                case .mine: "sval-mine-"
                case .own: "sval-own-"
                }
            }
        }
    }

    /// What one part's rules are made from: `key` names the inputs and
    /// `convert` makes the rules.
    struct PartInputs: Sendable {
        let part: Rules.Part
        let key: String
        let convert: @Sendable () -> ContentRules
    }

    @ObservationIgnored private(set) var rules = Rules()
    /// The lists' request blocking, for what the app fetches itself, or none
    /// while no list runs.
    @ObservationIgnored private(set) var requests: RequestBlocker?
    @ObservationIgnored private var requestsGeneration = 0
    @ObservationIgnored var onChange: (@MainActor () -> Void)?
    /// Whether new rules are being compiled, which takes a few seconds.
    private(set) var applying = false

    /// Names what the lists' rules were last made from
    /// (`BlockerLists.key`).
    @ObservationIgnored private(set) var inputsKey: String?
    @ObservationIgnored private var working: Task<Void, Never>?
    /// The inputs given while a check runs, which it checks once done.
    @ObservationIgnored private var pending: BlockerInputs?
    /// The inputs last given, which a list falling due is checked with.
    @ObservationIgnored private var given: BlockerInputs?
    /// When each list's last download failed.
    @ObservationIgnored private var failedAt: [String: Date] = [:]
    @ObservationIgnored private var dueCheck: Task<Void, Never>?
    /// Where the downloaded lists are kept.
    private let directory: URL
    /// A list's text from its publisher, or nil when the download failed.
    typealias Download = @Sendable (URL) async -> Data?
    private let download: Download
    @ObservationIgnored private var scriptsKey: String?
    @ObservationIgnored private var scriptsWork: Task<Void, Never>?
    /// Whether the script rules were set from a compile this launch, which
    /// the lists looked up at launch never replace.
    @ObservationIgnored private var scriptsSet = false
    /// Where the compiled rule lists are kept across launches, one store
    /// to a list. WebKit compiles the lists of one store one at a time, on
    /// a queue it keeps for the store's path
    /// (`API::ContentRuleListStore`), so lists in stores of their own
    /// compile at once.
    private let stores: URL
    @ObservationIgnored private var opened: [String: WKContentRuleListStore] = [:]
    /// Where each part's key and count, and what was last applied, are kept.
    private let defaults: UserDefaults
    /// Whether the launch's lookup of the lists last applied has ended,
    /// with them applied or none to find, or a check has applied rules. A
    /// page made before then waits (`Page.loadsUnder`), so no document
    /// loads before lists compiled at an earlier launch are installed.
    @ObservationIgnored private(set) var ready = false
    @ObservationIgnored private var readyWaiters: [CheckedContinuation<Void, Never>] = []

    /// The desktop's curated levels (`SvalBlocking.sys.mjs`'s `BALANCED`
    /// and `STRICT`), with each list's address
    /// (`browser.sval.adblock.list.<id>.url`).
    nonisolated static let balanced = [
        "sval-ublock-filters": "https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt",
        "sval-ublock-badware": "https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt",
        "sval-ublock-privacy": "https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt",
        "sval-ublock-unbreak": "https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt",
        "sval-ublock-quick-fixes": "https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt",
        "sval-easylist": "https://easylist.to/easylist/easylist.txt",
        "sval-easyprivacy": "https://easylist.to/easylist/easyprivacy.txt",
        "sval-curben-urlhaus": "https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-ag-online.txt",
        "sval-brave-unbreak": "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt",
    ]
    nonisolated static let strictExtra = [
        "sval-hagezi-pro-mini": "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt",
        "sval-curben-phishing": "https://malware-filter.gitlab.io/phishing-filter/phishing-filter.txt",
        "sval-ublock-annoyances-others": "https://ublockorigin.github.io/uAssetsCDN/filters/annoyances-others.txt",
        "sval-fanboy-social": "https://easylist.to/easylist/fanboy-social.txt",
        "sval-easylist-cookie": "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
        "sval-ublock-cookies": "https://ublockorigin.github.io/uAssetsCDN/filters/annoyances-cookies.txt",
    ]

    nonisolated static let levelKey = "browser.sval.adblock.level"
    nonisolated static let pageRulesKey = "browser.sval.adblock.pageRules"
    nonisolated static let allowedBranch = "browser.sval.adblock.allowedDomain."

    /// How long a downloaded list is used before it is fetched again.
    nonisolated static let listLifetime: TimeInterval = 24 * 60 * 60
    /// How long a list whose download failed waits before the next try.
    nonisolated static let retryAfter: TimeInterval = 60 * 60
    private static let scriptsId = "sval-scripts"

    /// The level's lists that compile in a part of their own, after the
    /// others are applied: malware-filter's, the largest lists, which their
    /// publisher rewrites every 12 hours (`! Expires:` in each).
    nonisolated static let lastLists: Set<String> = ["sval-curben-urlhaus", "sval-curben-phishing"]

    /// Each part's prefix and its rule count as last applied, which a
    /// launch looks up before the check reads any list.
    private static let appliedKey = "contentRules.applied"
    /// Whether the script rules were last applied with a list.
    private static let scriptsAppliedKey = "contentRules.scripts.applied"

    /// `formerStore` is a store that may hold lists an earlier build
    /// compiled, which are removed.
    init(directory: URL = URL.cachesDirectory.appending(path: "blocklists", directoryHint: .isDirectory),
         download: @escaping Download = { await ContentBlocker.fetch($0) },
         stores: URL = URL.applicationSupportDirectory.appending(path: "ContentRuleLists", directoryHint: .isDirectory),
         defaults: UserDefaults = .standard, formerStore: WKContentRuleListStore? = nil) {
        self.directory = directory
        self.download = download
        self.stores = stores
        self.defaults = defaults
        Task { [weak self] in await self?.restoreApplied() }
        if let formerStore {
            Task { await Self.removeLists(from: formerStore) }
        }
    }

    /// Removes the lists Sval compiled into `store`.
    static func removeLists(from store: WKContentRuleListStore) async {
        for id in await store.availableIdentifiers() ?? [] where id.hasPrefix("sval-") {
            try? await store.removeContentRuleList(forIdentifier: id)
        }
    }

    /// The store that keeps the list `id`, in a folder of its own under
    /// `stores`. The lists are made again from the downloads, so `stores`
    /// is left out of the backup.
    private func store(for id: String) -> WKContentRuleListStore? {
        if let store = opened[id] { return store }
        let folder = stores.appending(path: id, directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var root = stores
            try root.setResourceValues(values)
        } catch {
            Diagnostics.log("blocking: a rule list's folder was not made: \(Diagnostics.name(error))")
            return nil
        }
        let store = WKContentRuleListStore(url: folder)
        opened[id] = store
        return store
    }

    /// The body of `url`'s answer when it is a 200.
    nonisolated static func fetch(_ url: URL) async -> Data? {
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }

    /// Returns once `ready`.
    func whenReady() async {
        guard !ready else { return }
        await withCheckedContinuation { readyWaiters.append($0) }
    }

    private func becomeReady() {
        guard !ready else { return }
        ready = true
        let waiters = readyWaiters
        readyWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    /// Applies the lists the last launch applied, by identifier from their
    /// stores. The check that follows finds the same keys and keeps them,
    /// or replaces them as it would any rules. A part with no record, or
    /// with a list gone from its store, is left out, and the first check's
    /// rules for it apply when it ends. With nothing found, pages load at
    /// once.
    private func restoreApplied() async {
        defer { becomeReady() }
        guard !LaunchOption.given("-svalNoBlocking") else { return }
        let counts = defaults.dictionary(forKey: Self.appliedKey) as? [String: Int] ?? [:]
        var next = Rules()
        var found = 0
        for part in Rules.Part.allCases {
            guard let count = counts[part.prefix],
                  let lists = await storedLists(part.prefix, count: count) else { continue }
            next[keyPath: part.field] = lists
            found += 1
        }
        var scripts: WKContentRuleList?
        if defaults.bool(forKey: Self.scriptsAppliedKey) {
            scripts = try? await store(for: Self.scriptsId)?.contentRuleList(forIdentifier: Self.scriptsId)
        }
        guard !ready, found > 0 || scripts != nil else { return }
        if !scriptsSet { rules.scripts = scripts }
        apply(next)
        Diagnostics.log("blocking: \(Rules.Part.allCases.map { next[keyPath: $0.field].count }.reduce(0, +)) list(s) from the last launch applied")
    }

    /// Brings the rules in line with `inputs`: compiles the script rules at
    /// once when the JavaScript rules changed, then checks the lists' rules
    /// off the main actor and rebuilds them when the level, the page-rules
    /// switch, My filters or the allowed domains changed, or a list is due a
    /// download. Inputs given while a check runs are checked once it is
    /// done.
    func update(_ inputs: BlockerInputs) {
        given = inputs
        updateScripts(inputs)
        guard working == nil else {
            pending = inputs
            return
        }
        working = Task {
            var next: BlockerInputs? = inputs
            while let inputs = next {
                await check(inputs)
                next = pending
                pending = nil
            }
            working = nil
        }
    }

    /// Returns once the check under way, and any asked for meanwhile, are
    /// done.
    func settled() async {
        await working?.value
    }

    private func check(_ inputs: BlockerInputs) async {
        let checking = Signposts.blocker.beginInterval("check")
        defer { Signposts.blocker.endInterval("check", checking) }
        // A developer's launch option, to tell a page the rules break from
        // one that is broken anyway.
        if LaunchOption.given("-svalNoBlocking") {
            if inputsKey != "off" {
                inputsKey = "off"
                requestsGeneration += 1
                requests = nil
                apply(Rules())
                Diagnostics.log("blocking: off by launch option")
            }
            return
        }
        let directory = directory
        let failedAt = failedAt
        let lists = await Task.detached(priority: .userInitiated) {
            BlockerLists(inputs, in: directory, failedAt: failedAt, now: .now)
        }.value
        var next = lists.next
        if lists.key != inputsKey || lists.due {
            inputsKey = lists.key
            await rebuild(inputs, due: lists.due)
            let failedAt = self.failedAt
            next = await Task.detached(priority: .utility) {
                BlockerLists(inputs, in: directory, failedAt: failedAt, now: .now).next
            }.value
        }
        checkAgain(at: next)
    }

    /// Checks the inputs last given again when the next list falls due, so
    /// a list is fetched again while the app stays open.
    private func checkAgain(at date: Date?) {
        dueCheck?.cancel()
        dueCheck = date.map { date in
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(date.timeIntervalSinceNow, 0)))
                guard !Task.isCancelled, let self, let given else { return }
                update(given)
            }
        }
    }

    private func rebuild(_ inputs: BlockerInputs, due: Bool) async {
        let (lists, pageRules, myFilters, allowed) = (inputs.lists, inputs.pageRules, inputs.myFilters, inputs.allowed)
        // My filters' request blocking is ad blocking, and goes with the
        // lists; their page rules apply at every level (decision 1993).
        let own = pageRules ? myFilters : ""
        requestsGeneration += 1
        let generation = requestsGeneration
        if lists.isEmpty && own.isEmpty {
            requests = nil
            apply(Rules())
            defaults.set([String: Int](), forKey: Self.appliedKey)
            removeUnused()
            Diagnostics.log("blocking: off")
            return
        }
        let started = Date.now
        let building = Signposts.blocker.beginInterval("rebuild")
        defer { Signposts.blocker.endInterval("rebuild", building) }
        // Shown only while there's work the user waits on: a download or a
        // compile. Rules already compiled load at once.
        if due { applying = true }
        defer { applying = false }
        // The lists run to megabytes each, read and hashed at every launch,
        // so they are kept off the main thread.
        let directory = directory
        let failedAt = failedAt
        let download = download
        let (texts, failed) = await Task.detached(priority: .userInitiated) {
            await withTaskGroup(of: (id: String, text: String?, failed: Bool).self) { group in
                for (id, address) in lists {
                    group.addTask {
                        let part = Self.lastLists.contains(id) ? "last" : "lists"
                        let fetching = Signposts.blocker.beginInterval("download", "\(part, privacy: .public)")
                        defer { Signposts.blocker.endInterval("download", fetching) }
                        let list = await Self.list(id: id, address: address, in: directory, failedAt: failedAt,
                                                   download: download)
                        return (id, list.text, list.failed)
                    }
                }
                var texts: [(id: String, text: String)] = []
                var failed: [String] = []
                for await list in group {
                    if let text = list.text { texts.append((list.id, text)) }
                    if list.failed { failed.append(list.id) }
                }
                return (texts.sorted { $0.id < $1.id }, failed)
            }
        }.value
        let now = Date.now
        for id in failed { self.failedAt[id] = now }
        // Made apart from the rules, so a page waits on neither for the
        // other.
        Task {
            let made = await Task.detached(priority: .utility) {
                texts.isEmpty ? nil : RequestBlocker(lists: texts.map(\.text) + [myFilters], allowedDomains: allowed)
            }.value
            if generation == requestsGeneration { requests = made }
        }
        let parts = await Task.detached(priority: .utility) {
            Self.parts(texts: texts, pageRules: pageRules, myFilters: myFilters, allowed: allowed)
        }.value
        // The last lists compile once the other parts are applied, so their
        // compile takes no time from the others'. A part that fails to
        // compile keeps the lists it had.
        let absent = Set(Rules.Part.allCases).subtracting(parts.map(\.part))
        let stages = [(parts.filter { $0.part != .last }, absent), (parts.filter { $0.part == .last }, [])]
        var converted = 0
        for (stage, cleared) in stages where !stage.isEmpty || !cleared.isEmpty {
            let made = await withTaskGroup(of: (Rules.Part, (lists: [WKContentRuleList], rules: Int)?).self) { group in
                for part in stage {
                    group.addTask { @MainActor in (part.part, await self.made(part)) }
                }
                var made: [(Rules.Part, (lists: [WKContentRuleList], rules: Int)?)] = []
                for await result in group { made.append(result) }
                return made
            }
            var next = rules
            for part in cleared {
                next[keyPath: part.field] = []
                recordApplied(part, count: nil)
            }
            for (part, result) in made {
                guard let result else { continue }
                next[keyPath: part.field] = result.lists
                recordApplied(part, count: result.lists.count)
                converted += result.rules
            }
            apply(next)
        }
        removeUnused()
        let count = Rules.Part.allCases.map { rules[keyPath: $0.field].count }.reduce(0, +)
        Diagnostics.log("blocking: \(converted) rule(s) converted in \(count) list(s) from \(texts.count) source(s), \(Int(Date.now.timeIntervalSince(started))) s")
    }

    /// The parts the rules are made in, from each list's text by id.
    ///
    /// A lift reaches only the rules before it in its own list
    /// (`content_rules`), and a `$badfilter` only the rules converted with
    /// it. So each part made from the level's lists takes the shared lines
    /// (`sharedLines`) of the lists in the other part, and My filters'
    /// exceptions, and its rules come out as they would from all the lists
    /// converted together. My filters take the lists' exceptions.
    nonisolated static func parts(texts: [(id: String, text: String)], pageRules: Bool, myFilters: String,
                                  allowed: [String]) -> [PartInputs] {
        // Each key names what its rules are made from, the converter
        // included, so compiled rules are reused across launches until one
        // changes.
        let common = [converterVersion(), String(pageRules), allowed.joined(separator: ",")]
        let shared = texts.map { sharedLines(list: $0.text) }
        let theirs = exceptionLines(list: myFilters)
        var parts: [PartInputs] = []
        for part in [Rules.Part.lists, .last] {
            let inPart = texts.indices.filter { lastLists.contains(texts[$0].id) == (part == .last) }
            guard !inPart.isEmpty else { continue }
            let others = texts.indices.filter { !inPart.contains($0) }.map { shared[$0] }.joined()
            let lists = inPart.map { texts[$0].text } + [others, theirs].filter { !$0.isEmpty }
            parts.append(PartInputs(part: part, key: digest(common + lists.map { digest([$0]) }),
                                    convert: { contentRules(lists: lists, pageRules: pageRules, allowedDomains: allowed) }))
        }
        if !texts.isEmpty, !myFilters.isEmpty {
            let lists = [shared.map { exceptionLines(list: $0) }.joined(), myFilters]
            parts.append(PartInputs(part: .mine, key: digest(common + lists),
                                    convert: { contentRules(lists: lists, pageRules: pageRules, allowedDomains: allowed) }))
        }
        let own = pageRules ? myFilters : ""
        if !own.isEmpty {
            parts.append(PartInputs(part: .own, key: digest(common + [own]),
                                    convert: { ownPageRules(myFilters: own) }))
        }
        return parts
    }

    /// The rules `inputs` makes, compiled under its part's prefix, or those
    /// compiled earlier when its key names the same inputs. Returns how
    /// many rules it converted, 0 for rules reused, or nil when a list
    /// fails to compile.
    private func made(_ inputs: PartInputs) async -> (lists: [WKContentRuleList], rules: Int)? {
        let prefix = inputs.part.prefix
        let keyName = "contentRules.\(prefix).key"
        let countName = "contentRules.\(prefix).count"
        if inputs.key == defaults.string(forKey: keyName),
           let stored = await storedLists(prefix, count: defaults.integer(forKey: countName)) {
            return (stored, 0)
        }
        // The compile writes over this part's lists, so neither a launch nor
        // a later check may take them as they were.
        recordApplied(inputs.part, count: nil)
        defaults.removeObject(forKey: keyName)
        applying = true
        let converting = Signposts.blocker.beginInterval("convert", "\(prefix, privacy: .public)")
        let converted = await Task.detached(priority: .utility) { inputs.convert() }.value
        Signposts.blocker.endInterval("convert", converting)
        let compiling = Signposts.blocker.beginInterval("compile", "\(prefix, privacy: .public)")
        let compiled = await compile(converted.lists, prefix: prefix)
        Signposts.blocker.endInterval("compile", compiling)
        guard let compiled else { return nil }
        defaults.set(inputs.key, forKey: keyName)
        defaults.set(compiled.count, forKey: countName)
        return (compiled, Int(converted.rules))
    }

    /// `lists` compiled at once, each under `prefix` and its place in its
    /// own store, or none when one fails to compile.
    private func compile(_ lists: [String], prefix: String) async -> [WKContentRuleList]? {
        let compiled = await withTaskGroup(of: (Int, WKContentRuleList?).self) { group in
            for (index, json) in lists.enumerated() {
                let id = prefix + String(index)
                group.addTask { @MainActor in
                    guard let store = self.store(for: id) else { return (index, nil) }
                    do {
                        return (index, try await store.compileContentRuleList(forIdentifier: id,
                                                                              encodedContentRuleList: json))
                    } catch {
                        Diagnostics.log("blocking: a rule list failed to compile: \(Diagnostics.name(error))")
                        return (index, nil)
                    }
                }
            }
            var compiled: [Int: WKContentRuleList] = [:]
            for await (index, list) in group {
                if let list { compiled[index] = list }
            }
            return compiled
        }
        return compiled.count == lists.count ? lists.indices.compactMap { compiled[$0] } : nil
    }

    /// Records the count of `part`'s lists as applied, or that none are
    /// for a launch to look up.
    private func recordApplied(_ part: Rules.Part, count: Int?) {
        var counts = defaults.dictionary(forKey: Self.appliedKey) as? [String: Int] ?? [:]
        counts[part.prefix] = count
        defaults.set(counts, forKey: Self.appliedKey)
    }

    /// Removes the stores of the lists no part has applied: those past the
    /// count a part compiled, and those of a part that no longer runs.
    private func removeUnused() {
        let kept = Set(Rules.Part.allCases.flatMap { rules[keyPath: $0.field].map(\.identifier) })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: stores.path(percentEncoded: false))) ?? []
        for name in names where !kept.contains(name)
            && Rules.Part.allCases.contains(where: { name.hasPrefix($0.prefix) }) {
            opened[name] = nil
            try? FileManager.default.removeItem(at: stores.appending(path: name, directoryHint: .isDirectory))
        }
    }

    /// Takes the lists `made` holds, leaving the scripts', which change
    /// apart (`updateScripts`).
    private func apply(_ made: Rules) {
        for part in Rules.Part.allCases {
            rules[keyPath: part.field] = made[keyPath: part.field]
        }
        becomeReady()
        onChange?()
    }

    /// Compiles the rules that stop a JavaScript-off site's scripts in its
    /// frames when the JavaScript rules changed. They are small, so they are
    /// compiled again at each launch.
    private func updateScripts(_ inputs: BlockerInputs) {
        let json = scriptRules(allowedDefault: inputs.scriptsByDefault,
                               rules: inputs.scripts.sorted { $0.key < $1.key }
                                   .map { ScriptRule(name: $0.key, allowed: $0.value) })
        let key = json ?? ""
        guard key != scriptsKey else { return }
        scriptsKey = key
        let previous = scriptsWork
        scriptsWork = Task {
            await previous?.value
            guard key == scriptsKey else { return }
            var list: WKContentRuleList?
            if let json {
                // The compile writes over the stored list.
                defaults.set(false, forKey: Self.scriptsAppliedKey)
                do {
                    list = try await store(for: Self.scriptsId)?
                        .compileContentRuleList(forIdentifier: Self.scriptsId, encodedContentRuleList: json)
                } catch {
                    Diagnostics.log("blocking: the script rules failed to compile: \(Diagnostics.name(error))")
                    return
                }
            }
            guard key == scriptsKey else { return }
            rules.scripts = list
            scriptsSet = true
            defaults.set(list != nil, forKey: Self.scriptsAppliedKey)
            onChange?()
        }
    }

    /// Returns once the script rules for the settings last given are in
    /// `rules`, so a page reloaded for a JavaScript choice loads under them.
    func scriptsApplied() async {
        await scriptsWork?.value
    }

    /// A list's text: the download if it is fresh or its last download
    /// failed within `retryAfter`, a new download if not, and the old
    /// download when a new one fails. `failed` is set when the new download
    /// failed or was not kept: a list left without a file stays due, and
    /// would be fetched at every check.
    nonisolated private static func list(id: String, address: String, in directory: URL,
                                         failedAt: [String: Date],
                                         download: Download) async -> (text: String?, failed: Bool) {
        let file = directory.appending(path: "\(id).txt")
        let now = Date.now
        if BlockerLists.waits(id, failedAt: failedAt, now: now) {
            return (try? String(contentsOf: file, encoding: .utf8), false)
        }
        if !BlockerLists.isDue(id, in: directory, failedAt: failedAt, now: now),
           let text = try? String(contentsOf: file, encoding: .utf8) {
            return (text, false)
        }
        if let url = URL(string: address), let data = await download(url),
           let text = String(data: data, encoding: .utf8) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let kept = (try? data.write(to: file, options: .atomic)) != nil
            return (text, !kept)
        }
        Diagnostics.log("blocking: a list download failed")
        return (try? String(contentsOf: file, encoding: .utf8), true)
    }

    private func storedLists(_ prefix: String, count: Int) async -> [WKContentRuleList]? {
        var lists: [WKContentRuleList] = []
        for index in 0..<count {
            let id = prefix + String(index)
            guard let list = try? await store(for: id)?.contentRuleList(forIdentifier: id) else { return nil }
            lists.append(list)
        }
        return lists
    }

    nonisolated static func digest(_ parts: [String]) -> String {
        SHA256.hash(data: Data(parts.joined(separator: "\u{1F}").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}

/// What the blocker's rules are made from, read from the synced settings
/// once per change. It is Sendable, so the check of the downloaded lists
/// runs off the main actor.
struct BlockerInputs: Sendable, Equatable {
    let level: String
    /// The level's lists by id, each with its address.
    let lists: [String: String]
    let pageRules: Bool
    let myFilters: String
    /// The allowed domains, sorted.
    let allowed: [String]
    /// Whether a site with no JavaScript rule of its own runs scripts.
    let scriptsByDefault: Bool
    /// Each site's JavaScript rule, true where it allows scripts.
    let scripts: [String: Bool]

    init(settings: [String: Any]) {
        level = settings[ContentBlocker.levelKey] as? String ?? "balanced"
        // Custom's lists aren't on the phone yet, so it blocks as Balanced.
        lists = switch level {
        case "off": [:]
        case "strict": ContentBlocker.balanced.merging(ContentBlocker.strictExtra) { a, _ in a }
        default: ContentBlocker.balanced
        }
        pageRules = (settings[ContentBlocker.pageRulesKey] as? Bool ?? true)
            && !LaunchOption.given("-svalNoPageRules")
        myFilters = MyFilters.text(settings: settings)
        allowed = settings
            .filter { $0.key.hasPrefix(ContentBlocker.allowedBranch) && ($0.value as? Bool) == true }
            .map { String($0.key.dropFirst(ContentBlocker.allowedBranch.count)) }
            .sorted()
        scriptsByDefault = settings[JavaScriptRules.enabledKey] as? Bool ?? true
        var scripts: [String: Bool] = [:]
        for (key, value) in settings where key.hasPrefix(JavaScriptRules.siteBranch) {
            guard let rule = value as? String, rule == "allow" || rule == "block" else { continue }
            scripts[String(key.dropFirst(JavaScriptRules.siteBranch.count))] = rule == "allow"
        }
        self.scripts = scripts
    }
}

/// The downloaded lists' share of the blocker's check, read from the files
/// in `directory` off the main actor.
struct BlockerLists: Equatable, Sendable {
    /// Names the inputs and each list's download, so the rules are made
    /// again when either changes.
    let key: String
    /// Whether a list is due a download.
    let due: Bool
    /// When the next list falls due, or nil at a level with no lists.
    let next: Date?

    init(_ inputs: BlockerInputs, in directory: URL, failedAt: [String: Date], now: Date) {
        let ids = inputs.lists.keys.sorted()
        key = ContentBlocker.digest([
            inputs.level, String(inputs.pageRules), inputs.myFilters, inputs.allowed.joined(separator: ","),
            ids.map { "\($0)@\(Self.downloadedAt($0, in: directory)?.timeIntervalSince1970 ?? 0)" }
                .joined(separator: ","),
        ])
        due = ids.contains { Self.isDue($0, in: directory, failedAt: failedAt, now: now) }
        next = ids.map { id in
            if Self.waits(id, failedAt: failedAt, now: now), let failed = failedAt[id] {
                return failed.addingTimeInterval(ContentBlocker.retryAfter)
            }
            return Self.downloadedAt(id, in: directory)?.addingTimeInterval(ContentBlocker.listLifetime) ?? now
        }.min()
    }

    /// Whether list `id`'s last download failed within `retryAfter`.
    static func waits(_ id: String, failedAt: [String: Date], now: Date) -> Bool {
        failedAt[id].map { now.timeIntervalSince($0) < ContentBlocker.retryAfter } ?? false
    }

    /// Whether list `id` is missing or older than `listLifetime`, and is not
    /// waiting after a failed download.
    static func isDue(_ id: String, in directory: URL, failedAt: [String: Date], now: Date) -> Bool {
        guard !waits(id, failedAt: failedAt, now: now) else { return false }
        guard let at = downloadedAt(id, in: directory) else { return true }
        return now.timeIntervalSince(at) > ContentBlocker.listLifetime
    }

    static func downloadedAt(_ id: String, in directory: URL) -> Date? {
        let file = directory.appending(path: "\(id).txt")
        return (try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false)))?[.modificationDate] as? Date
    }
}
