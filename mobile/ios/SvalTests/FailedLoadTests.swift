// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// What a page keeps of a load that failed and left it empty.
@MainActor
final class FailedLoadTests: XCTestCase {
    /// Nothing listens on this port of the device itself, so a load of it
    /// is refused at once with no network.
    private let refused = URL(string: "http://127.0.0.1:9/first")!
    private let alsoRefused = URL(string: "http://127.0.0.1:9/second")!

    private func makePage() -> Page {
        Page(tabId: "tab", media: .allow, scriptAllowed: { _, _ in true },
             onNavigate: { _, _, _, _, _ in }, onState: {}, onScroll: { _, _ in })
    }

    /// Loads `url` and waits for the page to say the load failed.
    private func failing(_ page: Page, loading url: URL) async {
        let failed = expectation(description: "the load fails")
        page.onFailure = { failed.fulfill() }
        page.load(url)
        await fulfillment(of: [failed], timeout: 20)
    }

    func testAFailedLoadIsKeptWithItsAddressAndReason() async {
        let page = makePage()
        await failing(page, loading: refused)
        XCTAssertEqual(page.failure?.url, refused)
        XCTAssertFalse(page.failure?.reason.isEmpty ?? true)
    }

    func testLoadingAgainForgetsTheFailure() async {
        let page = makePage()
        await failing(page, loading: refused)
        page.load(refused)
        XCTAssertNil(page.failure)
    }

    func testALoadTheNextOneReplacedIsNoFailure() async {
        let page = makePage()
        var failures = 0
        let failed = expectation(description: "the second load fails")
        page.onFailure = {
            failures += 1
            failed.fulfill()
        }
        page.load(refused)
        page.load(alsoRefused)
        await fulfillment(of: [failed], timeout: 20)
        XCTAssertEqual(failures, 1)
        XCTAssertEqual(page.failure?.url, alsoRefused)
    }
}
