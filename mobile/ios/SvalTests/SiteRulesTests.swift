// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// A private tab's video and audio choices, as the desktop's private
/// window keeps them (`SvalSiteProtections`).
final class SiteRulesTests: XCTestCase {
    private let saved: [String: Any] = [
        SiteRules.protectionBranch + "example.com": #"{"media":"allow"}"#,
        SiteRules.mediaDefaultKey: NSNumber(value: 2),
    ]

    func testAPrivateTabIgnoresSavedChoices() {
        XCTAssertEqual(SiteRules(settings: saved).media(for: "example.com"), .allow)
        XCTAssertEqual(SiteRules(settings: saved, session: [:]).media(for: "example.com"), .block)
    }

    func testAPrivateChoiceAppliesUnderItsSite() {
        let rules = SiteRules(settings: saved, session: ["example.com": .ask])
        XCTAssertEqual(rules.media(for: "www.example.com"), .ask)
        XCTAssertEqual(SiteRules(settings: saved).media(for: "www.example.com"), .allow)
    }

    func testAHostMatchingItsSiteKeepsNoChoice() {
        let rules = SiteRules(settings: saved, session: ["example.com": .ask])
        XCTAssertEqual(rules.sessionMediaChange(for: "mail.example.com", to: .ask), ["example.com": .ask])
        XCTAssertEqual(rules.sessionMediaChange(for: "mail.example.com", to: .allow),
                       ["example.com": .ask, "mail.example.com": .allow])
    }

    /// Keep links in this tab, as the desktop's `SvalKeepLinks` keeps it: a
    /// host's own rule beats its site's, and a choice that matches what a
    /// name inherits takes its rule away.
    func testKeepLinksTakesTheMostSpecificRule() {
        let rules = SiteRules(settings: [
            SiteRules.keepLinksBranch + "example.com": "on",
            SiteRules.keepLinksBranch + "help.example.com": "off",
        ])
        XCTAssertTrue(rules.keepLinks(on: "www.example.com"))
        XCTAssertFalse(rules.keepLinks(on: "help.example.com"))
        XCTAssertFalse(rules.keepLinks(on: "example.org"))
        XCTAssertEqual(rules.keepLinksChange(for: "shop.example.com", on: true).value as? String, nil)
        XCTAssertEqual(rules.keepLinksChange(for: "shop.example.com", on: false).value as? String, "off")
        XCTAssertEqual(rules.keepLinksChange(for: "example.org", on: true).value as? String, "on")
    }
}
