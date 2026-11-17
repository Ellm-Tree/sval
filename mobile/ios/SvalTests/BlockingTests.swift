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
        rules.own = [try await list("own")]
        rules.scripts = try await list("scripts")
    }

    private func installed(protected: Bool) -> [String] {
        rules.installed(protected: protected).map(\.identifier)
    }

    func testAProtectedPageBlocksWithTheLevelsLists() {
        XCTAssertEqual(installed(protected: true), ["level-1", "level-2", "scripts"])
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
        XCTAssertEqual(installed(protected: rules.protectionsOn(for: "example.org")), ["level-1", "level-2", "scripts"])
    }
}
