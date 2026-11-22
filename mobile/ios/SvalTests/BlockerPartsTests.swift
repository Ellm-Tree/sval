// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// The blocker's rules made in parts (`ContentBlocker.parts`), against the
/// rules the level's lists made converted all together, kept here as they
/// were made.
final class BlockerPartsRulesTests: XCTestCase {
    /// The lists' JSON as the blocker made it before it made parts: the
    /// level's lists converted together with My filters' exceptions, and My
    /// filters with the lists' exceptions.
    private func together(_ texts: [(id: String, text: String)], pageRules: Bool, myFilters: String,
                          allowed: [String]) -> [String] {
        let texts = texts.map(\.text)
        let theirs = exceptionLines(list: myFilters)
        var lists = contentRules(lists: texts + (theirs.isEmpty ? [] : [theirs]), pageRules: pageRules,
                                 allowedDomains: allowed).lists
        if !texts.isEmpty, !myFilters.isEmpty {
            lists += contentRules(lists: [texts.map { exceptionLines(list: $0) }.joined(), myFilters],
                                  pageRules: pageRules, allowedDomains: allowed).lists
        }
        return lists
    }

    private func inParts(_ texts: [(id: String, text: String)], pageRules: Bool, myFilters: String,
                         allowed: [String]) -> [String] {
        ContentBlocker.parts(texts: texts, pageRules: pageRules, myFilters: myFilters, allowed: allowed)
            .filter { $0.part != .own }
            .flatMap { $0.convert().lists }
    }

    /// What `lists` do once installed: each rule with the lifts after it in
    /// its list, which are the only ones WebKit lets reach it, named by
    /// their digest. The order of the lists, and of a set's names, changes
    /// nothing.
    private func effect(_ lists: [String]) throws -> Set<String> {
        func canonical(_ value: Any) -> Any {
            if let object = value as? [String: Any] { return object.mapValues(canonical) }
            if let array = value as? [Any] {
                let items = array.map(canonical)
                if let names = items as? [String] { return names.sorted() }
                return items
            }
            return value
        }
        func text(_ rule: Any) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: canonical(rule), options: [.sortedKeys]),
                   as: UTF8.self)
        }
        var effect: Set<String> = []
        for json in lists {
            let rules = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]])
            var lifts: Set<String> = []
            var after: String?
            for rule in rules.reversed() {
                let type = (rule["action"] as? [String: Any])?["type"] as? String
                if type == "ignore-previous-rules" {
                    lifts.insert(try text(rule))
                    after = nil
                    continue
                }
                if after == nil { after = ContentBlocker.digest(lifts.sorted()) }
                effect.insert(try text(rule) + "\n--\n" + after!)
            }
        }
        return effect
    }

    /// Lists whose exceptions and `$badfilter`s reach across the parts,
    /// both ways.
    private let lists: [(id: String, text: String)] = [
        ("sval-curben-urlhaus", """
            ||evil.example^$all
            ||worse.example^$all
            ||bad.test^$all
            @@||bad.test/clean^
            bad.test#@#.banner
            ||tracker.example^$badfilter
            """),
        ("sval-easylist", """
            ||ads.example^
            ##.banner
            example.com##.promo
            @@||evil.example/ok^
            shop.test#@#.banner
            @@||generic.test^$generichide
            ||worse.example^$all,badfilter
            """),
        ("sval-ublock-filters", """
            ||tracker.example^
            @@||ads.example/fine^
            bad.test##.ad
            """),
    ]

    private let myFilters = """
        ||mine.example^
        @@||tracker.example/ok^
        example.com#@#.promo
        @@||evil.example/also^
        ##.mine
        """

    private func assertSame(_ texts: [(id: String, text: String)], file: StaticString = #filePath,
                            line: UInt = #line) throws {
        for pageRules in [true, false] {
            for myFilters in ["", myFilters] {
                for allowed in [[], ["allowed.example"]] {
                    let before = try effect(together(texts, pageRules: pageRules, myFilters: myFilters, allowed: allowed))
                    let after = try effect(inParts(texts, pageRules: pageRules, myFilters: myFilters, allowed: allowed))
                    XCTAssertFalse(before.isEmpty, file: file, line: line)
                    XCTAssertEqual(after, before, "page rules \(pageRules), My filters \(!myFilters.isEmpty), allowed \(allowed)",
                                   file: file, line: line)
                }
            }
        }
    }

    func testThePartsBlockAsTheListsTogetherDid() throws {
        try assertSame(lists)
        try assertSame(lists.filter { !ContentBlocker.lastLists.contains($0.id) })
        try assertSame(lists.filter { ContentBlocker.lastLists.contains($0.id) })
    }

    /// The publishers' lists, when `TEST_RUNNER_SVAL_LISTS` names a folder
    /// of them saved as `<id>.txt`. They are too large to keep in the
    /// repository, and a test never downloads.
    func testThePartsBlockAsTheListsTogetherDidWithThePublishersLists() throws {
        guard let folder = ProcessInfo.processInfo.environment["SVAL_LISTS"] else {
            throw XCTSkip("TEST_RUNNER_SVAL_LISTS names no folder")
        }
        let texts = try ContentBlocker.balanced.keys.sorted().map { id in
            (id: id, text: try String(contentsOf: URL(fileURLWithPath: folder).appending(path: "\(id).txt"),
                                      encoding: .utf8))
        }
        let before = try effect(together(texts, pageRules: true, myFilters: myFilters, allowed: ["allowed.example"]))
        let after = try effect(inParts(texts, pageRules: true, myFilters: myFilters, allowed: ["allowed.example"]))
        XCTAssertEqual(after.count, before.count)
        XCTAssertTrue(after == before, "\(after.subtracting(before).count) rule(s) added, \(before.subtracting(after).count) gone")
        print("blocker parts: \(before.count) rule(s) block the same")
    }
}

