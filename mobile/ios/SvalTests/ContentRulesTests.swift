// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// What the converted hiding rules hide once WebKit compiles and applies
/// them, on a page at each site. The converter's own tests check the JSON;
/// these check WebKit reads it as the lists mean it.
@MainActor
final class ContentRulesTests: XCTestCase {
    private static let list = """
        ##.generic
        example.com##.specific
        ~vipbox.pl,vipbox.*##.vipbox
        *##.everywhere
        ##.unhidden-on-site
        site.com#@#.unhidden-on-site
        @@||lifted.com^$generichide
        @@*$ghide,domain=domain-lifted.com
        @@||nospecific.com^$specifichide
        nospecific.com##.specific-there
        @@||nothing.com^$elemhide
        nothing.com##.specific-there
        !#if env_firefox
        ##.firefox-only
        !#else
        ##.not-firefox
        !#endif
        """

    private static let classes = [
        "generic", "specific", "vipbox", "everywhere", "unhidden-on-site",
        "specific-there", "firefox-only", "not-firefox", "plain",
    ]

    private var store: WKContentRuleListStore!
    private var lists: [WKContentRuleList] = []
    private var storeURL: URL!

    override func setUp() async throws {
        storeURL = FileManager.default.temporaryDirectory.appending(path: "rules-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: storeURL, withIntermediateDirectories: true)
        store = WKContentRuleListStore(url: storeURL)
        let converted = contentRules(lists: [Self.list], pageRules: true, allowedDomains: [])
        lists = []
        for (index, json) in converted.lists.enumerated() {
            let compiled = try await store.compileContentRuleList(forIdentifier: "test-\(index)", encodedContentRuleList: json)
            lists.append(try XCTUnwrap(compiled))
        }
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: storeURL)
    }

    /// The classes hidden on a page at `address`.
    private func hidden(at address: String) async throws -> Set<String> {
        let configuration = WKWebViewConfiguration()
        for list in lists { configuration.userContentController.add(list) }
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 640), configuration: configuration)
        let loaded = Loaded()
        view.navigationDelegate = loaded
        let body = Self.classes.map { "<div class=\"\($0)\">\($0)</div>" }.joined()
        view.loadHTMLString("<!doctype html><html><body>\(body)</body></html>", baseURL: URL(string: address))
        try await loaded.wait()
        let script = """
            JSON.stringify(\(Self.classes).filter(name =>
                getComputedStyle(document.querySelector("." + name)).display == "none"))
            """
        let json = try await view.evaluateJavaScript(script) as? String ?? "[]"
        return Set(try JSONDecoder().decode([String].self, from: Data(json.utf8)))
    }

    func testHidesGenericAndSpecificRulesWhereTheListSays() async throws {
        let other = try await hidden(at: "https://www.other.org/")
        XCTAssertEqual(other, ["generic", "everywhere", "unhidden-on-site", "not-firefox"])
        let example = try await hidden(at: "https://news.example.com/")
        XCTAssertEqual(example, ["generic", "specific", "everywhere", "unhidden-on-site", "not-firefox"])
    }

    func testAnExceptionUnhidesOnItsSite() async throws {
        let site = try await hidden(at: "https://www.site.com/")
        XCTAssertFalse(site.contains("unhidden-on-site"))
        XCTAssertTrue(site.contains("generic"))
    }

    func testGenerichideLiftsGenericHidingOnItsSite() async throws {
        for address in ["https://www.lifted.com/login", "https://domain-lifted.com/"] {
            let lifted = try await hidden(at: address)
            XCTAssertEqual(lifted, [], address)
        }
    }

    func testSpecifichideLiftsSiteHidingAlone() async throws {
        let site = try await hidden(at: "https://nospecific.com/")
        XCTAssertFalse(site.contains("specific-there"))
        XCTAssertTrue(site.contains("generic"))
    }

    func testElemhideLiftsAllHiding() async throws {
        let site = try await hidden(at: "https://nothing.com/")
        XCTAssertEqual(site, [])
    }

    func testARuleForEntitiesAloneHidesNowhere() async throws {
        let site = try await hidden(at: "https://www.figma.com/")
        XCTAssertFalse(site.contains("vipbox"))
    }
}

/// Waits for a page's load to finish.
@MainActor
final class Loaded: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?
    private var done = false

    func wait() async throws {
        if done { return }
        try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        done = true
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
