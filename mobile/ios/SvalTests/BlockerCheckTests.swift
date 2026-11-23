// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CryptoKit
import XCTest
@testable import Sval

/// The blocker's check, which runs when its inputs change, against the
/// check `ContentBlocker.update` made from the settings on every refresh,
/// kept here as it was.
@MainActor
final class BlockerCheckTests: XCTestCase {
    private struct Decision: Equatable {
        let key: String
        let due: Bool
        let lists: [String: String]
        let pageRules: Bool
        let myFilters: String
        let allowed: [String]
        let scripts: String?
    }

    /// What the former `update` rebuilt from, and when, for `settings` and
    /// the lists downloaded to `directory`.
    private func former(_ settings: [String: Any], in directory: URL) -> Decision {
        func downloadedAt(_ id: String) -> Date? {
            let file = directory.appending(path: "\(id).txt")
            return (try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false)))?[.modificationDate] as? Date
        }
        func isDue(_ id: String) -> Bool {
            guard let at = downloadedAt(id) else { return true }
            // The lists `write` makes name no lifetime of their own.
            return Date.now.timeIntervalSince(at) > ContentBlocker.defaultListLifetime
        }
        func digest(_ parts: [String]) -> String {
            SHA256.hash(data: Data(parts.joined(separator: "\u{1F}").utf8))
                .map { String(format: "%02x", $0) }.joined()
        }
        let allowedDefault = settings[JavaScriptRules.enabledKey] as? Bool ?? true
        let named = settings.compactMap { key, value -> ScriptRule? in
            guard key.hasPrefix(JavaScriptRules.siteBranch), let rule = value as? String,
                  rule == "allow" || rule == "block" else { return nil }
            return ScriptRule(name: String(key.dropFirst(JavaScriptRules.siteBranch.count)), allowed: rule == "allow")
        }
        let level = settings[ContentBlocker.levelKey] as? String ?? "balanced"
        let lists: [String: String] = switch level {
        case "off": [:]
        case "strict": ContentBlocker.balanced.merging(ContentBlocker.strictExtra) { a, _ in a }
        default: ContentBlocker.balanced
        }
        let pageRules = (settings[ContentBlocker.pageRulesKey] as? Bool ?? true)
            && !LaunchOption.given("-svalNoPageRules")
        let myFilters = MyFilters.text(settings: settings)
        let allowed = settings
            .filter { $0.key.hasPrefix(ContentBlocker.allowedBranch) && ($0.value as? Bool) == true }
            .map { String($0.key.dropFirst(ContentBlocker.allowedBranch.count)) }
            .sorted()
        let due = lists.keys.contains { isDue($0) }
        let key = digest([
            level, String(pageRules), myFilters, allowed.joined(separator: ","),
            lists.keys.sorted().map { "\($0)@\(downloadedAt($0)?.timeIntervalSince1970 ?? 0)" }
                .joined(separator: ","),
        ])
        return Decision(key: key, due: due, lists: lists, pageRules: pageRules, myFilters: myFilters,
                        allowed: allowed, scripts: scriptRules(allowedDefault: allowedDefault, rules: named))
    }

    /// The same, from the inputs the blocker is given.
    private func now(_ settings: [String: Any], in directory: URL) -> Decision {
        let inputs = BlockerInputs(settings: settings)
        let lists = BlockerLists(inputs, in: directory, failedAt: [:], now: .now)
        let scripts = scriptRules(allowedDefault: inputs.scriptsByDefault,
                                  rules: inputs.scripts.sorted { $0.key < $1.key }
                                      .map { ScriptRule(name: $0.key, allowed: $0.value) })
        return Decision(key: lists.key, due: lists.due, lists: inputs.lists, pageRules: inputs.pageRules,
                        myFilters: inputs.myFilters, allowed: inputs.allowed, scripts: scripts)
    }

    private let settingsCases: [[String: Any]] = [
        [:],
        [ContentBlocker.levelKey: "off"],
        [ContentBlocker.levelKey: "strict"],
        [ContentBlocker.levelKey: "custom"],
        [ContentBlocker.pageRulesKey: false],
        [
            MyFilters.branch + "a": #"{"line":"||ads.example^","order":"1"}"#,
            MyFilters.branch + "b": #"{"line":"example.org##.banner","order":"2"}"#,
            MyFilters.branch + "c": #"{"line":"bad","order":"10"}"#,
            MyFilters.branch + "d": 3,
        ],
        [
            ContentBlocker.allowedBranch + "b.example": true,
            ContentBlocker.allowedBranch + "a.example": true,
            ContentBlocker.allowedBranch + "c.example": false,
        ],
        [
            JavaScriptRules.enabledKey: false,
            JavaScriptRules.siteBranch + "example.com": "allow",
            JavaScriptRules.siteBranch + "a.example.com": "block",
            JavaScriptRules.siteBranch + "other.org": "ask",
        ],
        [
            ContentBlocker.levelKey: "strict",
            ContentBlocker.allowedBranch + "a.example": true,
            JavaScriptRules.siteBranch + "example.com": "block",
            "browser.sval.launcher.order": "tabs",
        ],
    ]

    private func write(_ id: String, in directory: URL, age: TimeInterval) throws {
        let file = directory.appending(path: "\(id).txt")
        try Data("||x.example^".utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-age)],
                                              ofItemAtPath: file.path(percentEncoded: false))
    }

    /// Every settings case decides as before with no list downloaded, some
    /// fresh and one stale, and every list fresh.
    func testTheInputsDecideAsTheSettingsDid() throws {
        let directory = try temporaryDirectory(self)
        let all = ContentBlocker.balanced.merging(ContentBlocker.strictExtra) { a, _ in a }.keys.sorted()
        var states: [() throws -> Void] = [{}]
        states.append { try self.write(all[0], in: directory, age: 60) }
        states.append { try self.write(all[1], in: directory, age: ContentBlocker.defaultListLifetime + 60) }
        states.append { for id in all { try self.write(id, in: directory, age: 60) } }
        var dues: Set<Bool> = []
        for state in states {
            try state()
            for settings in settingsCases {
                let before = former(settings, in: directory)
                XCTAssertEqual(now(settings, in: directory), before, "\(settings)")
                dues.insert(before.due)
            }
        }
        XCTAssertEqual(dues, [true, false])
    }

    /// A list whose download failed is not due for an hour, and the next
    /// check is set for when it is.
    func testAFailedDownloadWaitsAnHour() throws {
        let directory = try temporaryDirectory(self)
        let inputs = BlockerInputs(settings: [:])
        let now = Date.now
        let failed = now.addingTimeInterval(-59 * 60)
        let failedAt = Dictionary(uniqueKeysWithValues: inputs.lists.keys.map { ($0, failed) })
        let waiting = BlockerLists(inputs, in: directory, failedAt: failedAt, now: now)
        XCTAssertFalse(waiting.due)
        XCTAssertEqual(waiting.next, failed.addingTimeInterval(ContentBlocker.retryAfter))
        let later = BlockerLists(inputs, in: directory, failedAt: failedAt, now: now.addingTimeInterval(2 * 60))
        XCTAssertTrue(later.due)
        XCTAssertEqual(waiting.key, later.key)
    }

    /// A list's lifetime comes from its `! Expires:` line in hours or days,
    /// held to between 12 hours and 14 days, and is 4 days without one.
    func testAListsLifetimeIsReadFromItsExpiresLine() {
        let hour: TimeInterval = 60 * 60, day = 24 * hour
        let cases: [(String, TimeInterval)] = [
            ("[Adblock Plus 2.0]\n! Title: uBlock filters\n! Expires: 5 days\n", 5 * day),
            ("! Expires: 4 days (update frequency)\n", 4 * day),
            ("! Expires: 1 day\n", day),
            ("! expires: 2 DAYS\n", 2 * day),
            ("! Expires: 12 hours\n", 12 * hour),
            ("! Expires: 36 hours\n", 36 * hour),
            ("! Expires: 8 hours\n", 12 * hour),
            ("! Expires: 30 days\n", 14 * day),
            ("! Expires: 0 days\n", 4 * day),
            ("! Expires: 2 weeks\n", 4 * day),
            ("! Title: Expires: 1 day\n", 4 * day),
            ("||ads.example^\n", 4 * day),
            ("", 4 * day),
        ]
        for (head, lifetime) in cases {
            XCTAssertEqual(BlockerLists.lifetime(head: head), lifetime, head)
        }
    }

    private func write(_ id: String, _ text: String, in directory: URL, age: TimeInterval) throws {
        let file = directory.appending(path: "\(id).txt")
        try Data(text.utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-age)],
                                              ofItemAtPath: file.path(percentEncoded: false))
    }

    /// A list falls due at its own lifetime after its download, and the next
    /// check is set for the first list to fall due.
    func testAListIsDueAtItsOwnLifetime() throws {
        let directory = try temporaryDirectory(self)
        let hour: TimeInterval = 60 * 60
        let inputs = BlockerInputs(settings: [:])
        let ids = inputs.lists.keys.sorted()
        for id in ids { try write(id, "! Expires: 5 days\n", in: directory, age: 4 * 24 * hour) }
        let now = Date.now
        XCTAssertFalse(BlockerLists(inputs, in: directory, failedAt: [:], now: now).due,
                       "a 5-day list was due after 4 days")
        try write(ids[0], "! Expires: 12 hours\n", in: directory, age: 11 * hour)
        let fresh = BlockerLists(inputs, in: directory, failedAt: [:], now: now)
        XCTAssertFalse(fresh.due, "a 12-hour list was due after 11 hours")
        let downloaded = try XCTUnwrap(BlockerLists.downloadedAt(ids[0], in: directory))
        XCTAssertEqual(fresh.next, downloaded.addingTimeInterval(12 * hour))
        try write(ids[1], "! Expires: 12 hours\n", in: directory, age: 13 * hour)
        XCTAssertTrue(BlockerLists(inputs, in: directory, failedAt: [:], now: now).due,
                      "a 12-hour list was not due after 13 hours")
    }

    /// A list after its 4 KB head names no lifetime.
    func testAnExpiresLinePastTheHeadIsNotRead() throws {
        let directory = try temporaryDirectory(self)
        let padding = String(repeating: "! comment\n", count: 410)
        try write("a", padding + "! Expires: 12 hours\n", in: directory, age: 0)
        let downloaded = try XCTUnwrap(BlockerLists.downloadedAt("a", in: directory))
        XCTAssertEqual(BlockerLists.expiresAt("a", in: directory),
                       downloaded.addingTimeInterval(ContentBlocker.defaultListLifetime))
    }

    /// A publisher's answer that a list is unchanged starts its lifetime
    /// again, and leaves the key the rules are made from as it was.
    func testAnUnchangedAnswerStartsTheLifetimeAgain() throws {
        let directory = try temporaryDirectory(self)
        let inputs = BlockerInputs(settings: [:])
        let ids = inputs.lists.keys.sorted()
        for id in ids { try write(id, "! Expires: 1 day\n", in: directory, age: 2 * 24 * 60 * 60) }
        let stale = BlockerLists(inputs, in: directory, failedAt: [:], now: .now)
        XCTAssertTrue(stale.due)
        for id in ids {
            ListRecord(validators: .init(etag: "\"1\""), checkedAt: .now.addingTimeInterval(-60)).write(id, in: directory)
        }
        let checked = BlockerLists(inputs, in: directory, failedAt: [:], now: .now)
        XCTAssertFalse(checked.due, "a list answered unchanged a minute ago was due")
        XCTAssertEqual(checked.key, stale.key)
    }

    /// Inputs given while a check runs are the ones the rules end up made
    /// from.
    func testASettingsChangeDuringACheckIsApplied() async throws {
        let directory = try temporaryDirectory(self)
        let blocker = ContentBlocker(directory: directory)
        let first = BlockerInputs(settings: [ContentBlocker.levelKey: "off"])
        let second = BlockerInputs(settings: [ContentBlocker.levelKey: "off",
                                              ContentBlocker.allowedBranch + "example.com": true])
        let key = { BlockerLists($0, in: directory, failedAt: [:], now: .now).key }
        XCTAssertNotEqual(key(first), key(second))
        blocker.update(first)
        blocker.update(second)
        await blocker.settled()
        XCTAssertEqual(blocker.inputsKey, key(second))
    }
}
