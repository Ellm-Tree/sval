// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// A page whose web process keeps ending stops loading again.
@MainActor
final class CrashedPageTests: XCTestCase {
    private let one = URL(string: "sval-test://pages/one")!
    private let two = URL(string: "sval-test://pages/two")!

    func testThreeEndsWithinTheSpanStopTheCount() {
        var crashes = Page.Crashes()
        let start = Date.now
        XCTAssertFalse(crashes.ended(at: one, now: start))
        XCTAssertFalse(crashes.ended(at: one, now: start + 10))
        XCTAssertTrue(crashes.ended(at: one, now: start + 20))
        // The count starts over.
        XCTAssertFalse(crashes.ended(at: one, now: start + 21))
    }

    func testEndsOutsideTheSpanDoNotCount() {
        var crashes = Page.Crashes()
        let start = Date.now
        XCTAssertFalse(crashes.ended(at: one, now: start))
        XCTAssertFalse(crashes.ended(at: one, now: start + 30))
        XCTAssertFalse(crashes.ended(at: one, now: start + Page.Crashes.span + 1))
        XCTAssertTrue(crashes.ended(at: one, now: start + Page.Crashes.span + 2))
    }

    func testAnotherAddressStartsTheCountOver() {
        var crashes = Page.Crashes()
        let start = Date.now
        XCTAssertFalse(crashes.ended(at: one, now: start))
        XCTAssertFalse(crashes.ended(at: one, now: start + 1))
        XCTAssertFalse(crashes.ended(at: two, now: start + 2))
        XCTAssertFalse(crashes.ended(at: two, now: start + 3))
        XCTAssertTrue(crashes.ended(at: two, now: start + 4))
    }

    /// A page on screen whose process ends: it loads again twice, then
    /// shows its failure, and Try Again starts the count over.
    func testAShownPageReloadsTwiceThenShowsItsFailure() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(LocalPages(), forURLScheme: LocalPages.scheme)
        let page = Page(tabId: "tab", media: .allow, configuration: configuration, scriptAllowed: { _, _ in true },
                        onNavigate: { _, _, _, _, _ in }, onState: {}, onScroll: { _, _ in })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.addSubview(page.view)
        let committed = expectation(description: "the page commits")
        page.onLoad = { committed.fulfill() }
        page.load(one)
        await fulfillment(of: [committed], timeout: 20)
        var failures = 0
        page.onFailure = { failures += 1 }
        for _ in 1..<Page.Crashes.limit {
            page.webViewWebContentProcessDidTerminate(page.view)
            XCTAssertFalse(page.ended, "the page did not load again")
            XCTAssertNil(page.failure)
        }
        page.webViewWebContentProcessDidTerminate(page.view)
        XCTAssertEqual(page.failure, Page.LoadFailure(url: one, reason: "", keepsClosing: true))
        XCTAssertEqual(failures, 1)
        XCTAssertFalse(page.ended)
        // Try Again (`Browser.reload`) loads the failed address anew.
        page.load(one)
        XCTAssertNil(page.failure)
        page.webViewWebContentProcessDidTerminate(page.view)
        XCTAssertNil(page.failure)
        XCTAssertFalse(page.ended)
        page.close()
    }
}
