// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The Launcher's matching follows Places' `findOnBoundary` on plain and
/// accented text alike.
final class LauncherMatchTests: XCTestCase {
    private func boundary(_ typed: String, _ title: String, url: String = "") -> Bool {
        LauncherMatch.onBoundary(LauncherMatch.Query(typed), LauncherMatch.Fields(title: title, url: url))
    }

    private func anywhere(_ typed: String, _ title: String, url: String = "") -> Bool {
        LauncherMatch.anywhere(LauncherMatch.Query(typed), LauncherMatch.Fields(title: title, url: url))
    }

    func testBoundaries() {
        XCTAssertTrue(boundary("read", "Reading Club"))
        XCTAssertTrue(boundary("club", "Reading Club"))
        XCTAssertFalse(boundary("ead", "Reading Club"))
        XCTAssertTrue(boundary("club", "ReadingClub"), "a capital after a lower-case letter starts a word")
        XCTAssertTrue(boundary("2", "Page2"), "a digit never continues a word")
        XCTAssertTrue(boundary("read club", "Reading Club"))
        XCTAssertFalse(boundary("read zebra", "Reading Club"))
    }

    func testAccentsFold() {
        XCTAssertTrue(boundary("cafe", "Café Rouge"))
        XCTAssertTrue(boundary("rouge", "Café Rouge"))
        XCTAssertFalse(boundary("afe", "Café Rouge"))
        XCTAssertTrue(boundary("ecole", "École du Louvre"))
        XCTAssertTrue(boundary("louvre", "École du Louvre"))
        XCTAssertTrue(anywhere("afe", "Café Rouge"))
    }

    func testAddresses() {
        XCTAssertTrue(boundary("example", "", url: "https://www.example.com/"))
        XCTAssertTrue(boundary("www", "", url: "HTTPS://www.example.com/"), "the scheme goes in any case")
        XCTAssertFalse(boundary("https", "", url: "https://www.example.com/"))
        XCTAssertTrue(boundary("a b", "", url: "https://x.example/a%20b"), "an escaped address matches as text")
        XCTAssertTrue(anywhere("xample", "", url: "https://www.example.com/"))
        XCTAssertFalse(anywhere("zzz", "Reading", url: "https://www.example.com/"))
    }
}
