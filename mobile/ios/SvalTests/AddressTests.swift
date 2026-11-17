// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// What the address bar makes of typed text, as Gecko's `URIFixup` decides
/// it and HTTPS-First then loads it.
final class AddressTests: XCTestCase {
    private func page(_ text: String) -> String? {
        Address.page(text)?.absoluteString
    }

    func testAHostAndPortIsAnAddress() {
        XCTAssertEqual(page("localhost:3000"), "http://localhost:3000")
        XCTAssertEqual(page("example.com:8080"), "http://example.com:8080")
        XCTAssertEqual(page("[::1]:8080"), "http://[::1]:8080")
    }

    func testANameWithoutAKnownSuffixIsASearch() {
        XCTAssertNil(page("node.js"))
        XCTAssertNil(page("foo"))
        XCTAssertNil(page("what is this"))
        XCTAssertNil(page("?example.com"))
        XCTAssertNil(page("mailto:someone"))
    }

    func testATrailingSlashOrWwwInsistsOnAnAddress() {
        XCTAssertEqual(page("foo/"), "http://foo/")
        XCTAssertEqual(page("node.js/"), "http://node.js/")
        XCTAssertEqual(page("www.notasuffix"), "http://www.notasuffix")
    }

    func testALocalAddressLoadsOverHTTP() {
        XCTAssertEqual(page("192.168.1.1"), "http://192.168.1.1")
        XCTAssertEqual(page("10.0.0.2/admin"), "http://10.0.0.2/admin")
        XCTAssertEqual(page("127.0.0.1"), "http://127.0.0.1")
    }

    func testAPublicAddressLoadsOverHTTPS() {
        XCTAssertEqual(page("example.com"), "https://example.com")
        XCTAssertEqual(page("news.example.co.uk/today"), "https://news.example.co.uk/today")
        XCTAssertEqual(page("8.8.8.8"), "https://8.8.8.8")
        XCTAssertEqual(page("www.foo"), "https://www.foo")
    }

    func testAnAddressWithAWebSchemeStandsAsTyped() {
        XCTAssertEqual(page("http://example.com/a"), "http://example.com/a")
        XCTAssertEqual(page("https://node.js"), "https://node.js")
    }

    func testSearchesWithTheSyncedEngine() {
        XCTAssertEqual(Address.resolve("cats", settings: [:])?.absoluteString,
                       "https://duckduckgo.com/?q=cats")
        XCTAssertEqual(Address.resolve("cats", settings: [SearchEngine.key: "startpage"])?.absoluteString,
                       "https://www.startpage.com/sp/search?query=cats")
        XCTAssertEqual(Address.resolve("cats", settings: [SearchEngine.key: "someone-elses"])?.absoluteString,
                       "https://duckduckgo.com/?q=cats")
    }
}