/// The blocker's parts compiled, applied and kept apart.
@MainActor
final class BlockerPartsTests: XCTestCase {
    private var directory: URL!
    private var stores: URL!
    private var defaults: UserDefaults!
    private let inputs = BlockerInputs(settings: [:])

    override func setUp() async throws {
        directory = try temporaryDirectory(self)
        stores = try temporaryDirectory(self)
        let suite = "blocker-parts-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        // The last lists as malware-filter's are: request blocking, with
        // no exceptions.
        for id in inputs.lists.keys {
            try write(id, ContentBlocker.lastLists.contains(id) ? "||\(id).example^$all\n"
                : "||ads-\(id).example^\n@@||ads-\(id).example/ok^\n##.sval-\(id)\n")
        }
    }

    /// Writes list `id` as freshly downloaded.
    private func write(_ id: String, _ text: String) throws {
        try text.write(to: directory.appending(path: "\(id).txt"), atomically: true, encoding: .utf8)
    }

    private func blocker() -> ContentBlocker {
        ContentBlocker(directory: directory, download: { _ in nil }, stores: stores, defaults: defaults)
    }

    /// When each compiled file in the stores was written, by its store.
    private func written() throws -> [String: Date] {
        var dates: [String: Date] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: stores.path(percentEncoded: false)) {
            let folder = stores.appending(path: name, directoryHint: .isDirectory)
            guard let files = try? FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
            else { continue }
            for file in files {
                let attributes = try FileManager.default.attributesOfItem(
                    atPath: folder.appending(path: file).path(percentEncoded: false))
                dates[name] = try XCTUnwrap(attributes[.modificationDate] as? Date)
            }
        }
        return dates
    }

    private func ids(_ lists: [WKContentRuleList]) -> [String] { lists.map(\.identifier) }

    /// Each part's lists, compiled only when that part's inputs change.
    func testAListChangeCompilesItsPartAlone() async throws {
        let blocker = blocker()
        blocker.update(inputs)
        await blocker.settled()
        let lists = ids(blocker.rules.lists), last = ids(blocker.rules.last)
        XCTAssertFalse(lists.isEmpty)
        XCTAssertFalse(last.isEmpty)
        let first = try written()
        XCTAssertEqual(Set(first.keys), Set(lists + last))

        try write("sval-curben-urlhaus", "||evil.example^$all\n")
        blocker.update(inputs)
        await blocker.settled()
        let second = try written()
        XCTAssertEqual(ids(blocker.rules.lists), lists)
        XCTAssertEqual(ids(blocker.rules.last), last)
        for id in lists { XCTAssertEqual(second[id], first[id], "\(id) was compiled again") }
        for id in last { XCTAssertNotEqual(second[id], first[id], "\(id) was not compiled again") }

        // A rule changed in another list, its exceptions as they were.
        try write("sval-easylist", "||other.example^\n@@||ads-sval-easylist.example/ok^\n")
        blocker.update(inputs)
        await blocker.settled()
        let third = try written()
        for id in lists { XCTAssertNotEqual(third[id], second[id], "\(id) was not compiled again") }
        for id in last { XCTAssertEqual(third[id], second[id], "\(id) was compiled again") }
    }

    /// The last lists apply after the others, and a page installs them
    /// after the others.
    func testTheLastListsApplyLast() async throws {
        let blocker = blocker()
        await blocker.whenReady()
        // Each change of the lists a page takes, as counts of the others'
        // and the last lists.
        var applied: [[Int]] = []
        blocker.onChange = {
            let counts = [blocker.rules.lists.count, blocker.rules.last.count]
            if counts != applied.last ?? [0, 0] { applied.append(counts) }
        }
        blocker.update(inputs)
        await blocker.settled()
        XCTAssertEqual(applied.count, 2)
        XCTAssertGreaterThan(applied.first?[0] ?? 0, 0)
        XCTAssertEqual(applied.first?[1], 0, "the last lists applied with the others")
        XCTAssertGreaterThan(applied.last?[1] ?? 0, 0)
        XCTAssertEqual(ids(blocker.rules.installed(protected: true)),
                       ids(blocker.rules.lists) + ids(blocker.rules.last))
    }

    /// A part whose compile fails keeps the lists it had, and the other
    /// parts apply theirs.
    func testAPartThatFailsToCompileKeepsItsListsAndTheOthersApply() async throws {
        let earlier = blocker()
        earlier.update(inputs)
        await earlier.settled()
        let last = ids(earlier.rules.last)
        XCTAssertEqual(last, ["sval-last-0"])

        // A later launch, where the last part's store can't be made.
        let blocker = blocker()
        await blocker.whenReady()
        XCTAssertEqual(ids(blocker.rules.last), last)
        let folder = stores.appending(path: "sval-last-0", directoryHint: .isDirectory)
        try FileManager.default.removeItem(at: folder)
        try Data().write(to: folder)
        try write("sval-curben-urlhaus", "||evil.example^$all\n")
        try write("sval-easylist", "||other.example^\n")
        let before = try written()
        blocker.update(inputs)
        await blocker.settled()
        XCTAssertEqual(ids(blocker.rules.last), last, "the last part keeps its lists")
        XCTAssertFalse(blocker.rules.lists.isEmpty)
        let after = try written()
        for id in ids(blocker.rules.lists) {
            XCTAssertNotEqual(after[id], before[id], "\(id) was not compiled again")
        }
        XCTAssertNil(defaults.dictionary(forKey: "contentRules.applied")?["sval-last-"],
                     "a launch looks up the failed part")
    }

    /// A launch finds every part's lists, each in its own store.
    func testALaunchAppliesEveryPartsLists() async throws {
        let mine = BlockerInputs(settings: [MyFilters.branch + "a": ###"{"line":"##.mine","order":"1"}"###])
        let earlier = blocker()
        earlier.update(mine)
        await earlier.settled()
        let applied = ids(earlier.rules.installed(protected: true)) + ids(earlier.rules.own)
        XCTAssertEqual(Set(applied.map { $0.prefix { !$0.isNumber } }),
                       ["sval-lists-", "sval-last-", "sval-mine-", "sval-own-"])
        let launched = blocker()
        await launched.whenReady()
        XCTAssertEqual(ids(launched.rules.installed(protected: true)) + ids(launched.rules.own), applied)
    }

    /// The compiled lists are made again from the downloads, so a backup
    /// leaves them out.
    func testTheStoresAreLeftOutOfTheBackup() async throws {
        let blocker = blocker()
        blocker.update(inputs)
        await blocker.settled()
        let values = try URL(fileURLWithPath: stores.path(percentEncoded: false))
            .resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    /// The stores of lists no part applies go.
    func testAPartThatStopsRunningLeavesNoStore() async throws {
        let blocker = blocker()
        blocker.update(BlockerInputs(settings: [MyFilters.branch + "a": ###"{"line":"##.mine","order":"1"}"###]))
        await blocker.settled()
        XCTAssertTrue(try written().keys.contains("sval-mine-0"))
        blocker.update(inputs)
        await blocker.settled()
        XCTAssertEqual(Set(try written().keys), Set(ids(blocker.rules.lists) + ids(blocker.rules.last)))
    }

    /// The lists an earlier build compiled into a store are removed from
    /// it, and other lists are left.
    func testRemovesTheListsAnEarlierBuildCompiled() async throws {
        let store = try XCTUnwrap(WKContentRuleListStore(url: try temporaryDirectory(self)))
        let json = #"[{"trigger":{"url-filter":"ads"},"action":{"type":"block"}}]"#
        for id in ["sval-rules-0", "sval-scripts", "other-0"] {
            _ = try await store.compileContentRuleList(forIdentifier: id, encodedContentRuleList: json)
        }
        await ContentBlocker.removeLists(from: store)
        let left = await store.availableIdentifiers()
        XCTAssertEqual(left, ["other-0"])
    }
}
