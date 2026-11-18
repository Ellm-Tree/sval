// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// Remove from This Site's measuring of the page (`ElementPick`): what a
/// tap picks, where its outline is drawn, and the sheet that hides it.
@MainActor
final class ElementPickTests: XCTestCase {
    private var window: UIWindow!
    private var view: WKWebView!

    override func setUp() async throws {
        view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
        // In a window, as a page is, so it lays out and scrolls as one.
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = UIWindow(windowScene: scene)
        window.frame = view.frame
        window.addSubview(view)
        window.isHidden = false
        let loaded = Loaded()
        view.navigationDelegate = loaded
        view.loadHTMLString("""
            <!doctype html><html><head><meta name="viewport" content="width=device-width">
            <style>body { margin: 0 } div { position: absolute; left: 20px; width: 200px; height: 100px }</style>
            </head><body style="height: 3000px">
            <section class="promo"><div class="ad" style="top: 300px"><a href="/x">Buy</a></div></section>
            <div class="ad" style="top: 1000px"></div>
            </body></html>
            """, baseURL: URL(string: "https://news.example.com/"))
        try await loaded.wait()
    }

    override func tearDown() async throws {
        window.isHidden = true
        window = nil
        view = nil
    }

    func testATapPicksTheElementUnderItAndItsAncestors() async throws {
        let pick = try XCTUnwrap(ElementPick(view: view))
        XCTAssertEqual(pick.scope, "news.example.com")
        XCTAssertEqual(pick.hostScope, "news.example.com")
        let top = view.scrollView.adjustedContentInset.top
        await pick.pick(at: CGPoint(x: 120, y: top + 350))
        XCTAssertEqual(pick.stops.map(\.selector), [".ad", ".promo"])
        XCTAssertEqual(pick.stops.map(\.count), [2, 1])
        XCTAssertEqual(pick.line, "news.example.com##.ad")
        let first = try XCTUnwrap(pick.rects.first)
        XCTAssertEqual(first.minX, 20, accuracy: 1)
        XCTAssertEqual(first.minY, top + 300, accuracy: 1)
        XCTAssertEqual(first.width, 200, accuracy: 1)
        XCTAssertEqual(pick.rects.count, 2, "every match is outlined")
    }

    func testTheOutlineFollowsThePageAsItScrolls() async throws {
        let pick = try XCTUnwrap(ElementPick(view: view))
        let top = view.scrollView.adjustedContentInset.top
        await pick.pick(at: CGPoint(x: 120, y: top + 350))
        // A drag up of 200 points scrolls the page down by as much.
        await pick.scroll(by: CGVector(dx: 0, dy: -200))
        XCTAssertEqual(try XCTUnwrap(pick.rects.first).minY, top + 100, accuracy: 1)
        await pick.scroll(by: CGVector(dx: 0, dy: -600))
        await pick.pick(at: CGPoint(x: 120, y: top + 250))
        XCTAssertEqual(pick.stops.map(\.selector), [".ad"], "a tap after scrolling picks what is under it")
        XCTAssertEqual(try XCTUnwrap(pick.rects.first).minY, top + 200, accuracy: 1)
    }

    func testTheSheetHidesTheMatchesUntilUndone() async throws {
        let pick = try XCTUnwrap(ElementPick(view: view))
        let display = "getComputedStyle(document.querySelector('.ad')).display"
        let hidden = await pick.hide(".ad")
        let sheet = try XCTUnwrap(hidden)
        let during = try await view.evaluateJavaScript(display) as? String
        XCTAssertEqual(during, "none")
        await pick.unhide(sheet)
        let after = try await view.evaluateJavaScript(display) as? String
        XCTAssertEqual(after, "block")
        let refused = await pick.hide("x { color: red } .ad")
        XCTAssertNil(refused)
    }

    func testThePageNeverSeesThePicker() async throws {
        let pick = try XCTUnwrap(ElementPick(view: view))
        await pick.pick(at: CGPoint(x: 120, y: 400))
        let seen = try await view.evaluateJavaScript("typeof globalThis.__svalPicker") as? String
        XCTAssertEqual(seen, "undefined")
    }
}
