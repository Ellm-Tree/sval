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
        /// The level's lists, My filters with them.
        var lists: [WKContentRuleList] = []
        /// My filters' page rules alone, for a page the lists skip
        /// (decision 1993).
        var own: [WKContentRuleList] = []
        /// The scripts of a site with JavaScript off, stopped in its frames
        /// on any page (`scriptRules`).
        var scripts: WKContentRuleList?

        /// The lists a page blocks with, in order: the level's where its
        /// site has protections on, My filters' page rules alone where it
        /// hasn't or no list runs (decision 1993), and the scripts'
        /// everywhere.
        func installed(protected: Bool) -> [WKContentRuleList] {
            (protected && !lists.isEmpty ? lists : own) + (scripts.map { [$0] } ?? [])
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

    @ObservationIgnored private var inputsKey: String?
    @ObservationIgnored private var working: Task<Void, Never>?
    @ObservationIgnored private var scriptsKey: String?
    @ObservationIgnored private var scriptsWork: Task<Void, Never>?

    /// The desktop's curated levels (`SvalBlocking.sys.mjs`'s `BALANCED`
    /// and `STRICT`), with each list's address
    /// (`browser.sval.adblock.list.<id>.url`).
    static let balanced = [
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
    static let strictExtra = [
        "sval-hagezi-pro-mini": "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt",
        "sval-curben-phishing": "https://malware-filter.gitlab.io/phishing-filter/phishing-filter.txt",
        "sval-ublock-annoyances-others": "https://ublockorigin.github.io/uAssetsCDN/filters/annoyances-others.txt",
        "sval-fanboy-social": "https://easylist.to/easylist/fanboy-social.txt",
        "sval-easylist-cookie": "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
        "sval-ublock-cookies": "https://ublockorigin.github.io/uAssetsCDN/filters/annoyances-cookies.txt",
    ]

    static let levelKey = "browser.sval.adblock.level"
    static let pageRulesKey = "browser.sval.adblock.pageRules"
    static let myFiltersKey = "browser.sval.adblock.myFilters"
    static let allowedBranch = "browser.sval.adblock.allowedDomain."

    /// How long a downloaded list is used before it is fetched again.
    nonisolated static let listLifetime: TimeInterval = 24 * 60 * 60
    private static let compiledKey = "contentRulesKey"
    private static let compiledCount = "contentRulesCount"
    private static let ownCount = "contentRulesOwnCount"
    private static let idPrefix = "sval-rules-"
    private static let ownPrefix = "sval-own-"
    private static let scriptsId = "sval-scripts"

    nonisolated private static var cacheDirectory: URL {
        URL.cachesDirectory.appending(path: "blocklists", directoryHint: .isDirectory)
    }

    /// Brings the rules in line with the synced settings: rebuilds them when
    /// the level, the page-rules switch, My filters or the allowed domains
    /// changed, or a list is due a download.
    func update(settings: [String: Any]) {
        updateScripts(settings: settings)
        // A developer's launch option, to tell a page the rules break from
        // one that is broken anyway.
        if LaunchOption.given("-svalNoBlocking") {
            if inputsKey != "off" {
                inputsKey = "off"
                requestsGeneration += 1
                requests = nil
                apply([], own: [])
                Diagnostics.log("blocking: off by launch option")
            }
            return
        }
        let level = settings[Self.levelKey] as? String ?? "balanced"
        // Custom's lists aren't on the phone yet, so it blocks as Balanced.
        let lists: [String: String] = switch level {
        case "off": [:]
        case "strict": Self.balanced.merging(Self.strictExtra) { a, _ in a }
        default: Self.balanced
        }
        let pageRules = (settings[Self.pageRulesKey] as? Bool ?? true)
            && !LaunchOption.given("-svalNoPageRules")
        let myFilters = settings[Self.myFiltersKey] as? String ?? ""
        let allowed = settings
            .filter { $0.key.hasPrefix(Self.allowedBranch) && ($0.value as? Bool) == true }
            .map { String($0.key.dropFirst(Self.allowedBranch.count)) }
            .sorted()
        let due = lists.keys.contains { Self.isDue($0) }
        let key = Self.digest([
            level, String(pageRules), myFilters, allowed.joined(separator: ","),
            lists.keys.sorted().map { "\($0)@\(Self.downloadedAt($0)?.timeIntervalSince1970 ?? 0)" }
                .joined(separator: ","),
        ])
        guard key != inputsKey || due, working == nil else { return }
        inputsKey = key
        working = Task {
            await rebuild(lists: lists, pageRules: pageRules, myFilters: myFilters, allowed: allowed)
            working = nil
        }
    }

    private func rebuild(lists: [String: String], pageRules: Bool, myFilters: String, allowed: [String]) async {
        // My filters' request blocking is ad blocking, and goes with the
        // lists; their page rules apply at every level (decision 1993).
        let own = pageRules ? myFilters : ""
        requestsGeneration += 1
        let generation = requestsGeneration
        if lists.isEmpty && own.isEmpty {
            requests = nil
            apply([], own: [])
            Diagnostics.log("blocking: off")
            return
        }
        let started = Date.now
        // Shown only while there's work the user waits on: a download or a
        // compile. Rules already compiled load at once.
        if lists.keys.contains(where: Self.isDue) { applying = true }
        defer { applying = false }
        // The lists run to megabytes each, read and hashed at every launch,
        // so they are kept off the main thread.
        let (texts, key) = await Task.detached(priority: .userInitiated) {
            var texts: [String] = []
            for (id, address) in lists.sorted(by: { $0.key < $1.key }) {
                if let text = await Self.list(id: id, address: address) {
                    texts.append(text)
                }
            }
            if !texts.isEmpty, !myFilters.isEmpty { texts.append(myFilters) }
            // The key names what the rules were made from, the downloads
            // and the converter included, so the compiled rules are reused
            // across launches until one changes.
            let key = Self.digest([converterVersion(), String(pageRules), myFilters, allowed.joined(separator: ",")]
                + texts.map { Self.digest([$0]) })
            return (texts, key)
        }.value
        // Made apart from the rules, so a page waits on neither for the
        // other.
        Task {
            let made = await Task.detached(priority: .utility) {
                texts.isEmpty ? nil : RequestBlocker(lists: texts, allowedDomains: allowed)
            }.value
            if generation == requestsGeneration { requests = made }
        }
        let defaults = UserDefaults.standard
        if key == defaults.string(forKey: Self.compiledKey),
           let stored = await Self.storedLists(Self.idPrefix, count: defaults.integer(forKey: Self.compiledCount)),
           let storedOwn = await Self.storedLists(Self.ownPrefix, count: defaults.integer(forKey: Self.ownCount)) {
            apply(stored, own: storedOwn)
            Diagnostics.log("blocking: \(stored.count + storedOwn.count) compiled list(s) reused")
            return
        }
        applying = true
        let (converted, ownConverted) = await Task.detached(priority: .utility) {
            (texts.isEmpty ? ContentRules(lists: [], rules: 0)
                : contentRules(lists: texts, pageRules: pageRules, allowedDomains: allowed),
             own.isEmpty ? ContentRules(lists: [], rules: 0) : ownPageRules(myFilters: own))
        }.value
        guard let compiled = await Self.compile(converted.lists, prefix: Self.idPrefix),
              let compiledOwn = await Self.compile(ownConverted.lists, prefix: Self.ownPrefix) else { return }
        defaults.set(key, forKey: Self.compiledKey)
        defaults.set(compiled.count, forKey: Self.compiledCount)
        defaults.set(compiledOwn.count, forKey: Self.ownCount)
        apply(compiled, own: compiledOwn)
        Diagnostics.log("blocking: \(converted.rules + ownConverted.rules) rule(s) in \(compiled.count + compiledOwn.count) list(s) from \(texts.count) source(s), \(Int(Date.now.timeIntervalSince(started))) s")
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

    private func apply(_ lists: [WKContentRuleList], own: [WKContentRuleList]) {
        rules.lists = lists
        rules.own = own
        onChange?()
    }

    /// Compiles the rules that stop a JavaScript-off site's scripts in its
    /// frames when the JavaScript rules changed. They are small, so they are
    /// compiled again at each launch.
    private func updateScripts(settings: [String: Any]) {
        let allowedDefault = settings[JavaScriptRules.enabledKey] as? Bool ?? true
        let named = settings.compactMap { key, value -> ScriptRule? in
            guard key.hasPrefix(JavaScriptRules.siteBranch), let rule = value as? String,
                  rule == "allow" || rule == "block" else { return nil }
            return ScriptRule(name: String(key.dropFirst(JavaScriptRules.siteBranch.count)), allowed: rule == "allow")
        }
        let json = scriptRules(allowedDefault: allowedDefault, rules: named)
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

    /// A list's text: the download if it is fresh, a new download if not,
    /// and the old download when a new one fails.
    nonisolated private static func list(id: String, address: String) async -> String? {
        let file = cacheDirectory.appending(path: "\(id).txt")
        if !isDue(id), let text = try? String(contentsOf: file, encoding: .utf8) {
            return text
        }
        if let url = URL(string: address),
           let (data, response) = try? await URLSession.shared.data(from: url),
           (response as? HTTPURLResponse)?.statusCode == 200,
           let text = String(data: data, encoding: .utf8) {
            try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
            return text
        }
        Diagnostics.log("blocking: a list download failed")
        return try? String(contentsOf: file, encoding: .utf8)
    }

    nonisolated private static func downloadedAt(_ id: String) -> Date? {
        let file = cacheDirectory.appending(path: "\(id).txt")
        return (try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false)))?[.modificationDate] as? Date
    }

    nonisolated private static func isDue(_ id: String) -> Bool {
        guard let at = downloadedAt(id) else { return true }
        return Date.now.timeIntervalSince(at) > listLifetime
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

    nonisolated private static func digest(_ parts: [String]) -> String {
        SHA256.hash(data: Data(parts.joined(separator: "\u{1F}").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}
