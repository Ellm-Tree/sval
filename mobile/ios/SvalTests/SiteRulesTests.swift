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
}
