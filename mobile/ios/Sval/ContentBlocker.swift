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
        /// The level's lists, with My filters' exceptions.
        var lists: [WKContentRuleList] = []
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
            (protected && !lists.isEmpty ? lists + mine : own) + (scripts.map { [$0] } ?? [])
        }
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
    @ObservationIgnored private var scriptsKey: String?
    @ObservationIgnored private var scriptsWork: Task<Void, Never>?

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
    private static let idPrefix = "sval-rules-"
    private static let minePrefix = "sval-mine-"
    private static let ownPrefix = "sval-own-"
    private static let scriptsId = "sval-scripts"

    init(directory: URL = URL.cachesDirectory.appending(path: "blocklists", directoryHint: .isDirectory)) {
        self.directory = directory
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
        let (texts, failed) = await Task.detached(priority: .userInitiated) {
            var texts: [String] = []
            var failed: [String] = []
            for (id, address) in lists.sorted(by: { $0.key < $1.key }) {
                let list = await Self.list(id: id, address: address, in: directory, failedAt: failedAt)
                if let text = list.text { texts.append(text) }
                if list.failed { failed.append(id) }
            }
            return (texts, failed)
        }.value
        let now = Date.now
        for id in failed { self.failedAt[id] = now }
        // Made apart from the rules, so a page waits on neither for the
        // other.
        Task {
            let made = await Task.detached(priority: .utility) {
                texts.isEmpty ? nil : RequestBlocker(lists: texts + [myFilters], allowedDomains: allowed)
            }.value
            if generation == requestsGeneration { requests = made }
        }
        // Each key names what its rules are made from, the converter
        // included, so compiled rules are reused across launches until one
        // changes.
        let common = [converterVersion(), String(pageRules), allowed.joined(separator: ",")]
        let level = await Task.detached(priority: .utility) { () -> (key: String, convert: @Sendable () -> ContentRules)? in
            guard !texts.isEmpty else { return nil }
            let theirs = exceptionLines(list: myFilters)
            let inputs = texts + (theirs.isEmpty ? [] : [theirs])
            return (Self.digest(common + inputs.map { Self.digest([$0]) }),
                    { contentRules(lists: inputs, pageRules: pageRules, allowedDomains: allowed) })
        }.value
        let mine = await Task.detached(priority: .utility) { () -> (key: String, convert: @Sendable () -> ContentRules)? in
            guard !texts.isEmpty, !myFilters.isEmpty else { return nil }
            let inputs = [texts.map(exceptionLines).joined(), myFilters]
            return (Self.digest(common + inputs),
                    { contentRules(lists: inputs, pageRules: pageRules, allowedDomains: allowed) })
        }.value
        typealias Part = (part: WritableKeyPath<Rules, [WKContentRuleList]>, prefix: String,
                          key: String?, convert: (@Sendable () -> ContentRules)?)
        var next = Rules()
        var counts: [Int] = []
        let parts: [Part] = [
            (\Rules.lists, Self.idPrefix, level?.key, level?.convert),
            (\Rules.mine, Self.minePrefix, mine?.key, mine?.convert),
            (\Rules.own, Self.ownPrefix, own.isEmpty ? nil : Self.digest(common + [own]),
             own.isEmpty ? nil : { @Sendable in ownPageRules(myFilters: own) }),
        ]
        for (part, prefix, key, convert) in parts {
            guard let key, let convert else { continue }
            guard let compiled = await made(prefix: prefix, key: key, convert: convert) else { return }
            next[keyPath: part] = compiled.lists
            counts.append(compiled.rules)
        }
        apply(next)
        Diagnostics.log("blocking: \(counts.reduce(0, +)) rule(s) converted in \(next.lists.count + next.mine.count + next.own.count) list(s) from \(texts.count) source(s), \(Int(Date.now.timeIntervalSince(started))) s")
    }

    /// The rules `convert` makes, compiled under `prefix`, or those compiled
    /// earlier when `key` names the same inputs. Returns how many rules it
    /// converted, 0 for rules reused, or nil when a list fails to compile.
    private func made(prefix: String, key: String,
                      convert: @escaping @Sendable () -> ContentRules) async -> (lists: [WKContentRuleList], rules: Int)? {
        let defaults = UserDefaults.standard
        let keyName = "contentRules.\(prefix).key"
        let countName = "contentRules.\(prefix).count"
        if key == defaults.string(forKey: keyName),
           let stored = await Self.storedLists(prefix, count: defaults.integer(forKey: countName)) {
            return (stored, 0)
        }
        applying = true
        let converted = await Task.detached(priority: .utility) { convert() }.value
        guard let compiled = await Self.compile(converted.lists, prefix: prefix) else { return nil }
        defaults.set(key, forKey: keyName)
        defaults.set(compiled.count, forKey: countName)
        return (compiled, Int(converted.rules))
    }

    /// `lists` compiled, each under `prefix` and its place, or none when one
    /// fails to compile.
    private static func compile(_ lists: [String], prefix: String) async -> [WKContentRuleList]? {
        var compiled: [WKContentRuleList] = []
        for (index, json) in lists.enumerated() {
            do {
                if let list = try await WKContentRuleListStore.default()
                    .compileContentRuleList(forIdentifier: prefix + String(index), encodedContentRuleList: json) {
                    compiled.append(list)
                }
            } catch {
                Diagnostics.log("blocking: a rule list failed to compile: \(Diagnostics.name(error))")
            }
        }
        return compiled.count == lists.count ? compiled : nil
    }

    /// Takes the lists `made` holds, leaving the scripts', which change
    /// apart (`updateScripts`).
    private func apply(_ made: Rules) {
        rules.lists = made.lists
        rules.mine = made.mine
        rules.own = made.own
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
                do {
                    list = try await WKContentRuleListStore.default()
                        .compileContentRuleList(forIdentifier: Self.scriptsId, encodedContentRuleList: json)
                } catch {
                    Diagnostics.log("blocking: the script rules failed to compile: \(Diagnostics.name(error))")
                    return
                }
            }
            guard key == scriptsKey else { return }
            rules.scripts = list
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
                                         failedAt: [String: Date]) async -> (text: String?, failed: Bool) {
        let file = directory.appending(path: "\(id).txt")
        let now = Date.now
        if BlockerLists.waits(id, failedAt: failedAt, now: now) {
            return (try? String(contentsOf: file, encoding: .utf8), false)
        }
        if !BlockerLists.isDue(id, in: directory, failedAt: failedAt, now: now),
           let text = try? String(contentsOf: file, encoding: .utf8) {
            return (text, false)
        }
        if let url = URL(string: address),
           let (data, response) = try? await URLSession.shared.data(from: url),
           (response as? HTTPURLResponse)?.statusCode == 200,
           let text = String(data: data, encoding: .utf8) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let kept = (try? data.write(to: file, options: .atomic)) != nil
            return (text, !kept)
        }
        Diagnostics.log("blocking: a list download failed")
        return (try? String(contentsOf: file, encoding: .utf8), true)
    }

    private static func storedLists(_ prefix: String, count: Int) async -> [WKContentRuleList]? {
        var lists: [WKContentRuleList] = []
        for index in 0..<count {
            guard let list = try? await WKContentRuleListStore.default()
                .contentRuleList(forIdentifier: prefix + String(index))
            else { return nil }
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
