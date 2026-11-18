// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

private func protections(_ choices: [String: String]) -> [String: Any] {
    choices.reduce(into: [:]) { settings, choice in
        settings[SiteRules.protectionBranch + choice.key] = choice.value
    }
}

/// Whether a page's site has protections on, as the desktop's site
/// controls keep the choice (`SvalSiteProtections`).
final class SiteProtectionsTests: XCTestCase {
    private let siteOff = protections(["example.com": #"{"protections":"off"}"#])

    func testProtectionsAreOnWhereNothingIsSaved() {
        XCTAssertTrue(SiteRules(settings: [:]).protectionsOn(for: "example.com"))
    }

    func testASiteTurnedOffIsOffOnEveryHostUnderIt() {
        let rules = SiteRules(settings: siteOff)
        XCTAssertFalse(rules.protectionsOn(for: "example.com"))
        XCTAssertFalse(rules.protectionsOn(for: "www.example.com"))
        XCTAssertFalse(rules.protectionsOn(for: "mail.example.com"))
        XCTAssertTrue(rules.protectionsOn(for: "example.org"))
    }

    func testAHostCanStayOnUnderASiteThatIsOff() {
        let rules = SiteRules(settings: protections([
            "example.com": #"{"protections":"off"}"#,
            "mail.example.com": #"{"protections":"on"}"#,
        ]))
        XCTAssertTrue(rules.protectionsOn(for: "mail.example.com"))
        XCTAssertFalse(rules.protectionsOn(for: "www.example.com"))
    }

    func testAHostKeepsAChoiceOnlyWhereItDiffersFromItsSite() {
        let off = SiteRules(settings: siteOff)
        XCTAssertEqual(off.protectionsChange(for: "mail.example.com", on: true).value as? String,
                       #"{"protections":"on"}"#)
        XCTAssertNil(off.protectionsChange(for: "mail.example.com", on: false).value)
        XCTAssertNil(SiteRules(settings: [:]).protectionsChange(for: "mail.example.com", on: true).value)
    }

    func testTurningASiteOnKeepsItsOtherChoices() {
        let rules = SiteRules(settings: protections(["example.com": #"{"media":"allow","protections":"off"}"#]))
        let change = rules.protectionsChange(for: "example.com", on: true)
        XCTAssertEqual(change.key, SiteRules.protectionBranch + "example.com")
        XCTAssertEqual(change.value as? String, #"{"media":"allow"}"#)
    }

    /// The private session's choices live in memory and the saved ones
    /// don't reach it.
    func testAPrivateTabGoesByTheSessionsChoicesAlone() {
        XCTAssertTrue(SiteRules(settings: siteOff, sessionProtections: [:]).protectionsOn(for: "example.com"))
        let session = SiteRules(settings: [:], sessionProtections: [:]).sessionProtectionsChange(for: "example.com",
                                                                                                 on: false)
        XCTAssertEqual(session, ["example.com": "off"])
        let rules = SiteRules(settings: [:], sessionProtections: session)
        XCTAssertFalse(rules.protectionsOn(for: "www.example.com"))
    }

    func testAPrivateHostKeepsAChoiceOnlyWhereItDiffersFromItsSite() {
        let rules = SiteRules(settings: [:], sessionProtections: ["example.com": "off"])
        XCTAssertEqual(rules.sessionProtectionsChange(for: "mail.example.com", on: true),
                       ["example.com": "off", "mail.example.com": "on"])
        XCTAssertEqual(rules.sessionProtectionsChange(for: "mail.example.com", on: false), ["example.com": "off"])
        XCTAssertEqual(rules.sessionProtectionsChange(for: "example.com", on: true), [:])
    }
}

/// What the bar's shield shows for the page in front.
final class ShieldStateTests: XCTestCase {
    private func shield(_ address: String, _ settings: [String: Any] = [:]) -> ShieldState {
        ShieldState(url: URL(string: address), rules: SiteRules(settings: settings))
    }

    func testOnWhereTheSiteHasProtections() {
        XCTAssertEqual(shield("https://example.com/"), .on)
    }

    func testOffWhereTheSiteTurnedThemOff() {
        XCTAssertEqual(shield("https://www.example.com/", protections(["example.com": #"{"protections":"off"}"#])), .off)
    }

    func testOffEverywhereWithBlockingOff() {
        XCTAssertEqual(shield("https://example.com/", [ContentBlocker.levelKey: "off"]), .off)
    }

    func testPlainOnAPageThatIsNoWebSite() {
        XCTAssertEqual(shield("about:blank"), .plain)
    }
}

/// Which compiled rule lists a page blocks with (`installed(protected:)`).
@MainActor
final class PageRuleListsTests: XCTestCase {
    private var rules = ContentBlocker.Rules()

    override func setUp() async throws {
        let store = try XCTUnwrap(WKContentRuleListStore(url: try temporaryDirectory(self)))
        func list(_ id: String) async throws -> WKContentRuleList {
            let json = #"[{"trigger":{"url-filter":"\#(id)"},"action":{"type":"block"}}]"#
            let compiled = try await store.compileContentRuleList(forIdentifier: id, encodedContentRuleList: json)
            return try XCTUnwrap(compiled)
        }
        rules.lists = [try await list("level-1"), try await list("level-2")]
        rules.mine = [try await list("mine")]
        rules.own = [try await list("own")]
        rules.scripts = try await list("scripts")
    }

    private func installed(protected: Bool) -> [String] {
        rules.installed(protected: protected).map(\.identifier)
    }

    func testAProtectedPageBlocksWithTheLevelsListsAndMyFilters() {
        XCTAssertEqual(installed(protected: true), ["level-1", "level-2", "mine", "scripts"])
    }

    /// My filters' page rules apply where the lists don't (decision 1993).
    func testAPageWithProtectionsOffKeepsMyFiltersPageRules() {
        XCTAssertEqual(installed(protected: false), ["own", "scripts"])
    }

    func testWithBlockingOffAProtectedPageKeepsMyFiltersPageRules() {
        rules.lists = []
        XCTAssertEqual(installed(protected: true), ["own", "scripts"])
    }

    func testAPageTakesItsSitesProtections() {
        let rules = SiteRules(settings: protections(["example.com": #"{"protections":"off"}"#]))
        XCTAssertEqual(installed(protected: rules.protectionsOn(for: "www.example.com")), ["own", "scripts"])
        XCTAssertEqual(installed(protected: rules.protectionsOn(for: "example.org")), ["level-1", "level-2", "mine", "scripts"])
    }
}

/// My filters as the desktop syncs them, a setting per line
/// (`SvalMyFilters.sys.mjs`).
final class MyFiltersTests: XCTestCase {
    private func line(_ text: String, _ order: String) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: ["line": text, "order": order]), as: UTF8.self)
    }

    func testLinesReadInOrderAsOneText() {
        let settings: [String: Any] = [
            MyFilters.branch + "c": line("third", "r"),
            MyFilters.branch + "a": line("first", "9"),
            MyFilters.branch + "b": line("", "i"),
            "browser.sval.adblock.level": "strict",
        ]
        XCTAssertEqual(MyFilters.text(settings: settings), "first\n\nthird")
    }

    func testLinesOfOneOrderSortByKey() {
        let settings: [String: Any] = [
            MyFilters.branch + "b": line("second", "i"),
            MyFilters.branch + "a": line("first", "i"),
        ]
        XCTAssertEqual(MyFilters.text(settings: settings), "first\nsecond")
    }

    func testAValueThatIsNotALineIsLeftOut() {
        let settings: [String: Any] = [
            MyFilters.branch + "0": line("kept", "i"),
            MyFilters.branch + "1": "not json",
            MyFilters.branch + "2": line("two\nlines", "i"),
            MyFilters.branch + "3": line("control\u{1}", "i"),
            MyFilters.branch + "4": line("ends in zero", "i0"),
            MyFilters.branch + "5": 42,
        ]
        XCTAssertEqual(MyFilters.text(settings: settings), "kept")
    }

    /// The desktop names a line's setting by the same hash
    /// (`SvalMyFilters.lineKey`), so devices that add the same line write
    /// the same setting.
    func testALineIsKeyedAsTheDesktopKeysIt() {
        XCTAssertEqual(MyFilters.lineKey("example.com##.ad", 0), "ab9313a110bfd788bb333240a71a734f")
        XCTAssertEqual(MyFilters.lineKey("example.com##.ad", 1), "86f6299694a6da90d76159adf08a2765")
    }

    func testAnOrderFallsStrictlyBetweenItsNeighbours() {
        let cases: [(String, String?)] = [("", nil), ("", "1"), ("", "01"), ("h", "h1"), ("h", "i"),
                                          ("z", nil), ("zz", nil), ("a1", "a2"), ("9", "a")]
        for (a, b) in cases {
            let order = MyFilters.orderBetween(a, b)
            XCTAssertLessThan(a, order)
            if let b { XCTAssertLessThan(order, b) }
            XCTAssertNotEqual(order.last, "0")
        }
    }

    func testCountsTheLinesThatRemoveSomethingOnASite() {
        let lines = [
            "example.com##.ad", "news.example.com##.promo", "other.org,example.com#?#.banner",
            "||cdn.test/x.png$domain=example.com|other.org", "~example.com##.skip",
            "example.com#@#.ad", "@@||example.com^", "example.com##+js(noop)", "##.everywhere",
            "! example.com##.note",
        ]
        let settings = Dictionary(uniqueKeysWithValues: lines.enumerated().map { index, text in
            (MyFilters.branch + String(index), line(text, "i\(index + 1)"))
        })
        let news = MyFilters.removals(on: "news.example.com", settings: settings)
        XCTAssertEqual(news.map(\.shown), ["||cdn.test/x.png", ".banner", ".promo", ".ad"], "newest first")
        XCTAssertEqual(news.map(\.scope), ["example.com", "example.com", "news.example.com", "example.com"])
        XCTAssertEqual(MyFilters.removals(on: "www.example.com", settings: settings).count, 3)
        XCTAssertEqual(MyFilters.removals(on: "notexample.com", settings: settings).count, 0)
    }

    private func applying(_ writes: [(key: String, value: String?)], to settings: [String: Any]) -> [String: Any] {
        var settings = settings
        for (key, value) in writes { settings[key] = value }
        return settings
    }

    func testShowAgainTakesTheSiteOutOfItsLineInPlace() throws {
        let settings: [String: Any] = [
            MyFilters.branch + "a": line("other.org,example.com##.ad", "i"),
            MyFilters.branch + "b": line("last##.x", "r"),
            MyFilters.branch + "c": line("||cdn.test/x.png$third-party,domain=example.com|other.org", "9"),
        ]
        let removals = MyFilters.removals(on: "example.com", settings: settings)
        var after = settings
        for removal in removals { after = applying(MyFilters.showingAgain(removal, settings: after), to: after) }
        XCTAssertEqual(MyFilters.text(settings: after),
                       "||cdn.test/x.png$third-party,domain=other.org\nother.org##.ad\nlast##.x")
        XCTAssertNil(after[MyFilters.branch + "a"] as? String)
    }

    func testShowAgainDeletesALineWithNoSiteLeft() {
        let settings: [String: Any] = [MyFilters.branch + "a": line("~shop.example.com,example.com##.ad", "i")]
        let removal = MyFilters.removals(on: "example.com", settings: settings)[0]
        let after = applying(MyFilters.showingAgain(removal, settings: settings), to: settings)
        XCTAssertEqual(MyFilters.text(settings: after), "")
    }

    func testAnAddedLineComesLastUnderTheNextFreeKey() throws {
        var settings: [String: Any] = [
            MyFilters.branch + "a": line("first", "z"),
            MyFilters.branch + MyFilters.lineKey("example.com##.ad", 0): line("example.com##.ad", "i"),
        ]
        let added = try XCTUnwrap(MyFilters.adding("example.com##.ad", settings: settings))
        XCTAssertEqual(added.key, MyFilters.branch + MyFilters.lineKey("example.com##.ad", 1))
        settings[added.key] = added.value
        XCTAssertEqual(MyFilters.text(settings: settings), "example.com##.ad\nfirst\nexample.com##.ad")
        XCTAssertNil(MyFilters.adding("two\nlines", settings: settings))
    }
}
